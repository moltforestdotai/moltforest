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

export interface AgentReputationSummary {
  /** Active (non-revoked) feedback entries on the ERC-8004 Reputation Registry. */
  feedbackCount: number;
  revokedFeedbackCount: number;
  uniqueReviewerCount: number;
  lastFeedbackAt: string | null;
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
  items: AgentSummary[];
  nextCursor: string | null;
  /** Agents matching the current filters. */
  total: number;
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
