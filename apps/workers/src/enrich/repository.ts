import type pg from "pg";
import type { EnrichTarget, ProfileRow } from "./enrichAgent.js";

const REMOTE_KINDS = ["https", "http", "ipfs"];

/** Quotes validated identifiers, e.g. "envio"."Agent". */
export function table(schema: string, name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema) || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(`unsafe identifier ${schema}.${name}`);
  }
  return `"${schema}"."${name}"`;
}

/** Postgres rejects \u0000 inside jsonb/text; registration files occasionally contain it. */
const pgSafeJson = (value: unknown) => JSON.stringify(value).replace(/\\u0000/g, "");

export function createProfileRepository(db: pg.Pool, schemas: { indexer: string; app: string }) {
  const agents = table(schemas.indexer, "Agent");
  const profiles = table(schemas.app, "agent_profile");
  const snapshots = table(schemas.app, "agent_profile_snapshot");

  return {
    /**
     * Agents whose remote registration file needs fetching: never fetched, URI
     * changed since the last fetch, or refresh due. New and changed URIs come
     * first (newest agents first), then the most overdue refreshes.
     */
    async selectDue(limit: number): Promise<EnrichTarget[]> {
      const r = await db.query<{
        chain_id: number;
        agent_id: string;
        agent_uri: string;
        uri_kind: string;
        p_uri: string | null;
        content_hash: string | null;
        failures: number | null;
        change_count: number | null;
        first_fetched_at: Date | null;
        last_ok_at: Date | null;
        last_changed_at: Date | null;
      }>(
        `SELECT a.chain_id, a.agent_id::text AS agent_id, a.agent_uri, a.uri_kind,
                p.uri AS p_uri, p.content_hash, p.failures, p.change_count,
                p.first_fetched_at, p.last_ok_at, p.last_changed_at
           FROM ${agents} a
           LEFT JOIN ${profiles} p ON p.chain_id = a.chain_id AND p.agent_id = a.agent_id
          WHERE a.uri_kind = ANY($1)
            AND (p.agent_id IS NULL OR p.uri <> a.agent_uri OR p.next_fetch_at <= now())
          ORDER BY (p.agent_id IS NULL OR p.uri <> a.agent_uri) DESC,
                   p.next_fetch_at ASC NULLS FIRST,
                   a.agent_id DESC
          LIMIT $2`,
        [REMOTE_KINDS, limit],
      );
      return r.rows.map((row) => ({
        chainId: row.chain_id,
        agentId: row.agent_id,
        uri: row.agent_uri,
        uriKind: row.uri_kind,
        previous:
          row.p_uri === null
            ? null
            : {
                uri: row.p_uri,
                contentHash: row.content_hash,
                failures: row.failures ?? 0,
                changeCount: row.change_count ?? 0,
                firstFetchedAt: row.first_fetched_at,
                lastOkAt: row.last_ok_at,
                lastChangedAt: row.last_changed_at,
              },
      }));
    },

    async save(row: ProfileRow, snapshot: { contentHash: string; document: unknown } | null): Promise<void> {
      const f = row.fields;
      // When fields is null (transient failure, same URI) the stored profile fields are kept.
      await db.query(
        `INSERT INTO ${profiles} AS p (chain_id, agent_id, uri, uri_kind, fetch_url, status, http_status, error, content_hash,
            name, description, image, services, service_count, x402_support, active, supported_trust,
            first_fetched_at, fetched_at, last_ok_at, next_fetch_at, failures, change_count, last_changed_at)
         VALUES ($1, $2::numeric, $3, $4, $5, $6, $7, $8, $9,
            $10, $11, $12, COALESCE($13::jsonb, '[]'::jsonb), COALESCE($14, 0), $15, $16, COALESCE($17::text[], '{}'::text[]),
            $18, $19, $20, $21, $22, $23, $24)
         ON CONFLICT (chain_id, agent_id) DO UPDATE SET
            uri = EXCLUDED.uri, uri_kind = EXCLUDED.uri_kind, fetch_url = EXCLUDED.fetch_url, status = EXCLUDED.status,
            http_status = EXCLUDED.http_status, error = EXCLUDED.error, content_hash = EXCLUDED.content_hash,
            name          = CASE WHEN $25 THEN EXCLUDED.name          ELSE p.name END,
            description   = CASE WHEN $25 THEN EXCLUDED.description   ELSE p.description END,
            image         = CASE WHEN $25 THEN EXCLUDED.image         ELSE p.image END,
            services      = CASE WHEN $25 THEN EXCLUDED.services      ELSE p.services END,
            service_count = CASE WHEN $25 THEN EXCLUDED.service_count ELSE p.service_count END,
            x402_support  = CASE WHEN $25 THEN EXCLUDED.x402_support  ELSE p.x402_support END,
            active        = CASE WHEN $25 THEN EXCLUDED.active        ELSE p.active END,
            supported_trust = CASE WHEN $25 THEN EXCLUDED.supported_trust ELSE p.supported_trust END,
            first_fetched_at = EXCLUDED.first_fetched_at, fetched_at = EXCLUDED.fetched_at, last_ok_at = EXCLUDED.last_ok_at,
            next_fetch_at = EXCLUDED.next_fetch_at, failures = EXCLUDED.failures,
            change_count = EXCLUDED.change_count, last_changed_at = EXCLUDED.last_changed_at`,
        [
          row.chainId,
          row.agentId,
          row.uri,
          row.uriKind,
          row.fetchUrl,
          row.status,
          row.httpStatus,
          row.error,
          row.contentHash,
          f?.name ?? null,
          f?.description ?? null,
          f?.image ?? null,
          f ? pgSafeJson(f.services) : null,
          f?.serviceCount ?? null,
          f?.x402Support ?? null,
          f?.active ?? null,
          f?.supportedTrust ?? null,
          row.firstFetchedAt,
          row.fetchedAt,
          row.lastOkAt,
          row.nextFetchAt,
          row.failures,
          row.changeCount,
          row.lastChangedAt,
          f !== null,
        ],
      );
      if (snapshot) {
        await db.query(
          `INSERT INTO ${snapshots} (chain_id, agent_id, content_hash, uri, document)
           VALUES ($1, $2::numeric, $3, $4, $5::jsonb) ON CONFLICT DO NOTHING`,
          [row.chainId, row.agentId, snapshot.contentHash, row.uri, pgSafeJson(snapshot.document)],
        );
      }
    },
  };
}

export type ProfileRepository = ReturnType<typeof createProfileRepository>;
