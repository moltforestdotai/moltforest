/**
 * Background workers (single instance; each work table is its own queue):
 * - enrichment: fetches remote ERC-8004 registration files into app.agent_profile
 * - liveness:   probes declared http(s) service endpoints into app.endpoint_status
 * - relay:      anchors submitted receipts (app.receipt) on the ReceiptRegistry
 * - payments:   indexes x402 USDC settlements touching agent addresses (app.x402_payment)
 * - reviews:    looks up reviewer funding and decides which reviews count (app.agent_review_summary)
 * - receipt events: records receipts anchored on the ReceiptRegistry by anyone (app.receipt, source "chain")
 * - nansen:     asks Nansen how mainnet reviewer wallets are related (app.nansen_relation)
 */
import { pino, type Logger } from "pino";
import { createPool } from "@moltforest/db";
import { loadConfig, USER_AGENT } from "./config.js";
import { fetchDocument, probeEndpoint } from "./net/fetchDocument.js";
import { HostLimiter } from "./net/hostLimiter.js";
import { createProfileRepository } from "./enrich/repository.js";
import { runBatch } from "./enrich/runner.js";
import { createLivenessRepository } from "./liveness/repository.js";
import { runLivenessBatch } from "./liveness/runner.js";
import { NETWORK_NAMES, NETWORKS } from "@moltforest/chain";
import { createAnchorChain } from "./anchor/chain.js";
import { createAnchorRepository } from "./anchor/repository.js";
import { runAnchorBatch } from "./anchor/runner.js";
import { createHyperSync } from "./payments/hypersync.js";
import { createPaymentRepository } from "./payments/repository.js";
import { runPaymentsTick } from "./payments/runner.js";
import { createReviewRepository } from "./reviews/repository.js";
import { runReviewsTick } from "./reviews/runner.js";
import { createReceiptEventRepository } from "./receiptEvents/repository.js";
import { runReceiptEventsTick } from "./receiptEvents/runner.js";
import { createNansenClient } from "./nansen/client.js";
import { createNansenRepository } from "./nansen/repository.js";
import { runNansenTick } from "./nansen/runner.js";

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });
const db = createPool(config.DATABASE_URL, { max: config.DB_POOL_MAX, ssl: config.DATABASE_SSL, sslCaFile: config.DATABASE_SSL_CA_FILE });
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

/** One relay loop per network with a ReceiptRegistry (normally testnet only). */
const relays = () => {
  const log = logger.child({ worker: "relay" });
  if (!config.RECEIPT_RELAY_ENABLED) return [];
  const rpcUrls = { mainnet: config.MONAD_RPC_URL_MAINNET, testnet: config.MONAD_RPC_URL_TESTNET };
  const overrides = { mainnet: config.RECEIPT_REGISTRY_MAINNET, testnet: config.RECEIPT_REGISTRY_TESTNET };
  const repo = createAnchorRepository(db, schemas.app);
  const loops: Promise<void>[] = [];
  for (const name of NETWORK_NAMES) {
    const network = NETWORKS[name];
    const registry = overrides[name] ?? network.receiptRegistry?.address;
    if (!registry) continue;
    if (!config.RELAYER_PRIVATE_KEY) {
      log.info({ network: name }, "receipt relay off: RELAYER_PRIVATE_KEY is not set (receipts stay queued)");
      continue;
    }
    const chain = createAnchorChain({ network, rpcUrl: rpcUrls[name] ?? network.defaultRpcUrl, registry, privateKey: config.RELAYER_PRIVATE_KEY });
    log.info({ network: name, registry, relayer: chain.relayer }, "receipt relay on");
    const netLog = log.child({ network: name });
    loops.push(
      loop(`relay:${name}`, netLog, config.RECEIPT_RELAY_IDLE_POLL_SECONDS * 1000, async () => {
        const stats = await runAnchorBatch(
          { repo, chain, logger: netLog },
          {
            chainId: network.chainId,
            batchSize: config.RECEIPT_RELAY_BATCH_SIZE,
            maxPerAgentPerDay: config.RECEIPT_RELAY_MAX_PER_AGENT_PER_DAY,
            minBalanceWei: config.RECEIPT_RELAY_MIN_BALANCE_MON,
            txTimeoutMs: config.RECEIPT_RELAY_TX_TIMEOUT_SECONDS * 1000,
            droppedAfterMs: 10 * 60_000,
            maxAttempts: config.RECEIPT_RELAY_MAX_ATTEMPTS,
          },
        );
        return { selected: stats.selected, full: !stats.lowBalance && stats.selected >= config.RECEIPT_RELAY_BATCH_SIZE, stats };
      }),
    );
  }
  return loops;
};

/** One payments loop per network (both chains); off without a HyperSync token. */
const payments = () => {
  const log = logger.child({ worker: "payments" });
  if (!config.PAYMENTS_ENABLED) return [];
  if (!config.ENVIO_API_TOKEN) {
    log.info("x402 payments off: ENVIO_API_TOKEN is not set");
    return [];
  }
  const hs = createHyperSync({ token: config.ENVIO_API_TOKEN, urlTemplate: config.HYPERSYNC_URL_TEMPLATE, logger: log });
  const repo = createPaymentRepository(db, schemas);
  return NETWORK_NAMES.map((name) => {
    const network = NETWORKS[name];
    const netLog = log.child({ network: name });
    return loop(`payments:${name}`, netLog, config.PAYMENTS_POLL_SECONDS * 1000, async () => {
      const stats = await runPaymentsTick({ repo, hs, logger: netLog }, { chainId: network.chainId, usdc: network.usdc.toLowerCase() });
      // Pending backfill left: run again soon instead of waiting a full poll interval.
      const more = (await repo.addresses(network.chainId, false, 1)).length > 0;
      return { selected: stats.saved + stats.backfilled, full: more, stats };
    });
  });
};

/** One reviews loop per network (decision D31); off without a HyperSync token. */
const reviews = () => {
  const log = logger.child({ worker: "reviews" });
  if (!config.REVIEWS_ENABLED) return [];
  if (!config.ENVIO_API_TOKEN) {
    log.info("review assessment off: ENVIO_API_TOKEN is not set");
    return [];
  }
  const hs = createHyperSync({ token: config.ENVIO_API_TOKEN, urlTemplate: config.HYPERSYNC_URL_TEMPLATE, logger: log });
  const repo = createReviewRepository(db, schemas);
  return NETWORK_NAMES.map((name) => {
    const network = NETWORKS[name];
    const netLog = log.child({ network: name });
    return loop(`reviews:${name}`, netLog, config.REVIEWS_POLL_SECONDS * 1000, async () => {
      const stats = await runReviewsTick(
        { repo, hs, logger: netLog },
        {
          chainId: network.chainId,
          hubMinAgents: config.REVIEWS_HUB_MIN_AGENTS,
          repeatWindowDays: config.REVIEWS_REPEAT_WINDOW_DAYS,
          files: {
            batch: 500,
            concurrency: 8,
            fetch: { timeoutMs: config.ENRICH_TIMEOUT_MS, maxBytes: config.ENRICH_MAX_BYTES, userAgent: USER_AGENT },
            ipfsGateways: config.IPFS_GATEWAYS,
          },
        },
      );
      // Funding lookups left: run again soon instead of waiting a full poll interval.
      const more = (await repo.pendingWallets(network.chainId, 1)).length > 0;
      return { selected: stats.fundingLookedUp + stats.agentsChanged, full: more, stats };
    });
  });
};

/** One receipt-event scan per network with a ReceiptRegistry (testnet); off without a HyperSync token. */
const receiptEvents = () => {
  const log = logger.child({ worker: "receipt-events" });
  if (!config.RECEIPT_EVENTS_ENABLED) return [];
  if (!config.ENVIO_API_TOKEN) {
    log.info("receipt event scan off: ENVIO_API_TOKEN is not set");
    return [];
  }
  const hs = createHyperSync({ token: config.ENVIO_API_TOKEN, urlTemplate: config.HYPERSYNC_URL_TEMPLATE, logger: log });
  const repo = createReceiptEventRepository(db, schemas.app);
  return NETWORK_NAMES.flatMap((name) => {
    const registry = NETWORKS[name].receiptRegistry;
    if (!registry) return [];
    const netLog = log.child({ network: name });
    return [
      loop(`receipt-events:${name}`, netLog, config.RECEIPT_EVENTS_POLL_SECONDS * 1000, async () => {
        const stats = await runReceiptEventsTick(
          { repo, hs, logger: netLog },
          { chainId: NETWORKS[name].chainId, registry: registry.address, deployBlock: registry.deployBlock },
        );
        return { selected: stats.inserted + stats.updated, full: false, stats };
      }),
    ];
  });
};

/** One Nansen loop per network Nansen covers (Monad mainnet; decision D47); off without an API key. */
const nansen = () => {
  const log = logger.child({ worker: "nansen" });
  if (!config.NANSEN_ENABLED) return [];
  if (!config.NANSEN_API_KEY) {
    log.info("Nansen lookups off: NANSEN_API_KEY is not set");
    return [];
  }
  const client = createNansenClient({ apiKey: config.NANSEN_API_KEY, baseUrl: config.NANSEN_BASE_URL, timeoutMs: config.NANSEN_TIMEOUT_MS });
  const repo = createNansenRepository(db, schemas);
  return NETWORK_NAMES.flatMap((name) => {
    const { chainId, nansenChain } = NETWORKS[name];
    if (!nansenChain) return [];
    const netLog = log.child({ network: name });
    return [
      loop(`nansen:${name}`, netLog, config.NANSEN_POLL_SECONDS * 1000, async () => {
        const stats = await runNansenTick(
          { repo, client, logger: netLog },
          {
            chainId,
            nansenChain,
            dailyLookups: config.NANSEN_DAILY_LOOKUPS,
            batchSize: config.NANSEN_BATCH_SIZE,
            delayMs: config.NANSEN_REQUEST_DELAY_MS,
            maxAttempts: 4,
            focusAgents: config.NANSEN_FOCUS_AGENTS,
          },
        );
        return { selected: stats.selected, full: stats.stoppedBy === null && stats.selected >= config.NANSEN_BATCH_SIZE, stats };
      }),
    ];
  });
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info(`${signal} received; finishing current batches`);
    stopping = true;
  });
}

await Promise.all([
  enrichment(),
  config.LIVENESS_ENABLED ? liveness() : Promise.resolve(),
  ...relays(),
  ...payments(),
  ...reviews(),
  ...receiptEvents(),
  ...nansen(),
]);
await db.end();
