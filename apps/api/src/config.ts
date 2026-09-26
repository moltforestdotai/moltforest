import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Load the monorepo-root .env (apps/api/src → ../../../.env). Real env vars win.
loadDotenv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const schemaName = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, "must be a plain lowercase Postgres schema name");

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  INDEXER_DB_SCHEMA: schemaName.default("envio"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),
  MONAD_RPC_URL_MAINNET: z.string().url().optional(),
  MONAD_RPC_URL_TESTNET: z.string().url().optional(),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
  CHAIN_CHECK_TTL_SECONDS: z.coerce.number().int().min(5).default(60),
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
