import { Router } from "express";
import { z } from "zod";
import { DEFAULT_NETWORK, NETWORK_NAMES, NETWORKS, type NetworkName } from "@moltforest/chain";
import type { Metric, NetworkStats, Provenance } from "@moltforest/types";
import type { NetworkCounts, StatsRepository } from "../repositories/stats.js";

/** The homepage asks on every visit and the counts move slowly, so one read serves a minute. */
export const STATS_TTL_MS = 60_000;

const StatsQuery = z.object({ network: z.enum(NETWORK_NAMES).default(DEFAULT_NETWORK) });

const metric = (value: number | null | undefined, provenance: Provenance): Metric =>
  value === null || value === undefined ? { value: null, status: "not_measured", provenance } : { value, status: "measured", provenance };
const notes = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" ");

const REVIEW_CHECKS =
  "A review is not counted when it is a self-review, comes from a wallet the agent's owner funded, repeats the same wallet within 30 days, " +
  "or comes from a wallet sharing a funder with another reviewer. Each agent page lists every review with its reason.";

/** Pure: raw counts in, counts with their provenance out (C2). No score of anything (C1). */
export function buildNetworkStats(network: NetworkName, c: NetworkCounts, now: Date): NetworkStats {
  const n = NETWORKS[network];
  const indexed = c.progress ? { blockRange: { from: c.progress.startBlock, to: c.progress.progressBlock } } : {};
  const reputation = { address: n.reputationRegistry, events: ["NewFeedback", "FeedbackRevoked"] };
  // Without a scan cursor the network's payments were never scanned: that is "not measured", not zero.
  const nextPaymentBlock = c.payments?.nextBlock ? BigInt(c.payments.nextBlock) : null;
  const paymentNote = !c.payments
    ? undefined
    : nextPaymentBlock === null
      ? "Payments on this network are not indexed yet."
      : c.payments.pendingAddresses > 0
        ? "Some agent addresses are still being backfilled, so this number can still grow."
        : undefined;
  const receiptSource: Provenance = n.receiptRegistry
    ? { api: `/v1/receipts?network=${network}`, contract: { address: n.receiptRegistry.address, events: ["ReceiptAnchored", "ReceiptCoSigned"] }, window: "all time" }
    : { api: `/v1/receipts?network=${network}`, window: "all time", note: "Receipts are recorded on Monad testnet only for now." };
  const stillChecking = c.assessed && c.assessed.pendingReviewers > 0 ? "Some reviewer wallets are still being checked, so this number can still drop." : undefined;

  return {
    network,
    chainId: n.chainId,
    generatedAt: now.toISOString(),
    agents: {
      indexed: metric(c.agents, {
        api: `/v1/agents?network=${network}&includeIncomplete=true`,
        contract: { address: n.identityRegistry, events: ["Registered"] },
        window: "all time",
        ...indexed,
        note: "Every agent in the ERC-8004 Identity Registry, including ones without a usable registration file.",
      }),
    },
    reviews: {
      total: metric(c.reviews, { contract: reputation, window: "all time", ...indexed, note: "Non-revoked reviews in the ERC-8004 Reputation Registry." }),
      counted: metric(c.assessed?.counted, { contract: reputation, window: "all time", note: notes(REVIEW_CHECKS, stillChecking) }),
      verified: metric(c.assessed?.verified, {
        contract: reputation,
        window: "all time",
        note: "Counted reviews attached to an x402 payment from the reviewer to the agent, through an execution receipt or the review's proofOfPayment.",
      }),
    },
    payments: {
      x402: metric(nextPaymentBlock === null ? null : c.payments?.x402, {
        contract: { address: n.usdc, events: ["AuthorizationUsed", "Transfer"] },
        window: "all time",
        ...(nextPaymentBlock !== null && nextPaymentBlock > 0n ? { blockRange: { from: "0", to: (nextPaymentBlock - 1n).toString() } } : {}),
        note: notes(
          "USDC transferWithAuthorization settlements where an agent's owner or agent wallet is the payer or the payee. Each agent's own list is at /v1/agents/:network/:id/payments.",
          paymentNote,
        ),
      }),
    },
    receipts: {
      total: metric(c.receipts?.total, receiptSource),
      coSigned: metric(c.receipts?.coSigned, { ...receiptSource, note: notes(receiptSource.note, "Level 2: signed by the provider and co-signed by the client.") }),
      anchored: metric(c.receipts?.anchored, { ...receiptSource, note: notes(receiptSource.note, "Recorded on the ReceiptRegistry contract.") }),
    },
  };
}

/** GET /v1/stats?network=: network-wide counts, each with its source. */
export function statsRouter(repo: Pick<StatsRepository, "counts">, clock: () => Date = () => new Date()): Router {
  const router = Router();
  const cache = new Map<NetworkName, { expires: number; body: Promise<NetworkStats> }>();

  router.get("/stats", async (req, res) => {
    const { network } = StatsQuery.parse(req.query);
    const now = clock();
    let entry = cache.get(network);
    if (!entry || entry.expires <= now.getTime()) {
      // Concurrent requests share one read; a failed read is dropped so the next request tries again.
      const fresh = { expires: now.getTime() + STATS_TTL_MS, body: repo.counts(network).then((c) => buildNetworkStats(network, c, now)) };
      cache.set(network, fresh);
      fresh.body.catch(() => {
        if (cache.get(network) === fresh) cache.delete(network);
      });
      entry = fresh;
    }
    res.json(await entry.body);
  });

  return router;
}
