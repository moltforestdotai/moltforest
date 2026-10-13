/**
 * x402 quote + paid call — Monad mainnet USDC only (hackathon POC).
 */
import { getAddress, isAddressEqual, type Hex, type LocalAccount } from "viem";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { NETWORKS } from "@moltforest/chain";
import { formatUnits } from "viem";

export const MAINNET_CAIP2 = `eip155:${NETWORKS.mainnet.chainId}` as const;
const MAINNET_USDC = getAddress(NETWORKS.mainnet.usdc);

export function isPayableUsdc(r: Pick<PaymentRequirements, "scheme" | "network" | "asset">): boolean {
  if (r.scheme !== "exact") return false;
  if (r.network !== MAINNET_CAIP2) return false;
  if (!/^0x[0-9a-fA-F]{40}$/.test(r.asset)) return false;
  return isAddressEqual(getAddress(r.asset), MAINNET_USDC);
}

export function formatUsdc(atomic: bigint): string {
  return formatUnits(atomic, 6);
}

export interface ServiceRequest {
  url: string;
  method: "GET" | "POST";
  body?: unknown;
}

function requestInit(req: ServiceRequest): RequestInit {
  return req.method === "GET"
    ? { method: "GET", headers: { accept: "application/json" } }
    : {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(req.body ?? {}),
      };
}

export type QuoteResult =
  | { kind: "no_payment"; status: number; body: unknown }
  | { kind: "http_error"; status: number; body: unknown }
  | {
      kind: "payment_required";
      description: string | null;
      options: Array<{
        scheme: string;
        network: string;
        asset: string;
        amount: string;
        payTo: string;
        usdc: string | null;
        payable: boolean;
      }>;
      payable: PaymentRequirements | null;
    };

export async function requestQuote(req: ServiceRequest): Promise<QuoteResult> {
  const res = await fetch(req.url, requestInit(req));
  if (res.status === 402) {
    // continue below
  } else if (res.status >= 200 && res.status < 300) {
    return { kind: "no_payment", status: res.status, body: await res.json().catch(() => res.text()) };
  } else {
    // 404/5xx are not "free service" — wrong URL or service down
    return { kind: "http_error", status: res.status, body: await res.json().catch(() => res.text()) };
  }
  const header = res.headers.get("payment-required");
  if (!header) {
    await res.body?.cancel();
    throw new Error("402 without PAYMENT-REQUIRED header (need x402 v2)");
  }
  let required: PaymentRequired;
  try {
    required = decodePaymentRequiredHeader(header);
  } catch {
    throw new Error("Could not decode PAYMENT-REQUIRED header");
  }
  await res.body?.cancel();
  const options = (required.accepts ?? []).map((r) => {
    const payable = isPayableUsdc(r);
    return {
      scheme: r.scheme,
      network: r.network,
      asset: r.asset,
      amount: r.amount,
      payTo: r.payTo,
      usdc: payable ? formatUsdc(BigInt(r.amount)) : null,
      payable,
    };
  });
  const payableReq = (required.accepts ?? []).find((r) => isPayableUsdc(r)) ?? null;
  return {
    kind: "payment_required",
    description: required.resource?.description ?? null,
    options,
    payable: payableReq,
  };
}

export interface PaidCall {
  status: number;
  body: unknown;
  settlement: SettleResponse | null;
  paid: PaymentRequirements | null;
  paymentTx: Hex | null;
}

/** Pays at most `limitAtomic` mainnet USDC via x402. */
export async function payAndCall(account: LocalAccount, req: ServiceRequest, limitAtomic: bigint): Promise<PaidCall> {
  const acceptable = (r: PaymentRequirements) => isPayableUsdc(r) && BigInt(r.amount) <= limitAtomic;
  let paid: PaymentRequirements | null = null;

  const client = new x402Client()
    .register(MAINNET_CAIP2, new ExactEvmScheme(account))
    .registerPolicy((_version, reqs) => reqs.filter(acceptable))
    .onBeforePaymentCreation(async ({ selectedRequirements }) =>
      acceptable(selectedRequirements) ? undefined : { abort: true as const, reason: "price above confirmed limit or not mainnet USDC" },
    )
    .onAfterPaymentCreation(async ({ paymentPayload }) => {
      paid = paymentPayload.accepted;
    });
  client.setSpendControls({ maxAmountPerPayment: Number(formatUsdc(limitAtomic)) });

  let res: Response;
  try {
    res = await wrapFetchWithPayment(fetch, client)(req.url, requestInit(req));
  } catch (err) {
    throw new Error(`x402 payment failed: ${err instanceof Error ? err.message : String(err)}`);
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
  const body = await res.json().catch(() => res.text());
  const paymentTx =
    (typeof body === "object" && body && "payment" in body && typeof (body as { payment?: { transaction?: string } }).payment?.transaction === "string"
      ? ((body as { payment: { transaction: string } }).payment.transaction as Hex)
      : null) ??
    (settlement && "transaction" in settlement && typeof settlement.transaction === "string" ? (settlement.transaction as Hex) : null);

  return { status: res.status, body, settlement, paid, paymentTx };
}
