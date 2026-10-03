import type pg from "pg";
import { table } from "../enrich/repository.js";
import type { ChainReceipt } from "./decode.js";

export type ApplyOutcome = "inserted" | "updated" | "orphan";

export function createReceiptEventRepository(db: pg.Pool, appSchema: string) {
  const receipts = table(appSchema, "receipt");
  const cursors = table(appSchema, "chain_scan_cursor");

  return {
    async getCursor(name: string, chainId: number): Promise<number | null> {
      const r = await db.query<{ next_block: string }>(`SELECT next_block::text FROM ${cursors} WHERE name = $1 AND chain_id = $2`, [name, chainId]);
      return r.rows[0] ? Number(r.rows[0].next_block) : null;
    },

    async setCursor(name: string, chainId: number, nextBlock: number): Promise<void> {
      await db.query(
        `INSERT INTO ${cursors} (name, chain_id, next_block, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (name, chain_id) DO UPDATE SET next_block = EXCLUDED.next_block, updated_at = now()`,
        [name, chainId, nextBlock],
      );
    },

    /**
     * Records an on-chain anchor. A receipt MoltForest already has (submitted
     * through the API) is marked anchored, never lowered: levels and signatures
     * only grow. An unknown receipt is inserted with source "chain".
     */
    async apply(chainId: number, registry: string, r: ChainReceipt): Promise<ApplyOutcome> {
      if (r.providerSigner === null) {
        // ReceiptCoSigned: raises a receipt anchored earlier (its ReceiptAnchored came first).
        const u = await db.query(
          `UPDATE ${receipts}
              SET level = 2, client_signature = COALESCE(client_signature, $2), client_signer = COALESCE(client_signer, $3),
                  anchor_level = 2, anchor_status = 'anchored', anchor_tx = $4, anchor_block = $5,
                  anchored_at = COALESCE(anchored_at, $6), anchor_error = NULL, updated_at = now()
            WHERE receipt_hash = $1`,
          [r.receiptHash, r.clientSignature, r.clientSigner, r.tx, r.block, r.blockTime],
        );
        return (u.rowCount ?? 0) > 0 ? "updated" : "orphan";
      }
      const j = r.receipt;
      const res = await db.query<{ inserted: boolean }>(
        `INSERT INTO ${receipts} AS t (receipt_hash, chain_id, registry, task_id, client_agent_id, provider_agent_id, request_hash, result_hash,
             payment_ref, started_at, completed_at, proof_type, proof_ref, level, provider_signature, client_signature, provider_signer,
             client_signer, submitted_at, anchor_status, anchor_level, anchor_tx, anchor_block, anchored_at, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'anchored', $14, $20, $21, $19, 'chain')
         ON CONFLICT (receipt_hash) DO UPDATE SET
           level = GREATEST(t.level, EXCLUDED.level),
           client_signature = COALESCE(t.client_signature, EXCLUDED.client_signature),
           client_signer = COALESCE(t.client_signer, EXCLUDED.client_signer),
           anchor_level = GREATEST(COALESCE(t.anchor_level, 0), EXCLUDED.anchor_level),
           anchor_status = CASE WHEN GREATEST(t.level, EXCLUDED.level) > GREATEST(COALESCE(t.anchor_level, 0), EXCLUDED.anchor_level)
                                THEN t.anchor_status ELSE 'anchored' END,
           anchor_tx = CASE WHEN EXCLUDED.anchor_level >= COALESCE(t.anchor_level, 0) THEN EXCLUDED.anchor_tx ELSE t.anchor_tx END,
           anchor_block = CASE WHEN EXCLUDED.anchor_level >= COALESCE(t.anchor_level, 0) THEN EXCLUDED.anchor_block ELSE t.anchor_block END,
           anchored_at = COALESCE(t.anchored_at, EXCLUDED.anchored_at),
           anchor_error = NULL,
           updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [
          r.receiptHash,
          chainId,
          registry.toLowerCase(),
          j.taskId,
          j.clientAgentId,
          j.providerAgentId,
          j.requestHash,
          j.resultHash,
          j.paymentRef,
          j.startedAt,
          j.completedAt,
          j.proofType,
          j.proofRef,
          r.level,
          r.providerSignature,
          r.clientSignature,
          r.providerSigner,
          r.clientSigner,
          r.blockTime,
          r.tx,
          r.block,
        ],
      );
      return res.rows[0]?.inserted ? "inserted" : "updated";
    },
  };
}

export type ReceiptEventRepository = ReturnType<typeof createReceiptEventRepository>;
