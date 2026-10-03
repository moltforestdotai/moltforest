import type pg from "pg";
import { table } from "../enrich/repository.js";
import type { AgentAddresses, AgentSummary, Funding, ReviewLabel, ReviewRow } from "./assess.js";
import type { FundingResult } from "./funding.js";

export function createReviewRepository(db: pg.Pool, schemas: { indexer: string; app: string }) {
  const feedback = table(schemas.indexer, "Feedback");
  const agents = table(schemas.indexer, "Agent");
  const funding = table(schemas.app, "wallet_funding");
  const assessment = table(schemas.app, "review_assessment");
  const summary = table(schemas.app, "agent_review_summary");

  return {
    /** Adds every reviewer wallet on the chain as pending; returns how many are new. */
    async syncReviewers(chainId: number): Promise<number> {
      const r = await db.query(
        `INSERT INTO ${funding} (chain_id, address)
         SELECT DISTINCT $1::int, lower(client) FROM ${feedback}
          WHERE chain_id = $1 AND lower(client) ~ '^0x[0-9a-f]{40}$'
         ON CONFLICT DO NOTHING`,
        [chainId],
      );
      return r.rowCount ?? 0;
    },

    async pendingWallets(chainId: number, limit: number): Promise<string[]> {
      const r = await db.query<{ address: string }>(
        `SELECT address FROM ${funding} WHERE chain_id = $1 AND status = 'pending' ORDER BY added_at, address LIMIT $2`,
        [chainId, limit],
      );
      return r.rows.map((row) => row.address);
    },

    async saveFunding(chainId: number, results: FundingResult[], checkedBlock: number): Promise<void> {
      for (const f of results) {
        await db.query(
          `UPDATE ${funding}
              SET status = $3, funder = $4, funding_tx = $5, funding_block = $6, funding_value = $7,
                  sweep_tx = $8, sent_tx_count = $9, checked_block = $10, checked_at = now()
            WHERE chain_id = $1 AND address = $2`,
          [chainId, f.address, f.status, f.funder, f.fundingTx, f.fundingBlock, f.fundingValue, f.sweepTx, f.sentTxCount, checkedBlock],
        );
      }
    },

    /** Non-revoked reviews on the chain. */
    async reviews(chainId: number): Promise<ReviewRow[]> {
      const r = await db.query<{ agent_id: string; client: string; feedback_index: string; block_number: string; ts: string }>(
        `SELECT agent_id::text, lower(client) AS client, feedback_index::text, block_number::text,
                extract(epoch FROM "timestamp")::bigint::text AS ts
           FROM ${feedback} WHERE chain_id = $1 AND NOT revoked`,
        [chainId],
      );
      return r.rows.map((row) => ({
        agentId: row.agent_id,
        client: row.client,
        feedbackIndex: row.feedback_index,
        blockNumber: Number(row.block_number),
        timestamp: Number(row.ts),
      }));
    },

    async agentAddresses(chainId: number, agentIds: string[]): Promise<Map<string, AgentAddresses>> {
      const r = await db.query<{ agent_id: string; owner: string; agent_wallet: string | null }>(
        `SELECT agent_id::text, lower(owner) AS owner, lower(agent_wallet) AS agent_wallet
           FROM ${agents} WHERE chain_id = $1 AND agent_id = ANY($2::numeric[])`,
        [chainId, agentIds],
      );
      const zero = "0x0000000000000000000000000000000000000000";
      return new Map(r.rows.map((row) => [row.agent_id, { owner: row.owner, wallet: row.agent_wallet && row.agent_wallet !== zero ? row.agent_wallet : null }]));
    },

    async funding(chainId: number): Promise<Map<string, Funding>> {
      const r = await db.query<{ address: string; status: Funding["status"]; funder: string | null; funding_tx: string | null; sweep_tx: string | null }>(
        `SELECT address, status, funder, funding_tx, sweep_tx FROM ${funding} WHERE chain_id = $1`,
        [chainId],
      );
      return new Map(r.rows.map((row) => [row.address, { status: row.status, funder: row.funder, fundingTx: row.funding_tx, sweepTx: row.sweep_tx }]));
    },

    async assessmentHashes(chainId: number): Promise<Map<string, string>> {
      const r = await db.query<{ agent_id: string; assessment_hash: string }>(
        `SELECT agent_id::text, assessment_hash FROM ${summary} WHERE chain_id = $1`,
        [chainId],
      );
      return new Map(r.rows.map((row) => [row.agent_id, row.assessment_hash]));
    },

    /** Replaces one agent's labels and summary in a single transaction. */
    async saveAssessment(chainId: number, s: AgentSummary, labels: ReviewLabel[]): Promise<void> {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(`DELETE FROM ${assessment} WHERE chain_id = $1 AND agent_id = $2`, [chainId, s.agentId]);
        for (let i = 0; i < labels.length; i += 500) {
          const chunk = labels.slice(i, i + 500);
          const values: unknown[] = [];
          const rows = chunk.map((l, j) => {
            values.push(chainId, l.agentId, l.client, l.feedbackIndex, l.counted, l.reason, l.evidence === null ? null : JSON.stringify(l.evidence));
            const o = j * 7;
            return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}::jsonb)`;
          });
          await client.query(
            `INSERT INTO ${assessment} (chain_id, agent_id, client, feedback_index, counted, reason, evidence) VALUES ${rows.join(", ")}`,
            values,
          );
        }
        await client.query(
          `INSERT INTO ${summary} (chain_id, agent_id, counted_reviews, counted_reviewers, excluded, pending_reviewers, assessment_hash, assessed_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, now())
           ON CONFLICT (chain_id, agent_id) DO UPDATE SET
             counted_reviews = EXCLUDED.counted_reviews, counted_reviewers = EXCLUDED.counted_reviewers,
             excluded = EXCLUDED.excluded, pending_reviewers = EXCLUDED.pending_reviewers,
             assessment_hash = EXCLUDED.assessment_hash, assessed_at = now()`,
          [chainId, s.agentId, s.countedReviews, s.countedReviewers, JSON.stringify(s.excluded), s.pendingReviewers, s.assessmentHash],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },

    /** Drops assessments of agents that no longer have any non-revoked review. */
    async removeStale(chainId: number, keep: string[]): Promise<number> {
      await db.query(`DELETE FROM ${assessment} WHERE chain_id = $1 AND NOT (agent_id = ANY($2::numeric[]))`, [chainId, keep]);
      const r = await db.query(`DELETE FROM ${summary} WHERE chain_id = $1 AND NOT (agent_id = ANY($2::numeric[]))`, [chainId, keep]);
      return r.rowCount ?? 0;
    },
  };
}

export type ReviewRepository = ReturnType<typeof createReviewRepository>;
