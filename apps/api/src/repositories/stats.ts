import { NETWORKS, type NetworkName } from "@moltforest/chain";
import { table, type Db } from "../db.js";
import { createSyncRepository, isMissingRelation, type IndexerProgress } from "./sync.js";

/** Raw network-wide counts behind GET /v1/stats. A part is null while its table does not exist yet. */
export interface NetworkCounts {
  /** How far the ERC-8004 index has processed the chain. */
  progress: IndexerProgress | null;
  agents: number | null;
  /** Non-revoked reviews. */
  reviews: number | null;
  /** Sums of the per-agent review assessments (D31). */
  assessed: { counted: number; verified: number; pendingReviewers: number } | null;
  /**
   * `nextBlock`: payments are complete below it for every address that has caught up (null: never scanned).
   * `pendingAddresses`: agent addresses whose history is not backfilled yet.
   */
  payments: { x402: number; nextBlock: string | null; pendingAddresses: number } | null;
  receipts: { total: number; coSigned: number; anchored: number } | null;
}

/** Null instead of an error while a table does not exist yet (fresh database, indexer not started). */
async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    if (isMissingRelation(err)) return null;
    throw err;
  }
}

export function createStatsRepository(db: Db, schemas: { indexer: string; app: string }) {
  const sync = createSyncRepository(db, schemas.indexer);
  const feedback = table(schemas.indexer, "Feedback");
  const summaries = table(schemas.app, "agent_review_summary");
  const payments = table(schemas.app, "x402_payment");
  const paymentCursor = table(schemas.app, "payment_cursor");
  const paymentAddresses = table(schemas.app, "payment_address");
  const receipts = table(schemas.app, "receipt");

  /** The single row of an aggregate query over one chain. */
  async function row<T>(sql: string, chainId: number): Promise<T> {
    return (await db.query(sql, [chainId])).rows[0] as T;
  }

  return {
    async counts(network: NetworkName): Promise<NetworkCounts> {
      const chainId = NETWORKS[network].chainId;
      const [progress, agents, reviews, assessed, x402, receiptCounts] = await Promise.all([
        orNull(() => sync.progress(network)),
        orNull(async () => (await sync.agentStats(network)).indexedCount),
        orNull(async () => {
          const r = await row<{ total: string }>(`SELECT count(*) AS total FROM ${feedback} WHERE chain_id = $1 AND NOT revoked`, chainId);
          return Number(r.total);
        }),
        orNull(async () => {
          const r = await row<{ counted: string; verified: string; pending: string }>(
            `SELECT coalesce(sum(counted_reviews), 0) AS counted, coalesce(sum(verified_reviews), 0) AS verified,
                    coalesce(sum(pending_reviewers), 0) AS pending
               FROM ${summaries} WHERE chain_id = $1`,
            chainId,
          );
          return { counted: Number(r.counted), verified: Number(r.verified), pendingReviewers: Number(r.pending) };
        }),
        orNull(async () => {
          const r = await row<{ x402: string; next_block: string | null; pending: string }>(
            `SELECT (SELECT count(*) FROM ${payments} WHERE chain_id = $1) AS x402,
                    (SELECT next_block FROM ${paymentCursor} WHERE chain_id = $1) AS next_block,
                    (SELECT count(*) FROM ${paymentAddresses} WHERE chain_id = $1 AND NOT caught_up) AS pending`,
            chainId,
          );
          return { x402: Number(r.x402), nextBlock: r.next_block === null ? null : String(r.next_block), pendingAddresses: Number(r.pending) };
        }),
        orNull(async () => {
          const r = await row<{ total: string; co_signed: string; anchored: string }>(
            `SELECT count(*) AS total, count(*) FILTER (WHERE level = 2) AS co_signed,
                    count(*) FILTER (WHERE anchor_status = 'anchored') AS anchored
               FROM ${receipts} WHERE chain_id = $1`,
            chainId,
          );
          return { total: Number(r.total), coSigned: Number(r.co_signed), anchored: Number(r.anchored) };
        }),
      ]);
      return { progress, agents, reviews, assessed, payments: x402, receipts: receiptCounts };
    },
  };
}

export type StatsRepository = ReturnType<typeof createStatsRepository>;
