import { networkByChainId } from "@moltforest/chain";
import type { AgentReceiptSummary, ReceiptAnchorStatus, ReceiptLevel, ReceiptRole, ReceiptView } from "@moltforest/types";
import { proofTypeName } from "@moltforest/receipts";
import { table, type Db } from "../db.js";
import { isMissingRelation } from "./sync.js";

export const EMPTY_RECEIPT_SUMMARY: AgentReceiptSummary = { total: 0, coSigned: 0, anchored: 0, lastCompletedAt: null };

/** app.receipt row as node-postgres returns it (NUMERIC and INT8 as strings). */
export interface ReceiptRow {
  receipt_hash: string;
  chain_id: number;
  registry: string;
  task_id: string;
  client_agent_id: string;
  provider_agent_id: string;
  request_hash: string;
  result_hash: string;
  payment_ref: string;
  started_at: string;
  completed_at: string;
  proof_type: number;
  proof_ref: string;
  level: ReceiptLevel;
  provider_signature: string;
  client_signature: string | null;
  provider_signer: string;
  client_signer: string | null;
  submitted_at: Date;
  anchor_status: ReceiptAnchorStatus;
  anchor_level: ReceiptLevel | null;
  anchor_tx: string | null;
  anchor_block: string | null;
  anchored_at: Date | null;
  anchor_error: string | null;
  source: "api" | "chain";
}

export type NewReceipt = Omit<
  ReceiptRow,
  "submitted_at" | "anchor_status" | "anchor_level" | "anchor_tx" | "anchor_block" | "anchored_at" | "anchor_error" | "source"
>;

/** Keyset position in newest-first order. `submittedAt` is written with millisecond precision. */
export interface ReceiptCursor {
  submittedAt: string;
  receiptHash: string;
}

const COLUMNS = `receipt_hash, chain_id, registry, task_id, client_agent_id, provider_agent_id, request_hash, result_hash,
  payment_ref, started_at, completed_at, proof_type, proof_ref, level, provider_signature, client_signature,
  provider_signer, client_signer, submitted_at, anchor_status, anchor_level, anchor_tx, anchor_block, anchored_at, anchor_error, source`;

export function createReceiptRepository(db: Db, appSchema: string) {
  const receipts = table(appSchema, "receipt");

  return {
    async get(receiptHash: string): Promise<ReceiptRow | null> {
      const r = await db.query<ReceiptRow>(`SELECT ${COLUMNS} FROM ${receipts} WHERE receipt_hash = $1`, [receiptHash]);
      return r.rows[0] ?? null;
    },

    /** Inserts a verified receipt; false when the hash already exists. */
    async insert(row: NewReceipt): Promise<boolean> {
      const r = await db.query(
        `INSERT INTO ${receipts} (receipt_hash, chain_id, registry, task_id, client_agent_id, provider_agent_id, request_hash,
           result_hash, payment_ref, started_at, completed_at, proof_type, proof_ref, level, provider_signature,
           client_signature, provider_signer, client_signer, submitted_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $19)
         ON CONFLICT (receipt_hash) DO NOTHING`,
        [
          row.receipt_hash,
          row.chain_id,
          row.registry,
          row.task_id,
          row.client_agent_id,
          row.provider_agent_id,
          row.request_hash,
          row.result_hash,
          row.payment_ref,
          row.started_at,
          row.completed_at,
          row.proof_type,
          row.proof_ref,
          row.level,
          row.provider_signature,
          row.client_signature,
          row.provider_signer,
          row.client_signer,
          new Date(),
        ],
      );
      return (r.rowCount ?? 0) > 0;
    },

    /**
     * Raises a stored level-1 receipt to level 2 and queues the co-signature for
     * relaying. A transaction already in flight keeps its status; the relayer
     * re-queues after it confirms at level 1. Null when the row is not level 1.
     */
    async addClientSignature(receiptHash: string, signature: string, signer: string): Promise<ReceiptRow | null> {
      const r = await db.query<ReceiptRow>(
        `UPDATE ${receipts}
            SET client_signature = $2, client_signer = $3, level = 2, updated_at = now(),
                anchor_status = CASE WHEN anchor_status = 'sending' THEN 'sending' ELSE 'queued' END,
                anchor_error = NULL, anchor_attempts = 0, next_anchor_at = now()
          WHERE receipt_hash = $1 AND level = 1
          RETURNING ${COLUMNS}`,
        [receiptHash, signature, signer],
      );
      return r.rows[0] ?? null;
    },

    /**
     * Receipt counts per provider agent. Missing table (migrations not applied
     * yet) counts as no receipts, so agent pages keep working.
     */
    async providerSummaries(chainId: number, agentIds: string[]): Promise<Map<string, AgentReceiptSummary>> {
      const out = new Map<string, AgentReceiptSummary>();
      if (agentIds.length === 0) return out;
      try {
        const r = await db.query<{ agent_id: string; total: string; co_signed: string; anchored: string; last_completed: string | null }>(
          `SELECT provider_agent_id::text AS agent_id, count(*)::text AS total,
                  count(*) FILTER (WHERE level = 2)::text AS co_signed,
                  count(*) FILTER (WHERE anchor_status = 'anchored')::text AS anchored,
                  max(completed_at)::text AS last_completed
             FROM ${receipts}
            WHERE chain_id = $1 AND provider_agent_id = ANY($2::numeric[])
            GROUP BY provider_agent_id`,
          [chainId, agentIds],
        );
        for (const row of r.rows) {
          out.set(row.agent_id, {
            total: Number(row.total),
            coSigned: Number(row.co_signed),
            anchored: Number(row.anchored),
            lastCompletedAt: row.last_completed === null ? null : new Date(Number(row.last_completed) * 1000).toISOString(),
          });
        }
      } catch (err) {
        if (!isMissingRelation(err)) throw err;
      }
      return out;
    },

    async listForAgent(params: {
      chainId: number;
      agentId: string;
      role: ReceiptRole;
      limit: number;
      cursor?: ReceiptCursor;
    }): Promise<{ rows: ReceiptRow[]; nextCursor: ReceiptCursor | null }> {
      const values: unknown[] = [params.chainId, params.agentId];
      const role =
        params.role === "provider"
          ? "provider_agent_id = $2"
          : params.role === "client"
            ? "client_agent_id = $2"
            : "(provider_agent_id = $2 OR client_agent_id = $2)";
      let after = "";
      if (params.cursor) {
        values.push(params.cursor.submittedAt, params.cursor.receiptHash);
        after = "AND (submitted_at, receipt_hash) < ($3::timestamptz, $4)";
      }
      values.push(params.limit + 1);
      const r = await db.query<ReceiptRow>(
        `SELECT ${COLUMNS} FROM ${receipts}
          WHERE chain_id = $1 AND ${role} ${after}
          ORDER BY submitted_at DESC, receipt_hash DESC
          LIMIT $${values.length}`,
        values,
      );
      const rows = r.rows.slice(0, params.limit);
      const last = rows.at(-1);
      const nextCursor =
        r.rows.length > params.limit && last ? { submittedAt: last.submitted_at.toISOString(), receiptHash: last.receipt_hash } : null;
      return { rows, nextCursor };
    },
  };
}

export type ReceiptRepository = ReturnType<typeof createReceiptRepository>;

export function toReceiptView(row: ReceiptRow): ReceiptView {
  const network = networkByChainId(row.chain_id);
  if (!network) throw new Error(`receipt ${row.receipt_hash} has unknown chain id ${row.chain_id}`);
  return {
    receiptHash: row.receipt_hash,
    network: network.name,
    chainId: row.chain_id,
    registry: row.registry,
    receipt: {
      taskId: row.task_id,
      clientAgentId: row.client_agent_id,
      providerAgentId: row.provider_agent_id,
      requestHash: row.request_hash,
      resultHash: row.result_hash,
      paymentRef: row.payment_ref,
      startedAt: Number(row.started_at),
      completedAt: Number(row.completed_at),
      proofType: row.proof_type,
      proofRef: row.proof_ref,
    },
    level: row.level,
    claimedProofType: proofTypeName(row.proof_type),
    signatures: { provider: row.provider_signature, client: row.client_signature },
    signers: { provider: row.provider_signer, client: row.client_signer },
    submittedAt: row.submitted_at.toISOString(),
    anchor: {
      status: row.anchor_status,
      level: row.anchor_level,
      txHash: row.anchor_tx,
      blockNumber: row.anchor_block,
      anchoredAt: row.anchored_at?.toISOString() ?? null,
      error: row.anchor_error,
    },
    payment: null,
    source: row.source,
  };
}
