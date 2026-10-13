import { formatUnits } from "viem";
import { NETWORKS, nansenLinkKind, type NetworkName } from "@moltforest/chain";
import type {
  FundingGraph,
  FundingGraphCluster,
  FundingGraphFundingEdge,
  FundingGraphNansenEdge,
  FundingGraphNode,
  FundingGraphPaidEdge,
  FundingGraphPaymentEdge,
  FundingGraphReviewEdge,
  ReviewExclusionReason,
  WalletFundingStatus,
} from "@moltforest/types";
import { table, type Db } from "../db.js";
import { isMissingRelation } from "./sync.js";

/** Reviewer wallets drawn by default, and the most a caller may ask for. 8,000 covers the known mainnet farms (agent #182 had 7,665). */
export const DEFAULT_GRAPH_LIMIT = 8_000;
export const MAX_GRAPH_LIMIT = 10_000;
/** Wallets the agent paid or was paid by that are drawn; the busiest first (decision D48). Mainnet's most had 21 in October 2026. */
export const PAYMENT_WALLET_LIMIT = 1_000;

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
 * The wallets the agent's addresses paid or were paid by through x402 are
 * added too, one edge per wallet and direction, so an agent without reviews
 * still has a graph (decision D48). Payments are matched by address, as on
 * the agent's payments list.
 *
 * Reviewers are ordered by how many reviews they wrote and capped, because a
 * farmed agent can have thousands of them; the remainder is summarised rather
 * than dropped silently.
 *
 * On networks Nansen covers, Nansen's labels and the relations MoltForest
 * uses are added (decision D47).
 */
export function createFundingGraphRepository(db: Db, schemas: { indexer: string; app: string }) {
  const agents = table(schemas.indexer, "Agent");
  const feedback = table(schemas.indexer, "Feedback");
  const assessment = table(schemas.app, "review_assessment");
  const summary = table(schemas.app, "agent_review_summary");
  const funding = table(schemas.app, "wallet_funding");
  const nansenWallets = table(schemas.app, "nansen_wallet");
  const nansenRelations = table(schemas.app, "nansen_relation");
  const x402Payments = table(schemas.app, "x402_payment");

  /** Rows of a query on the Nansen tables, or none before they are migrated. */
  const optional = async <T>(query: Promise<{ rows: T[] }>): Promise<T[]> => {
    try {
      return (await query).rows;
    } catch (err) {
      if (isMissingRelation(err)) return [];
      throw err;
    }
  };

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
        nansenLabel: null,
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
          nansenLabel: null,
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
            nansenLabel: null,
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
            nansenLabel: null,
          });
        }
      }

      // x402 payments with other wallets (decision D48). Self-payments are summed, never drawn as income.
      let paymentSummary: FundingGraph["payments"] = null;
      const paidEdges: FundingGraphPaidEdge[] = [];
      try {
        const own = [...targetAddrs];
        const matched = `FROM ${x402Payments} WHERE chain_id = $1 AND (payer = ANY($2::text[]) OR payee = ANY($2::text[]))`;
        const [pairs, sums] = await Promise.all([
          db.query<{ payer: string; payee: string; payments: number; amount: string; last_at: Date; last_tx: string }>(
            `WITH p AS (
               SELECT payer, payee, amount, block_time, block_number, tx_hash, log_index,
                      CASE WHEN payer = ANY($2::text[]) THEN payee ELSE payer END AS wallet
                 ${matched} AND NOT (payer = ANY($2::text[]) AND payee = ANY($2::text[]))
             ), busiest AS (
               SELECT wallet FROM p GROUP BY wallet ORDER BY count(*) DESC, wallet LIMIT $3
             )
             SELECT p.payer, p.payee, count(*)::int AS payments, sum(p.amount)::text AS amount, max(p.block_time) AS last_at,
                    (array_agg(p.tx_hash ORDER BY p.block_number DESC, p.log_index DESC))[1] AS last_tx
               FROM p JOIN busiest USING (wallet)
              GROUP BY p.payer, p.payee
              ORDER BY payments DESC, p.payer, p.payee`,
            [chainId, own, PAYMENT_WALLET_LIMIT],
          ),
          db.query<{ self: number; self_amount: string; payments: number; wallets: number }>(
            `SELECT count(*) FILTER (WHERE self)::int AS self,
                    coalesce(sum(amount) FILTER (WHERE self), 0)::text AS self_amount,
                    count(*) FILTER (WHERE NOT self)::int AS payments,
                    count(DISTINCT wallet) FILTER (WHERE NOT self)::int AS wallets
               FROM (SELECT amount, payer = ANY($2::text[]) AND payee = ANY($2::text[]) AS self,
                            CASE WHEN payer = ANY($2::text[]) THEN payee ELSE payer END AS wallet
                       ${matched}) p`,
            [chainId, own],
          ),
        ]);
        const totals = sums.rows[0] ?? { self: 0, self_amount: "0", payments: 0, wallets: 0 };
        const shared =
          totals.self + totals.payments > 0
            ? await db.query<{ address: string; agents: number }>(
                `SELECT x.address, count(a.agent_id)::int AS agents
                   FROM unnest($2::text[]) AS x(address)
                   LEFT JOIN ${agents} a ON a.chain_id = $1 AND (lower(a.owner) = x.address OR lower(a.agent_wallet) = x.address)
                  GROUP BY x.address ORDER BY x.address`,
                [chainId, own],
              )
            : { rows: [] };

        const drawnWallets = new Set<string>();
        let drawnPayments = 0;
        for (const row of pairs.rows) {
          const wallet = targetAddrs.has(row.payer) ? row.payee : row.payer;
          drawnWallets.add(wallet);
          drawnPayments += row.payments;
          // Not part of the reviewer clusters: a counterparty wrote no review here.
          addNode({
            address: wallet,
            role: "counterparty",
            cluster: null,
            fundingStatus: "pending",
            reviews: 0,
            countedReviews: 0,
            verifiedReviews: 0,
            notCountedReason: null,
            nansenLabel: null,
          });
          paidEdges.push({
            from: row.payer,
            to: row.payee,
            payments: row.payments,
            amountUsdc: formatUnits(BigInt(row.amount), 6),
            lastAt: row.last_at.toISOString(),
            lastTxHash: row.last_tx,
          });
        }
        paymentSummary = {
          self: { payments: totals.self, amountUsdc: formatUnits(BigInt(totals.self_amount), 6) },
          payments: totals.payments,
          wallets: totals.wallets,
          addresses: shared.rows.map((row) => ({ address: row.address, agentCount: row.agents })),
          omitted:
            totals.wallets > drawnWallets.size ? { wallets: totals.wallets - drawnWallets.size, payments: totals.payments - drawnPayments } : null,
        };
      } catch (err) {
        if (!isMissingRelation(err)) throw err;
      }

      // What Nansen says about the drawn reviewers (decision D47).
      const nansenEdges: FundingGraphNansenEdge[] = [];
      let nansenCoverage: FundingGraph["nansen"] = null;
      if (NETWORKS[network].nansenChain) {
        const drawn = reviewers.rows.map((r) => r.client);
        const [relations, coverage] = await Promise.all([
          optional(
            db.query<{ wallet: string; related: string; relation: string; tx_hash: string | null }>(
              `SELECT wallet, related, relation, tx_hash FROM ${nansenRelations}
                WHERE chain_id = $1 AND wallet = ANY($2::text[]) ORDER BY wallet, relation, related`,
              [chainId, drawn],
            ),
          ),
          optional(
            db.query<{ looked_up: number; last: Date | null }>(
              `SELECT count(*)::int AS looked_up, max(fetched_at) AS last FROM ${nansenWallets}
                WHERE chain_id = $1 AND status = 'ok' AND address = ANY($2::text[])`,
              [chainId, drawn],
            ),
          ),
        ]);
        const fundingPairs = new Set(fundingEdges.map((e) => `${e.from}>${e.to}`));
        for (const row of relations) {
          const kind = nansenLinkKind(row.relation);
          if (!kind || row.related === row.wallet) continue;
          // A first funder our own scan found too is already drawn as a funding edge.
          if (kind === "funding" && fundingPairs.has(`${row.related}>${row.wallet}`)) continue;
          nansenEdges.push({ from: row.related, to: row.wallet, relation: row.relation, kind, txHash: row.tx_hash });
        }

        const missingRelated = [...new Set(nansenEdges.map((e) => e.from).filter((a) => !byAddress.has(a)))];
        if (missingRelated.length > 0) {
          const rows = await db.query<{ address: string; status: WalletFundingStatus; cluster_root: string | null }>(
            `SELECT address, status, cluster_root FROM ${funding} WHERE chain_id = $1 AND address = ANY($2::text[])`,
            [chainId, missingRelated],
          );
          const known = new Map(rows.rows.map((row) => [row.address, row]));
          const funds = new Set(nansenEdges.filter((e) => e.kind === "funding").map((e) => e.from));
          for (const address of missingRelated) {
            const row = known.get(address);
            addNode({
              address,
              role: funds.has(address) ? "funder" : "linked",
              cluster: row?.cluster_root ?? null,
              fundingStatus: row?.status ?? "pending",
              reviews: 0,
              countedReviews: 0,
              verifiedReviews: 0,
              notCountedReason: null,
              nansenLabel: null,
            });
          }
        }

        const labels = await optional(
          db.query<{ related: string; label: string }>(
            `SELECT DISTINCT ON (related) related, label FROM ${nansenRelations}
              WHERE chain_id = $1 AND related = ANY($2::text[]) AND label IS NOT NULL
              ORDER BY related, fetched_at DESC, label`,
            [chainId, nodes.map((n) => n.address)],
          ),
        );
        for (const row of labels) {
          const node = byAddress.get(row.related);
          if (node) node.nansenLabel = row.label;
        }
        nansenCoverage = { lookedUp: coverage[0]?.looked_up ?? 0, wallets: drawn.length, lastFetchedAt: coverage[0]?.last?.toISOString() ?? null };
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
        edges: { funding: fundingEdges, review: reviewEdges, payment: paymentEdges, nansen: nansenEdges, paid: paidEdges },
        clusters: [...clusters.values()].sort((a, b) => b.wallets - a.wallets || a.root.localeCompare(b.root)),
        nansen: nansenCoverage,
        limit,
        omitted: omittedWallets > 0 ? { wallets: omittedWallets, reviews: totalReviews - drawnReviews } : null,
        payments: paymentSummary,
      };
    },
  };
}

export type FundingGraphRepository = ReturnType<typeof createFundingGraphRepository>;
