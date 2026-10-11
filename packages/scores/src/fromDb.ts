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
  /** Postgres schema (default `app`). */
  schema?: string;
  /**
   * Only include agents with verified reviews or counted reviewers (default true).
   * Zero-signal agents still assessed are omitted to keep the Merkle tree small.
   */
  requireSignal?: boolean;
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

/**
 * Load Floor-2 assessment facts from `agent_review_summary`, with paid volume
 * summed from counted `review_assessment.link.amount` (USDC base units).
 */
export async function loadScoresFromDb(opts: LoadScoresFromDbOpts): Promise<AgentScore[]> {
  const schema = quoteIdent(opts.schema ?? "app");
  const summary = `${schema}."agent_review_summary"`;
  const assessment = `${schema}."review_assessment"`;
  const requireSignal = opts.requireSignal !== false;
  const limit = opts.limit && opts.limit > 0 ? Math.trunc(opts.limit) : undefined;

  const signalClause = requireSignal
    ? "AND (s.verified_reviews > 0 OR s.counted_reviewers > 0)"
    : "";
  const limitClause = limit !== undefined ? `LIMIT ${limit}` : "";

  const result = await opts.db.query(
    `SELECT s.agent_id::text AS agent_id,
            s.verified_reviews,
            s.counted_reviewers,
            COALESCE(v.total_paid_volume, 0)::text AS total_paid_volume
     FROM ${summary} s
     LEFT JOIN (
       SELECT agent_id,
              SUM((link->>'amount')::numeric) AS total_paid_volume
       FROM ${assessment}
       WHERE chain_id = $1
         AND counted = true
         AND link IS NOT NULL
         AND link ? 'amount'
       GROUP BY agent_id
     ) v ON v.agent_id = s.agent_id
     WHERE s.chain_id = $1
       ${signalClause}
     ORDER BY s.agent_id::numeric ASC
     ${limitClause}`,
    [opts.chainId],
  );

  const rows = (result as { rows: DbRow[] }).rows;
  if (!rows || rows.length === 0) {
    throw new Error(
      `No agent_review_summary rows for chainId=${opts.chainId}` +
        (requireSignal ? " with verified_reviews > 0 or counted_reviewers > 0" : "") +
        ". Run the reviews worker, or use --demo / --scores.",
    );
  }

  return scoresFromSummaryRows(
    rows.map((r) => ({
      agentId: r.agent_id,
      verifiedReviews: Number(r.verified_reviews),
      countedReviewers: Number(r.counted_reviewers),
      totalPaidVolume: r.total_paid_volume,
    })),
  );
}
