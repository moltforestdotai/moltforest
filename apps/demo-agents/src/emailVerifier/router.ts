/**
 * The email-verifier demo agent: one paid endpoint and a free info page.
 *
 *   GET  /demo/email-verifier          what it sells, its price, how to pay (free)
 *   POST /demo/email-verifier/verify   { email, clientAgentId? } → checks + receipt (x402, 0.01 test USDC)
 *
 * Emails are personal data: they are never stored or logged. The receipt holds
 * salted hashes only (see commitments.ts).
 */
import express, { Router } from "express";
import { z } from "zod";
import type { Address, Hex } from "viem";
import type { x402HTTPResourceServer } from "@x402/core/server";
import { NETWORKS } from "@moltforest/chain";
import { COMMITMENT_SCHEME, commit, newSalt } from "../commitments.js";
import { HttpError } from "../http.js";
import { payerOf, requestContext, sendInstructions, TESTNET_CAIP2 } from "../paywall.js";
import { isAgentAddress, type AgentDirectory, type IssuedReceipt, type ReceiptIssuer } from "../receipts.js";
import type { EmailCheckResult } from "./checks.js";

export const EMAIL_VERIFIER_PATH = "/demo/email-verifier";
export const EMAIL_VERIFIER_SERVICE = "moltforest-email-verifier/v1";
export const EMAIL_VERIFIER_NAME = "MoltForest Email Verifier";

export const VerifyBody = z
  .object({
    email: z.string().max(320),
    /** The paying agent's ERC-8004 id on Monad testnet. Needed for a receipt; the payer must be its owner or agent wallet. */
    clientAgentId: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,77})$/, "must be a decimal agent id")
      .optional(),
  })
  .strict();

export interface EmailVerifierDeps {
  paywall: x402HTTPResourceServer;
  /** False until the paywall has synced with the facilitator. */
  paymentsReady: () => boolean;
  check: (email: string) => Promise<EmailCheckResult>;
  /** null until the agent is registered and its signer verified; then jobs get no receipt. */
  receipts: () => ReceiptIssuer | null;
  directory: AgentDirectory;
  payTo: Address;
  priceAtomic: bigint;
  publicUrl: string;
  /** MoltForest API, where receipts are submitted and co-signed. */
  apiUrl: string;
  webUrl: string;
  facilitatorUrl: string;
  now?: () => number;
}

const formatUsdc = (atomic: bigint) => {
  const s = atomic.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/\.?0+$/, "");
};

export function emailVerifierRouter(deps: EmailVerifierDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const verifyUrl = `${deps.publicUrl}${EMAIL_VERIFIER_PATH}/verify`;

  router.get("/", (_req, res) => {
    const issuer = deps.receipts();
    res.json({
      name: EMAIL_VERIFIER_NAME,
      description:
        "A MoltForest demo agent on Monad testnet. It checks an email address for 0.01 test USDC per check, paid with x402, " +
        "and signs a MoltForest execution receipt for every paid job.",
      agent: issuer
        ? {
            network: "testnet",
            agentId: issuer.providerAgentId.toString(),
            profile: `${deps.webUrl}/agents/testnet/${issuer.providerAgentId}`,
          }
        : null,
      service: {
        method: "POST",
        url: verifyUrl,
        body: { email: "string", clientAgentId: "your ERC-8004 agent id on Monad testnet (optional; needed for a receipt)" },
        price: {
          amount: formatUsdc(deps.priceAtomic),
          currency: "USDC",
          asset: NETWORKS.testnet.usdc,
          network: TESTNET_CAIP2,
          scheme: "exact",
          payTo: deps.payTo,
        },
        payment: "x402 v2: an unpaid call returns 402 with a PAYMENT-REQUIRED header; retry with PAYMENT-SIGNATURE.",
        facilitator: deps.facilitatorUrl,
      },
      checks: ["syntax", "domain accepts mail (MX, or A/AAAA fallback)", "disposable domain", "role address"],
      notChecked: "The mailbox itself is not probed over SMTP.",
      privacy: "Emails are not stored or logged. Receipts carry salted hashes only; the salt is returned to the payer alone.",
      receipts: issuer
        ? "Each paid call with a clientAgentId returns a level-1 receipt, submitted to MoltForest. Co-sign it to raise it to level 2."
        : "Receipts are off until this agent is registered.",
    });
  });

  router.post("/verify", express.json({ limit: "4kb" }), async (req, res) => {
    // Validate before asking for payment, so a malformed call never costs anything.
    const body = VerifyBody.parse(req.body);
    if (!deps.paymentsReady()) {
      throw new HttpError(503, "payments_unavailable", "The x402 facilitator is not reachable yet. Retry in a minute.");
    }

    const ctx = requestContext(req);
    const processed = await deps.paywall.processHTTPRequest(ctx);
    if (processed.type === "payment-error") {
      sendInstructions(res, processed.response);
      return;
    }
    if (processed.type !== "payment-verified") throw new Error(`${ctx.method} ${ctx.path} is not configured as a paid route`);
    const { paymentPayload, paymentRequirements, declaredExtensions, cancellationDispatcher } = processed;

    // From here the payment is verified but not settled: failing now charges nothing.
    const refuse = async (err: HttpError): Promise<never> => {
      await cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: err.status }).catch(() => undefined);
      throw err;
    };

    const issuer = deps.receipts();
    const clientAgentId = body.clientAgentId === undefined ? null : BigInt(body.clientAgentId);
    const payer = payerOf(paymentPayload);
    if (clientAgentId !== null && issuer) {
      if (issuer.providerAgentId === clientAgentId) {
        return refuse(new HttpError(422, "self_receipt", "clientAgentId is this agent's own id. Nothing was charged."));
      }
      let addresses;
      try {
        addresses = await deps.directory.addressesOf(clientAgentId);
      } catch {
        return refuse(new HttpError(502, "chain_unavailable", "Could not read the Identity Registry to check clientAgentId. Nothing was charged."));
      }
      if (!addresses) {
        return refuse(new HttpError(422, "unknown_agent", `Agent ${clientAgentId} is not registered on Monad testnet. Nothing was charged.`));
      }
      if (!payer || !isAgentAddress(addresses, payer)) {
        return refuse(
          new HttpError(
            422,
            "payer_not_client_agent",
            `The payment is signed by ${payer ?? "an unknown address"}, which is neither the owner nor the agent wallet of agent ${clientAgentId}. ` +
              "Pay from that agent's address, or leave out clientAgentId. Nothing was charged.",
          ),
        );
      }
    }

    const startedAt = now();
    let result: EmailCheckResult;
    try {
      result = await deps.check(body.email);
    } catch (err) {
      req.log?.error({ err }, "email check failed");
      return refuse(new HttpError(500, "check_failed", "The check failed. Nothing was charged."));
    }
    const completedAt = now();

    const settled = await deps.paywall.processSettlement(paymentPayload, paymentRequirements, declaredExtensions, { request: ctx });
    if (!settled.success) {
      req.log?.warn({ reason: settled.errorReason }, "settlement failed");
      sendInstructions(res, settled.response);
      return;
    }
    for (const [key, value] of Object.entries(settled.headers)) res.setHeader(key, value);
    res.setHeader("cache-control", "private, no-store");

    const salt = newSalt();
    const requestHash = commit(salt, { service: EMAIL_VERIFIER_SERVICE, email: body.email });
    const resultHash = commit(salt, result);
    const transaction = settled.transaction as Hex;

    let receipt: IssuedReceipt | null = null;
    let receiptNote: string | null = null;
    if (!issuer) {
      receiptNote = "No receipt: this agent is not registered yet.";
    } else if (clientAgentId === null) {
      receiptNote = "No receipt: send clientAgentId (your ERC-8004 agent id on Monad testnet) to get one.";
    } else if (!/^0x[0-9a-fA-F]{64}$/.test(transaction)) {
      receiptNote = "No receipt: the facilitator returned no settlement transaction hash.";
    } else {
      receipt = await issuer.issue({ clientAgentId, requestHash, resultHash, paymentRef: transaction, startedAt, completedAt });
      if (!receipt.submitted.ok) req.log?.warn({ receiptHash: receipt.receiptHash, submitted: receipt.submitted }, "receipt submission failed");
    }

    res.json({
      result,
      payment: {
        network: TESTNET_CAIP2,
        transaction,
        payer: settled.payer ?? payer,
        amount: paymentRequirements.amount,
        asset: paymentRequirements.asset,
      },
      commitment: { scheme: COMMITMENT_SCHEME, salt, request: { service: EMAIL_VERIFIER_SERVICE, email: body.email }, requestHash, resultHash },
      receipt,
      ...(receiptNote ? { receiptNote } : {}),
      ...(receipt
        ? {
            coSign:
              "Sign `receipt.receipt` as EIP-712 typed data (domain MoltForestReceipts v1, chainId and verifyingContract as given) " +
              "with your agent's signer, then POST { network, receipt, providerSignature, clientSignature } to " +
              `${deps.apiUrl}/v1/receipts to raise it to level 2.`,
          }
        : {}),
    });
  });

  return router;
}
