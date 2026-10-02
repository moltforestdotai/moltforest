import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { parseUnits, type Hex } from "viem";
import { z } from "zod";

// Load the monorepo-root .env (apps/demo-agents/src → ../../../.env). Real env vars win.
loadDotenv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

/** Testnet-only demo key (constraint C6). Accepted with or without the 0x prefix. */
const privateKey = z
  .string()
  .trim()
  .regex(/^(0x)?[0-9a-fA-F]{64}$/, "must be a 32-byte hex private key")
  .transform((s) => (s.startsWith("0x") ? s : `0x${s}`).toLowerCase() as Hex);

const agentId = z
  .string()
  .trim()
  .regex(/^(0|[1-9][0-9]{0,77})$/, "must be a decimal agent id")
  .transform((s) => BigInt(s));

/** A USDC amount such as "0.01" (6 decimals), kept as atomic units. */
const usdcAmount = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,6})?$/, "must be a USDC amount with at most 6 decimals")
  .transform((s) => parseUnits(s, 6))
  .refine((v) => v > 0n, "must be more than zero");

const EnvSchema = z.object({
  DEMO_AGENTS_HOST: z.string().default("127.0.0.1"),
  DEMO_AGENTS_PORT: z.coerce.number().int().min(1).max(65_535).default(7051),
  /** Public origin the demo agents are reached at; used in 402 responses and registration files. */
  DEMO_AGENTS_PUBLIC_URL: z
    .string()
    .url()
    .default("http://localhost:7051")
    .transform((s) => s.replace(/\/+$/, "")),
  DEMO_AGENTS_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  MONAD_RPC_URL_TESTNET: z.string().url().optional(),
  X402_FACILITATOR_URL: z.string().url().default("https://x402-facilitator.molandak.org"),
  /** Where signed receipts are submitted (POST /v1/receipts). */
  MOLTFOREST_API_URL: z
    .string()
    .url()
    .default("https://api.moltforest.ai")
    .transform((s) => s.replace(/\/+$/, "")),
  MOLTFOREST_WEB_URL: z
    .string()
    .url()
    .default("https://www.moltforest.ai")
    .transform((s) => s.replace(/\/+$/, "")),
  EMAIL_VERIFIER_PRIVATE_KEY: privateKey,
  /** Set after `pnpm register`; receipts are off until then. */
  EMAIL_VERIFIER_AGENT_ID: agentId.optional(),
  EMAIL_VERIFIER_PRICE_USDC: usdcAmount.default(parseUnits("0.01", 6)),
  EMAIL_VERIFIER_DNS_TIMEOUT_MS: z.coerce.number().int().min(250).max(30_000).default(3_000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type DemoAgentsConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DemoAgentsConfig {
  // Treat empty values (`KEY=` in .env) as unset, so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    // Never echo values: one of them is a private key.
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid demo-agents configuration:\n${issues}`);
  }
  return parsed.data;
}
