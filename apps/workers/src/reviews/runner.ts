import type { Logger } from "pino";
import type { HyperSync } from "../payments/hypersync.js";
import { assessReviews, DEFAULT_ASSESS_OPTIONS, type AssessOptions } from "./assess.js";
import { lookupFunding } from "./funding.js";
import type { ReviewRepository } from "./repository.js";

export interface ReviewsOptions extends Partial<AssessOptions> {
  chainId: number;
  /** Wallets per HyperSync lookup. */
  chunkSize?: number;
  /** Pending wallets looked up per tick. */
  fundingBatch?: number;
}

export interface ReviewsStats {
  newReviewers: number;
  fundingLookedUp: number;
  agentsAssessed: number;
  agentsChanged: number;
  hubs: number;
}

/**
 * One pass for one chain (decision D31): add new reviewer wallets, look up the
 * funding of pending ones, then reassess every agent's reviews and rewrite the
 * agents whose labels changed. Reviews of wallets still pending count for now.
 */
export async function runReviewsTick(deps: { repo: ReviewRepository; hs: HyperSync; logger?: Logger }, opts: ReviewsOptions): Promise<ReviewsStats> {
  const { repo, hs } = deps;
  const stats: ReviewsStats = { newReviewers: await repo.syncReviewers(opts.chainId), fundingLookedUp: 0, agentsAssessed: 0, agentsChanged: 0, hubs: 0 };

  const pending = await repo.pendingWallets(opts.chainId, opts.fundingBatch ?? 5000);
  if (pending.length > 0) {
    const head = await hs.height(opts.chainId);
    const chunkSize = opts.chunkSize ?? 500;
    for (let i = 0; i < pending.length; i += chunkSize) {
      const chunk = pending.slice(i, i + chunkSize);
      const results = await lookupFunding(hs, opts.chainId, chunk, head);
      await repo.saveFunding(opts.chainId, results, head);
      stats.fundingLookedUp += chunk.length;
      deps.logger?.info({ chainId: opts.chainId, wallets: chunk.length, found: results.filter((r) => r.status === "found").length }, "reviewer funding chunk done");
    }
  }

  const reviews = await repo.reviews(opts.chainId);
  const agentIds = [...new Set(reviews.map((r) => r.agentId))];
  const [agents, funding, hashes] = await Promise.all([
    repo.agentAddresses(opts.chainId, agentIds),
    repo.funding(opts.chainId),
    repo.assessmentHashes(opts.chainId),
  ]);
  const { labels, summaries, hubs } = assessReviews(reviews, agents, funding, { ...DEFAULT_ASSESS_OPTIONS, ...opts });
  stats.hubs = hubs.size;
  stats.agentsAssessed = summaries.length;

  const labelsByAgent = new Map<string, typeof labels>();
  for (const l of labels) {
    let list = labelsByAgent.get(l.agentId);
    if (!list) labelsByAgent.set(l.agentId, (list = []));
    list.push(l);
  }
  for (const s of summaries) {
    if (hashes.get(s.agentId) === s.assessmentHash) continue;
    await repo.saveAssessment(opts.chainId, s, labelsByAgent.get(s.agentId) ?? []);
    stats.agentsChanged++;
  }
  await repo.removeStale(opts.chainId, agentIds);
  return stats;
}
