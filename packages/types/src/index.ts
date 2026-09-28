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

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}
