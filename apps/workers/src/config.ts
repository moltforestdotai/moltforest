import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { parseEther } from "viem";
import { z } from "zod";

// Load the monorepo-root .env (apps/workers/src → ../../../.env). Real env vars win.
loadDotenv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const schemaName = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean));

const address = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address")
  .transform((s) => s.toLowerCase() as `0x${string}`);

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_SSL: z.enum(["disable", "require", "verify-full"]).default("disable"),
  DATABASE_SSL_CA_FILE: z.string().optional(),
  /** Queries wait for a free connection, so this can be far below the fetch concurrency. */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
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
  LIVENESS_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  LIVENESS_BATCH_SIZE: z.coerce.number().int().min(1).max(5_000).default(200),
  LIVENESS_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(8),
  LIVENESS_PER_HOST_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
  LIVENESS_PER_HOST_RPS: z.coerce.number().min(0.1).max(50).default(1),
  LIVENESS_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(5_000),
  LIVENESS_IDLE_POLL_SECONDS: z.coerce.number().int().min(1).default(30),
  // --- Receipt relayer (anchors submitted receipts on-chain; testnet only, decision D05) ---
  MONAD_RPC_URL_MAINNET: z.string().url().optional(),
  MONAD_RPC_URL_TESTNET: z.string().url().optional(),
  /** Overrides the ReceiptRegistry address from @moltforest/chain (e.g. a local Anvil deployment). */
  RECEIPT_REGISTRY_TESTNET: address.optional(),
  RECEIPT_REGISTRY_MAINNET: address.optional(),
  /** Testnet-only key with a small balance (constraint C6). Without it the relayer is off. */
  RELAYER_PRIVATE_KEY: z
    .string()
    .trim()
    .regex(/^(0x)?[0-9a-fA-F]{64}$/, "must be a 32-byte hex private key")
    .transform((s) => (s.startsWith("0x") ? s : `0x${s}`) as `0x${string}`)
    .optional(),
  RECEIPT_RELAY_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  RECEIPT_RELAY_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(20),
  RECEIPT_RELAY_MAX_PER_AGENT_PER_DAY: z.coerce.number().int().min(0).default(100),
  RECEIPT_RELAY_MIN_BALANCE_MON: z
    .string()
    .regex(/^\d+(\.\d{1,18})?$/, "must be a decimal MON amount")
    .default("0.05")
    .transform((v) => parseEther(v)),
  RECEIPT_RELAY_TX_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(600).default(60),
  RECEIPT_RELAY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(8),
  RECEIPT_RELAY_IDLE_POLL_SECONDS: z.coerce.number().int().min(1).default(15),
  // --- x402 payments (decision D33; HyperSync, same token as the indexer) ---
  ENVIO_API_TOKEN: z.string().trim().min(1).optional(),
  HYPERSYNC_URL_TEMPLATE: z.string().default("https://{chainId}.hypersync.xyz"),
  PAYMENTS_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  PAYMENTS_POLL_SECONDS: z.coerce.number().int().min(30).default(300),
  // --- Review assessment (decision D31; HyperSync for reviewer funding) ---
  REVIEWS_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  REVIEWS_POLL_SECONDS: z.coerce.number().int().min(30).default(300),
  /** A funder whose wallets reviewed at least this many agents is a hub (faucet, exchange) and links nothing. */
  REVIEWS_HUB_MIN_AGENTS: z.coerce.number().int().min(2).default(10),
  /** A wallet's later review of the same agent counts again after this many days. */
  REVIEWS_REPEAT_WINDOW_DAYS: z.coerce.number().int().min(1).default(30),
  // --- Nansen related wallets of Monad mainnet reviewers (decision D47) ---
  /** Without it the Nansen lookups are off. */
  NANSEN_API_KEY: z.string().trim().min(1).optional(),
  NANSEN_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  NANSEN_BASE_URL: z.string().url().default("https://api.nansen.ai"),
  /** Answered lookups per UTC day; each costs 1 credit. */
  NANSEN_DAILY_LOOKUPS: z.coerce.number().int().min(0).default(25),
  NANSEN_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(25),
  NANSEN_POLL_SECONDS: z.coerce.number().int().min(60).default(600),
  NANSEN_REQUEST_DELAY_MS: z.coerce.number().int().min(0).max(10_000).default(300),
  NANSEN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  /** Mainnet agent ids whose reviewers are looked up first, e.g. "182,9" for the agents a demo shows. */
  NANSEN_FOCUS_AGENTS: csv("").pipe(z.array(z.string().regex(/^\d+$/, "must be agent ids, e.g. 182,9"))),
  // --- Receipts anchored on the ReceiptRegistry by anyone (HyperSync) ---
  RECEIPT_EVENTS_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  RECEIPT_EVENTS_POLL_SECONDS: z.coerce.number().int().min(10).default(60),
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

export const USER_AGENT = "MoltForestBot/0.1 (+https://www.moltforest.ai; ERC-8004 registration indexer)";
