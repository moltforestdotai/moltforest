import { pino } from "pino";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { createApp } from "./app.js";
import { createChainChecker } from "./services/chainCheck.js";

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });
const db = createDb(config.DATABASE_URL);
const chain = createChainChecker({
  ttlMs: config.CHAIN_CHECK_TTL_SECONDS * 1000,
  rpcUrls: { mainnet: config.MONAD_RPC_URL_MAINNET, testnet: config.MONAD_RPC_URL_TESTNET },
});

const app = createApp({ config, db, chain, logger });
const server = app.listen(config.API_PORT, () => {
  logger.info(`MoltForest API listening on http://localhost:${config.API_PORT}`);
});

async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  server.close();
  await db.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
