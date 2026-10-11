import type pg from "pg";
import { table } from "../enrich/repository.js";
import {
  NO_NANSEN_FACTS,
  reviewKey,
  type AgentAddresses,
  type AgentSummary,
  type FileFacts,
  type Funding,
  type LinkContext,
  type NansenFacts,
  type PaymentFact,
  type ReceiptFact,
  type ReviewLabel,
  type ReviewRow,
} from "./assess.js";
import type { FileResult } from "./feedbackFiles.js";
import type { FundingResult } from "./funding.js";
import { nansenFactsFromRows } from "../nansen/facts.js";

export interface DueFile {
  agentId: string;
  client: string;
  feedbackIndex: string;
  uri: string;
  feedbackHash: string;
  attempts: number;
}

const HOUR_MS = 3_600_000;
/** Feedback files are fetched at most this many times. */
export const MAX_FILE_ATTEMPTS = 4;

export function createReviewRepository(db: pg.Pool, schemas: { indexer: string; app: string }) {
  const feedback = table(schemas.indexer, "Feedback");
  const agents = table(schemas.indexer, "Agent");
  const funding = table(schemas.app, "wallet_funding");
  const assessment = table(schemas.app, "review_assessment");
  const summary = table(schemas.app, "agent_review_summary");
  const files = table(schemas.app, "feedback_file");
  const receipts = table(schemas.app, "receipt");
  const payments = table(schemas.app, "x402_payment");
  const nansen = table(schemas.app, "nansen_relation");

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

    /**
     * Stores the funding cluster each wallet ended up in, so the funding graph
     * can be read back without redoing the union-find. Only rows whose group
     * changed are written. Returns how many changed.
     */
    async saveClusterRoots(chainId: number, roots: Map<string, string>): Promise<number> {
      const entries = [...roots];
      let changed = 0;
      for (let i = 0; i < entries.length; i += 1000) {
        const chunk = entries.slice(i, i + 1000);
        const values: unknown[] = [chainId];
        const rows = chunk.map(([address, root], j) => {
          values.push(address, root);
          return `($${j * 2 + 2}, $${j * 2 + 3})`;
        });
        const r = await db.query(
          `UPDATE ${funding} f SET cluster_root = v.root
             FROM (VALUES ${rows.join(", ")}) AS v(address, root)
            WHERE f.chain_id = $1 AND f.address = v.address AND f.cluster_root IS DISTINCT FROM v.root`,
          values,
        );
        changed += r.rowCount ?? 0;
      }
      return changed;
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

    /** Nansen's links and exchange, bridge and faucet labels on this chain (decision D47); empty where Nansen has no data. */
    async nansenFacts(chainId: number): Promise<NansenFacts> {
      try {
        const r = await db.query<{ wallet: string; related: string; relation: string; label: string | null; tx_hash: string | null }>(
          `SELECT wallet, related, relation, label, tx_hash FROM ${nansen} WHERE chain_id = $1 ORDER BY wallet, related, relation`,
          [chainId],
        );
        return nansenFactsFromRows(r.rows.map((row) => ({ wallet: row.wallet, related: row.related, relation: row.relation, label: row.label, txHash: row.tx_hash })));
      } catch (err) {
        // Not migrated yet: assess without Nansen rather than not at all.
        if ((err as { code?: string }).code === "42P01") return NO_NANSEN_FACTS;
        throw err;
      }
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
            values.push(
              chainId,
              l.agentId,
              l.client,
              l.feedbackIndex,
              l.counted,
              l.reason,
              l.evidence === null ? null : JSON.stringify(l.evidence),
              l.link === null ? (l.linkProblem ? JSON.stringify({ problem: l.linkProblem }) : null) : JSON.stringify(l.link),
              l.paidUnattached,
            );
            const o = j * 9;
            return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}::jsonb, $${o + 8}::jsonb, $${o + 9})`;
          });
          await client.query(
            `INSERT INTO ${assessment} (chain_id, agent_id, client, feedback_index, counted, reason, evidence, link, paid_unattached) VALUES ${rows.join(", ")}`,
            values,
          );
        }
        await client.query(
          `INSERT INTO ${summary} (chain_id, agent_id, counted_reviews, counted_reviewers, excluded, pending_reviewers, verified_reviews, assessment_hash, assessed_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, now())
           ON CONFLICT (chain_id, agent_id) DO UPDATE SET
             counted_reviews = EXCLUDED.counted_reviews, counted_reviewers = EXCLUDED.counted_reviewers,
             excluded = EXCLUDED.excluded, pending_reviewers = EXCLUDED.pending_reviewers, verified_reviews = EXCLUDED.verified_reviews,
             assessment_hash = EXCLUDED.assessment_hash, assessed_at = now()`,
          [chainId, s.agentId, s.countedReviews, s.countedReviewers, JSON.stringify(s.excluded), s.pendingReviewers, s.verifiedReviews, s.assessmentHash],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },

    /** Queues the feedback file of every non-revoked review that names one; returns how many are new. */
    async syncFeedbackFiles(chainId: number): Promise<number> {
      const r = await db.query(
        `INSERT INTO ${files} (chain_id, agent_id, client, feedback_index, uri)
         SELECT chain_id, agent_id::numeric, lower(client), feedback_index, left(feedback_uri, 100000) FROM ${feedback}
          WHERE chain_id = $1 AND NOT revoked AND feedback_uri <> ''
         ON CONFLICT DO NOTHING`,
        [chainId],
      );
      return r.rowCount ?? 0;
    },

    async dueFeedbackFiles(chainId: number, limit: number): Promise<DueFile[]> {
      const r = await db.query<{ agent_id: string; client: string; feedback_index: string; uri: string; feedback_hash: string; attempts: number }>(
        `SELECT f.agent_id::text, f.client, f.feedback_index::text, f.uri, fb.feedback_hash, f.attempts
           FROM ${files} f
           JOIN ${feedback} fb ON fb.chain_id = f.chain_id AND fb.agent_id = f.agent_id::text
                              AND lower(fb.client) = f.client AND fb.feedback_index = f.feedback_index
          WHERE f.chain_id = $1 AND f.status IN ('pending', 'unreachable') AND f.next_fetch_at <= now() AND f.attempts < $3
          ORDER BY f.next_fetch_at LIMIT $2`,
        [chainId, limit, MAX_FILE_ATTEMPTS],
      );
      return r.rows.map((row) => ({
        agentId: row.agent_id,
        client: row.client,
        feedbackIndex: row.feedback_index,
        uri: row.uri,
        feedbackHash: row.feedback_hash,
        attempts: row.attempts,
      }));
    },

    async saveFeedbackFile(chainId: number, f: DueFile, result: FileResult): Promise<void> {
      // Transient failures come back with backoff (1 h, 2 h, 4 h); everything else is final.
      const retryInMs = result.transient ? HOUR_MS * 2 ** f.attempts : null;
      await db.query(
        `UPDATE ${files}
            SET status = $5, attempts = attempts + 1, fetched_at = now(),
                next_fetch_at = CASE WHEN $6::bigint IS NULL THEN 'infinity'::timestamptz ELSE now() + ($6::bigint * interval '1 millisecond') END,
                proof_tx = $7, proof_chain_id = $8, proof_from = $9, proof_to = $10, receipt_hash = $11, endpoint = $12, error = $13
          WHERE chain_id = $1 AND agent_id = $2 AND client = $3 AND feedback_index = $4`,
        [
          chainId,
          f.agentId,
          f.client,
          f.feedbackIndex,
          result.status,
          retryInMs,
          result.proofTx ?? null,
          result.proofChainId ?? null,
          result.proofFrom ?? null,
          result.proofTo ?? null,
          result.receiptHash ?? null,
          result.endpoint ?? null,
          result.error ?? null,
        ],
      );
    },

    /** File facts, the receipts and payments they name, and reviewers' payments, for the link checks. */
    async linkContext(chainId: number, reviewers: string[]): Promise<LinkContext> {
      const fileRows = await db.query<{
        agent_id: string;
        client: string;
        feedback_index: string;
        status: string;
        proof_tx: string | null;
        proof_chain_id: string | null;
        receipt_hash: string | null;
        endpoint: string | null;
      }>(
        `SELECT agent_id::text, client, feedback_index::text, status, proof_tx, proof_chain_id, receipt_hash, endpoint
           FROM ${files} WHERE chain_id = $1 AND status <> 'pending'`,
        [chainId],
      );
      const fileMap = new Map<string, FileFacts>();
      for (const f of fileRows.rows) {
        fileMap.set(reviewKey(f.agent_id, f.client, f.feedback_index), {
          status: f.status,
          proofTx: f.proof_tx,
          proofChainId: f.proof_chain_id,
          receiptHash: f.receipt_hash,
          endpoint: f.endpoint,
        });
      }

      const receiptHashes = [...new Set(fileRows.rows.map((f) => f.receipt_hash).filter((h): h is string => !!h))];
      const receiptRows = receiptHashes.length
        ? (
            await db.query<{ receipt_hash: string; provider_agent_id: string; client_signer: string | null; payment_ref: string }>(
              `SELECT receipt_hash, provider_agent_id::text, client_signer, payment_ref FROM ${receipts} WHERE chain_id = $1 AND receipt_hash = ANY($2::text[])`,
              [chainId, receiptHashes],
            )
          ).rows
        : [];
      const receiptMap = new Map<string, ReceiptFact>(
        receiptRows.map((r) => [r.receipt_hash, { providerAgentId: r.provider_agent_id, clientSigner: r.client_signer, paymentRef: r.payment_ref }]),
      );

      type PaymentRow = { tx_hash: string; payer: string; payee: string; amount: string; block_number: string };
      const toFact = (p: PaymentRow): PaymentFact => ({ tx: p.tx_hash, payer: p.payer, payee: p.payee, amount: p.amount, block: Number(p.block_number) });
      const txs = [...new Set([...fileRows.rows.map((f) => f.proof_tx), ...receiptRows.map((r) => r.payment_ref)].filter((t): t is string => !!t))];
      // The first transfer of each transaction: an x402 settlement has one.
      const byTx = txs.length
        ? (
            await db.query<PaymentRow>(
              `SELECT DISTINCT ON (tx_hash) tx_hash, payer, payee, amount::text, block_number::text
                 FROM ${payments} WHERE chain_id = $1 AND tx_hash = ANY($2::text[]) ORDER BY tx_hash, log_index`,
              [chainId, txs],
            )
          ).rows
        : [];
      const byPayer = reviewers.length
        ? (
            await db.query<PaymentRow>(
              `SELECT tx_hash, payer, payee, amount::text, block_number::text FROM ${payments} WHERE chain_id = $1 AND payer = ANY($2::text[])`,
              [chainId, reviewers],
            )
          ).rows
        : [];
      const paymentsByPayer = new Map<string, PaymentFact[]>();
      for (const p of byPayer) {
        let list = paymentsByPayer.get(p.payer);
        if (!list) paymentsByPayer.set(p.payer, (list = []));
        list.push(toFact(p));
      }

      const endpoints = await db.query<{ agent_id: string; client: string; feedback_index: string; endpoint: string }>(
        `SELECT agent_id::text, lower(client) AS client, feedback_index::text, endpoint FROM ${feedback}
          WHERE chain_id = $1 AND NOT revoked AND endpoint <> ''`,
        [chainId],
      );
      return {
        chainId,
        files: fileMap,
        receipts: receiptMap,
        payments: new Map(byTx.map((p) => [p.tx_hash, toFact(p)])),
        paymentsByPayer,
        onChainEndpoints: new Map(endpoints.rows.map((e) => [reviewKey(e.agent_id, e.client, e.feedback_index), e.endpoint.slice(0, 2048)])),
      };
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
