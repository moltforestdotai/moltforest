/**
 * MoltForest public API contract, v1.
 *
 * Source of truth for response shapes. moltforest-web keeps a copy in
 * src/lib/api-types.ts — update both together.
 *
 * Conventions:
 * - Big integers (agent ids, block numbers) are decimal strings.
 * - Timestamps are ISO-8601 strings (UTC).
 * - Addresses are lowercase hex.
 * - Missing values are `null`, never omitted.
 * - No single trust score or verdict is ever returned (constraint C1).
 */

export type NetworkName = "mainnet" | "testnet";
export type UriKind = "empty" | "data" | "json" | "ipfs" | "https" | "http" | "other";
/**
 * ok: a valid registration file is known · pending: remote file not fetched yet ·
 * invalid: file is not a valid registration · unreachable: remote file could not
 * be fetched · empty: no agentURI · unsupported: unknown URI scheme.
 */
export type MetadataStatus = "ok" | "pending" | "invalid" | "unreachable" | "empty" | "unsupported";
/** Outcome of the last fetch of a remote registration file. */
export type ProfileFetchStatus = "ok" | "invalid" | "too_large" | "unreachable" | "blocked";
export type AgentSort = "newest" | "oldest" | "most_reviewed";

/**
 * Listing filters. Each one is an observable fact, not a judgment (C5).
 * - payments: x402 payments on Monad. `any` = received from others or sent to
 *   others; self-payments never count.
 * - protocol: the agent declares a service with this name.
 * - endpoint: a declared endpoint was up at its last liveness check, or has
 *   answered 402 Payment Required (an x402 paywall).
 * - minReviewers: distinct reviewer addresses in the Reputation Registry.
 */
export type AgentPaymentFilter = "any" | "received" | "sent";
export type AgentProtocolFilter = "mcp" | "a2a" | "web" | "oasf";
export type AgentEndpointFilter = "up" | "payment_required";

export interface AgentListFilters {
  payments: AgentPaymentFilter | null;
  protocol: AgentProtocolFilter | null;
  endpoint: AgentEndpointFilter | null;
  minReviewers: number | null;
}

export interface NetworkInfo {
  network: NetworkName;
  chainId: number;
  label: string;
  isTestnet: boolean;
  isDefault: boolean;
  identityRegistry: string;
  reputationRegistry: string;
}

export interface AgentService {
  name: string;
  endpoint: string;
  version?: string;
}

/**
 * Why a review is not counted (decision D31). Neutral observations with
 * evidence, never accusations (constraint C5): reviews are not hidden.
 * - SELF_REVIEW: the reviewer is the agent's owner or agent wallet.
 * - FUNDED_BY_TARGET: the reviewer wallet was funded by the agent's owner or agent wallet (directly or through a linked wallet).
 * - REPEAT_REVIEWER: the same wallet already has a counted review of this agent within the repeat window.
 * - COORDINATED_CLUSTER: the reviewer shares a funder with a wallet whose review already counts; a cluster counts as one reviewer.
 */
export type ReviewExclusionReason = "SELF_REVIEW" | "FUNDED_BY_TARGET" | "REPEAT_REVIEWER" | "COORDINATED_CLUSTER";

export interface AgentReputationSummary {
  /** Active (non-revoked) feedback entries on the ERC-8004 Reputation Registry. */
  feedbackCount: number;
  revokedFeedbackCount: number;
  uniqueReviewerCount: number;
  lastFeedbackAt: string | null;
  /** Counted numbers after the D31 checks, next to the totals above; null until assessed. */
  counted: {
    reviews: number;
    reviewers: number;
    /** Not-counted reviews by reason. */
    notCounted: Partial<Record<ReviewExclusionReason, number>>;
    /** Reviewer wallets whose funding is not looked up yet; their reviews count for now. */
    pendingReviewers: number;
    /** Counted reviews attached to a checked x402 payment (via a receipt or ERC-8004 proofOfPayment). */
    verifiedReviews: number;
    assessedAt: string;
  } | null;
}

/** The payment a review is attached to, after MoltForest checked it (payer, payee, timing, one review per payment). */
export interface ReviewPaymentLink {
  by: "receipt" | "payment_proof";
  paymentTx: string;
  /** Decimal USDC. */
  amountUsdc: string;
  receiptHash: string | null;
  /** The service the review is about (its endpoint): the purpose of the payment. */
  endpoint: string | null;
}

/** Liveness roll-up over the agent's declared http(s) service endpoints. */
export interface AgentLiveness {
  /** http(s) endpoints declared in the registration file. */
  endpoints: number;
  /** Endpoints checked at least once. */
  checked: number;
  /** Endpoints answering at the last check (any HTTP status below 500). */
  up: number;
  /** Endpoints that cannot be reached from the internet (localhost, private IPs…). */
  notPublic: number;
  /** Endpoints that answered 402 Payment Required (x402 paywall). */
  paymentRequired: number;
  /** Share of successful checks over the last 7 days across checked endpoints; null without data. */
  uptime7d: number | null;
  checks7d: number;
}

export type EndpointLivenessStatus = "up" | "error" | "down" | "not_public" | "unchecked";

export interface EndpointLiveness {
  url: string;
  status: EndpointLivenessStatus;
  httpStatus: number | null;
  latencyMs: number | null;
  paymentRequired: boolean;
  error: string | null;
  lastCheckedAt: string | null;
  lastUpAt: string | null;
  uptime7d: number | null;
  checks7d: number;
  avgLatencyMs7d: number | null;
}

export interface AgentSummary {
  network: NetworkName;
  chainId: number;
  agentId: string;
  /** eip155:<chainId>:<identityRegistry>:<agentId> */
  globalId: string;
  name: string | null;
  description: string | null;
  image: string | null;
  owner: string;
  agentWallet: string | null;
  uriKind: UriKind;
  metadataStatus: MetadataStatus;
  services: AgentService[];
  serviceCount: number;
  x402Support: boolean | null;
  active: boolean | null;
  supportedTrust: string[];
  registeredAt: string;
  registeredBlock: string;
  updatedAt: string;
  reputation: AgentReputationSummary;
  /** Reviews this agent wrote about other agents (its work as a client). */
  reviewsGiven: AgentReviewsGiven;
  liveness: AgentLiveness;
  receipts: AgentReceiptSummary;
  payments: AgentPaymentSummary;
}

/**
 * ERC-8004 reviews whose client is the agent's owner or agent wallet, about
 * other agents; revoked reviews are left out. They show the agent's activity
 * as a client and say nothing about the quality of its own work.
 */
export interface AgentReviewsGiven {
  reviews: number;
  /** Of those, counted reviews attached to a checked x402 payment (decision D39). */
  verified: number;
  lastAt: string | null;
}

/**
 * x402 payments (decision D33): USDC settlements made with EIP-3009
 * transferWithAuthorization where the agent's owner or agent wallet is the
 * payer or the payee. Amounts are decimal USDC strings. Payments between the
 * agent's own addresses are counted separately and never as received from others.
 */
export interface AgentPaymentSummary {
  receivedFromOthers: number;
  sent: number;
  /** The agent paying itself (payer and payee are its own owner/wallet). */
  selfPayments: number;
  receivedAmount: string;
  sentAmount: string;
  lastPaymentAt: string | null;
}

export type PaymentDirection = "received" | "sent" | "self";

export interface PaymentView {
  network: NetworkName;
  chainId: number;
  txHash: string;
  logIndex: number;
  blockNumber: string;
  blockTime: string;
  /** Token contract. */
  asset: string;
  assetSymbol: "USDC";
  /** Decimal USDC. */
  amount: string;
  payer: string;
  payee: string;
  /** Transaction sender, normally the x402 facilitator. */
  facilitator: string | null;
  /** Agents whose owner or agent wallet is the payer / payee (first 10). */
  payerAgentIds: string[];
  payerAgentCount: number;
  payeeAgentIds: string[];
  payeeAgentCount: number;
  /** MoltForest receipts whose paymentRef is this transaction (the job this payment paid for). */
  receiptHashes: string[];
  /**
   * Reviews attached to this payment; their endpoint says what it paid for.
   * `counted` with an attachment means the review is verified. The value
   * fields are null while the indexer has not stored the review yet.
   */
  reviews: {
    agentId: string;
    client: string;
    feedbackIndex: string;
    endpoint: string | null;
    counted: boolean;
    value: string | null;
    valueDecimals: number | null;
    tag1: string | null;
  }[];
}

export interface AgentPaymentView extends PaymentView {
  direction: PaymentDirection;
}

export interface AgentPaymentsResponse {
  network: NetworkName;
  agentId: string;
  /** Addresses the payments are matched on, and how many agents share each. */
  addresses: { address: string; roles: ("owner" | "wallet")[]; agentCount: number }[];
  direction: PaymentDirection | "any";
  items: AgentPaymentView[];
  nextCursor: string | null;
}

export interface PaymentLookupResponse {
  txHash: string;
  items: PaymentView[];
}

/**
 * Execution receipts submitted to MoltForest with this agent as the **provider**
 * (decision D06). Level 1 is the provider's own signed claim; level 2 is also
 * co-signed by the client. Receipts where the agent is only the client are not
 * counted here.
 */
export interface AgentReceiptSummary {
  total: number;
  /** Co-signed by the client agent (level 2). */
  coSigned: number;
  /** Confirmed on the ReceiptRegistry. */
  anchored: number;
  /** Latest `completedAt` (ISO), or null. */
  lastCompletedAt: string | null;
  /** Receipts this agent co-signed as the client (level 2): jobs it hired another agent for. */
  coSignedAsClient: number;
  /** Latest `completedAt` (ISO) of those, or null. */
  lastAsClientAt: string | null;
}

export interface AgentUriHistoryEntry {
  uri: string;
  uriKind: UriKind;
  updatedBy: string;
  blockNumber: string;
  timestamp: string;
  txHash: string;
}

export interface FeedbackEntry {
  client: string;
  feedbackIndex: string;
  /** Raw int128 value as a decimal string; divide by 10^valueDecimals. */
  value: string;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackUri: string;
  feedbackHash: string;
  revoked: boolean;
  responseCount: number;
  blockNumber: string;
  timestamp: string;
  txHash: string;
  /** Whether this review counts (D31); null for revoked reviews or before assessment. */
  counted: boolean | null;
  /** Why it does not count, with on-chain evidence (e.g. funder and funding tx). */
  notCounted: { reason: ReviewExclusionReason; evidence: Record<string, unknown> | null } | null;
  /** The x402 payment the review is attached to, when the attachment checks out. */
  payment: ReviewPaymentLink | null;
  /** Why an attached payment did not check out (e.g. "the payment came after the review"). */
  paymentProblem: string | null;
  /** The reviewer paid this agent before reviewing but attached nothing (information, not verification). */
  paidUnattached: boolean;
}

export interface AgentDetail extends AgentSummary {
  /** Truncated to 2048 characters; see agentUriTruncated. */
  agentUri: string;
  agentUriTruncated: boolean;
  metadataError: string | null;
  registeredTx: string;
  uriChangeCount: number;
  /** Where the registration fields came from: the agentURI itself, or a fetched remote file. */
  profileSource: "onchain" | "remote";
  /** Last fetch of the remote registration file (null for on-chain profiles or not yet fetched). */
  profileFetch: {
    status: ProfileFetchStatus;
    httpStatus: number | null;
    error: string | null;
    fetchUrl: string | null;
    fetchedAt: string;
    /** When the profile fields were last confirmed valid; they may be kept through transient outages. */
    lastOkAt: string | null;
    nextFetchAt: string | null;
    /** Times the file's content changed after the first successful fetch. */
    contentChangeCount: number;
  } | null;
  uriHistory: AgentUriHistoryEntry[];
  recentFeedback: FeedbackEntry[];
  /** Liveness of each declared http(s) endpoint. */
  endpoints: EndpointLiveness[];
}

export type ActivityType = "agent_registered" | "profile_updated" | "feedback_given";

/** One on-chain event, emitted only once the indexer has fully processed its block. */
export interface ActivityEvent {
  id: string;
  network: NetworkName;
  chainId: number;
  type: ActivityType;
  agentId: string;
  agentName: string | null;
  /** Owner (registration), updater (profile update) or reviewer (feedback). */
  actor: string;
  blockNumber: string;
  timestamp: string;
  txHash: string;
  /** Feedback value/tag or new URI kind, when relevant. */
  detail: string | null;
}

export interface ActivityListResponse {
  network: NetworkName;
  chainId: number;
  items: ActivityEvent[];
}

/** SSE `status` event on /v1/activity/stream. */
export interface ActivityStreamStatus {
  network: NetworkName;
  progressBlock: string;
  chainHeadBlock: string;
}

export interface AgentListResponse {
  network: NetworkName;
  chainId: number;
  sort: AgentSort;
  includeIncomplete: boolean;
  filters: AgentListFilters;
  items: AgentSummary[];
  nextCursor: string | null;
  /** Agents matching the current filters. */
  total: number;
  /**
   * Agents that match the search and filters but are hidden because they have
   * no usable profile (D19). Null when `includeIncomplete` is true.
   */
  hiddenIncomplete: number | null;
  /** All indexed agents on this network, including incomplete ones. */
  totalIndexed: number;
}

export interface SyncStatus {
  network: NetworkName;
  chainId: number;
  indexed: boolean;
  indexer: {
    ready: boolean;
    readyAt: string | null;
    usingHyperSync: boolean;
    startBlock: string;
    progressBlock: string;
    chainHeadBlock: string;
    lagBlocks: string;
    progressBlockTime: string | null;
    eventsProcessed: string;
  } | null;
  agents: {
    indexedCount: number;
    highestIndexedAgentId: string | null;
  };
  /** Reconciler check against the chain itself (cached). */
  chain: {
    highestAgentId: string | null;
    checkedAt: string | null;
    error: string | null;
  };
  /** highestAgentId(chain) − highestIndexedAgentId; > 0 means the index is behind. */
  missingAgents: string | null;
}

/**
 * Execution receipts (decision D06). A receipt is evidence that a job happened,
 * not a proof of what happened (constraint C4). Level 1 = provider signed,
 * level 2 = client co-signed; levels 3–5 (validation, ZK, TEE) are reserved.
 */
export type ReceiptLevel = 1 | 2;
export type ReceiptAnchorStatus = "queued" | "sending" | "anchored" | "failed" | "skipped";
/** What the signers claim about extra proof; recorded, never verified or scored by MoltForest. */
export type ClaimedProofType = "none" | "zk" | "tee" | "validator" | "unknown";

/** The signed EIP-712 fields, as sent to POST /v1/receipts. Timestamps are unix seconds. */
export interface ReceiptFields {
  taskId: string;
  clientAgentId: string;
  providerAgentId: string;
  requestHash: string;
  resultHash: string;
  /** x402 settlement tx hash, or 32 zero bytes. */
  paymentRef: string;
  startedAt: number;
  completedAt: number;
  proofType: number;
  proofRef: string;
}

export interface ReceiptView {
  /** EIP-712 digest of the receipt; its id on-chain and here. */
  receiptHash: string;
  network: NetworkName;
  chainId: number;
  /** ReceiptRegistry the receipt was signed for (EIP-712 verifyingContract). */
  registry: string;
  receipt: ReceiptFields;
  level: ReceiptLevel;
  claimedProofType: ClaimedProofType;
  signatures: { provider: string; client: string | null };
  /** Addresses that signed for each agent when the receipt was verified. */
  signers: { provider: string; client: string | null };
  submittedAt: string;
  anchor: {
    status: ReceiptAnchorStatus;
    /** Level confirmed on-chain; can trail `level` while a co-signature is relayed. */
    level: ReceiptLevel | null;
    txHash: string | null;
    blockNumber: string | null;
    anchoredAt: string | null;
    error: string | null;
  };
  /** The indexed x402 payment `receipt.paymentRef` points to; null when it is zero or not indexed (yet). */
  payment: PaymentView | null;
  /** api: submitted to MoltForest; chain: found anchored on the ReceiptRegistry, submitted elsewhere. */
  source: "api" | "chain";
}

/** GET /v1/receipts: the newest receipts on a network, each with its payment. */
export interface RecentReceiptsResponse {
  network: NetworkName;
  items: ReceiptView[];
  nextCursor: string | null;
}

export interface ReceiptSubmitResponse extends ReceiptView {
  /** True when this exact receipt was already stored (submission is idempotent). */
  duplicate: boolean;
}

export type ReceiptRole = "provider" | "client" | "any";

export interface AgentReceiptsResponse {
  network: NetworkName;
  agentId: string;
  role: ReceiptRole;
  items: ReceiptView[];
  nextCursor: string | null;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Evidence profile and trust queries (phase 6). Evidence, never a score or a
// verdict (constraint C1); every metric says where it came from (C2).
// ---------------------------------------------------------------------------

/** Where a metric comes from: the API list of underlying records, the contract and events, the window and block range. */
export interface Provenance {
  /** MoltForest API path listing the records behind the metric. */
  api?: string;
  /** Contract the records come from, with its events or calls. */
  contract?: { address: string; events: string[] };
  /** e.g. "last 7 days", "all time". */
  window?: string;
  blockRange?: { from: string; to: string };
  note?: string;
}

/** One number (or fact) with its provenance. `value` is null when MoltForest cannot measure it yet. */
export interface Metric<T = number> {
  value: T | null;
  status: "measured" | "not_measured";
  provenance: Provenance;
}

export type ObservationCode =
  | "LOW_HISTORY"
  | "STALE"
  | "REVIEWS_NOT_COUNTED"
  | "SELF_PAYMENTS_ONLY"
  | "NO_RECEIPTS"
  | "ENDPOINT_CHURN"
  | "PROFILE_UNREACHABLE"
  | "ENDPOINTS_DOWN"
  | "ENDPOINTS_NOT_PUBLIC"
  | "MARKED_INACTIVE";

/** An observable condition worth a closer look; never an accusation (constraint C5). */
export interface Observation {
  code: ObservationCode;
  severity: "info" | "notice" | "warning";
  message: string;
  provenance: Provenance;
}

export interface EvidenceProfile {
  network: NetworkName;
  agentId: string;
  globalId: string;
  name: string | null;
  generatedAt: string;
  identity: {
    registeredAt: Metric<string>;
    ageDays: Metric;
    profileStatus: Metric<MetadataStatus>;
    uriChanges: Metric;
    agentWalletSet: Metric<boolean>;
    declaredServices: Metric;
    x402Support: Metric<boolean>;
  };
  reliability: {
    endpoints: Metric;
    endpointsUp: Metric;
    uptime7d: Metric;
    endpointLatencyMs7d: Metric;
    /** Latest of the agent's own actions: x402 payment, receipt (either role), review written, registration update. */
    lastActivityAt: Metric<string>;
    /** Share of jobs that succeeded: not measurable yet (receipts exist only for completed jobs). */
    jobSuccessRate: Metric;
    /** Time from request to result: not measurable yet. */
    jobLatencyMs: Metric;
  };
  reputation: {
    reviews: Metric;
    reviewers: Metric;
    countedReviews: Metric;
    countedReviewers: Metric;
    /** Counted reviews attached to a checked x402 payment. */
    verifiedReviews: Metric;
    notCounted: Metric<Partial<Record<ReviewExclusionReason, number>>>;
    lastReviewAt: Metric<string>;
    /** Reviews the agent wrote about other agents (context, not about its own work). */
    reviewsGiven: Metric;
    verifiedReviewsGiven: Metric;
  };
  economic: {
    paymentsReceivedFromOthers: Metric;
    receivedUsdc: Metric<string>;
    distinctPayers: Metric;
    largestPaymentUsdc: Metric<string>;
    paymentsSent: Metric;
    selfPayments: Metric;
    lastPaymentAt: Metric<string>;
  };
  verification: {
    receipts: Metric;
    coSignedReceipts: Metric;
    anchoredReceipts: Metric;
    receiptsWithPayment: Metric;
    /** 1 = provider signed, 2 = client co-signed; null without receipts. */
    highestReceiptLevel: Metric;
    lastReceiptAt: Metric<string>;
    /** Receipts the agent co-signed as the client of another agent. */
    coSignedAsClient: Metric;
  };
  observations: Observation[];
  /** How much MoltForest can see per category ("how much do we know?", not "how good is it?"). */
  coverage: { category: "identity" | "reliability" | "reputation" | "economic" | "verification"; measured: number; total: number }[];
}

/** Task context for a trust query (constraint C3). All optional. */
export interface TaskContextQuery {
  taskType?: string;
  /** In USD (USDC). */
  valueAtRisk?: number;
  requiredProof?: "none" | "provider-signed" | "client-cosigned" | "validator" | "zk" | "tee";
  maxLatencyMs?: number;
  /** Observed jobs (receipts as provider) the caller wants to see. */
  minimumHistory?: number;
}

/**
 * One asked value next to what MoltForest observed. `comparison` compares the
 * two numbers; it is not MoltForest's judgement of the agent.
 */
export interface ContextFact {
  parameter: keyof TaskContextQuery;
  asked: string | number;
  observed: string | number | null;
  comparison: "meets" | "below" | "above" | "mentioned" | "not_mentioned" | "not_measurable";
  note: string;
}

export interface TrustResponse {
  profile: EvidenceProfile;
  context: { query: TaskContextQuery; facts: ContextFact[] };
  note: string;
}

/**
 * Network-wide counts (GET /v1/stats), e.g. for the website's homepage: plain
 * counts of what MoltForest has indexed, each with its source (constraint C2).
 * They rate nothing (C1). Served from a cache up to a minute old.
 */
export interface NetworkStats {
  network: NetworkName;
  chainId: number;
  generatedAt: string;
  agents: { indexed: Metric };
  reviews: {
    /** Non-revoked ERC-8004 reviews. */
    total: Metric;
    /** Reviews that count after the reviewer checks (D31). */
    counted: Metric;
    /** Counted reviews attached to a checked x402 payment (D39). */
    verified: Metric;
  };
  /** x402 settlements where an agent's owner or agent wallet is the payer or the payee. */
  payments: { x402: Metric };
  receipts: { total: Metric; coSigned: Metric; anchored: Metric };
}
