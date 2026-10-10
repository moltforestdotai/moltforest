/** One agent row committed under scoresRoot (matches ScoreRegistry.Score). */
export interface AgentScore {
  agentId: bigint;
  scoreBps: number; // 0..10_000
  confidenceBps: number; // 0..10_000
  paidReviews: number;
  independentClusters: number;
  totalPaidVolume: bigint;
}

/** Inputs available from the reviews worker summary (Floor 2). */
export interface ScoreInputs {
  agentId: string | bigint;
  /** Counted reviews attached to a checked payment. */
  verifiedReviews: number;
  /** Distinct counted reviewer wallets after cluster dedup. */
  countedReviewers: number;
  /** Optional USDC base units summed from verified payment links. */
  totalPaidVolume?: bigint | string | number;
}
