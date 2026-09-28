import type pg from "pg";
import { table } from "../enrich/repository.js";
import type { ProbeResult } from "./policy.js";

export interface DueEndpoint {
  url: string;
  host: string;
  consecutiveFailures: number;
  firstCheckedAt: Date | null;
  lastUpAt: Date | null;
  paymentRequired: boolean;
}

/**
 * Declared http(s) service endpoints are read from each agent's *effective*
 * registration: inline fields from the indexer, remote ones from a valid
 * app.agent_profile for the agent's current URI.
 */
function declaredEndpointsSql(indexer: string, app: string): string {
  return `
    SELECT DISTINCT s->>'endpoint' AS url
      FROM ${table(indexer, "Agent")} a
      LEFT JOIN ${table(app, "agent_profile")} p
        ON p.chain_id = a.chain_id AND p.agent_id = a.agent_id AND p.uri = a.agent_uri AND p.last_ok_at IS NOT NULL
     CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN a.uri_kind IN ('https', 'http', 'ipfs') THEN COALESCE(p.services, '[]'::jsonb) ELSE a.services END
     ) AS s
     WHERE s->>'endpoint' ~* '^https?://' AND length(s->>'endpoint') <= 2048`;
}

export function createLivenessRepository(db: pg.Pool, schemas: { indexer: string; app: string }) {
  const status = table(schemas.app, "endpoint_status");
  const daily = table(schemas.app, "endpoint_uptime_daily");

  return {
    /** Endpoints currently declared by some agent that were never checked or are due. */
    async selectDue(limit: number): Promise<DueEndpoint[]> {
      const r = await db.query<{
        url: string;
        consecutive_failures: number | null;
        first_checked_at: Date | null;
        last_up_at: Date | null;
        payment_required: boolean | null;
      }>(
        `WITH declared AS (${declaredEndpointsSql(schemas.indexer, schemas.app)})
         SELECT d.url, e.consecutive_failures, e.first_checked_at, e.last_up_at, e.payment_required
           FROM declared d
           LEFT JOIN ${status} e ON e.url = d.url
          WHERE e.url IS NULL OR e.next_check_at <= now()
          ORDER BY e.next_check_at ASC NULLS FIRST
          LIMIT $1`,
        [limit],
      );
      return r.rows.map((row) => {
        let host = "invalid";
        try {
          host = new URL(row.url).host.toLowerCase();
        } catch {
          /* recorded as blocked by the probe */
        }
        return {
          url: row.url,
          host,
          consecutiveFailures: row.consecutive_failures ?? 0,
          firstCheckedAt: row.first_checked_at,
          lastUpAt: row.last_up_at,
          paymentRequired: row.payment_required ?? false,
        };
      });
    },

    async save(endpoint: DueEndpoint, result: ProbeResult, checkedAt: Date, nextCheckAt: Date): Promise<void> {
      const up = result.status === "up";
      await db.query(
        `INSERT INTO ${status} (url, host, status, http_status, latency_ms, payment_required, error,
            first_checked_at, last_checked_at, last_up_at, next_check_at, consecutive_failures)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (url) DO UPDATE SET
            host = EXCLUDED.host, status = EXCLUDED.status, http_status = EXCLUDED.http_status,
            latency_ms = EXCLUDED.latency_ms, payment_required = EXCLUDED.payment_required, error = EXCLUDED.error,
            last_checked_at = EXCLUDED.last_checked_at, last_up_at = EXCLUDED.last_up_at,
            next_check_at = EXCLUDED.next_check_at, consecutive_failures = EXCLUDED.consecutive_failures`,
        [
          endpoint.url,
          endpoint.host,
          result.status,
          result.httpStatus,
          result.latencyMs,
          endpoint.paymentRequired || result.paymentRequired,
          result.error,
          endpoint.firstCheckedAt ?? checkedAt,
          checkedAt,
          up ? checkedAt : endpoint.lastUpAt,
          nextCheckAt,
          up ? 0 : endpoint.consecutiveFailures + 1,
        ],
      );
      // Blocked endpoints are not a reachability measurement; keep them out of uptime.
      if (result.status === "blocked") return;
      await db.query(
        `INSERT INTO ${daily} AS d (url, day, checks, up, latency_ms_sum, latency_ms_max)
         VALUES ($1, ($2::timestamptz AT TIME ZONE 'UTC')::date, 1, $3::int, $4::bigint, $5::int)
         ON CONFLICT (url, day) DO UPDATE SET
            checks = d.checks + 1,
            up = d.up + EXCLUDED.up,
            latency_ms_sum = d.latency_ms_sum + EXCLUDED.latency_ms_sum,
            latency_ms_max = GREATEST(d.latency_ms_max, EXCLUDED.latency_ms_max)`,
        [endpoint.url, checkedAt, up ? 1 : 0, up ? (result.latencyMs ?? 0) : 0, up ? (result.latencyMs ?? 0) : 0],
      );
    },
  };
}

export type LivenessRepository = ReturnType<typeof createLivenessRepository>;
