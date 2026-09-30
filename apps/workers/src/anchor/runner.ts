import type { Logger } from "pino";
import type { AnchorChain } from "./chain.js";
import type { AnchorRepository, DueReceipt } from "./repository.js";

export interface AnchorOptions {
  chainId: number;
  batchSize: number;
  /** New anchors the relayer pays for per provider agent per 24 h (bounds gas spent on one agent's receipts). */
  maxPerAgentPerDay: number;
  /** Below this relayer balance nothing is sent; receipts stay queued. */
  minBalanceWei: bigint;
  txTimeoutMs: number;
  /** A sent transaction still unknown after this long is presumed dropped and the receipt is retried. */
  droppedAfterMs: number;
  maxAttempts: number;
}

export interface AnchorStats {
  selected: number;
  anchored: number;
  alreadyAnchored: number;
  pending: number;
  failed: number;
  skipped: number;
  retried: number;
  lowBalance: boolean;
}

type Outcome = "anchored" | "alreadyAnchored" | "pending" | "failed" | "skipped" | "retried";

/** Contract errors that a retry cannot fix, with a reason a person can act on. */
const PERMANENT: Record<string, string> = {
  InvalidProviderSignature: "the provider signature does not match the provider agent's current signer (agent wallet, or owner if none)",
  InvalidClientSignature: "the client signature does not match the client agent's current signer (agent wallet, or owner if none)",
  UnknownAgent: "an agent in the receipt is not registered in the Identity Registry",
  SelfReceipt: "the client and provider are the same agent",
  InvalidTimestamps: "startedAt is after completedAt",
};

export const retryDelayMs = (attempts: number) => Math.min(30_000 * 2 ** attempts, 30 * 60_000);

/** Anchors due receipts one at a time (a single relayer account keeps nonces simple). */
export async function runAnchorBatch(
  deps: { repo: AnchorRepository; chain: AnchorChain; logger?: Logger; now?: () => Date },
  opts: AnchorOptions,
): Promise<AnchorStats> {
  const now = () => deps.now?.() ?? new Date();
  const due = await deps.repo.selectDue(opts.chainId, opts.batchSize);
  const stats: AnchorStats = { selected: due.length, anchored: 0, alreadyAnchored: 0, pending: 0, failed: 0, skipped: 0, retried: 0, lowBalance: false };
  if (due.length === 0) return stats;

  const balance = await deps.chain.balance();
  if (balance < opts.minBalanceWei) {
    stats.lowBalance = true;
    deps.logger?.warn(
      { relayer: deps.chain.relayer, balanceWei: balance.toString(), waiting: due.length },
      "relayer balance is below RECEIPT_RELAY_MIN_BALANCE_MON; fund it from the faucet. Receipts stay queued.",
    );
    return stats;
  }

  const { repo, chain } = deps;

  const recordOnChainLevel = async (r: DueReceipt, level: number, tx?: { hash: string; blockNumber: bigint; blockTime: Date }) => {
    await repo.markAnchored(r.receiptHash, {
      level,
      txHash: tx?.hash ?? null,
      blockNumber: tx?.blockNumber ?? null,
      anchoredAt: tx?.blockTime ?? now(),
    });
  };

  async function processOne(r: DueReceipt): Promise<Outcome> {
    // 1. A transaction sent earlier (previous batch or before a restart).
    if (r.status === "sending" && r.anchorTx) {
      const earlier = await chain.wait(r.anchorTx, 5_000);
      if (earlier.status === "success") {
        await recordOnChainLevel(r, await chain.levelOf(r.receiptHash), { hash: r.anchorTx, ...earlier });
        return "anchored";
      }
      if (earlier.status === "pending" && now().getTime() - r.updatedAt.getTime() < opts.droppedAfterMs) {
        await repo.retryLater(r.receiptHash, null, 30_000, { countAttempt: false });
        return "pending";
      }
      // Reverted or presumed dropped: decide again from the chain state below.
      // Sending again is safe; a duplicate anchor only reverts with AlreadyAnchored.
    }

    // 2. Already on-chain at this level, by us or by anyone else?
    const onChain = await chain.levelOf(r.receiptHash);
    if (onChain >= r.level) {
      await recordOnChainLevel(r, onChain);
      return "alreadyAnchored";
    }

    // 3. Relay cap for new anchors. Relaying a co-signature is at most once per receipt and always allowed.
    if (onChain === 0 && (await repo.relayedInLastDay(opts.chainId, r.providerAgentId)) >= opts.maxPerAgentPerDay) {
      await repo.markSkipped(
        r.receiptHash,
        `relay cap reached (${opts.maxPerAgentPerDay} anchors per provider agent per day); anchor it with ReceiptRegistry.anchor or resubmit tomorrow`,
      );
      return "skipped";
    }

    // 4. Dry run: never pay gas for a transaction the contract rejects.
    const sim = await chain.simulate(r);
    if (!sim.ok) {
      if (sim.revert === "AlreadyAnchored") {
        await recordOnChainLevel(r, await chain.levelOf(r.receiptHash));
        return "alreadyAnchored";
      }
      await repo.markFailed(r.receiptHash, `ReceiptRegistry rejects this receipt (${sim.revert}): ${PERMANENT[sim.revert] ?? "contract revert"}`);
      return "failed";
    }

    // 5. Send, record the hash, then wait.
    const txHash = await chain.send(r);
    await repo.markSending(r.receiptHash, txHash);
    const outcome = await chain.wait(txHash, opts.txTimeoutMs);
    if (outcome.status === "pending") return "pending";
    if (outcome.status === "success") {
      await recordOnChainLevel(r, await chain.levelOf(r.receiptHash), { hash: txHash, ...outcome });
      return "anchored";
    }
    const after = await chain.levelOf(r.receiptHash);
    if (after >= r.level) {
      await recordOnChainLevel(r, after); // someone else anchored it first
      return "alreadyAnchored";
    }
    await repo.retryLater(r.receiptHash, `transaction ${txHash} reverted`, retryDelayMs(r.attempts), { countAttempt: false, requeue: true });
    return "retried";
  }

  for (const r of due) {
    try {
      stats[await processOne(r)]++;
    } catch (err) {
      const message = err instanceof Error ? (err.message.split("\n")[0] ?? "error").slice(0, 300) : "error";
      if (r.attempts + 1 >= opts.maxAttempts) {
        await repo.markFailed(r.receiptHash, `gave up after ${r.attempts + 1} attempts: ${message}`);
        stats.failed++;
      } else {
        await repo.retryLater(r.receiptHash, message, retryDelayMs(r.attempts), { countAttempt: true });
        stats.retried++;
      }
      deps.logger?.warn({ err, receiptHash: r.receiptHash }, "anchor attempt failed");
    }
  }
  return stats;
}
