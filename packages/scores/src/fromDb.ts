import type { SqlQueryable } from "./persist.js";
import type { ScoreInputs } from "./types.js";
import { computeScore } from "./compute.js";
import type { AgentScore } from "./types.js";

export interface ReviewSummaryRow {
  agentId: string;
  verifiedReviews: number;
  countedReviewers: number;
  /** USDC base units from counted reviews with a checked payment link; 0 when unknown. */
  totalPaidVolume: string | number | bigint;
}

export interface LoadScoresFromDbOpts {
  db: SqlQueryable;
  chainId: number;
  /** App schema holding agent_review_summary (default `app`). */
  schema?: string;
  /**
   * Indexer schema holding ERC-8004 `Agent` (default `envio`).
   * Used when `allAgents` is true.
   */
  indexerSchema?: string;
  /**
   * Only include agents with verified reviews or counted reviewers (default true).
   * Ignored when `allAgents` is true (every registered agent is a leaf; zeros allowed).
   */
  requireSignal?: boolean;
  /**
   * Include every ERC-8004 Agent on this chain from the indexer (Identity Registry history),
   * LEFT JOIN assessment summaries. Agents with no reviews score 0.
   */
  allAgents?: boolean;
  /** Hard cap on leaves (safety for huge indexes). */
  limit?: number;
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

/** Pure map from summary (+ optional volume) rows to ScoreInputs. */
export function scoreInputsFromSummaryRows(rows: readonly ReviewSummaryRow[]): ScoreInputs[] {
  return rows.map((r) => ({
    agentId: r.agentId,
    verifiedReviews: r.verifiedReviews,
    countedReviewers: r.countedReviewers,
    totalPaidVolume: r.totalPaidVolume,
  }));
}

export function scoresFromSummaryRows(rows: readonly ReviewSummaryRow[]): AgentScore[] {
  return scoreInputsFromSummaryRows(rows).map(computeScore);
}

interface DbRow {
  agent_id: string;
  verified_reviews: number;
  counted_reviewers: number;
  total_paid_volume: string;
}

function mapRows(rows: DbRow[]): AgentScore[] {
  return scoresFromSummaryRows(
    rows.map((r) => ({
      agentId: r.agent_id,
      verifiedReviews: Number(r.verified_reviews),
      countedReviewers: Number(r.counted_reviewers),
      totalPaidVolume: r.total_paid_volume,
    })),
  );
}

/**
 * Load Floor-2 assessment facts from `agent_review_summary`, with paid volume
 * summed from counted `review_assessment.link.amount` (USDC base units).
 *
 * With `allAgents: true`, starts from indexer `Agent` (all ERC-8004 registrations
 * since Identity Registry deploy / indexer start_block) so every agent is a Merkle leaf.
 */
export async function loadScoresFromDb(opts: LoadScoresFromDbOpts): Promise<AgentScore[]> {
  const schema = quoteIdent(opts.schema ?? "app");
  const indexer = quoteIdent(opts.indexerSchema ?? "envio");
  const summary = `${schema}."agent_review_summary"`;
  const assessment = `${schema}."review_assessment"`;
  const agents = `${indexer}."Agent"`;
  const allAgents = opts.allAgents === true;
  const requireSignal = !allAgents && opts.requireSignal !== false;
  const limit = opts.limit && opts.limit > 0 ? Math.trunc(opts.limit) : undefined;
  const limitClause = limit !== undefined ? `LIMIT ${limit}` : "";

  const volumeJoin = `
     LEFT JOIN (
       SELECT agent_id,
              SUM((link->>'amount')::numeric) AS total_paid_volume
       FROM ${assessment}
       WHERE chain_id = $1
         AND counted = true
         AND link IS NOT NULL
         AND link ? 'amount'
       GROUP BY agent_id
     ) v ON v.agent_id = s.agent_id`;

  let sql: string;
  if (allAgents) {
    sql = `SELECT a.agent_id::text AS agent_id,
            COALESCE(s.verified_reviews, 0)::int AS verified_reviews,
            COALESCE(s.counted_reviewers, 0)::int AS counted_reviewers,
            COALESCE(v.total_paid_volume, 0)::text AS total_paid_volume
     FROM ${agents} a
     LEFT JOIN ${summary} s
       ON s.chain_id = a.chain_id AND s.agent_id = a.agent_id
     LEFT JOIN (
       SELECT agent_id,
              SUM((link->>'amount')::numeric) AS total_paid_volume
       FROM ${assessment}
       WHERE chain_id = $1
         AND counted = true
         AND link IS NOT NULL
         AND link ? 'amount'
       GROUP BY agent_id
     ) v ON v.agent_id = a.agent_id
     WHERE a.chain_id = $1
     ORDER BY a.agent_id::numeric ASC
     ${limitClause}`;
  } else {
    const signalClause = requireSignal
      ? "AND (s.verified_reviews > 0 OR s.counted_reviewers > 0)"
      : "";
    sql = `SELECT s.agent_id::text AS agent_id,
            s.verified_reviews,
            s.counted_reviewers,
            COALESCE(v.total_paid_volume, 0)::text AS total_paid_volume
     FROM ${summary} s
     ${volumeJoin}
     WHERE s.chain_id = $1
       ${signalClause}
     ORDER BY s.agent_id::numeric ASC
     ${limitClause}`;
  }

  const result = await opts.db.query(sql, [opts.chainId]);
  const rows = (result as { rows: DbRow[] }).rows;
  if (!rows || rows.length === 0) {
    throw new Error(
      allAgents
        ? `No Agent rows in ${opts.indexerSchema ?? "envio"} for chainId=${opts.chainId}. Is the indexer synced?`
        : `No agent_review_summary rows for chainId=${opts.chainId}` +
            (requireSignal ? " with verified_reviews > 0 or counted_reviewers > 0" : "") +
            ". Run the reviews worker, or use --demo / --scores / --all-agents.",
    );
  }

  return mapRows(rows);
}
