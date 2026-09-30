/**
 * MoltForest-owned tables. They live in the Postgres schema "app"; the indexer
 * owns schema "envio" and nothing here writes to it (decision D21).
 */
import { sql } from "drizzle-orm";
import { bigint, boolean, date, index, integer, jsonb, numeric, pgSchema, primaryKey, smallint, text, timestamp } from "drizzle-orm/pg-core";

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

/**
 * Relay state of a submitted receipt (anchor-receipt worker):
 * queued: waiting for the relayer · sending: tx sent, awaiting confirmation ·
 * anchored: on-chain at `anchor_level` · failed: the contract rejects it ·
 * skipped: not relayed (relay cap reached); the signers can still anchor it themselves.
 */
export type ReceiptAnchorStatus = "queued" | "sending" | "anchored" | "failed" | "skipped";

/**
 * Execution receipts submitted through POST /v1/receipts (decision D06). The
 * signatures were verified against the agents' ERC-8004 signers at submission;
 * only the hash goes on-chain. `receipt_hash` is the EIP-712 digest, so a
 * resubmission is idempotent. Timestamps are the signed unix seconds.
 */
export const receipt = app.table(
  "receipt",
  {
    receiptHash: text("receipt_hash").primaryKey(),
    chainId: integer("chain_id").notNull(),
    /** ReceiptRegistry address the receipt was signed for (EIP-712 verifyingContract), lowercase. */
    registry: text("registry").notNull(),
    taskId: text("task_id").notNull(),
    clientAgentId: numeric("client_agent_id", { precision: 78, scale: 0, mode: "string" }).notNull(),
    providerAgentId: numeric("provider_agent_id", { precision: 78, scale: 0, mode: "string" }).notNull(),
    requestHash: text("request_hash").notNull(),
    resultHash: text("result_hash").notNull(),
    paymentRef: text("payment_ref").notNull(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    completedAt: bigint("completed_at", { mode: "number" }).notNull(),
    /** Claimed proof type (0 none, 1 zk, 2 tee, 3 validator); never raises the level. */
    proofType: smallint("proof_type").notNull(),
    proofRef: text("proof_ref").notNull(),
    /** 1 = provider signed, 2 = client co-signed (verified off-chain at submission). */
    level: smallint("level").notNull(),
    providerSignature: text("provider_signature").notNull(),
    clientSignature: text("client_signature"),
    /** Address that signed for each agent when verified (agent wallets can change later). */
    providerSigner: text("provider_signer").notNull(),
    clientSigner: text("client_signer"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    anchorStatus: text("anchor_status").$type<ReceiptAnchorStatus>().notNull().default("queued"),
    /** Level confirmed on-chain; can trail `level` while a co-signature is being relayed. */
    anchorLevel: smallint("anchor_level"),
    anchorTx: text("anchor_tx"),
    anchorBlock: bigint("anchor_block", { mode: "number" }),
    anchoredAt: timestamp("anchored_at", { withTimezone: true }),
    anchorAttempts: integer("anchor_attempts").notNull().default(0),
    anchorError: text("anchor_error"),
    nextAnchorAt: timestamp("next_anchor_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("receipt_provider_idx").on(t.chainId, t.providerAgentId, t.submittedAt),
    index("receipt_client_idx").on(t.chainId, t.clientAgentId, t.submittedAt),
    index("receipt_anchor_queue_idx").on(t.nextAnchorAt).where(sql`anchor_status IN ('queued', 'sending')`),
  ],
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
