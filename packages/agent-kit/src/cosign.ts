/**
 * Receipts from providers: recognising one in a response, and checking it before
 * co-signing. A co-signature (level 2) is this agent saying "yes, this job
 * happened as described", so it is only given when the kit can confirm it.
 */
import { getAddress, isAddressEqual, type Hex, type PublicClient } from "viem";
import {
  canonicalJson,
  commit,
  COMMITMENT_SCHEME,
  hashReceipt,
  receiptDomain,
  receiptJsonSchema,
  recoverReceiptSigner,
  signatureSchema,
  type Receipt,
  type ReceiptJson,
} from "@moltforest/receipts";
import { RECEIPT_REGISTRY, receiptSignerOf, TESTNET, transactionSucceeded } from "./chain.js";
import type { JobRecord } from "./store.js";

export interface ProviderReceipt {
  receipt: ReceiptJson;
  parsed: Receipt;
  providerSignature: Hex;
  /** Recomputed here; never taken from the provider. */
  receiptHash: Hex;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Finds a MoltForest receipt in a provider's response:
 * `{ receipt: { receipt, providerSignature, chainId, registry } }`. Receipts for
 * another chain or registry are ignored.
 */
export function extractReceipt(body: unknown): ProviderReceipt | null {
  if (!isRecord(body) || !isRecord(body.receipt)) return null;
  const r = body.receipt;
  if (r.chainId !== TESTNET.chainId || typeof r.registry !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(r.registry)) return null;
  if (!isAddressEqual(getAddress(r.registry), RECEIPT_REGISTRY)) return null;
  const parsed = receiptJsonSchema.safeParse(r.receipt);
  const signature = signatureSchema.safeParse(r.providerSignature);
  if (!parsed.success || !signature.success) return null;
  return {
    receipt: r.receipt as ReceiptJson,
    parsed: parsed.data,
    providerSignature: signature.data,
    receiptHash: hashReceipt(parsed.data, receiptDomain(TESTNET.chainId, RECEIPT_REGISTRY)),
  };
}

export interface Check {
  check: string;
  ok: boolean;
  detail: string;
  /** Commitment checks can be waived with `acceptUnverified`; the others cannot. */
  waivable: boolean;
}

export interface CheckContext {
  myAgentId: bigint;
  publicClient: PublicClient;
  now?: () => number;
}

/** Every key the provider says it committed to (except `service`) must equal what this agent sent. */
function requestMatches(committed: Record<string, unknown>, sent: unknown): boolean {
  if (!isRecord(sent)) return false;
  return Object.entries(committed).every(([k, v]) => k === "service" || canonicalJson(v) === canonicalJson(sent[k]));
}

export async function checkJob(job: JobRecord, ctx: CheckContext): Promise<Check[]> {
  const parsed = receiptJsonSchema.parse(job.receipt);
  const domain = receiptDomain(TESTNET.chainId, RECEIPT_REGISTRY);
  const checks: Check[] = [];
  const add = (check: string, ok: boolean, detail: string, waivable = false) => checks.push({ check, ok, detail, waivable });

  add(
    "client agent",
    parsed.clientAgentId === ctx.myAgentId,
    `the receipt names agent ${parsed.clientAgentId} as the client; this wallet's agent is ${ctx.myAgentId}`,
  );

  const paymentOnChain = await transactionSucceeded(ctx.publicClient, job.paymentTx);
  add(
    "payment",
    parsed.paymentRef.toLowerCase() === job.paymentTx.toLowerCase() && paymentOnChain === true,
    `paymentRef ${parsed.paymentRef}; this agent paid in ${job.paymentTx}, which ${
      paymentOnChain === true ? "succeeded" : paymentOnChain === false ? "reverted" : "was not found"
    } on Monad testnet`,
  );

  try {
    const [expected, actual] = await Promise.all([
      receiptSignerOf(ctx.publicClient, parsed.providerAgentId),
      recoverReceiptSigner(parsed, domain, job.providerSignature),
    ]);
    add(
      "provider signature",
      isAddressEqual(expected, actual),
      `signed by ${actual}; agent ${parsed.providerAgentId}'s receipt signer is ${expected}`,
    );
  } catch (err) {
    add("provider signature", false, `could not check: ${err instanceof Error ? err.message : String(err)}`);
  }

  const now = Math.floor((ctx.now?.() ?? Date.now()) / 1000);
  add(
    "timestamps",
    parsed.startedAt <= parsed.completedAt && Number(parsed.completedAt) <= now + 300,
    `started ${parsed.startedAt}, completed ${parsed.completedAt}`,
  );

  const response = isRecord(job.response) ? job.response : {};
  const c = isRecord(response.commitment) ? response.commitment : null;
  if (!c || c.scheme !== COMMITMENT_SCHEME || typeof c.salt !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(c.salt) || !isRecord(c.request)) {
    const why = "the provider did not return MoltForest salted commitments, so the hashes cannot be recomputed";
    add("request hash", false, why, true);
    add("result hash", false, why, true);
  } else {
    const salt = c.salt as Hex;
    add(
      "request hash",
      commit(salt, c.request) === parsed.requestHash && requestMatches(c.request, job.request),
      "requestHash commits to the request this agent sent",
      true,
    );
    add("result hash", commit(salt, response.result) === parsed.resultHash, "resultHash commits to the result this agent received", true);
  }
  return checks;
}

/** True when every check passed, or failed only where `acceptUnverified` waives it. */
export function checksAllow(checks: Check[], acceptUnverified: boolean): boolean {
  return checks.every((c) => c.ok || (acceptUnverified && c.waivable));
}
