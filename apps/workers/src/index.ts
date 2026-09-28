/**
 * Enrichment worker: fetches remote ERC-8004 registration files (https/http/ipfs)
 * into app.agent_profile. Runs as a single instance; the profile table itself
 * is the work queue (next_fetch_at).
 */
import pg from "pg";
import { pino } from "pino";
import { loadConfig, USER_AGENT } from "./config.js";
import { fetchDocument } from "./net/fetchDocument.js";
import { HostLimiter } from "./net/hostLimiter.js";
import { createProfileRepository } from "./enrich/repository.js";
import { runBatch } from "./enrich/runner.js";

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });
const db = new pg.Pool({ connectionString: config.DATABASE_URL, max: config.ENRICH_CONCURRENCY + 2 });
const repo = createProfileRepository(db, { indexer: config.INDEXER_DB_SCHEMA, app: config.APP_DB_SCHEMA });
const limiter = new HostLimiter(config.ENRICH_PER_HOST_CONCURRENCY, 1000 / config.ENRICH_PER_HOST_RPS);
const fetcher = (url: string) =>
  fetchDocument(url, { timeoutMs: config.ENRICH_TIMEOUT_MS, maxBytes: config.ENRICH_MAX_BYTES, maxRedirects: 3, userAgent: USER_AGENT });

let stopping = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  logger.info({ batchSize: config.ENRICH_BATCH_SIZE, perHostRps: config.ENRICH_PER_HOST_RPS }, "enrichment worker started");
  while (!stopping) {
    try {
      const started = Date.now();
      const stats = await runBatch(
        { repo, fetcher, limiter, logger },
        { batchSize: config.ENRICH_BATCH_SIZE, concurrency: config.ENRICH_CONCURRENCY, ipfsGateways: config.IPFS_GATEWAYS },
      );
      if (stats.selected > 0) logger.info({ ...stats, ms: Date.now() - started }, "enrichment batch done");
      if (stats.selected < config.ENRICH_BATCH_SIZE) await sleep(config.ENRICH_IDLE_POLL_SECONDS * 1000);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "42P01" || code === "3F000") {
        logger.warn("tables missing: start the indexer and run `pnpm db:migrate`; retrying in 30s");
      } else {
        logger.error({ err }, "enrichment batch failed; retrying in 30s");
      }
      await sleep(30_000);
    }
  }
  await db.end();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info(`${signal} received; finishing the current batch`);
    stopping = true;
  });
}

await main();
