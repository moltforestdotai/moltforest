/**
 * MoltForest-owned tables. They live in the Postgres schema "app"; the indexer
 * owns schema "envio" and nothing here writes to it (decision D21).
 */
import { sql } from "drizzle-orm";
import { bigint, boolean, date, index, integer, jsonb, numeric, pgSchema, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const app = pgSchema("app");

/** Fetch outcome for a remote registration file. */
export type ProfileStatus = "ok" | "invalid" | "too_large" | "unreachable" | "blocked";

/**
 * The latest fetched registration file for each agent whose agentURI is remote
 * (https/http/ipfs). Doubles as the enrichment work queue via next_fetch_at.
 * A row applies to the agent only while `uri` equals the agent's current agentURI.
 */
export const agentProfile = app.table(
  "agent_profile",
  {
    chainId: integer("chain_id").notNull(),
    agentId: numeric("agent_id", { precision: 78, scale: 0, mode: "string" }).notNull(),
    uri: text("uri").notNull(),
    uriKind: text("uri_kind").notNull(),
    fetchUrl: text("fetch_url"),
    status: text("status").$type<ProfileStatus>().notNull(),
    httpStatus: integer("http_status"),
    error: text("error"),
    contentHash: text("content_hash"),
    name: text("name"),
    description: text("description"),
    image: text("image"),
    services: jsonb("services").notNull().default(sql`'[]'::jsonb`),
    serviceCount: integer("service_count").notNull().default(0),
    x402Support: boolean("x402_support"),
    active: boolean("active"),
    supportedTrust: text("supported_trust").array().notNull().default(sql`'{}'::text[]`),
    firstFetchedAt: timestamp("first_fetched_at", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    /**
     * When the parsed fields above were last confirmed for `uri`. Null while no
     * valid file is known for the current URI. A transient failure (timeout,
     * 5xx, 429) keeps the last good fields; a definitive one clears them.
     */
    lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
    nextFetchAt: timestamp("next_fetch_at", { withTimezone: true }).notNull(),
    /** Consecutive failed fetches; drives retry backoff. */
    failures: integer("failures").notNull().default(0),
    /** Times the file content changed after the first successful fetch (churn signal). */
    changeCount: integer("change_count").notNull().default(0),
    lastChangedAt: timestamp("last_changed_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.agentId] }), index("agent_profile_next_fetch_idx").on(t.nextFetchAt)],
);

/**
 * Liveness result of a declared service endpoint.
 * up: any HTTP response below 500 (401/402/404 still prove the server answers) ·
 * error: HTTP 5xx · down: no response (DNS, connect, TLS, timeout) ·
 * blocked: not a public http(s) endpoint (localhost, private IP, bad port…).
 */
export type EndpointStatus = "up" | "error" | "down" | "blocked";

/**
 * Latest liveness check per distinct http(s) endpoint URL, shared by every
 * agent that declares it. Doubles as the liveness work queue (next_check_at).
 */
export const endpointStatus = app.table(
  "endpoint_status",
  {
    url: text("url").primaryKey(),
    host: text("host").notNull(),
    status: text("status").$type<EndpointStatus>().notNull(),
    httpStatus: integer("http_status"),
    latencyMs: integer("latency_ms"),
    /** The endpoint answered 402 Payment Required at least once (x402 paywall). */
    paymentRequired: boolean("payment_required").notNull().default(false),
    error: text("error"),
    firstCheckedAt: timestamp("first_checked_at", { withTimezone: true }).notNull(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }).notNull(),
    lastUpAt: timestamp("last_up_at", { withTimezone: true }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull(),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  },
  (t) => [index("endpoint_status_next_check_idx").on(t.nextCheckAt)],
);

/** Daily roll-up of liveness checks (uptime % and latency without unbounded history). */
export const endpointUptimeDaily = app.table(
  "endpoint_uptime_daily",
  {
    url: text("url").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    checks: integer("checks").notNull().default(0),
    up: integer("up").notNull().default(0),
    latencyMsSum: bigint("latency_ms_sum", { mode: "number" }).notNull().default(0),
    latencyMsMax: integer("latency_ms_max").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.url, t.day] })],
);

/** Every distinct version of a registration file we have seen (provenance, churn). */
export const agentProfileSnapshot = app.table(
  "agent_profile_snapshot",
  {
    chainId: integer("chain_id").notNull(),
    agentId: numeric("agent_id", { precision: 78, scale: 0, mode: "string" }).notNull(),
    contentHash: text("content_hash").notNull(),
    uri: text("uri").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    document: jsonb("document").notNull(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.agentId, t.contentHash] })],
);
