import { formatUnits } from "viem";
import { NETWORKS, type NetworkName } from "@moltforest/chain";
import type {
  FundingGraph,
  FundingGraphCluster,
  FundingGraphFundingEdge,
  FundingGraphNode,
  FundingGraphPaymentEdge,
  FundingGraphReviewEdge,
  ReviewExclusionReason,
  WalletFundingStatus,
} from "@moltforest/types";
import { table, type Db } from "../db.js";

/** Reviewer wallets drawn by default, and the most a caller may ask for. 8,000 covers the known mainnet farms (agent #182 had 7,665). */
export const DEFAULT_GRAPH_LIMIT = 8_000;
export const MAX_GRAPH_LIMIT = 10_000;

interface ReviewerRow {
  client: string;
  reviews: number;
  counted: number;
  verified: number;
  reason: ReviewExclusionReason | null;
  status: WalletFundingStatus | null;
  funder: string | null;
  funding_tx: string | null;
  sweep_tx: string | null;
  cluster_root: string | null;
}

/**
 * The funding graph of one agent (decision D31): the wallets that reviewed it,
 * the wallet that first funded each of them, and the x402 payments that back a
 * counted review (decision D39).
 *
 * Reviewers are ordered by how many reviews they wrote and capped, because a
 * farmed agent can have thousands of them; the remainder is summarised rather
 * than dropped silently.
 */
export function createFundingGraphRepository(db: Db, schemas: { indexer: string; app: string }) {
  const agents = table(schemas.indexer, "Agent");
  const feedback = table(schemas.indexer, "Feedback");
  const assessment = table(schemas.app, "review_assessment");
  const summary = table(schemas.app, "agent_review_summary");
  const funding = table(schemas.app, "wallet_funding");

  return {
    async get(network: NetworkName, agentId: string, limit: number): Promise<FundingGraph | null> {
      const chainId = NETWORKS[network].chainId;
      const zero = "0x0000000000000000000000000000000000000000";

      const agent = await db.query<{ owner: string; agent_wallet: string | null }>(
        `SELECT lower(owner) AS owner, lower(agent_wallet) AS agent_wallet FROM ${agents} WHERE chain_id = $1 AND agent_id = $2`,
        [chainId, agentId],
      );
      const target = agent.rows[0];
      if (!target) return null;
      const agentWallet = target.agent_wallet && target.agent_wallet !== zero ? target.agent_wallet : null;
      const targetAddrs = new Set([target.owner, agentWallet].filter((a): a is string => !!a));

      const [reviewers, totals, assessed, payments] = await Promise.all([
        // One row per reviewer wallet: its reviews here, plus how it was funded.
        db.query<ReviewerRow>(
          `SELECT lower(f.client) AS client,
                  count(*)::int AS reviews,
                  count(*) FILTER (WHERE ra.counted)::int AS counted,
                  count(*) FILTER (WHERE ra.counted AND ra.link->>'paymentTx' IS NOT NULL)::int AS verified,
                  (array_agg(ra.reason) FILTER (WHERE ra.reason IS NOT NULL))[1] AS reason,
                  wf.status, wf.funder, wf.funding_tx, wf.sweep_tx, wf.cluster_root
             FROM ${feedback} f
             LEFT JOIN ${assessment} ra
               ON ra.chain_id = f.chain_id AND ra.agent_id = f.agent_id::numeric
              AND ra.client = lower(f.client) AND ra.feedback_index = f.feedback_index
             LEFT JOIN ${funding} wf ON wf.chain_id = f.chain_id AND wf.address = lower(f.client)
            WHERE f.chain_id = $1 AND f.agent_id = $2 AND NOT f.revoked
            GROUP BY lower(f.client), wf.status, wf.funder, wf.funding_tx, wf.sweep_tx, wf.cluster_root
            ORDER BY counted DESC, reviews DESC, client
            LIMIT $3`,
          [chainId, agentId, limit],
        ),
        db.query<{ wallets: string; reviews: string }>(
          `SELECT count(DISTINCT lower(client)) AS wallets, count(*) AS reviews
             FROM ${feedback} WHERE chain_id = $1 AND agent_id = $2 AND NOT revoked`,
          [chainId, agentId],
        ),
        db.query<{ assessed_at: Date }>(`SELECT assessed_at FROM ${summary} WHERE chain_id = $1 AND agent_id = $2`, [chainId, agentId]),
        db.query<{ client: string; tx: string; amount: string | null; receipt: string | null; endpoint: string | null }>(
          `SELECT client, link->>'paymentTx' AS tx, link->>'amount' AS amount,
                  link->>'receiptHash' AS receipt, link->>'endpoint' AS endpoint
             FROM ${assessment}
            WHERE chain_id = $1 AND agent_id = $2 AND counted AND link->>'paymentTx' IS NOT NULL`,
          [chainId, agentId],
        ),
      ]);

      const nodes: FundingGraphNode[] = [];
      const byAddress = new Map<string, FundingGraphNode>();
      const addNode = (node: FundingGraphNode) => {
        if (byAddress.has(node.address)) return;
        byAddress.set(node.address, node);
        nodes.push(node);
      };

      addNode({
        address: target.owner,
        role: "owner",
        cluster: null,
        fundingStatus: "pending",
        reviews: 0,
        countedReviews: 0,
        verifiedReviews: 0,
        notCountedReason: null,
      });
      if (agentWallet) {
        addNode({
          address: agentWallet,
          role: "agentWallet",
          cluster: null,
          fundingStatus: "pending",
          reviews: 0,
          countedReviews: 0,
          verifiedReviews: 0,
          notCountedReason: null,
        });
      }

      const targetFunding = await db.query<{ address: string; status: WalletFundingStatus; cluster_root: string | null }>(
        `SELECT address, status, cluster_root FROM ${funding} WHERE chain_id = $1 AND address = ANY($2::text[])`,
        [chainId, [...targetAddrs]],
      );
      for (const row of targetFunding.rows) {
        const node = byAddress.get(row.address);
        if (!node) continue;
        node.fundingStatus = row.status;
        node.cluster = row.cluster_root;
      }

      const fundingEdges: FundingGraphFundingEdge[] = [];
      const reviewEdges: FundingGraphReviewEdge[] = [];
      for (const r of reviewers.rows) {
        const existing = byAddress.get(r.client);
        if (existing) {
          // The agent reviewed itself: keep the owner role and fill in its reviews.
          existing.reviews = r.reviews;
          existing.countedReviews = r.counted;
          existing.verifiedReviews = r.verified;
          existing.notCountedReason = r.counted > 0 ? null : r.reason;
          existing.cluster = r.cluster_root;
          existing.fundingStatus = r.status ?? "pending";
        } else {
          addNode({
            address: r.client,
            role: "reviewer",
            cluster: r.cluster_root,
            fundingStatus: r.status ?? "pending",
            reviews: r.reviews,
            countedReviews: r.counted,
            verifiedReviews: r.verified,
            notCountedReason: r.counted > 0 ? null : r.reason,
          });
        }
        reviewEdges.push({ from: r.client, reviews: r.reviews, countedReviews: r.counted });
        if (r.funder) fundingEdges.push({ from: r.funder, to: r.client, txHash: r.funding_tx, sweepTxHash: r.sweep_tx });
      }

      // A funder that did not review this agent still needs a node, or its
      // edges would hang off nothing.
      const missingFunders = [...new Set(fundingEdges.map((e) => e.from).filter((f) => !byAddress.has(f)))];
      if (missingFunders.length > 0) {
        const rows = await db.query<{ address: string; status: WalletFundingStatus; cluster_root: string | null }>(
          `SELECT address, status, cluster_root FROM ${funding} WHERE chain_id = $1 AND address = ANY($2::text[])`,
          [chainId, missingFunders],
        );
        const known = new Map(rows.rows.map((row) => [row.address, row]));
        for (const address of missingFunders) {
          const row = known.get(address);
          addNode({
            address,
            role: "funder",
            cluster: row?.cluster_root ?? null,
            fundingStatus: row?.status ?? "pending",
            reviews: 0,
            countedReviews: 0,
            verifiedReviews: 0,
            notCountedReason: null,
          });
        }
      }

      const paymentEdges: FundingGraphPaymentEdge[] = payments.rows
        .filter((p) => byAddress.has(p.client))
        .map((p) => ({
          from: p.client,
          txHash: p.tx,
          amountUsdc: p.amount ? formatUnits(BigInt(p.amount), 6) : "0",
          receiptHash: p.receipt,
          endpoint: p.endpoint,
        }));

      // Clusters over the wallets actually drawn, so the counts match the picture.
      const clusters = new Map<string, FundingGraphCluster>();
      for (const node of nodes) {
        if (!node.cluster) continue;
        let cluster = clusters.get(node.cluster);
        if (!cluster) {
          clusters.set(
            node.cluster,
            (cluster = { root: node.cluster, wallets: 0, reviews: 0, countedReviews: 0, containsTarget: false, notCountedReason: null }),
          );
        }
        cluster.wallets++;
        cluster.reviews += node.reviews;
        cluster.countedReviews += node.countedReviews;
        if (targetAddrs.has(node.address) || node.notCountedReason === "FUNDED_BY_TARGET") cluster.containsTarget = true;
        if (cluster.notCountedReason === null) cluster.notCountedReason = node.notCountedReason;
      }
      for (const edge of fundingEdges) {
        // A cluster also contains the target when the agent's own address funded it directly.
        if (!targetAddrs.has(edge.from)) continue;
        const cluster = clusters.get(byAddress.get(edge.to)?.cluster ?? "");
        if (cluster) cluster.containsTarget = true;
      }

      const totalWallets = Number(totals.rows[0]?.wallets ?? 0);
      const totalReviews = Number(totals.rows[0]?.reviews ?? 0);
      const drawnReviews = reviewers.rows.reduce((n, r) => n + r.reviews, 0);
      const omittedWallets = totalWallets - reviewers.rows.length;

      return {
        network,
        chainId,
        agentId,
        owner: target.owner,
        agentWallet,
        assessedAt: assessed.rows[0]?.assessed_at.toISOString() ?? null,
        nodes,
        edges: { funding: fundingEdges, review: reviewEdges, payment: paymentEdges },
        clusters: [...clusters.values()].sort((a, b) => b.wallets - a.wallets || a.root.localeCompare(b.root)),
        limit,
        omitted: omittedWallets > 0 ? { wallets: omittedWallets, reviews: totalReviews - drawnReviews } : null,
      };
    },
  };
}

export type FundingGraphRepository = ReturnType<typeof createFundingGraphRepository>;
