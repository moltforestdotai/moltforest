import { NETWORKS, type NetworkName } from "@moltforest/chain";
import type { ActivityEvent, ActivityType } from "@moltforest/types";
import { table, type Db } from "../db.js";

interface EventRow {
  type: ActivityType;
  agent_id: string;
  block_number: string;
  ts: Date;
  tx_hash: string;
  actor: string;
  key: string;
  value: string | null;
  value_decimals: number | null;
  label: string | null;
}

function formatValue(value: string, decimals: number): string {
  if (decimals === 0) return value;
  const n = Number(value) / 10 ** decimals;
  return Number.isFinite(n) ? String(n) : value;
}

/**
 * On-chain activity from the indexer's tables. Block bounds let the live stream
 * emit only blocks the indexer has fully processed.
 */
export function createActivityRepository(db: Db, schemas: { indexer: string; app: string }) {
  const agents = table(schemas.indexer, "Agent");
  const uriChanges = table(schemas.indexer, "AgentUriChange");
  const feedback = table(schemas.indexer, "Feedback");
  const profiles = table(schemas.app, "agent_profile");

  async function names(chainId: number, agentIds: string[]): Promise<Map<string, string>> {
    if (agentIds.length === 0) return new Map();
    const r = await db.query<{ agent_id: string; name: string | null }>(
      `SELECT a.agent_id::text AS agent_id,
              CASE WHEN a.uri_kind IN ('https', 'http', 'ipfs') THEN p.name ELSE a.name END AS name
         FROM ${agents} a
         LEFT JOIN ${profiles} p ON p.chain_id = a.chain_id AND p.agent_id = a.agent_id AND p.uri = a.agent_uri AND p.last_ok_at IS NOT NULL
        WHERE a.chain_id = $1 AND a.agent_id = ANY($2::numeric[])`,
      [chainId, agentIds],
    );
    return new Map(r.rows.filter((row) => row.name).map((row) => [row.agent_id, row.name!]));
  }

  return {
    /** Newest first. `after`/`upTo` bound block numbers (exclusive/inclusive). */
    async list(network: NetworkName, opts: { limit: number; after?: string; upTo?: string }): Promise<ActivityEvent[]> {
      const chainId = NETWORKS[network].chainId;
      const values: unknown[] = [chainId, opts.after ?? "-1", opts.upTo ?? null, opts.limit];
      const bound = (col: string) => `chain_id = $1 AND ${col} > $2::numeric AND ($3::numeric IS NULL OR ${col} <= $3::numeric)`;
      const r = await db.query<EventRow>(
        `SELECT * FROM (
           SELECT 'agent_registered' AS type, agent_id::text AS agent_id, registered_block AS block_number, registered_at AS ts,
                  registered_tx AS tx_hash, owner AS actor, id AS key, NULL::numeric AS value, NULL::int AS value_decimals, NULL AS label
             FROM ${agents} WHERE ${bound("registered_block")}
           UNION ALL
           SELECT 'profile_updated', agent_id, block_number, "timestamp", tx_hash, updated_by, id, NULL, NULL, uri_kind
             FROM ${uriChanges} WHERE ${bound("block_number")}
           UNION ALL
           SELECT 'feedback_given', agent_id, block_number, "timestamp", tx_hash, client, id, value, value_decimals, NULLIF(tag1, '')
             FROM ${feedback} WHERE ${bound("block_number")}
         ) events
         ORDER BY block_number DESC, key DESC
         LIMIT $4`,
        values,
      );
      const agentNames = await names(chainId, [...new Set(r.rows.map((row) => row.agent_id))]);
      return r.rows.map((row) => ({
        id: `${chainId}:${row.type}:${row.key}`,
        network,
        chainId,
        type: row.type,
        agentId: row.agent_id,
        agentName: agentNames.get(row.agent_id) ?? null,
        actor: row.actor,
        blockNumber: String(row.block_number),
        timestamp: row.ts.toISOString(),
        txHash: row.tx_hash,
        detail:
          row.type === "feedback_given" && row.value !== null
            ? [formatValue(row.value, row.value_decimals ?? 0), row.label].filter(Boolean).join(" · ")
            : row.type === "profile_updated"
              ? row.label
              : null,
      }));
    },
  };
}

export type ActivityRepository = ReturnType<typeof createActivityRepository>;
