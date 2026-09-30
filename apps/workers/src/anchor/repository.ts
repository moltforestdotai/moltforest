import type pg from "pg";
import { table } from "../enrich/repository.js";

/** A receipt waiting for the relayer (app.receipt, anchor_status queued or sending). */
export interface DueReceipt {
  receiptHash: `0x${string}`;
  chainId: number;
  registry: `0x${string}`;
  taskId: `0x${string}`;
  clientAgentId: bigint;
  providerAgentId: bigint;
  requestHash: `0x${string}`;
  resultHash: `0x${string}`;
  paymentRef: `0x${string}`;
  startedAt: bigint;
  completedAt: bigint;
  proofType: number;
  proofRef: `0x${string}`;
  level: 1 | 2;
  providerSignature: `0x${string}`;
  clientSignature: `0x${string}` | null;
  status: "queued" | "sending";
  anchorLevel: number | null;
  anchorTx: `0x${string}` | null;
  attempts: number;
  /** Last change of the row; for a sending row, when the transaction was sent. */
  updatedAt: Date;
}

export interface AnchorFact {
  /** Level now on-chain. */
  level: number;
  txHash: string | null;
  blockNumber: bigint | null;
  anchoredAt: Date;
}

export function createAnchorRepository(db: pg.Pool, appSchema: string) {
  const receipts = table(appSchema, "receipt");

  return {
    async selectDue(chainId: number, limit: number): Promise<DueReceipt[]> {
      const r = await db.query(
        `SELECT receipt_hash, chain_id, registry, task_id, client_agent_id::text, provider_agent_id::text, request_hash,
                result_hash, payment_ref, started_at::text, completed_at::text, proof_type, proof_ref, level,
                provider_signature, client_signature, anchor_status, anchor_level, anchor_tx, anchor_attempts, updated_at
           FROM ${receipts}
          WHERE chain_id = $1 AND anchor_status IN ('queued', 'sending') AND next_anchor_at <= now()
          ORDER BY next_anchor_at
          LIMIT $2`,
        [chainId, limit],
      );
      return r.rows.map((row) => ({
        receiptHash: row.receipt_hash,
        chainId: row.chain_id,
        registry: row.registry,
        taskId: row.task_id,
        clientAgentId: BigInt(row.client_agent_id),
        providerAgentId: BigInt(row.provider_agent_id),
        requestHash: row.request_hash,
        resultHash: row.result_hash,
        paymentRef: row.payment_ref,
        startedAt: BigInt(row.started_at),
        completedAt: BigInt(row.completed_at),
        proofType: row.proof_type,
        proofRef: row.proof_ref,
        level: row.level,
        providerSignature: row.provider_signature,
        clientSignature: row.client_signature,
        status: row.anchor_status,
        anchorLevel: row.anchor_level,
        anchorTx: row.anchor_tx,
        attempts: row.anchor_attempts,
        updatedAt: row.updated_at,
      }));
    },

    /** Relayer anchors in the last 24 h for a provider agent (the per-agent relay cap). */
    async relayedInLastDay(chainId: number, providerAgentId: bigint): Promise<number> {
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${receipts}
          WHERE chain_id = $1 AND provider_agent_id = $2 AND anchor_tx IS NOT NULL AND updated_at > now() - interval '24 hours'`,
        [chainId, providerAgentId.toString()],
      );
      return Number(r.rows[0]?.n ?? 0);
    },

    /** Records the sent transaction before waiting, so a restart checks it instead of sending again. */
    async markSending(receiptHash: string, txHash: string): Promise<void> {
      await db.query(
        `UPDATE ${receipts} SET anchor_status = 'sending', anchor_tx = $2, anchor_attempts = anchor_attempts + 1,
                anchor_error = NULL, updated_at = now(), next_anchor_at = now() + interval '30 seconds'
          WHERE receipt_hash = $1`,
        [receiptHash, txHash],
      );
    },

    /**
     * Records the on-chain level. If the stored level is higher (a co-signature
     * arrived meanwhile), the row goes back to the queue to relay it.
     */
    async markAnchored(receiptHash: string, fact: AnchorFact): Promise<void> {
      await db.query(
        `UPDATE ${receipts}
            SET anchor_level = $2, anchor_tx = COALESCE($3, anchor_tx), anchor_block = COALESCE($4, anchor_block),
                anchored_at = COALESCE(anchored_at, $5), anchor_error = NULL, anchor_attempts = 0, updated_at = now(),
                anchor_status = CASE WHEN level > $2 THEN 'queued' ELSE 'anchored' END,
                next_anchor_at = now()
          WHERE receipt_hash = $1`,
        [receiptHash, fact.level, fact.txHash, fact.blockNumber?.toString() ?? null, fact.anchoredAt],
      );
    },

    /** The contract rejects this receipt; retrying cannot help. */
    async markFailed(receiptHash: string, error: string): Promise<void> {
      await db.query(
        `UPDATE ${receipts} SET anchor_status = 'failed', anchor_error = $2, updated_at = now() WHERE receipt_hash = $1`,
        [receiptHash, error.slice(0, 500)],
      );
    },

    /** Not relayed (e.g. relay cap); the signers can still anchor it themselves. */
    async markSkipped(receiptHash: string, reason: string): Promise<void> {
      await db.query(
        `UPDATE ${receipts} SET anchor_status = 'skipped', anchor_error = $2, updated_at = now() WHERE receipt_hash = $1`,
        [receiptHash, reason.slice(0, 500)],
      );
    },

    /** Transient problem (RPC, pending transaction): try again after `delayMs`. */
    async retryLater(receiptHash: string, error: string | null, delayMs: number, opts: { countAttempt: boolean; requeue?: boolean }): Promise<void> {
      await db.query(
        `UPDATE ${receipts}
            SET anchor_error = COALESCE($2, anchor_error),
                anchor_attempts = anchor_attempts + $4::int,
                anchor_status = CASE WHEN $5::boolean THEN 'queued' ELSE anchor_status END,
                next_anchor_at = now() + make_interval(secs => $3::double precision / 1000)
          WHERE receipt_hash = $1`,
        [receiptHash, error?.slice(0, 500) ?? null, delayMs, opts.countAttempt ? 1 : 0, opts.requeue ?? false],
      );
    },
  };
}

export type AnchorRepository = ReturnType<typeof createAnchorRepository>;
