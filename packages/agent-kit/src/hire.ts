/**
 * Hiring an agent over x402: a quote (the unpaid call and its 402), then the
 * paid call. Only the "exact" scheme with USDC on Monad testnet is accepted,
 * and never above the price the user confirmed.
 */
import { getAddress, isAddressEqual, type Hex, type LocalAccount } from "viem";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { formatUsdc, TESTNET_CAIP2, USDC } from "./chain.js";
import { KitError, readBody } from "./net.js";

export interface ServiceRequest {
  url: string;
  method: "GET" | "POST";
  /** JSON body for POST. */
  body?: unknown;
}

function requestInit(req: ServiceRequest): RequestInit {
  return req.method === "GET"
    ? { method: "GET", headers: { accept: "application/json" } }
    : { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(req.body ?? {}) };
}

export interface PriceOption {
  scheme: string;
  network: string;
  asset: string;
  /** Atomic units of `asset`. */
  amount: string;
  payTo: string;
  /** Decimal USDC, when the asset is testnet USDC. */
  usdc: string | null;
  /** Whether this kit can pay it ("exact", USDC, Monad testnet). */
  payable: boolean;
}

export type QuoteResult =
  | { kind: "no_payment"; status: number; body: unknown }
  | { kind: "payment_required"; resource: PaymentRequired["resource"] | null; description: string | null; options: PriceOption[]; payable: PriceOption | null };

export function isPayable(r: Pick<PaymentRequirements, "scheme" | "network" | "asset">): boolean {
  return r.scheme === "exact" && r.network === TESTNET_CAIP2 && /^0x[0-9a-fA-F]{40}$/.test(r.asset) && isAddressEqual(getAddress(r.asset), USDC);
}

function toOption(r: PaymentRequirements): PriceOption {
  const payable = isPayable(r);
  return { scheme: r.scheme, network: r.network, asset: r.asset, amount: r.amount, payTo: r.payTo, usdc: payable ? formatUsdc(BigInt(r.amount)) : null, payable };
}

/** Calls the service without paying. A 402 becomes a quote; anything else is returned as is. */
export async function requestQuote(fetchImpl: typeof fetch, req: ServiceRequest): Promise<QuoteResult> {
  const res = await fetchImpl(req.url, requestInit(req));
  if (res.status !== 402) return { kind: "no_payment", status: res.status, body: await readBody(res) };

  const header = res.headers.get("payment-required");
  if (!header) {
    await res.body?.cancel();
    throw new KitError("The service answered 402 without an x402 v2 PAYMENT-REQUIRED header. Only x402 v2 is supported.");
  }
  let required: PaymentRequired;
  try {
    required = decodePaymentRequiredHeader(header);
  } catch {
    throw new KitError("The service's PAYMENT-REQUIRED header could not be decoded.");
  }
  await res.body?.cancel();
  const options = (required.accepts ?? []).map(toOption);
  return {
    kind: "payment_required",
    resource: required.resource ?? null,
    description: required.resource?.description ?? null,
    options,
    payable: options.find((o) => o.payable) ?? null,
  };
}

export interface PaidCall {
  status: number;
  body: unknown;
  /** Decoded PAYMENT-RESPONSE header, when the service sent one. */
  settlement: SettleResponse | null;
  /** The requirement this kit signed a payment for; null when it signed none. */
  paid: PaymentRequirements | null;
}

/** Calls the service and pays at most `limit` atomic USDC through x402. */
export async function payAndCall(account: LocalAccount, fetchImpl: typeof fetch, req: ServiceRequest, limit: bigint): Promise<PaidCall> {
  const acceptable = (r: PaymentRequirements) => isPayable(r) && BigInt(r.amount) <= limit;
  let paid: PaymentRequirements | null = null;

  const client = new x402Client()
    .register(TESTNET_CAIP2, new ExactEvmScheme(account))
    .registerPolicy((_version, reqs) => reqs.filter(acceptable))
    .onBeforePaymentCreation(async ({ selectedRequirements }) =>
      acceptable(selectedRequirements) ? undefined : { abort: true as const, reason: "price above the confirmed limit" },
    )
    .onAfterPaymentCreation(async ({ paymentPayload }) => {
      paid = paymentPayload.accepted;
    });
  client.setSpendControls({ maxAmountPerPayment: Number(formatUsdc(limit)) });

  let res: Response;
  try {
    res = await wrapFetchWithPayment(fetchImpl, client)(req.url, requestInit(req));
  } catch (err) {
    if (err instanceof KitError) throw err;
    throw new KitError(`Payment was not made: ${err instanceof Error ? err.message : String(err)}`);
  }
  const header = res.headers.get("payment-response");
  let settlement: SettleResponse | null = null;
  if (header) {
    try {
      settlement = decodePaymentResponseHeader(header);
    } catch {
      settlement = null;
    }
  }
  return { status: res.status, body: await readBody(res), settlement, paid };
}

/** A settled payment's transaction hash, or null. */
export function settledTransaction(call: PaidCall): Hex | null {
  const tx = call.settlement?.success ? call.settlement.transaction : null;
  return tx && /^0x[0-9a-fA-F]{64}$/.test(tx) ? (tx.toLowerCase() as Hex) : null;
}
