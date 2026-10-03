import express, { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { Hex } from "viem";
import { NETWORK_NAMES, NETWORKS } from "@moltforest/chain";
import { hashReceipt, receiptDomain, receiptJsonSchema, receiptToJson, signatureSchema, type Receipt } from "@moltforest/receipts";
import type { AgentReceiptsResponse, ReceiptSubmitResponse, ReceiptView } from "@moltforest/types";
import { AgentParams } from "./agents.js";
import { toReceiptView, type ReceiptCursor, type ReceiptRepository, type ReceiptRow } from "../repositories/receipts.js";
import type { ReceiptNetwork, ReceiptNetworks } from "../services/receiptNetworks.js";
import { isMissingRelation } from "../repositories/sync.js";
import type { PaymentRepository } from "../repositories/payments.js";
import { HttpError } from "../lib/errors.js";

export const SubmitReceiptBody = z
  .object({
    network: z.enum(NETWORK_NAMES),
    receipt: receiptJsonSchema,
    providerSignature: signatureSchema,
    clientSignature: signatureSchema.nullish(),
  })
  .strict();

const ReceiptHashParams = z.object({
  receiptHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "receiptHash must be 0x followed by 64 hex characters")
    .transform((s) => s.toLowerCase()),
});

const AgentReceiptsQuery = z.object({
  role: z.enum(["provider", "client", "any"]).default("any"),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  cursor: z.string().max(512).optional(),
});

export interface ReceiptRouterOptions {
  /** How far in the future `completedAt` may be (clock skew between agents). */
  maxFutureSeconds: number;
  /** Rate limiter for submissions (writes cost verification RPC calls and relayer gas). */
  submitLimiter?: RequestHandler;
  /** Links each receipt to the indexed x402 payment its paymentRef names. */
  payments?: Pick<PaymentRepository, "firstByTransactions">;
}

const ZERO_REF = `0x${"0".repeat(64)}`;

const tableMissing = () =>
  new HttpError(503, "receipts_not_ready", "The receipt table is missing. Apply migrations (`pnpm db:migrate`).");

function encodeReceiptCursor(c: ReceiptCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeReceiptCursor(raw: string): ReceiptCursor {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<ReceiptCursor>;
    if (
      typeof c.submittedAt === "string" &&
      !Number.isNaN(Date.parse(c.submittedAt)) &&
      typeof c.receiptHash === "string" &&
      /^0x[0-9a-f]{64}$/.test(c.receiptHash)
    ) {
      return { submittedAt: c.submittedAt, receiptHash: c.receiptHash };
    }
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "invalid_cursor", "cursor is malformed");
}

/** Verifies one agent's signature; maps outcomes to API errors. */
async function verifyAgent(net: ReceiptNetwork, role: "provider" | "client", agentId: bigint, digest: Hex, signature: Hex) {
  let result;
  try {
    result = await net.verifier.verify(agentId, digest, signature);
  } catch {
    throw new HttpError(502, "chain_unavailable", `Could not read the ${net.network} Identity Registry to verify the ${role} signature. Retry later.`);
  }
  if (!result.ok && result.reason === "unknown_agent") {
    throw new HttpError(422, "unknown_agent", `The ${role} agent ${agentId} is not registered on ${net.network}.`);
  }
  if (!result.ok) {
    throw new HttpError(
      422,
      "invalid_signature",
      `${role}Signature is not a valid EIP-712 signature of this receipt by agent ${agentId}'s signer ${result.signer.toLowerCase()} ` +
        `(its agent wallet, or its owner when no wallet is set).`,
    );
  }
  return result.signer.toLowerCase();
}

export function receiptsRouter(repo: ReceiptRepository, networks: ReceiptNetworks, opts: ReceiptRouterOptions): Router {
  const router = Router();
  const view = (row: ReceiptRow): ReceiptView => toReceiptView(row);

  /** Fills `payment` from the payment index, one query per chain. */
  async function withPayments<T extends ReceiptView>(views: T[]): Promise<T[]> {
    if (!opts.payments) return views;
    const byChain = new Map<number, string[]>();
    for (const v of views) {
      if (v.receipt.paymentRef !== ZERO_REF) byChain.set(v.chainId, [...(byChain.get(v.chainId) ?? []), v.receipt.paymentRef]);
    }
    for (const [chainId, refs] of byChain) {
      const found = await opts.payments.firstByTransactions(chainId, [...new Set(refs)]);
      for (const v of views) if (v.chainId === chainId) v.payment = found.get(v.receipt.paymentRef) ?? null;
    }
    return views;
  }

  router.post("/receipts", ...(opts.submitLimiter ? [opts.submitLimiter] : []), express.json({ limit: "48kb" }), async (req, res) => {
    const body = SubmitReceiptBody.parse(req.body);
    const net = networks[body.network];
    if (!net) {
      throw new HttpError(503, "receipts_not_enabled", `Receipts are not enabled on ${body.network}: no ReceiptRegistry is deployed there.`);
    }
    const receipt: Receipt = body.receipt;
    if (Number(receipt.completedAt) > Math.floor(Date.now() / 1000) + opts.maxFutureSeconds) {
      throw new HttpError(422, "invalid_receipt", "completedAt is in the future.");
    }
    const digest = hashReceipt(receipt, receiptDomain(net.chainId, net.registry));
    const clientSignature = body.clientSignature ?? null;

    try {
      const existing = await repo.get(digest);
      if (existing) {
        // Idempotent: a stored receipt is returned as is, unless this call adds the client's co-signature.
        if (existing.level === 2 || !clientSignature) {
          const [v] = await withPayments([view(existing)]);
          res.status(200).json({ ...v!, duplicate: true } satisfies ReceiptSubmitResponse);
          return;
        }
        const clientSigner = await verifyAgent(net, "client", receipt.clientAgentId, digest, clientSignature);
        const raised = (await repo.addClientSignature(digest, clientSignature, clientSigner)) ?? (await repo.get(digest));
        const [v] = await withPayments([view(raised!)]);
        res.status(200).json({ ...v!, duplicate: false } satisfies ReceiptSubmitResponse);
        return;
      }

      const providerSigner = await verifyAgent(net, "provider", receipt.providerAgentId, digest, body.providerSignature);
      const clientSigner = clientSignature ? await verifyAgent(net, "client", receipt.clientAgentId, digest, clientSignature) : null;
      const json = receiptToJson(receipt);
      const inserted = await repo.insert({
        receipt_hash: digest,
        chain_id: net.chainId,
        registry: net.registry,
        task_id: json.taskId,
        client_agent_id: json.clientAgentId,
        provider_agent_id: json.providerAgentId,
        request_hash: json.requestHash,
        result_hash: json.resultHash,
        payment_ref: json.paymentRef,
        started_at: String(json.startedAt),
        completed_at: String(json.completedAt),
        proof_type: json.proofType,
        proof_ref: json.proofRef,
        level: clientSignature ? 2 : 1,
        provider_signature: body.providerSignature,
        client_signature: clientSignature,
        provider_signer: providerSigner,
        client_signer: clientSigner,
      });
      const stored = await repo.get(digest);
      const [v] = await withPayments([view(stored!)]);
      res.status(inserted ? 202 : 200).json({ ...v!, duplicate: !inserted } satisfies ReceiptSubmitResponse);
    } catch (err) {
      throw isMissingRelation(err) ? tableMissing() : err;
    }
  });

  router.get("/receipts/:receiptHash", async (req, res) => {
    const { receiptHash } = ReceiptHashParams.parse(req.params);
    try {
      const row = await repo.get(receiptHash);
      if (!row) throw new HttpError(404, "receipt_not_found", `No receipt ${receiptHash} has been submitted to MoltForest.`);
      const [v] = await withPayments([view(row)]);
      res.json(v);
    } catch (err) {
      throw isMissingRelation(err) ? tableMissing() : err;
    }
  });

  router.get("/agents/:network/:agentId/receipts", async (req, res) => {
    const { network, agentId } = AgentParams.parse(req.params);
    const q = AgentReceiptsQuery.parse(req.query);
    const cursor = q.cursor ? decodeReceiptCursor(q.cursor) : undefined;
    try {
      const page = await repo.listForAgent({ chainId: NETWORKS[network].chainId, agentId, role: q.role, limit: q.limit, cursor });
      const body: AgentReceiptsResponse = {
        network,
        agentId,
        role: q.role,
        items: await withPayments(page.rows.map(view)),
        nextCursor: page.nextCursor ? encodeReceiptCursor(page.nextCursor) : null,
      };
      res.json(body);
    } catch (err) {
      throw isMissingRelation(err) ? tableMissing() : err;
    }
  });

  return router;
}
