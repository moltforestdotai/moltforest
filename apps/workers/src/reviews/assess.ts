/**
 * Which reviews count (decisions D20, D31). Pure: reviews, agent addresses and
 * reviewer funding in; one label per review and counted totals per agent out.
 *
 * Wallets are linked only by hard on-chain facts: a reviewer and the wallet that
 * first funded it. Linked wallets form clusters (union-find). A funder whose
 * wallets reviewed many different agents is a hub (faucet, exchange, bridge) and
 * links nothing. Then, for each agent, in review order:
 *
 *   SELF_REVIEW          the reviewer is the agent's owner or agent wallet
 *   FUNDED_BY_TARGET     the reviewer's cluster includes the agent's owner or agent wallet
 *   REPEAT_REVIEWER      the wallet already has a counted review within the repeat window
 *   COORDINATED_CLUSTER  another wallet of the same cluster already counts (a cluster counts as one reviewer)
 *
 * Reviews are never hidden: every review keeps its row, with a neutral reason
 * and the funding transactions as evidence (constraints C2, C5).
 */
import { createHash } from "node:crypto";

export type ReviewExclusion = "SELF_REVIEW" | "FUNDED_BY_TARGET" | "REPEAT_REVIEWER" | "COORDINATED_CLUSTER";

export interface ReviewRow {
  agentId: string;
  /** Lowercase reviewer address. */
  client: string;
  feedbackIndex: string;
  blockNumber: number;
  /** Unix seconds. */
  timestamp: number;
}

export interface AgentAddresses {
  owner: string;
  wallet: string | null;
}

export interface Funding {
  status: "pending" | "found" | "none";
  funder?: string | null;
  fundingTx?: string | null;
  sweepTx?: string | null;
}

export interface ReviewLabel {
  agentId: string;
  client: string;
  feedbackIndex: string;
  counted: boolean;
  reason: ReviewExclusion | null;
  evidence: Record<string, unknown> | null;
}

export interface AgentSummary {
  agentId: string;
  countedReviews: number;
  countedReviewers: number;
  excluded: Partial<Record<ReviewExclusion, number>>;
  pendingReviewers: number;
  assessmentHash: string;
}

export interface AssessOptions {
  /** A funder whose wallets reviewed at least this many distinct agents is a hub. */
  hubMinAgents: number;
  /** A wallet's later review counts again after this many days. */
  repeatWindowDays: number;
}

export const DEFAULT_ASSESS_OPTIONS: AssessOptions = { hubMinAgents: 10, repeatWindowDays: 30 };

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let root = x;
    while (this.parent.has(root) && this.parent.get(root) !== root) root = this.parent.get(root)!;
    // Path compression.
    let node = x;
    while (node !== root) {
      const next = this.parent.get(node) ?? root;
      this.parent.set(node, root);
      node = next;
    }
    return root;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
}

/** Funders whose wallets reviewed at least `hubMinAgents` distinct agents. */
export function findHubs(reviews: ReviewRow[], funding: Map<string, Funding>, hubMinAgents: number): Set<string> {
  const agentsByFunder = new Map<string, Set<string>>();
  for (const r of reviews) {
    const funder = funding.get(r.client)?.funder;
    if (!funder) continue;
    let set = agentsByFunder.get(funder);
    if (!set) agentsByFunder.set(funder, (set = new Set()));
    set.add(r.agentId);
  }
  return new Set([...agentsByFunder].filter(([, agents]) => agents.size >= hubMinAgents).map(([funder]) => funder));
}

export function assessReviews(
  reviews: ReviewRow[],
  agents: Map<string, AgentAddresses>,
  funding: Map<string, Funding>,
  options: AssessOptions = DEFAULT_ASSESS_OPTIONS,
): { labels: ReviewLabel[]; summaries: AgentSummary[]; hubs: Set<string> } {
  const hubs = findHubs(reviews, funding, options.hubMinAgents);

  // Every known funding fact links two wallets, so chains (owner → wallet → reviewer) join too.
  const clusters = new UnionFind();
  for (const [wallet, f] of funding) {
    if (f.funder && !hubs.has(f.funder)) clusters.union(wallet, f.funder);
  }

  const byAgent = new Map<string, ReviewRow[]>();
  for (const r of reviews) {
    let list = byAgent.get(r.agentId);
    if (!list) byAgent.set(r.agentId, (list = []));
    list.push(r);
  }

  const windowSeconds = options.repeatWindowDays * 86_400;
  const labels: ReviewLabel[] = [];
  const summaries: AgentSummary[] = [];

  for (const [agentId, list] of [...byAgent].sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1))) {
    list.sort((a, b) => a.blockNumber - b.blockNumber || (BigInt(a.feedbackIndex) < BigInt(b.feedbackIndex) ? -1 : 1));
    const target = agents.get(agentId);
    const targetAddrs = new Set([target?.owner, target?.wallet].filter((a): a is string => !!a));
    const targetRoots = new Set([...targetAddrs].map((a) => clusters.find(a)));

    // Cluster sizes among this agent's reviewers, for the evidence.
    const clusterSize = new Map<string, number>();
    for (const client of new Set(list.map((r) => r.client))) {
      const root = clusters.find(client);
      clusterSize.set(root, (clusterSize.get(root) ?? 0) + 1);
    }

    const lastCounted = new Map<string, number>();
    const countedRoot = new Map<string, string>();
    const agentLabels: ReviewLabel[] = [];
    const pending = new Set<string>();

    for (const r of list) {
      const f = funding.get(r.client);
      if (!f || f.status === "pending") pending.add(r.client);
      const root = clusters.find(r.client);
      const fundingEvidence = f?.funder ? { funder: f.funder, fundingTx: f.fundingTx ?? null, ...(f.sweepTx ? { sweepTx: f.sweepTx } : {}) } : {};
      const label = (reason: ReviewExclusion | null, evidence: Record<string, unknown> | null): ReviewLabel => ({
        agentId,
        client: r.client,
        feedbackIndex: r.feedbackIndex,
        counted: reason === null,
        reason,
        evidence,
      });

      if (targetAddrs.has(r.client)) {
        agentLabels.push(label("SELF_REVIEW", { reviewer: r.client, role: r.client === target?.owner ? "owner" : "agentWallet" }));
      } else if ((f?.funder && targetAddrs.has(f.funder)) || targetRoots.has(root)) {
        // Direct funding always links, even when the owner funds so widely that it counts as a hub.
        const direct = !!f?.funder && targetAddrs.has(f.funder);
        agentLabels.push(label("FUNDED_BY_TARGET", { ...fundingEvidence, link: direct ? "direct" : "cluster" }));
      } else if (lastCounted.has(r.client) && r.timestamp - lastCounted.get(r.client)! < windowSeconds) {
        agentLabels.push(label("REPEAT_REVIEWER", { windowDays: options.repeatWindowDays }));
      } else if (countedRoot.has(root) && countedRoot.get(root) !== r.client) {
        agentLabels.push(label("COORDINATED_CLUSTER", { ...fundingEvidence, clusterSize: clusterSize.get(root), countedAs: countedRoot.get(root) }));
      } else {
        agentLabels.push(label(null, null));
        lastCounted.set(r.client, r.timestamp);
        countedRoot.set(root, r.client);
      }
    }

    const excluded: Partial<Record<ReviewExclusion, number>> = {};
    for (const l of agentLabels) if (l.reason) excluded[l.reason] = (excluded[l.reason] ?? 0) + 1;
    const counted = agentLabels.filter((l) => l.counted);
    summaries.push({
      agentId,
      countedReviews: counted.length,
      countedReviewers: new Set(counted.map((l) => l.client)).size,
      excluded,
      pendingReviewers: pending.size,
      assessmentHash: createHash("sha256").update(JSON.stringify(agentLabels)).digest("hex"),
    });
    labels.push(...agentLabels);
  }
  return { labels, summaries, hubs };
}
