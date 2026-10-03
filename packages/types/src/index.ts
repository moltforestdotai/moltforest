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
    assessedAt: string;
  } | null;
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
  liveness: AgentLiveness;
  receipts: AgentReceiptSummary;
  payments: AgentPaymentSummary;
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
