import { agentGlobalId, NETWORKS, type NetworkName } from "@moltforest/chain";
import type {
  AgentDetail,
  AgentService,
  AgentSort,
  AgentSummary,
  AgentUriHistoryEntry,
  FeedbackEntry,
  MetadataStatus,
  UriKind,
} from "@moltforest/types";
import { table, type Db } from "../db.js";
import type { AgentCursor } from "../lib/cursor.js";

export const URI_PREVIEW_LIMIT = 2_048;
const HISTORY_LIMIT = 20;

export interface ListAgentsParams {
  network: NetworkName;
  sort: AgentSort;
  includeIncomplete: boolean;
  q?: string;
  cursor?: AgentCursor;
  limit: number;
}

export interface ListAgentsResult {
  items: AgentSummary[];
  /** The last row of this page, when another page exists. */
  nextCursor: AgentCursor | null;
  total: number;
  totalIndexed: number;
}

const SUMMARY_COLUMNS = [
  "agent_id",
  "owner",
  "agent_wallet",
  "uri_kind",
  "metadata_status",
  "name",
  "description",
  "image",
  "services",
  "service_count",
  "x402_support",
  "active",
  "supported_trust",
  "registered_at",
  "registered_block",
  "updated_at",
  "feedback_count",
  "revoked_feedback_count",
  "unique_reviewer_count",
  "last_feedback_at",
].join(", ");

interface AgentRow {
  agent_id: string;
  owner: string;
  agent_wallet: string | null;
  uri_kind: string;
  metadata_status: string;
  name: string | null;
  description: string | null;
  image: string | null;
  services: unknown;
  service_count: number;
  x402_support: boolean | null;
  active: boolean | null;
  supported_trust: string[] | null;
  registered_at: Date;
  registered_block: string;
  updated_at: Date;
  feedback_count: number;
  revoked_feedback_count: number;
  unique_reviewer_count: number;
  last_feedback_at: Date | null;
}

interface AgentDetailRow extends AgentRow {
  agent_uri: string;
  metadata_error: string | null;
  registered_tx: string;
  uri_change_count: number;
}

/** Builds a parameterized WHERE clause without string-concatenating values. */
class Where {
  readonly clauses: string[] = [];
  readonly values: unknown[] = [];
  param(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
  add(clause: string): this {
    this.clauses.push(clause);
    return this;
  }
  sql(): string {
    return this.clauses.length ? `WHERE ${this.clauses.join(" AND ")}` : "";
  }
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function toServices(value: unknown): AgentService[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (s): s is AgentService => typeof s === "object" && s !== null && typeof s.endpoint === "string" && typeof s.name === "string",
  );
}

function toSummary(network: NetworkName, row: AgentRow): AgentSummary {
  return {
    network,
    chainId: NETWORKS[network].chainId,
    agentId: row.agent_id,
    globalId: agentGlobalId(network, row.agent_id),
    name: row.name,
    description: row.description,
    image: row.image,
    owner: row.owner,
    agentWallet: row.agent_wallet,
    uriKind: row.uri_kind as UriKind,
    metadataStatus: row.metadata_status as MetadataStatus,
    services: toServices(row.services),
    serviceCount: row.service_count,
    x402Support: row.x402_support,
    active: row.active,
    supportedTrust: row.supported_trust ?? [],
    registeredAt: row.registered_at.toISOString(),
    registeredBlock: row.registered_block,
    updatedAt: row.updated_at.toISOString(),
    reputation: {
      feedbackCount: row.feedback_count,
      revokedFeedbackCount: row.revoked_feedback_count,
      uniqueReviewerCount: row.unique_reviewer_count,
      lastFeedbackAt: row.last_feedback_at?.toISOString() ?? null,
    },
  };
}

const truncate = (s: string) => (s.length > URI_PREVIEW_LIMIT ? s.slice(0, URI_PREVIEW_LIMIT) : s);

export function createAgentRepository(db: Db, schema: string) {
  const agents = table(schema, "Agent");
  const uriChanges = table(schema, "AgentUriChange");
  const feedback = table(schema, "Feedback");

  /** Filters shared by the page query and the `total` count (no cursor). */
  function baseFilters(p: ListAgentsParams): Where {
    const w = new Where();
    w.add(`chain_id = ${w.param(NETWORKS[p.network].chainId)}`);
    if (!p.includeIncomplete) {
      // Decision D19: hide agents without a valid registration file and at least one service.
      w.add(`metadata_status = 'ok' AND service_count > 0`);
    }
    if (p.q) {
      if (/^\d{1,78}$/.test(p.q)) {
        w.add(`(agent_id = ${w.param(p.q)}::numeric OR name ILIKE ${w.param(`%${escapeLike(p.q)}%`)})`);
      } else if (/^0x[0-9a-fA-F]{40}$/.test(p.q)) {
        const addr = w.param(p.q.toLowerCase());
        w.add(`(owner = ${addr} OR agent_wallet = ${addr})`);
      } else {
        w.add(`name ILIKE ${w.param(`%${escapeLike(p.q)}%`)}`);
      }
    }
    return w;
  }

  return {
    async list(p: ListAgentsParams): Promise<ListAgentsResult> {
      const page = baseFilters(p);
      let orderBy: string;
      switch (p.sort) {
        case "newest":
          if (p.cursor) page.add(`agent_id < ${page.param(p.cursor.agentId)}::numeric`);
          orderBy = "agent_id DESC";
          break;
        case "oldest":
          if (p.cursor) page.add(`agent_id > ${page.param(p.cursor.agentId)}::numeric`);
          orderBy = "agent_id ASC";
          break;
        case "most_reviewed":
          if (p.cursor) {
            page.add(`(feedback_count, agent_id) < (${page.param(p.cursor.feedbackCount)}::int, ${page.param(p.cursor.agentId)}::numeric)`);
          }
          orderBy = "feedback_count DESC, agent_id DESC";
          break;
      }
      const limitParam = page.param(p.limit + 1);

      const counts = baseFilters(p);
      const [rows, total, totalIndexed] = await Promise.all([
        db.query<AgentRow>(`SELECT ${SUMMARY_COLUMNS} FROM ${agents} ${page.sql()} ORDER BY ${orderBy} LIMIT ${limitParam}`, page.values),
        db.query<{ count: string }>(`SELECT count(*) FROM ${agents} ${counts.sql()}`, counts.values),
        db.query<{ count: string }>(`SELECT count(*) FROM ${agents} WHERE chain_id = $1`, [NETWORKS[p.network].chainId]),
      ]);

      const hasMore = rows.rows.length > p.limit;
      const pageRows = hasMore ? rows.rows.slice(0, p.limit) : rows.rows;
      const last = pageRows.at(-1);
      return {
        items: pageRows.map((r) => toSummary(p.network, r)),
        nextCursor:
          hasMore && last
            ? { sort: p.sort, agentId: last.agent_id, ...(p.sort === "most_reviewed" ? { feedbackCount: last.feedback_count } : {}) }
            : null,
        total: Number(total.rows[0]?.count ?? 0),
        totalIndexed: Number(totalIndexed.rows[0]?.count ?? 0),
      };
    },

    async get(network: NetworkName, agentId: string): Promise<AgentDetail | null> {
      const chainId = NETWORKS[network].chainId;
      const result = await db.query<AgentDetailRow>(
        `SELECT ${SUMMARY_COLUMNS}, agent_uri, metadata_error, registered_tx, uri_change_count
           FROM ${agents} WHERE chain_id = $1 AND id = $2`,
        [chainId, agentId],
      );
      const row = result.rows[0];
      if (!row) return null;

      const [history, fb] = await Promise.all([
        db.query<{ uri: string; uri_kind: string; updated_by: string; block_number: string; timestamp: Date; tx_hash: string }>(
          `SELECT uri, uri_kind, updated_by, block_number, "timestamp", tx_hash
             FROM ${uriChanges} WHERE chain_id = $1 AND agent_id = $2
            ORDER BY block_number DESC, id DESC LIMIT ${HISTORY_LIMIT}`,
          [chainId, agentId],
        ),
        db.query<{
          client: string;
          feedback_index: string;
          value: string;
          value_decimals: number;
          tag1: string;
          tag2: string;
          endpoint: string;
          feedback_uri: string;
          feedback_hash: string;
          revoked: boolean;
          response_count: number;
          block_number: string;
          timestamp: Date;
          tx_hash: string;
        }>(
          `SELECT client, feedback_index, value, value_decimals, tag1, tag2, endpoint, feedback_uri, feedback_hash,
                  revoked, response_count, block_number, "timestamp", tx_hash
             FROM ${feedback} WHERE chain_id = $1 AND agent_id = $2
            ORDER BY block_number DESC, id DESC LIMIT ${HISTORY_LIMIT}`,
          [chainId, agentId],
        ),
      ]);

      const uriHistory: AgentUriHistoryEntry[] = history.rows.map((h) => ({
        uri: truncate(h.uri),
        uriKind: h.uri_kind as UriKind,
        updatedBy: h.updated_by,
        blockNumber: h.block_number,
        timestamp: h.timestamp.toISOString(),
        txHash: h.tx_hash,
      }));
      const recentFeedback: FeedbackEntry[] = fb.rows.map((f) => ({
        client: f.client,
        feedbackIndex: f.feedback_index,
        value: f.value,
        valueDecimals: f.value_decimals,
        tag1: f.tag1,
        tag2: f.tag2,
        endpoint: f.endpoint,
        feedbackUri: truncate(f.feedback_uri),
        feedbackHash: f.feedback_hash,
        revoked: f.revoked,
        responseCount: f.response_count,
        blockNumber: f.block_number,
        timestamp: f.timestamp.toISOString(),
        txHash: f.tx_hash,
      }));

      return {
        ...toSummary(network, row),
        agentUri: truncate(row.agent_uri),
        agentUriTruncated: row.agent_uri.length > URI_PREVIEW_LIMIT,
        metadataError: row.metadata_error,
        registeredTx: row.registered_tx,
        uriChangeCount: row.uri_change_count,
        uriHistory,
        recentFeedback,
      };
    },
  };
}

export type AgentRepository = ReturnType<typeof createAgentRepository>;
