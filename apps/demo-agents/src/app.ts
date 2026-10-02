import express, { type Express } from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { pinoHttp } from "pino-http";
import type { Logger } from "pino";
import { errorHandler, notFound } from "./http.js";
import { EMAIL_VERIFIER_PATH, emailVerifierRouter, type EmailVerifierDeps } from "./emailVerifier/router.js";

export interface AppDeps {
  emailVerifier: EmailVerifierDeps;
  rateLimitPerMinute: number;
  logger?: Logger;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // behind nginx in production

  // Log method, path and status only: request bodies carry email addresses.
  if (deps.logger) {
    app.use(
      pinoHttp({
        logger: deps.logger,
        autoLogging: { ignore: (req) => req.url === "/health" },
        serializers: {
          req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url.split("?")[0] }),
          res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
        },
      }),
    );
  }
  app.use(helmet());
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: deps.rateLimitPerMinute,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: { code: "rate_limited", message: "Too many requests, slow down." } },
    }),
  );
  app.use(EMAIL_VERIFIER_PATH, emailVerifierRouter(deps.emailVerifier));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
