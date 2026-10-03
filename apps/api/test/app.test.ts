/**
 * Integration tests against a real Postgres. Tables are cloned from the live
 * Envio schema (`LIKE envio."Agent"`), so these tests fail if Envio's column
 * names drift from what the API queries. Skipped when the database or the
 * Envio schema is unavailable (run `pnpm db:up` and `pnpm indexer:up` first).
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import type {
  ActivityListResponse,
  AgentDetail,
  AgentListResponse,
  AgentPaymentsResponse,
  AgentReceiptsResponse,
  PaymentLookupResponse,
  ReceiptView,
  SyncStatus,
} from "@moltforest/types";
import { loadConfig } from "../src/config.js";
import { createDb, type Db } from "../src/db.js";
import { createApp } from "../src/app.js";
import type { ChainChecker } from "../src/services/chainCheck.js";
import { ActivityHub } from "../src/services/activityHub.js";
import { createActivityRepository } from "../src/repositories/activity.js";
import { createSyncRepository } from "../src/repositories/sync.js";

const OWNER_A = "0x00000000000000000000000000000000000000aa";
const OWNER_B = "0x00000000000000000000000000000000000000bb";
const SCHEMA = `api_test_${randomBytes(4).toString("hex")}`;
const BETA_URI = "https://b.example/" + "x".repeat(3000);
/** How the indexer stores an agent with a remote agentURI before enrichment. */
const REMOTE = { uri_kind: "https", metadata_status: "pending", name: null, services: "[]", service_count: 0 };

const fakeChain: ChainChecker = {
  highestAgentId: async (network) =>
    network === "mainnet"
      ? { highestAgentId: "10", checkedAt: new Date("2026-09-26T00:00:00Z"), error: null }
      : { highestAgentId: null, checkedAt: null, error: "rpc down" },
};

let db: Db | undefined;
let app: Express;
let hub: ActivityHub;
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
    const exists = await pool.query(
      `SELECT to_regclass('envio."Agent"') AS t, to_regclass('app.agent_profile') AS p, to_regclass('app.endpoint_status') AS e`,
    );
    if (!exists.rows[0]?.t || !exists.rows[0]?.p || !exists.rows[0]?.e) {
      skipReason = "needs the indexer tables (start the indexer once) and `pnpm db:migrate`";
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
  for (const t of ["agent_profile", "endpoint_status", "endpoint_uptime_daily", "receipt", "x402_payment", "agent_review_summary", "review_assessment"]) {
    await db.query(`CREATE TABLE ${s}."${t}" (LIKE app."${t}" INCLUDING ALL)`);
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
    // Remote agents: the indexer only knows the URI; fields come from app.agent_profile.
    agent(143, 3, { ...REMOTE, owner: OWNER_B, feedback_count: 5, agent_uri: BETA_URI, uri_change_count: 1 }),
    agent(143, 4, { name: "Gamma", feedback_count: 9 }),
    agent(143, 5, { ...REMOTE, agent_uri: "https://e.example/5.json" }), // never fetched → pending
    agent(143, 6, { ...REMOTE, agent_uri: "https://e.example/6-new.json" }), // profile is for an old URI → pending
    agent(143, 7, { ...REMOTE, agent_uri: "https://e.example/7.json" }), // fetch failed definitively → unreachable
    agent(143, 8, { ...REMOTE, agent_uri: "ipfs://bafy8", uri_kind: "ipfs" }), // transient outage keeps last good profile
    agent(10143, 0, { name: "Testnet Alpha" }),
  ];
  for (const r of rows) {
    const cols = Object.keys(r);
    await db.query(
      `INSERT INTO ${s}."Agent" (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(r),
    );
  }

  const profile = async (id: number, uri: string, over: Record<string, unknown>) => {
    const r = {
      chain_id: 143,
      agent_id: id,
      uri,
      uri_kind: uri.startsWith("ipfs") ? "ipfs" : "https",
      status: "ok",
      fetched_at: new Date("2026-09-28T00:00:00Z"),
      next_fetch_at: new Date("2026-09-28T06:00:00Z"),
      ...over,
    };
    const cols = Object.keys(r);
    await db!.query(
      `INSERT INTO ${s}."agent_profile" (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(r),
    );
  };
  const okAt = new Date("2026-09-28T00:00:00Z");
  await profile(3, BETA_URI, {
    name: "Beta_Oracle 100%",
    services: JSON.stringify([{ name: "A2A", endpoint: "https://b.example" }, { name: "MCP", endpoint: "https://b.example/mcp" }]),
    service_count: 2,
    last_ok_at: okAt,
  });
  await profile(6, "https://e.example/6-old.json", { name: "Stale", services: JSON.stringify([{ name: "x", endpoint: "https://x" }]), service_count: 1, last_ok_at: okAt });
  await profile(7, "https://e.example/7.json", { status: "unreachable", http_status: 404, error: "HTTP 404" });
  await profile(8, "ipfs://bafy8", {
    status: "unreachable",
    http_status: 503,
    error: "HTTP 503",
    name: "Ipfs Eight",
    services: JSON.stringify([{ name: "MCP", endpoint: "https://i.example/mcp" }]),
    service_count: 1,
    last_ok_at: okAt,
    change_count: 2,
  });

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
  // D31 assessment of agent 0's one non-revoked review.
  await db.query(
    `INSERT INTO ${s}."agent_review_summary" (chain_id, agent_id, counted_reviews, counted_reviewers, excluded, pending_reviewers, assessment_hash, assessed_at)
     VALUES (143, 0, 0, 0, '{"SELF_REVIEW": 1}', 0, 'h', '2026-10-03T00:00:00Z')`,
  );
  await db.query(
    `INSERT INTO ${s}."review_assessment" (chain_id, agent_id, client, feedback_index, counted, reason, evidence)
     VALUES (143, 0, lower($1), 1, false, 'SELF_REVIEW', $2::jsonb)`,
    [OWNER_B, JSON.stringify({ reviewer: OWNER_B.toLowerCase(), role: "owner" })],
  );
  await db.query(
    `INSERT INTO ${s}."envio_chains" (id, ecosystem, start_block, max_reorg_depth, buffer_block, source_block, ready_at,
       events_processed, _is_hyper_sync, progress_block, progress_block_time, checkpoint_id)
     VALUES (143, 'evm', 0, 200, 5000, 5000, now(), 1234, true, 4990, now(), 1)`,
  );

  // Liveness: both of Beta's endpoints are checked (one is an x402 paywall); agent 0's is not.
  for (const [url, http, up, lat] of [
    ["https://b.example", 200, 9, 450],
    ["https://b.example/mcp", 402, 10, 1000],
  ] as const) {
    await db.query(
      `INSERT INTO ${s}.endpoint_status (url, host, status, http_status, latency_ms, payment_required, first_checked_at, last_checked_at, last_up_at, next_check_at)
       VALUES ($1, 'b.example', 'up', $2::int, 50, $3, now(), now(), now(), now() + interval '15 minutes')`,
      [url, http, http === 402],
    );
    await db.query(
      `INSERT INTO ${s}.endpoint_uptime_daily (url, day, checks, up, latency_ms_sum, latency_ms_max)
       VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 10, $2::int, $3::bigint, 120)`,
      [url, up, lat],
    );
  }

  hub = new ActivityHub(
    { activity: createActivityRepository(db, { indexer: SCHEMA, app: SCHEMA }), sync: createSyncRepository(db, SCHEMA) },
    { pollMs: 60_000, maxEventsPerTick: 50, maxSubscribers: 10 },
  );
  app = createApp({
    activityHub: hub,
    config: { INDEXER_DB_SCHEMA: SCHEMA, APP_DB_SCHEMA: SCHEMA, CORS_ORIGINS: ["http://localhost:3000"], RATE_LIMIT_PER_MINUTE: 10_000 },
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
      expect(body).toMatchObject({ network: "mainnet", chainId: 143, sort: "newest", includeIncomplete: false, total: 4, hiddenIncomplete: 5, totalIndexed: 9 });
      expect(body.filters).toEqual({ payments: null, protocol: null, endpoint: null, minReviewers: null });
      // 8: remote profile kept through an outage · 4: inline · 3: fetched remote profile · 0: inline
      expect(ids(body)).toEqual(["8", "4", "3", "0"]);
      expect(body.items[2]).toMatchObject({
        name: "Beta_Oracle 100%",
        metadataStatus: "ok",
        serviceCount: 2,
        globalId: "eip155:143:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432:3",
        reputation: { feedbackCount: 5 },
      });
      expect(body.items[0]).not.toHaveProperty("trustScore");
    });

    run("includeIncomplete shows every indexed agent with its effective status", async () => {
      const res = await request(app).get("/v1/agents?includeIncomplete=true&sort=oldest");
      const body = res.body as AgentListResponse;
      expect(ids(body)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8"]);
      expect(body.total).toBe(9);
      expect(body.hiddenIncomplete).toBeNull();
      const status = Object.fromEntries(body.items.map((a) => [a.agentId, a.metadataStatus]));
      expect(status).toMatchObject({ "2": "empty", "3": "ok", "5": "pending", "6": "pending", "7": "unreachable", "8": "ok" });
      expect(body.items.find((a) => a.agentId === "6")).toMatchObject({ name: null, serviceCount: 0 }); // stale profile not shown
    });

    run("keeps networks apart", async () => {
      const res = await request(app).get("/v1/agents?network=testnet");
      expect(res.body).toMatchObject({ network: "testnet", chainId: 10143, total: 1 });
      expect(res.body.items[0]).toMatchObject({ agentId: "0", name: "Testnet Alpha" });
    });

    run("paginates with a keyset cursor", async () => {
      const first = await request(app).get("/v1/agents?limit=3");
      expect(ids(first.body)).toEqual(["8", "4", "3"]);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      const second = await request(app).get(`/v1/agents?limit=3&cursor=${first.body.nextCursor}`);
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
      // Counted reviews (D31): agent 0 has 5 raw reviews but none counts; unassessed agents use their raw totals.
      expect(seen).toEqual(["4", "3", "8", "0"]);
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
      expect(body).toMatchObject({
        agentId: "3",
        uriKind: "https",
        uriChangeCount: 1,
        agentUriTruncated: true,
        profileSource: "remote",
        profileFetch: { status: "ok", contentChangeCount: 0, lastOkAt: "2026-09-28T00:00:00.000Z" },
      });
      expect(body.agentUri).toHaveLength(2048);
      expect(body.uriHistory).toHaveLength(1);

      const detail = async (id: number) => (await request(app).get(`/v1/agents/mainnet/${id}`)).body as AgentDetail;
      expect(await detail(5)).toMatchObject({ metadataStatus: "pending", profileFetch: null });
      expect(await detail(6)).toMatchObject({ metadataStatus: "pending", name: null, profileFetch: null });
      expect(await detail(7)).toMatchObject({ metadataStatus: "unreachable", metadataError: "HTTP 404", profileFetch: { status: "unreachable", httpStatus: 404, lastOkAt: null } });
      expect(await detail(8)).toMatchObject({ metadataStatus: "ok", name: "Ipfs Eight", profileFetch: { status: "unreachable", httpStatus: 503, contentChangeCount: 2 } });
      expect(await detail(4)).toMatchObject({ profileSource: "onchain", profileFetch: null });

      const withFeedback = (await request(app).get("/v1/agents/mainnet/000")).body as AgentDetail;
      expect(withFeedback.agentId).toBe("0");
      expect(withFeedback.recentFeedback.map((f) => [f.feedbackIndex, f.revoked, f.value, f.valueDecimals])).toEqual([
        ["2", true, "-25", 1],
        ["1", false, "-25", 1],
      ]);

      // D31: counted numbers next to the totals, and a neutral reason per review that does not count.
      expect(withFeedback.reputation.counted).toEqual({
        reviews: 0,
        reviewers: 0,
        notCounted: { SELF_REVIEW: 1 },
        pendingReviewers: 0,
        assessedAt: "2026-10-03T00:00:00.000Z",
      });
      expect(withFeedback.recentFeedback.map((f) => [f.feedbackIndex, f.counted, f.notCounted?.reason ?? null])).toEqual([
        ["2", null, null],
        ["1", false, "SELF_REVIEW"],
      ]);
      expect(withFeedback.recentFeedback[1]!.notCounted?.evidence).toEqual({ reviewer: OWNER_B.toLowerCase(), role: "owner" });
      expect((await detail(4)).reputation.counted).toBeNull();
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
        agents: { indexedCount: 9, highestIndexedAgentId: "8" },
        chain: { highestAgentId: "10", error: null },
        missingAgents: "2",
      });

      const test = (await request(app).get("/v1/sync-status?network=testnet")).body as SyncStatus;
      expect(test).toMatchObject({ indexed: false, indexer: null, chain: { error: "rpc down" }, missingAgents: null });
    });

    run("counts x402 payments per agent: received from others, sent, and self-payments", async () => {
      const EXT = "0x00000000000000000000000000000000000000ee";
      const tx = (n: number) => `0x${String(n).padStart(64, "0")}`;
      const pay = (n: number, payer: string, payee: string, units: number) =>
        db!.query(
          `INSERT INTO "${SCHEMA}".x402_payment (chain_id, tx_hash, log_index, block_number, block_time, asset, payer, payee, amount, facilitator)
           VALUES (143, $1, 1, $2, $3, '0xusdc', $4, $5, $6, '0xfacilitator')`,
          [tx(n), 5000 + n, new Date(Date.UTC(2026, 8, n)), payer, payee, units],
        );
      await pay(1, OWNER_A, OWNER_B, 1_000_000); // agents owned by A pay agent 3
      await pay(2, EXT, OWNER_B, 2_500_000); // an outside wallet pays agent 3
      await pay(3, OWNER_B, OWNER_B, 10_000_000); // agent 3 pays itself
      await pay(4, OWNER_B, EXT, 500_000); // agent 3 pays an outside wallet
      try {
        const list = (await request(app).get("/v1/agents?includeIncomplete=true")).body as AgentListResponse;
        expect(list.items.find((a) => a.agentId === "3")!.payments).toEqual({
          receivedFromOthers: 2,
          sent: 1,
          selfPayments: 1,
          receivedAmount: "3.5",
          sentAmount: "0.5",
          lastPaymentAt: new Date(Date.UTC(2026, 8, 4)).toISOString(),
        });
        expect(list.items.find((a) => a.agentId === "4")!.payments).toMatchObject({ receivedFromOthers: 0, sent: 1, sentAmount: "1", selfPayments: 0 });

        const all = (await request(app).get("/v1/agents/mainnet/3/payments")).body as AgentPaymentsResponse;
        expect(all.addresses).toEqual([{ address: OWNER_B, roles: ["owner", "wallet"], agentCount: 1 }]);
        expect(all.items.map((p) => [p.txHash, p.direction, p.amount])).toEqual([
          [tx(4), "sent", "0.5"],
          [tx(3), "self", "10"],
          [tx(2), "received", "2.5"],
          [tx(1), "received", "1"],
        ]);
        const fromA = all.items.find((p) => p.txHash === tx(1))!;
        expect(fromA).toMatchObject({ payer: OWNER_A, payerAgentCount: 8, payeeAgentIds: ["3"], payeeAgentCount: 1, facilitator: "0xfacilitator", assetSymbol: "USDC" });
        expect(fromA.payerAgentIds.slice(0, 3)).toEqual(["0", "1", "2"]);

        const received = (await request(app).get("/v1/agents/mainnet/3/payments?direction=received&limit=1")).body as AgentPaymentsResponse;
        expect(received.items.map((p) => p.txHash)).toEqual([tx(2)]);
        const next = (await request(app).get(`/v1/agents/mainnet/3/payments?direction=received&limit=1&cursor=${received.nextCursor}`)).body as AgentPaymentsResponse;
        expect(next.items.map((p) => p.txHash)).toEqual([tx(1)]);
        expect(next.nextCursor).toBeNull();

        const lookup = (await request(app).get(`/v1/payments/${tx(2).toUpperCase().replace("0X", "0x")}`)).body as PaymentLookupResponse;
        expect(lookup.items).toMatchObject([{ network: "mainnet", payer: EXT, payeeAgentIds: ["3"], amount: "2.5" }]);
        expect(((await request(app).get(`/v1/payments/${tx(99)}?network=testnet`)).body as PaymentLookupResponse).items).toEqual([]);
        expect((await request(app).get("/v1/payments/0x1234")).status).toBe(400);
        expect((await request(app).get("/v1/agents/mainnet/999/payments")).status).toBe(404);
      } finally {
        await db!.query(`DELETE FROM "${SCHEMA}".x402_payment`);
      }
    });

    run("filters the listing by x402 payments, never counting self-payments", async () => {
      const EXT = "0x00000000000000000000000000000000000000ee";
      const pay = (n: number, payer: string, payee: string) =>
        db!.query(
          `INSERT INTO "${SCHEMA}".x402_payment (chain_id, tx_hash, log_index, block_number, block_time, asset, payer, payee, amount, facilitator)
           VALUES (143, $1, 1, $2, now(), '0xusdc', $3, $4, 1000000, NULL)`,
          [`0x${String(n).padStart(64, "0")}`, 6000 + n, payer, payee],
        );
      const list = async (query: string) => (await request(app).get(`/v1/agents?${query}`)).body as AgentListResponse;
      try {
        await pay(1, OWNER_B, OWNER_B); // agent 3 pays itself
        expect(ids(await list("payments=any&includeIncomplete=true"))).toEqual([]);

        await pay(2, EXT, OWNER_B); // an outside wallet pays agent 3
        await pay(3, OWNER_A, EXT); // agents owned by A pay an outside wallet
        expect(ids(await list("payments=received"))).toEqual(["3"]);
        const sent = await list("payments=sent");
        expect(ids(sent)).toEqual(["8", "4", "0"]);
        expect(sent).toMatchObject({ total: 3, hiddenIncomplete: 5, filters: { payments: "sent", protocol: null } });
        expect(await list("payments=sent&includeIncomplete=true")).toMatchObject({ total: 8, hiddenIncomplete: null });
        expect(ids(await list("payments=any"))).toEqual(["8", "4", "3", "0"]);
        expect(ids(await list("payments=sent&protocol=mcp"))).toEqual(["8"]);
        expect((await request(app).get("/v1/agents?payments=self")).status).toBe(400);
      } finally {
        await db!.query(`DELETE FROM "${SCHEMA}".x402_payment`);
      }
    });

    run("filters the listing by protocol, endpoint status and distinct reviewers", async () => {
      const list = async (query: string) => ids((await request(app).get(`/v1/agents?${query}`)).body as AgentListResponse);
      // Service names are matched case-insensitively ("MCP", "A2A" in the fixtures).
      expect(await list("protocol=mcp")).toEqual(["8", "3"]);
      expect(await list("protocol=a2a")).toEqual(["4", "3", "0"]);
      expect(await list("protocol=web")).toEqual([]);

      await db!.query(
        `INSERT INTO "${SCHEMA}".endpoint_status (url, host, status, payment_required, first_checked_at, last_checked_at, next_check_at)
         VALUES ('https://a4.example', 'a4.example', 'down', false, now(), now(), now())`,
      );
      try {
        expect(await list("endpoint=up")).toEqual(["3"]);
        expect(await list("endpoint=payment_required")).toEqual(["3"]);
      } finally {
        await db!.query(`DELETE FROM "${SCHEMA}".endpoint_status WHERE url = 'https://a4.example'`);
      }

      // Counted reviewers (D31): agent 0 has 3 reviewer wallets, but its assessment counts none of them.
      expect(await list("minReviewers=1")).toEqual([]);
      await db!.query(`UPDATE "${SCHEMA}".agent_review_summary SET counted_reviewers = 3 WHERE chain_id = 143 AND agent_id = 0`);
      try {
        expect(await list("minReviewers=3")).toEqual(["0"]);
        expect(await list("minReviewers=4")).toEqual([]);
        expect(await list("protocol=a2a&minReviewers=1&sort=oldest")).toEqual(["0"]);
      } finally {
        await db!.query(`UPDATE "${SCHEMA}".agent_review_summary SET counted_reviewers = 0 WHERE chain_id = 143 AND agent_id = 0`);
      }
      expect((await request(app).get("/v1/agents?minReviewers=0")).status).toBe(400);
      expect((await request(app).get("/v1/agents?protocol=grpc")).status).toBe(400);
    });

    run("counts receipts where the agent is the provider, not the client", async () => {
      const receipt = (n: number, provider: number, client: number, level: 1 | 2, status: string) =>
        db!.query(
          `INSERT INTO "${SCHEMA}".receipt (receipt_hash, chain_id, registry, task_id, client_agent_id, provider_agent_id, request_hash,
             result_hash, payment_ref, started_at, completed_at, proof_type, proof_ref, level, provider_signature, provider_signer,
             anchor_status)
           VALUES ($1, 143, '0x00', '0x00', $2, $3, '0x00', '0x00', '0x00', $4, $4, 0, '0x00', $5, '0x00', '0x00', $6)`,
          [`0x${String(n).padStart(64, "0")}`, client, provider, 1_790_000_000 + n, level, status],
        );
      await receipt(1, 3, 4, 1, "queued");
      await receipt(2, 3, 4, 2, "anchored");
      await receipt(3, 4, 3, 2, "anchored"); // agent 3 is only the client here
      try {
        const list = (await request(app).get("/v1/agents")).body as AgentListResponse;
        expect(list.items.find((a) => a.agentId === "3")!.receipts).toEqual({
          total: 2,
          coSigned: 1,
          anchored: 1,
          lastCompletedAt: new Date((1_790_000_000 + 2) * 1000).toISOString(),
        });
        expect(list.items.find((a) => a.agentId === "0")!.receipts).toEqual({ total: 0, coSigned: 0, anchored: 0, lastCompletedAt: null });
        const detail = (await request(app).get("/v1/agents/mainnet/4")).body as AgentDetail;
        expect(detail.receipts).toMatchObject({ total: 1, coSigned: 1 });
      } finally {
        await db!.query(`DELETE FROM "${SCHEMA}".receipt`);
      }
    });

    run("links a receipt to the x402 payment its paymentRef names, both ways", async () => {
      const tx = `0x${"77".repeat(32)}`;
      const linked = `0x${"a1".repeat(32)}`;
      const unpaid = `0x${"a2".repeat(32)}`;
      await db!.query(
        `INSERT INTO "${SCHEMA}".x402_payment (chain_id, tx_hash, log_index, block_number, block_time, asset, payer, payee, amount, facilitator)
         VALUES (143, $1, 3, 5000, '2026-10-03T00:00:00Z', '0xusdc', '0x00000000000000000000000000000000000000c1', '0x00000000000000000000000000000000000000c2', 10000, '0xfac')`,
        [tx],
      );
      for (const [hash, ref] of [[linked, tx], [unpaid, `0x${"0".repeat(64)}`]] as const) {
        await db!.query(
          `INSERT INTO "${SCHEMA}".receipt (receipt_hash, chain_id, registry, task_id, client_agent_id, provider_agent_id, request_hash,
             result_hash, payment_ref, started_at, completed_at, proof_type, proof_ref, level, provider_signature, provider_signer, anchor_status)
           VALUES ($1, 143, '0x00', '0x00', 3, 4, '0x00', '0x00', $2, 1790000000, 1790000000, 0, '0x00', 2, '0x00', '0x00', 'anchored')`,
          [hash, ref],
        );
      }
      try {
        const r = (await request(app).get(`/v1/receipts/${linked}`)).body as ReceiptView;
        expect(r.payment).toMatchObject({ txHash: tx, amount: "0.01", logIndex: 3, receiptHashes: [linked] });
        expect(((await request(app).get(`/v1/receipts/${unpaid}`)).body as ReceiptView).payment).toBeNull();

        const pay = (await request(app).get(`/v1/payments/${tx}?network=mainnet`)).body as PaymentLookupResponse;
        expect(pay.items.map((p) => p.receiptHashes)).toEqual([[linked]]);

        const list = (await request(app).get("/v1/agents/mainnet/4/receipts")).body as AgentReceiptsResponse;
        expect(Object.fromEntries(list.items.map((i) => [i.receiptHash, i.payment?.txHash ?? null]))).toEqual({ [linked]: tx, [unpaid]: null });
      } finally {
        await db!.query(`DELETE FROM "${SCHEMA}".receipt`);
        await db!.query(`DELETE FROM "${SCHEMA}".x402_payment`);
      }
    });

    run("rolls endpoint liveness up per agent and details it per endpoint", async () => {
      const list = (await request(app).get("/v1/agents")).body as AgentListResponse;
      const beta = list.items.find((a) => a.agentId === "3")!;
      expect(beta.liveness).toEqual({ endpoints: 2, checked: 2, up: 2, notPublic: 0, paymentRequired: 1, uptime7d: 0.95, checks7d: 20 });
      const alpha = list.items.find((a) => a.agentId === "0")!;
      expect(alpha.liveness).toMatchObject({ endpoints: 1, checked: 0, uptime7d: null });

      const detail = (await request(app).get("/v1/agents/mainnet/3")).body as AgentDetail;
      expect(detail.endpoints).toEqual([
        expect.objectContaining({ url: "https://b.example", status: "up", httpStatus: 200, uptime7d: 0.9, checks7d: 10, avgLatencyMs7d: 50 }),
        expect.objectContaining({ url: "https://b.example/mcp", status: "up", paymentRequired: true, uptime7d: 1, avgLatencyMs7d: 100 }),
      ]);
      const unchecked = (await request(app).get("/v1/agents/mainnet/0")).body as AgentDetail;
      expect(unchecked.endpoints).toEqual([expect.objectContaining({ url: "https://a0.example", status: "unchecked" })]);
    });

    run("lists recent on-chain activity newest first", async () => {
      const res = await request(app).get("/v1/activity?limit=4");
      expect(res.status).toBe(200);
      const body = res.body as ActivityListResponse;
      expect(body.items.map((e) => [e.type, e.agentId, e.blockNumber])).toEqual([
        ["feedback_given", "0", "1200"],
        ["feedback_given", "0", "1100"],
        ["profile_updated", "3", "1010"],
        ["agent_registered", "8", "1008"],
      ]);
      expect(body.items[0]).toMatchObject({ agentName: "Alpha Reviewer", detail: "-2.5 · quality", actor: OWNER_B });
      expect(body.items[2]).toMatchObject({ agentName: "Beta_Oracle 100%", detail: "https" });
    });

    run("streams newly indexed activity over SSE", async () => {
      const server = app.listen(0);
      const port = (server.address() as AddressInfo).port;
      let received = "";
      const req = http.get(`http://127.0.0.1:${port}/v1/activity/stream?network=mainnet`);
      const response = await new Promise<http.IncomingMessage>((resolve) => req.on("response", resolve));
      expect(response.headers["content-type"]).toContain("text/event-stream");
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (received += chunk));

      await hub.tick(); // first sighting sets the watermark (progress 4990); no replay
      await db!.query(
        `INSERT INTO "${SCHEMA}"."Feedback" (id, chain_id, agent_id, client, feedback_index, value, value_decimals, tag1, tag2, endpoint,
           feedback_uri, feedback_hash, revoked, response_count, block_number, "timestamp", tx_hash)
         VALUES ('4_new', 143, '4', $1, 1, 80, 0, 'speed', '', '', '', '0x', false, 0, 4995, now(), '0xfeed')`,
        [OWNER_A],
      );
      await db!.query(`UPDATE "${SCHEMA}".envio_chains SET progress_block = 5000 WHERE id = 143`);
      await hub.tick();
      await new Promise((r) => setTimeout(r, 100));

      req.destroy();
      server.close();
      expect(received).toContain("retry: 5000");
      expect(received).toContain("event: status");
      const activity = received.split("\n\n").find((block) => block.startsWith("event: activity"));
      expect(activity).toBeDefined();
      expect(JSON.parse(activity!.split("data: ")[1]!)).toMatchObject({ type: "feedback_given", agentId: "4", agentName: "Gamma", blockNumber: "4995", detail: "80 · speed" });
      expect(received.match(/event: activity/g)).toHaveLength(1); // older history was not replayed
    });

    run("answers 503 while the indexer has not created its tables", async () => {
      const cold = createApp({
        config: { INDEXER_DB_SCHEMA: "schema_that_does_not_exist", APP_DB_SCHEMA: "app", CORS_ORIGINS: [], RATE_LIMIT_PER_MINUTE: 10_000 },
        db: db!,
        chain: fakeChain,
      });
      const res = await request(cold).get("/v1/agents");
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("index_not_ready");
    });
  }
});
