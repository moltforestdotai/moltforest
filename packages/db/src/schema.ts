/**
 * MoltForest-owned tables. They live in the Postgres schema "app"; the indexer
 * owns schema "envio" and nothing here writes to it (decision D21).
 */
import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, numeric, pgSchema, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

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
