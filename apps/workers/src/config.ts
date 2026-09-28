import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Load the monorepo-root .env (apps/workers/src → ../../../.env). Real env vars win.
loadDotenv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const schemaName = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean));

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  INDEXER_DB_SCHEMA: schemaName.default("envio"),
  APP_DB_SCHEMA: schemaName.default("app"),
  ENRICH_BATCH_SIZE: z.coerce.number().int().min(1).max(5_000).default(500),
  ENRICH_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(24),
  ENRICH_PER_HOST_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
  ENRICH_PER_HOST_RPS: z.coerce.number().min(0.1).max(100).default(5),
  ENRICH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  ENRICH_MAX_BYTES: z.coerce.number().int().min(1_024).max(5_000_000).default(256 * 1024),
  ENRICH_IDLE_POLL_SECONDS: z.coerce.number().int().min(1).default(30),
  // dweb.link rejects path-style requests (403); w3s.link redirects to its subdomain gateway.
  IPFS_GATEWAYS: csv("https://ipfs.io/ipfs/,https://w3s.link/ipfs/,https://gateway.pinata.cloud/ipfs/"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type WorkerConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid worker configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  return parsed.data;
}

export const USER_AGENT = "MoltForestBot/0.1 (+https://moltforest.ai; ERC-8004 registration indexer)";
