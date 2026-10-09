import type { Logger } from "pino";
import type { HyperSync } from "../payments/hypersync.js";
import { assessReviews, DEFAULT_ASSESS_OPTIONS, type AssessOptions } from "./assess.js";
import { readFeedbackFile } from "./feedbackFiles.js";
import { lookupFunding } from "./funding.js";
import type { FetchOptions } from "../net/fetchDocument.js";
import type { ReviewRepository } from "./repository.js";

export interface ReviewsOptions extends Partial<AssessOptions> {
  chainId: number;
  /** Wallets per HyperSync lookup. */
  chunkSize?: number;
  /** Pending wallets looked up per tick. */
  fundingBatch?: number;
  /** Feedback files read per tick, and how. */
  files?: { batch: number; concurrency: number; fetch: Omit<FetchOptions, "maxRedirects">; ipfsGateways: string[] };
}

export interface ReviewsStats {
  newReviewers: number;
  fundingLookedUp: number;
  agentsAssessed: number;
  agentsChanged: number;
  hubs: number;
  filesRead: number;
  verifiedReviews: number;
  /** Wallets whose funding cluster changed since the last pass. */
  clustersWritten: number;
  /** Nansen links taken into account (decision D47). */
  nansenLinks: number;
}

/**
 * One pass for one chain (decision D31): add new reviewer wallets, look up the
 * funding of pending ones, then reassess every agent's reviews and rewrite the
 * agents whose labels changed. Reviews of wallets still pending count for now.
 */
export async function runReviewsTick(deps: { repo: ReviewRepository; hs: HyperSync; logger?: Logger }, opts: ReviewsOptions): Promise<ReviewsStats> {
  const { repo, hs } = deps;
  const stats: ReviewsStats = {
    newReviewers: await repo.syncReviewers(opts.chainId),
    fundingLookedUp: 0,
    agentsAssessed: 0,
    agentsChanged: 0,
    hubs: 0,
    filesRead: 0,
    verifiedReviews: 0,
    clustersWritten: 0,
    nansenLinks: 0,
  };

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

  // Feedback files: queue new ones, read the due ones a few at a time.
  if (opts.files) {
    await repo.syncFeedbackFiles(opts.chainId);
    const due = await repo.dueFeedbackFiles(opts.chainId, opts.files.batch);
    const files = opts.files;
    for (let i = 0; i < due.length; i += files.concurrency) {
      await Promise.all(
        due.slice(i, i + files.concurrency).map(async (f) => {
          const result = await readFeedbackFile(f.uri, f.feedbackHash, { fetch: files.fetch, ipfsGateways: files.ipfsGateways });
          await repo.saveFeedbackFile(opts.chainId, f, result);
        }),
      );
    }
    stats.filesRead = due.length;
  }

  const reviews = await repo.reviews(opts.chainId);
  const agentIds = [...new Set(reviews.map((r) => r.agentId))];
  const [agents, funding, hashes, nansen] = await Promise.all([
    repo.agentAddresses(opts.chainId, agentIds),
    repo.funding(opts.chainId),
    repo.assessmentHashes(opts.chainId),
    repo.nansenFacts(opts.chainId),
  ]);
  stats.nansenLinks = nansen.links.length;
  const links = opts.files ? await repo.linkContext(opts.chainId, [...new Set(reviews.map((r) => r.client))]) : undefined;
  const { labels, summaries, hubs, clusterRoots } = assessReviews(reviews, agents, funding, { ...DEFAULT_ASSESS_OPTIONS, ...opts }, links, nansen);
  stats.verifiedReviews = summaries.reduce((n, s) => n + s.verifiedReviews, 0);
  stats.hubs = hubs.size;
  stats.agentsAssessed = summaries.length;
  stats.clustersWritten = await repo.saveClusterRoots(opts.chainId, clusterRoots);

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
