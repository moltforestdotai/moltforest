import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { pinoHttp } from "pino-http";
import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import type { Db } from "./db.js";
import { createAgentRepository } from "./repositories/agents.js";
import { createSyncRepository } from "./repositories/sync.js";
import type { ChainChecker } from "./services/chainCheck.js";
import { agentsRouter } from "./routes/agents.js";
import { metaRouter } from "./routes/meta.js";
import { activityRouter } from "./routes/activity.js";
import { createActivityRepository } from "./repositories/activity.js";
import type { ActivityHub } from "./services/activityHub.js";
import { receiptsRouter } from "./routes/receipts.js";
import { paymentsRouter } from "./routes/payments.js";
import { createPaymentRepository } from "./repositories/payments.js";
import { createReceiptRepository } from "./repositories/receipts.js";
import type { ReceiptNetworks } from "./services/receiptNetworks.js";
import { errorHandler, notFound } from "./lib/errors.js";

export interface AppDeps {
  config: Pick<AppConfig, "INDEXER_DB_SCHEMA" | "APP_DB_SCHEMA" | "CORS_ORIGINS" | "RATE_LIMIT_PER_MINUTE">;
  db: Db;
  chain: ChainChecker;
  /** Live activity for SSE; omitted in tests that do not need streaming. */
  activityHub?: ActivityHub;
  /** Receipt submission; without networks, POST /v1/receipts answers 503 and reads still work. */
  receipts?: { networks: ReceiptNetworks; submitPerMinute: number; maxFutureSeconds: number };
  logger?: Logger;
}

const rateLimited = { error: { code: "rate_limited", message: "Too many requests, slow down." } };

export function createApp({ config, db, chain, activityHub, receipts, logger }: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.set("query parser", "simple");

  if (logger) app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/health" } }));
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGINS, methods: ["GET"], maxAge: 600 }));
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: config.RATE_LIMIT_PER_MINUTE,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: rateLimited,
    }),
  );

  // Decision D15: every endpoint is free for now (x402 paywall arrives behind a flag).
  app.use(metaRouter(db, createSyncRepository(db, config.INDEXER_DB_SCHEMA), chain));
  app.use(
    "/v1/agents",
    agentsRouter(createAgentRepository(db, { indexer: config.INDEXER_DB_SCHEMA, app: config.APP_DB_SCHEMA })),
  );
  app.use(
    "/v1/activity",
    activityRouter(createActivityRepository(db, { indexer: config.INDEXER_DB_SCHEMA, app: config.APP_DB_SCHEMA }), activityHub),
  );
  app.use(
    "/v1",
    receiptsRouter(createReceiptRepository(db, config.APP_DB_SCHEMA), receipts?.networks ?? {}, {
      maxFutureSeconds: receipts?.maxFutureSeconds ?? 300,
      // Submissions cost RPC reads to verify and relayer gas to anchor, so they get a tighter limit.
      submitLimiter: rateLimit({
        windowMs: 60_000,
        limit: receipts?.submitPerMinute ?? 30,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        message: rateLimited,
      }),
    }),
  );

  app.use("/v1", paymentsRouter(createPaymentRepository(db, { indexer: config.INDEXER_DB_SCHEMA, app: config.APP_DB_SCHEMA })));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
