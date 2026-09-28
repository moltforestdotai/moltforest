import { pino } from "pino";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { createApp } from "./app.js";
import { createChainChecker } from "./services/chainCheck.js";
import { ActivityHub } from "./services/activityHub.js";
import { createActivityRepository } from "./repositories/activity.js";
import { createSyncRepository } from "./repositories/sync.js";

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });
const db = createDb(config.DATABASE_URL);
const chain = createChainChecker({
  ttlMs: config.CHAIN_CHECK_TTL_SECONDS * 1000,
  rpcUrls: { mainnet: config.MONAD_RPC_URL_MAINNET, testnet: config.MONAD_RPC_URL_TESTNET },
});
const activityHub = new ActivityHub(
  {
    activity: createActivityRepository(db, { indexer: config.INDEXER_DB_SCHEMA, app: config.APP_DB_SCHEMA }),
    sync: createSyncRepository(db, config.INDEXER_DB_SCHEMA),
    logger,
  },
  { pollMs: config.ACTIVITY_POLL_MS, maxEventsPerTick: 200, maxSubscribers: config.ACTIVITY_MAX_STREAMS },
);
activityHub.start();

const app = createApp({ config, db, chain, activityHub, logger });
const server = app.listen(config.API_PORT, () => {
  logger.info(`MoltForest API listening on http://localhost:${config.API_PORT}`);
});

async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  activityHub.stop();
  server.closeAllConnections(); // SSE streams would otherwise keep the server open
  server.close();
  await db.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
