import { NETWORKS, type NetworkName } from "@moltforest/chain";
import { table, type Db } from "../db.js";

export interface IndexerProgress {
  startBlock: string;
  progressBlock: string;
  chainHeadBlock: string;
  eventsProcessed: string;
  readyAt: Date | null;
  usingHyperSync: boolean;
  progressBlockTime: Date | null;
}

export interface AgentIndexStats {
  indexedCount: number;
  highestIndexedAgentId: string | null;
}

/** Reads Envio's own bookkeeping table (envio_chains) and the Agent table. */
export function createSyncRepository(db: Db, schema: string) {
  const chains = table(schema, "envio_chains");
  const agents = table(schema, "Agent");

  return {
    async progress(network: NetworkName): Promise<IndexerProgress | null> {
      const r = await db.query<{
        start_block: string;
        progress_block: string;
        source_block: string;
        events_processed: string;
        ready_at: Date | null;
        _is_hyper_sync: boolean;
        progress_block_time: Date | null;
      }>(
        `SELECT start_block, progress_block, source_block, events_processed, ready_at, _is_hyper_sync, progress_block_time
           FROM ${chains} WHERE id = $1`,
        [NETWORKS[network].chainId],
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        startBlock: String(row.start_block),
        progressBlock: String(row.progress_block),
        chainHeadBlock: String(row.source_block),
        eventsProcessed: String(row.events_processed),
        readyAt: row.ready_at,
        usingHyperSync: row._is_hyper_sync,
        progressBlockTime: row.progress_block_time,
      };
    },

    async agentStats(network: NetworkName): Promise<AgentIndexStats> {
      const r = await db.query<{ count: string; max: string | null }>(
        `SELECT count(*), max(agent_id) FROM ${agents} WHERE chain_id = $1`,
        [NETWORKS[network].chainId],
      );
      return { indexedCount: Number(r.rows[0]?.count ?? 0), highestIndexedAgentId: r.rows[0]?.max ?? null };
    },
  };
}

export type SyncRepository = ReturnType<typeof createSyncRepository>;

/** Postgres "relation/schema does not exist": the indexer has not created its tables yet. */
export function isMissingRelation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42P01" || code === "3F000";
}
