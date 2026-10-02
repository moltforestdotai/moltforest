import { homedir } from "node:os";
import { join } from "node:path";
import { parseUnits } from "viem";
import { z } from "zod";

/** A USDC amount such as "0.10" (6 decimals), kept as atomic units. */
const usdcAmount = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,6})?$/, "must be a USDC amount with at most 6 decimals")
  .transform((s) => parseUnits(s, 6))
  .refine((v) => v > 0n, "must be more than zero");

const origin = (fallback: string) =>
  z
    .string()
    .url()
    .default(fallback)
    .transform((s) => s.replace(/\/+$/, ""));

const EnvSchema = z.object({
  /** Folder holding the wallet key and the payment ledger. */
  MOLTFOREST_KIT_HOME: z.string().default(join(homedir(), ".moltforest", "agent-kit")),
  MOLTFOREST_API_URL: origin("https://api.moltforest.ai"),
  MOLTFOREST_WEB_URL: origin("https://www.moltforest.ai"),
  MONAD_RPC_URL_TESTNET: z.string().url().optional(),
  /** Spend caps: the owner chose 0.10 USDC per payment and 1 USDC per day (2026-10-01). */
  MOLTFOREST_KIT_MAX_PER_PAYMENT_USDC: usdcAmount.default(parseUnits("0.10", 6)),
  MOLTFOREST_KIT_MAX_PER_DAY_USDC: usdcAmount.default(parseUnits("1", 6)),
  /** Allow http:// and private-network service URLs (local testing only). */
  MOLTFOREST_KIT_ALLOW_LOCAL: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
});

export type KitConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KitConfig {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid agent-kit configuration:\n${issues}`);
  }
  if (parsed.data.MOLTFOREST_KIT_MAX_PER_PAYMENT_USDC > parsed.data.MOLTFOREST_KIT_MAX_PER_DAY_USDC) {
    throw new Error("Invalid agent-kit configuration: the per-payment cap is above the daily cap.");
  }
  return parsed.data;
}
