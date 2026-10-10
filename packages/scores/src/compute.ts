import type { AgentScore, ScoreInputs } from "./types.js";

export const ALGO_ID = "moltforest-score-v1";
export const ALGO_HASH_PREIMAGE = `${ALGO_ID}:verified*1500+clusters*2000+volumeCap;confidence=clusters*2500+verified*1000`;

const BPS_CAP = 10_000;
const clampBps = (n: number) => Math.max(0, Math.min(BPS_CAP, Math.trunc(n)));

/**
 * Deterministic integer score from Floor-2 assessment outputs.
 * Pure: same inputs → same AgentScore. No floats.
 *
 * scoreBps   ≈ quality signal from verified paid reviews + independent clusters
 * confidence ≈ how much independent evidence backs the score (new ≠ bad)
 */
export function computeScore(input: ScoreInputs): AgentScore {
  const paidReviews = Math.max(0, Math.trunc(input.verifiedReviews));
  const independentClusters = Math.max(0, Math.trunc(input.countedReviewers));
  const totalPaidVolume = BigInt(input.totalPaidVolume ?? 0);

  // Volume soft-cap in base units (USDC 6 decimals): 100 USDC → +2000 bps max.
  const volumeBonus = Number(totalPaidVolume > 100_000_000n ? 100_000_000n : totalPaidVolume) / 50_000;

  const scoreBps =
    independentClusters === 0 && paidReviews === 0
      ? 0
      : clampBps(2_000 + paidReviews * 1_500 + independentClusters * 2_000 + volumeBonus);

  const confidenceBps = clampBps(independentClusters * 2_500 + paidReviews * 1_000);

  return {
    agentId: typeof input.agentId === "bigint" ? input.agentId : BigInt(input.agentId),
    scoreBps,
    confidenceBps,
    paidReviews,
    independentClusters,
    totalPaidVolume,
  };
}

/** Canonical sort for Merkle leaves: agentId ascending. */
export function sortScores(scores: readonly AgentScore[]): AgentScore[] {
  return [...scores].sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
}
