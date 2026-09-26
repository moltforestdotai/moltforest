/**
 * Integration tests against a real Postgres. Tables are cloned from the live
 * Envio schema (`LIKE envio."Agent"`), so these tests fail if Envio's column
 * names drift from what the API queries. Skipped when the database or the
 * Envio schema is unavailable (run `pnpm db:up` and `pnpm indexer:up` first).
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type { AgentDetail, AgentListResponse, SyncStatus } from "@moltforest/types";
import { loadConfig } from "../src/config.js";
import { createDb, type Db } from "../src/db.js";
import { createApp } from "../src/app.js";
import type { ChainChecker } from "../src/services/chainCheck.js";

const OWNER_A = "0x00000000000000000000000000000000000000aa";
const OWNER_B = "0x00000000000000000000000000000000000000bb";
const SCHEMA = `api_test_${randomBytes(4).toString("hex")}`;

const fakeChain: ChainChecker = {
  highestAgentId: async (network) =>
    network === "mainnet"
      ? { highestAgentId: "6", checkedAt: new Date("2026-09-26T00:00:00Z"), error: null }
      : { highestAgentId: null, checkedAt: null, error: "rpc down" },
};

let db: Db | undefined;
let app: Express;
let skipReason: string | null = null;

async function setup(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    skipReason = (err as Error).message;
    return;
  }
  const pool = createDb(config.DATABASE_URL);
  try {
    const exists = await pool.query(`SELECT to_regclass('envio."Agent"') AS t`);
    if (!exists.rows[0]?.t) {
      skipReason = "envio schema not found (start the indexer once)";
      await pool.end();
      return;
    }
  } catch (err) {
    skipReason = `database unreachable: ${(err as Error).message}`;
    await pool.end();
    return;
  }
  db = pool;

  const s = `"${SCHEMA}"`;
  await db.query(`CREATE SCHEMA ${s}`);
  for (const t of ["Agent", "AgentUriChange", "Feedback", "envio_chains"]) {
    await db.query(`CREATE TABLE ${s}."${t}" (LIKE envio."${t}" INCLUDING DEFAULTS)`);
  }

  const agent = (chainId: number, id: number, over: Record<string, unknown> = {}) => ({
    id: String(id),
    chain_id: chainId,
    agent_id: id,
    owner: OWNER_A,
    agent_wallet: null,
    agent_uri: "data:application/json;base64,e30=",
    uri_kind: "data",
    metadata_status: "ok",
    metadata_error: null,
    name: `Agent ${id}`,
    description: null,
    image: null,
    services: JSON.stringify([{ name: "A2A", endpoint: `https://a${id}.example` }]),
    service_count: 1,
    x402_support: true,
    active: true,
    supported_trust: ["reputation"],
    registered_block: 1000 + id,
    registered_at: new Date(Date.UTC(2026, 0, 1 + id)),
    registered_tx: "0x" + "ab".repeat(32),
    updated_block: 1000 + id,
    updated_at: new Date(Date.UTC(2026, 0, 1 + id)),
    uri_change_count: 0,
    feedback_count: 0,
    revoked_feedback_count: 0,
    unique_reviewer_count: 0,
    last_feedback_at: null,
    ...over,
  });

  const rows = [
    agent(143, 0, { name: "Alpha Reviewer", feedback_count: 5, unique_reviewer_count: 3 }),
    agent(143, 1, { services: "[]", service_count: 0 }),
    agent(143, 2, { metadata_status: "empty", uri_kind: "empty", agent_uri: "", name: null, services: "[]", service_count: 0 }),
    agent(143, 3, {
      name: "Beta_Oracle 100%",
      owner: OWNER_B,
      feedback_count: 5,
      services: JSON.stringify([{ name: "A2A", endpoint: "https://b.example" }, { name: "MCP", endpoint: "https://b.example/mcp" }]),
      service_count: 2,
      agent_uri: "https://b.example/" + "x".repeat(3000),
      uri_kind: "https",
      uri_change_count: 1,
    }),
    agent(143, 4, { name: "Gamma", feedback_count: 9 }),
    agent(10143, 0, { name: "Testnet Alpha" }),
  ];
  for (const r of rows) {
    const cols = Object.keys(r);
    await db.query(
      `INSERT INTO ${s}."Agent" (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(r),
    );
  }

  await db.query(
    `INSERT INTO ${s}."AgentUriChange" (id, chain_id, agent_id, uri, uri_kind, updated_by, block_number, "timestamp", tx_hash)
     VALUES ('1010_0', 143, '3', 'https://b.example/reg.json', 'https', $1, 1010, '2026-02-01T00:00:00Z', $2)`,
    [OWNER_B, "0x" + "cd".repeat(32)],
  );
  for (const [i, block] of [
    [1, 1100],
    [2, 1200],
  ] as const) {
    await db.query(
      `INSERT INTO ${s}."Feedback" (id, chain_id, agent_id, client, feedback_index, value, value_decimals, tag1, tag2, endpoint,
         feedback_uri, feedback_hash, revoked, response_count, block_number, "timestamp", tx_hash)
       VALUES ($1, 143, '0', $2, $3, -25, 1, 'quality', '', '', '', $4, $5, 0, $6, $7, $8)`,
      [`0_${OWNER_B}_${i}`, OWNER_B, i, "0x" + "00".repeat(32), i === 2, block, new Date(Date.UTC(2026, 1, i)), "0x" + "ef".repeat(32)],
    );
  }
  await db.query(
    `INSERT INTO ${s}."envio_chains" (id, ecosystem, start_block, max_reorg_depth, buffer_block, source_block, ready_at,
       events_processed, _is_hyper_sync, progress_block, progress_block_time, checkpoint_id)
     VALUES (143, 'evm', 0, 200, 5000, 5000, now(), 1234, true, 4990, now(), 1)`,
  );

  app = createApp({
    config: { INDEXER_DB_SCHEMA: SCHEMA, CORS_ORIGINS: ["http://localhost:3000"], RATE_LIMIT_PER_MINUTE: 10_000 },
    db,
    chain: fakeChain,
  });
}

beforeAll(setup, 30_000);
afterAll(async () => {
  if (!db) return;
  await db.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await db.end();
});

const ids = (body: AgentListResponse) => body.items.map((a) => a.agentId);

describe("API (integration)", () => {
  {
    // Skips at runtime (not collection time) because setup decides availability.
    const run = (name: string, fn: () => Promise<void>) =>
      it(name, async (ctx) => {
        if (skipReason) ctx.skip(skipReason);
        await fn();
      });

    run("GET /health", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok", database: "ok" });
    });

    run("GET /v1/networks lists both chains, mainnet default", async () => {
      const res = await request(app).get("/v1/networks");
      expect(res.body.networks.map((n: { network: string; isDefault: boolean }) => [n.network, n.isDefault])).toEqual([
        ["mainnet", true],
        ["testnet", false],
      ]);
    });

    run("lists complete mainnet agents newest first by default", async () => {
      const res = await request(app).get("/v1/agents");
      expect(res.status).toBe(200);
      const body = res.body as AgentListResponse;
      expect(body).toMatchObject({ network: "mainnet", chainId: 143, sort: "newest", includeIncomplete: false, total: 3, totalIndexed: 5 });
      expect(ids(body)).toEqual(["4", "3", "0"]);
      expect(body.items[1]).toMatchObject({
        name: "Beta_Oracle 100%",
        serviceCount: 2,
        globalId: "eip155:143:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432:3",
        reputation: { feedbackCount: 5 },
      });
      expect(body.items[0]).not.toHaveProperty("trustScore");
    });

    run("includeIncomplete shows every indexed agent", async () => {
      const res = await request(app).get("/v1/agents?includeIncomplete=true&sort=oldest");
      expect(ids(res.body)).toEqual(["0", "1", "2", "3", "4"]);
      expect(res.body.total).toBe(5);
    });

    run("keeps networks apart", async () => {
      const res = await request(app).get("/v1/agents?network=testnet");
      expect(res.body).toMatchObject({ network: "testnet", chainId: 10143, total: 1 });
      expect(res.body.items[0]).toMatchObject({ agentId: "0", name: "Testnet Alpha" });
    });

    run("paginates with a keyset cursor", async () => {
      const first = await request(app).get("/v1/agents?limit=2");
      expect(ids(first.body)).toEqual(["4", "3"]);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      const second = await request(app).get(`/v1/agents?limit=2&cursor=${first.body.nextCursor}`);
      expect(ids(second.body)).toEqual(["0"]);
      expect(second.body.nextCursor).toBeNull();
    });

    run("most_reviewed pages break ties by agent id", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res: request.Response = await request(app).get(`/v1/agents?sort=most_reviewed&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
        seen.push(...ids(res.body));
        cursor = res.body.nextCursor;
      } while (cursor);
      expect(seen).toEqual(["4", "3", "0"]);
    });

    run("searches by name with LIKE wildcards escaped, by id and by owner", async () => {
      expect(ids((await request(app).get("/v1/agents?q=beta")).body)).toEqual(["3"]);
      expect(ids((await request(app).get("/v1/agents?q=100%25")).body)).toEqual(["3"]);
      expect(ids((await request(app).get("/v1/agents?q=_")).body)).toEqual(["3"]);
      expect(ids((await request(app).get("/v1/agents?q=4")).body)).toEqual(["4"]);
      expect(ids((await request(app).get(`/v1/agents?q=${OWNER_B.toUpperCase().replace("0X", "0x")}`)).body)).toEqual(["3"]);
    });

    run("rejects bad input with 400", async () => {
      const badNetwork = await request(app).get("/v1/agents?network=ethereum");
      expect(badNetwork.status).toBe(400);
      expect(badNetwork.body.error.code).toBe("invalid_request");

      const newestCursor = (await request(app).get("/v1/agents?limit=1")).body.nextCursor;
      const wrongSort = await request(app).get(`/v1/agents?sort=oldest&cursor=${newestCursor}`);
      expect(wrongSort.status).toBe(400);
      expect(wrongSort.body.error.code).toBe("invalid_cursor");

      expect((await request(app).get("/v1/agents?limit=500")).status).toBe(400);
      expect((await request(app).get("/v1/agents/mainnet/abc")).status).toBe(400);
    });

    run("returns agent detail with URI history and feedback", async () => {
      const res = await request(app).get("/v1/agents/mainnet/3");
      expect(res.status).toBe(200);
      const body = res.body as AgentDetail;
      expect(body).toMatchObject({ agentId: "3", uriKind: "https", uriChangeCount: 1, agentUriTruncated: true });
      expect(body.agentUri).toHaveLength(2048);
      expect(body.uriHistory).toHaveLength(1);

      const withFeedback = (await request(app).get("/v1/agents/mainnet/000")).body as AgentDetail;
      expect(withFeedback.agentId).toBe("0");
      expect(withFeedback.recentFeedback.map((f) => [f.feedbackIndex, f.revoked, f.value, f.valueDecimals])).toEqual([
        ["2", true, "-25", 1],
        ["1", false, "-25", 1],
      ]);
    });

    run("404s for unknown agents and routes", async () => {
      const missing = await request(app).get("/v1/agents/mainnet/99");
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe("agent_not_found");
      expect((await request(app).get("/v1/nope")).status).toBe(404);
    });

    run("reports sync status and missing agents", async () => {
      const main = (await request(app).get("/v1/sync-status")).body as SyncStatus;
      expect(main).toMatchObject({
        network: "mainnet",
        indexed: true,
        indexer: { ready: true, usingHyperSync: true, lagBlocks: "10", eventsProcessed: "1234" },
        agents: { indexedCount: 5, highestIndexedAgentId: "4" },
        chain: { highestAgentId: "6", error: null },
        missingAgents: "2",
      });

      const test = (await request(app).get("/v1/sync-status?network=testnet")).body as SyncStatus;
      expect(test).toMatchObject({ indexed: false, indexer: null, chain: { error: "rpc down" }, missingAgents: null });
    });

    run("answers 503 while the indexer has not created its tables", async () => {
      const cold = createApp({
        config: { INDEXER_DB_SCHEMA: "schema_that_does_not_exist", CORS_ORIGINS: [], RATE_LIMIT_PER_MINUTE: 10_000 },
        db: db!,
        chain: fakeChain,
      });
      const res = await request(cold).get("/v1/agents");
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("index_not_ready");
    });
  }
});
