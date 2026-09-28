import type { AgentLiveness, AgentService, EndpointLiveness, EndpointLivenessStatus } from "@moltforest/types";
import { table, type Db } from "../db.js";

interface EndpointRow {
  url: string;
  status: string;
  http_status: number | null;
  latency_ms: number | null;
  payment_required: boolean;
  error: string | null;
  last_checked_at: Date;
  last_up_at: Date | null;
  checks7d: string;
  up7d: string;
  latency_sum7d: string;
}

const isHttp = (endpoint: string) => /^https?:\/\//i.test(endpoint);

export function httpEndpoints(services: AgentService[]): string[] {
  return [...new Set(services.map((s) => s.endpoint).filter(isHttp))];
}

/** Reads the enrichment worker's liveness tables for a set of endpoint URLs. */
export function createLivenessRepository(db: Db, appSchema: string) {
  const status = table(appSchema, "endpoint_status");
  const daily = table(appSchema, "endpoint_uptime_daily");

  async function load(urls: string[]): Promise<Map<string, EndpointLiveness>> {
    const out = new Map<string, EndpointLiveness>();
    if (urls.length === 0) return out;
    const r = await db.query<EndpointRow>(
      `SELECT e.url, e.status, e.http_status, e.latency_ms, e.payment_required, e.error, e.last_checked_at, e.last_up_at,
              COALESCE(sum(d.checks), 0) AS checks7d, COALESCE(sum(d.up), 0) AS up7d, COALESCE(sum(d.latency_ms_sum), 0) AS latency_sum7d
         FROM ${status} e
         LEFT JOIN ${daily} d ON d.url = e.url AND d.day >= (now() AT TIME ZONE 'UTC')::date - 6
        WHERE e.url = ANY($1)
        GROUP BY e.url`,
      [urls],
    );
    for (const row of r.rows) {
      const checks = Number(row.checks7d);
      const up = Number(row.up7d);
      out.set(row.url, {
        url: row.url,
        status: (row.status === "blocked" ? "not_public" : row.status) as EndpointLivenessStatus,
        httpStatus: row.http_status,
        latencyMs: row.latency_ms,
        paymentRequired: row.payment_required,
        error: row.error,
        lastCheckedAt: row.last_checked_at.toISOString(),
        lastUpAt: row.last_up_at?.toISOString() ?? null,
        uptime7d: checks > 0 ? up / checks : null,
        checks7d: checks,
        avgLatencyMs7d: up > 0 ? Math.round(Number(row.latency_sum7d) / up) : null,
      });
    }
    return out;
  }

  const unchecked = (url: string): EndpointLiveness => ({
    url,
    status: "unchecked",
    httpStatus: null,
    latencyMs: null,
    paymentRequired: false,
    error: null,
    lastCheckedAt: null,
    lastUpAt: null,
    uptime7d: null,
    checks7d: 0,
    avgLatencyMs7d: null,
  });

  function summarize(endpoints: EndpointLiveness[]): AgentLiveness {
    const checked = endpoints.filter((e) => e.status !== "unchecked");
    const measured = checked.filter((e) => e.status !== "not_public");
    const checks7d = measured.reduce((n, e) => n + e.checks7d, 0);
    const up7d = measured.reduce((n, e) => n + (e.uptime7d ?? 0) * e.checks7d, 0);
    return {
      endpoints: endpoints.length,
      checked: checked.length,
      up: checked.filter((e) => e.status === "up").length,
      notPublic: checked.filter((e) => e.status === "not_public").length,
      paymentRequired: checked.filter((e) => e.paymentRequired).length,
      uptime7d: checks7d > 0 ? up7d / checks7d : null,
      checks7d,
    };
  }

  return {
    /** Per-agent endpoint details, one entry per declared http(s) endpoint. */
    async forServices(services: AgentService[]): Promise<EndpointLiveness[]> {
      const urls = httpEndpoints(services);
      const found = await load(urls);
      return urls.map((u) => found.get(u) ?? unchecked(u));
    },

    /** Liveness roll-ups for many agents in one query. */
    async summaries(servicesByAgent: AgentService[][]): Promise<AgentLiveness[]> {
      const found = await load([...new Set(servicesByAgent.flatMap(httpEndpoints))]);
      return servicesByAgent.map((services) => summarize(httpEndpoints(services).map((u) => found.get(u) ?? unchecked(u))));
    },

    summarize,
  };
}

export type LivenessRepository = ReturnType<typeof createLivenessRepository>;
