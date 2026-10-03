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
    /** api: submitted through POST /v1/receipts; chain: found anchored on the ReceiptRegistry by someone else. */
    source: text("source").$type<"api" | "chain">().notNull().default("api"),
  },
  (t) => [
    index("receipt_provider_idx").on(t.chainId, t.providerAgentId, t.submittedAt),
    index("receipt_client_idx").on(t.chainId, t.clientAgentId, t.submittedAt),
    index("receipt_anchor_queue_idx").on(t.nextAnchorAt).where(sql`anchor_status IN ('queued', 'sending')`),
  ],
);

/**
 * x402-style payments (decision D33): USDC settlements made with EIP-3009
 * `transferWithAuthorization`, found by an `AuthorizationUsed` log and the
 * matching `Transfer` in the same transaction. Only payments where the payer
 * or the payee is a tracked agent address are stored. Amounts are base units.
 */
export const x402Payment = app.table(
  "x402_payment",
  {
    chainId: integer("chain_id").notNull(),
    txHash: text("tx_hash").notNull(),
    /** Log index of the USDC Transfer. */
    logIndex: integer("log_index").notNull(),
    blockNumber: bigint("block_number", { mode: "number" }).notNull(),
    blockTime: timestamp("block_time", { withTimezone: true }).notNull(),
    /** Token contract (USDC). */
    asset: text("asset").notNull(),
    payer: text("payer").notNull(),
    payee: text("payee").notNull(),
    amount: numeric("amount", { precision: 78, scale: 0, mode: "string" }).notNull(),
    /** Transaction sender, normally the x402 facilitator. */
    facilitator: text("facilitator"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.chainId, t.txHash, t.logIndex] }),
    index("x402_payment_payer_idx").on(t.chainId, t.payer, t.blockNumber),
    index("x402_payment_payee_idx").on(t.chainId, t.payee, t.blockNumber),
  ],
);

/**
 * Agent owner and wallet addresses whose payments are tracked. A new address
 * is backfilled from block 0 up to the chain's cursor once, then `caught_up`.
 */
export const paymentAddress = app.table(
  "payment_address",
  {
    chainId: integer("chain_id").notNull(),
    address: text("address").notNull(),
    caughtUp: boolean("caught_up").notNull().default(false),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.address] }), index("payment_address_pending_idx").on(t.chainId).where(sql`NOT caught_up`)],
);

/** Next block to scan per chain: every caught-up address is complete below it. */
export const paymentCursor = app.table("payment_cursor", {
  chainId: integer("chain_id").primaryKey(),
  nextBlock: bigint("next_block", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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

/**
 * How each reviewer wallet was first funded (decision D31): its first incoming
 * MON transfer, found with HyperSync. Funding links reviewers to each other and
 * to the agents they review; the funding tx is the provenance shown with every
 * review that is not counted.
 */
export const walletFunding = app.table(
  "wallet_funding",
  {
    chainId: integer("chain_id").notNull(),
    address: text("address").notNull(),
    /** pending: not looked up yet; found: funder known; none: no incoming MON transfer (e.g. funded by a contract). */
    status: text("status").notNull().default("pending"),
    funder: text("funder"),
    fundingTx: text("funding_tx"),
    fundingBlock: bigint("funding_block", { mode: "number" }),
    /** Wei. */
    fundingValue: numeric("funding_value", { precision: 78, scale: 0, mode: "string" }),
    /** First transfer of MON from this wallet back to its funder, if any. */
    sweepTx: text("sweep_tx"),
    /** Transactions this wallet sent, up to `checkedBlock`. */
    sentTxCount: integer("sent_tx_count"),
    checkedBlock: bigint("checked_block", { mode: "number" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.address] }), index("wallet_funding_pending_idx").on(t.chainId).where(sql`status = 'pending'`)],
);

/** Why a review is not counted (decision D31). Raw reviews are never hidden or deleted. */
export type ReviewExclusion = "SELF_REVIEW" | "FUNDED_BY_TARGET" | "REPEAT_REVIEWER" | "COORDINATED_CLUSTER";

/** One row per non-revoked review: counted or not, with a neutral reason and its evidence. */
export const reviewAssessment = app.table(
  "review_assessment",
  {
    chainId: integer("chain_id").notNull(),
    agentId: numeric("agent_id", { precision: 78, scale: 0, mode: "string" }).notNull(),
    client: text("client").notNull(),
    feedbackIndex: numeric("feedback_index", { precision: 78, scale: 0, mode: "string" }).notNull(),
    counted: boolean("counted").notNull(),
    reason: text("reason").$type<ReviewExclusion>(),
    /** e.g. { funder, fundingTx, clusterSize, sweepTx } */
    evidence: jsonb("evidence"),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.agentId, t.client, t.feedbackIndex] })],
);

/** Counted review numbers per agent, next to the raw totals (decision D31, constraint C1). */
export const agentReviewSummary = app.table(
  "agent_review_summary",
  {
    chainId: integer("chain_id").notNull(),
    agentId: numeric("agent_id", { precision: 78, scale: 0, mode: "string" }).notNull(),
    countedReviews: integer("counted_reviews").notNull(),
    countedReviewers: integer("counted_reviewers").notNull(),
    /** Not-counted reviews by reason, e.g. { "FUNDED_BY_TARGET": 7665 }. */
    excluded: jsonb("excluded").$type<Partial<Record<ReviewExclusion, number>>>().notNull(),
    /** Reviewer wallets whose funding is not looked up yet; counts can still drop while this is above zero. */
    pendingReviewers: integer("pending_reviewers").notNull(),
    /** Hash of this agent's review labels, so an unchanged assessment is not rewritten. */
    assessmentHash: text("assessment_hash").notNull(),
    assessedAt: timestamp("assessed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.agentId] })],
);

/** Next block to scan per chain for named on-chain event scans (e.g. "receipt_events"). */
export const chainScanCursor = app.table(
  "chain_scan_cursor",
  {
    name: text("name").notNull(),
    chainId: integer("chain_id").notNull(),
    nextBlock: bigint("next_block", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.name, t.chainId] })],
);
