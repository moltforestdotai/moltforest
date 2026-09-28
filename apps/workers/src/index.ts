/**
 * Background workers (single instance; each work table is its own queue):
 * - enrichment: fetches remote ERC-8004 registration files into app.agent_profile
 * - liveness:   probes declared http(s) service endpoints into app.endpoint_status
 */
import pg from "pg";
import { pino, type Logger } from "pino";
import { loadConfig, USER_AGENT } from "./config.js";
import { fetchDocument, probeEndpoint } from "./net/fetchDocument.js";
import { HostLimiter } from "./net/hostLimiter.js";
import { createProfileRepository } from "./enrich/repository.js";
import { runBatch } from "./enrich/runner.js";
import { createLivenessRepository } from "./liveness/repository.js";
import { runLivenessBatch } from "./liveness/runner.js";

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });
const db = new pg.Pool({ connectionString: config.DATABASE_URL, max: config.ENRICH_CONCURRENCY + config.LIVENESS_CONCURRENCY + 2 });
const schemas = { indexer: config.INDEXER_DB_SCHEMA, app: config.APP_DB_SCHEMA };

let stopping = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `batch` until stopped; idles when the queue is drained; survives errors. */
async function loop(name: string, log: Logger, idleMs: number, batch: () => Promise<{ selected: number; full: boolean; stats: object }>) {
  log.info(`${name} loop started`);
  while (!stopping) {
    try {
      const started = Date.now();
      const { selected, full, stats } = await batch();
      if (selected > 0) log.info({ ...stats, ms: Date.now() - started }, `${name} batch done`);
      if (!full) await sleep(idleMs);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "42P01" || code === "3F000") log.warn("tables missing: start the indexer and run `pnpm db:migrate`; retrying in 30s");
      else log.error({ err }, `${name} batch failed; retrying in 30s`);
      await sleep(30_000);
    }
  }
}

const enrichment = () => {
  const repo = createProfileRepository(db, schemas);
  const limiter = new HostLimiter(config.ENRICH_PER_HOST_CONCURRENCY, 1000 / config.ENRICH_PER_HOST_RPS);
  const fetcher = (url: string) =>
    fetchDocument(url, { timeoutMs: config.ENRICH_TIMEOUT_MS, maxBytes: config.ENRICH_MAX_BYTES, maxRedirects: 3, userAgent: USER_AGENT });
  return loop("enrichment", logger.child({ worker: "enrichment" }), config.ENRICH_IDLE_POLL_SECONDS * 1000, async () => {
    const stats = await runBatch(
      { repo, fetcher, limiter, logger },
      { batchSize: config.ENRICH_BATCH_SIZE, concurrency: config.ENRICH_CONCURRENCY, ipfsGateways: config.IPFS_GATEWAYS },
    );
    return { selected: stats.selected, full: stats.selected >= config.ENRICH_BATCH_SIZE, stats };
  });
};

const liveness = () => {
  const repo = createLivenessRepository(db, schemas);
  const limiter = new HostLimiter(config.LIVENESS_PER_HOST_CONCURRENCY, 1000 / config.LIVENESS_PER_HOST_RPS);
  const probe = (url: string) => probeEndpoint(url, { timeoutMs: config.LIVENESS_TIMEOUT_MS, userAgent: USER_AGENT });
  return loop("liveness", logger.child({ worker: "liveness" }), config.LIVENESS_IDLE_POLL_SECONDS * 1000, async () => {
    const stats = await runLivenessBatch({ repo, probe, limiter, logger }, { batchSize: config.LIVENESS_BATCH_SIZE, concurrency: config.LIVENESS_CONCURRENCY });
    return { selected: stats.checked, full: stats.checked >= config.LIVENESS_BATCH_SIZE, stats };
  });
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info(`${signal} received; finishing current batches`);
    stopping = true;
  });
}

await Promise.all([enrichment(), config.LIVENESS_ENABLED ? liveness() : Promise.resolve()]);
await db.end();
