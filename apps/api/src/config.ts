import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Load the monorepo-root .env (apps/api/src → ../../../.env). Real env vars win.
loadDotenv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const schemaName = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, "must be a plain lowercase Postgres schema name");

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address")
  .transform((s) => s.toLowerCase() as `0x${string}`);

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_SSL: z.enum(["disable", "require", "verify-full"]).default("disable"),
  DATABASE_SSL_CA_FILE: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  INDEXER_DB_SCHEMA: schemaName.default("envio"),
  APP_DB_SCHEMA: schemaName.default("app"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),
  MONAD_RPC_URL_MAINNET: z.string().url().optional(),
  MONAD_RPC_URL_TESTNET: z.string().url().optional(),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
  CHAIN_CHECK_TTL_SECONDS: z.coerce.number().int().min(5).default(60),
  ACTIVITY_POLL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),
  ACTIVITY_MAX_STREAMS: z.coerce.number().int().min(1).max(10_000).default(500),
  /** Overrides the ReceiptRegistry address from @moltforest/chain (e.g. a local Anvil deployment). */
  RECEIPT_REGISTRY_TESTNET: address.optional(),
  RECEIPT_REGISTRY_MAINNET: address.optional(),
  RECEIPT_SUBMIT_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  RECEIPT_MAX_FUTURE_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid API configuration:\n${issues}`);
  }
  return parsed.data;
}
