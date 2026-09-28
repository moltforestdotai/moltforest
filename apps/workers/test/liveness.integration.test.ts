/**
 * Runs liveness batches against tables cloned from the live `envio` and `app`
 * schemas with a fake prober. Skipped when the database or tables are missing.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { loadConfig } from "../src/config.js";
import { createLivenessRepository } from "../src/liveness/repository.js";
import { runLivenessBatch, type Prober } from "../src/liveness/runner.js";
import { HostLimiter } from "../src/net/hostLimiter.js";
import type { ProbeOutcome } from "../src/net/fetchDocument.js";

const IDX = `lv_test_idx_${randomBytes(3).toString("hex")}`;
const APP = `lv_test_app_${randomBytes(3).toString("hex")}`;
let db: pg.Pool | undefined;
let skipReason: string | null = null;

const outcomes = new Map<string, ProbeOutcome>();
const probed: string[] = [];
const probe: Prober = async (url) => {
  probed.push(url);
  return outcomes.get(url) ?? { kind: "no_response", reason: "ECONNREFUSED", latencyMs: 3 };
};

const services = (...endpoints: string[]) => JSON.stringify(endpoints.map((endpoint, i) => ({ name: `s${i}`, endpoint })));

beforeAll(async () => {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    skipReason = (err as Error).message;
    return;
  }
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
  try {
    const r = await pool.query(`SELECT to_regclass('envio."Agent"') a, to_regclass('app.endpoint_status') e, to_regclass('app.agent_profile') p`);
    if (!r.rows[0]?.a || !r.rows[0]?.e || !r.rows[0]?.p) {
      skipReason = "needs the indexer tables and `pnpm db:migrate`";
      await pool.end();
      return;
    }
  } catch (err) {
    skipReason = `database unreachable: ${(err as Error).message}`;
    await pool.end();
    return;
  }
  db = pool;
  await db.query(`CREATE SCHEMA "${IDX}"; CREATE SCHEMA "${APP}"`);
  await db.query(`CREATE TABLE "${IDX}"."Agent" (LIKE envio."Agent" INCLUDING DEFAULTS)`);
  for (const t of ["agent_profile", "endpoint_status", "endpoint_uptime_daily"]) {
    await db.query(`CREATE TABLE "${APP}"."${t}" (LIKE app."${t}" INCLUDING ALL)`);
  }
  const agent = async (id: number, uri: string, kind: string, svc: string) =>
    db!.query(
      `INSERT INTO "${IDX}"."Agent" (id, chain_id, agent_id, owner, agent_uri, uri_kind, metadata_status, services, service_count,
         supported_trust, registered_block, registered_at, registered_tx, updated_block, updated_at, uri_change_count,
         feedback_count, revoked_feedback_count, unique_reviewer_count)
       VALUES ($1, 143, $5, '0x00', $2, $3, 'ok', $4::jsonb, 0, '{}', 1, now(), '0x', 1, now(), 0, 0, 0, 0)`,
      [String(id), uri, kind, svc, id],
    );
  // Inline profile: two http endpoints (one shared with agent 2) and a non-http one.
  await agent(1, "data:application/json,{}", "data", services("https://a.example/mcp", "https://shared.example/x402", "eip155:143:0xabc"));
  // Remote profile: endpoints come from app.agent_profile, not from the indexer row.
  await agent(2, "https://p.example/reg.json", "https", "[]");
  await db.query(
    `INSERT INTO "${APP}"."agent_profile" (chain_id, agent_id, uri, uri_kind, status, services, service_count, fetched_at, last_ok_at, next_fetch_at)
     VALUES (143, 2, 'https://p.example/reg.json', 'https', 'ok', $1::jsonb, 2, now(), now(), now() + interval '1 hour')`,
    [services("https://shared.example/x402", "http://localhost:3000/api")],
  );
  // Remote profile fetched for an OLD uri: its endpoints must not be checked.
  await agent(3, "https://p.example/new.json", "https", "[]");
  await db.query(
    `INSERT INTO "${APP}"."agent_profile" (chain_id, agent_id, uri, uri_kind, status, services, service_count, fetched_at, last_ok_at, next_fetch_at)
     VALUES (143, 3, 'https://p.example/old.json', 'https', 'ok', $1::jsonb, 1, now(), now(), now() + interval '1 hour')`,
    [services("https://stale.example/api")],
  );
});

afterAll(async () => {
  if (!db) return;
  await db.query(`DROP SCHEMA IF EXISTS "${IDX}" CASCADE; DROP SCHEMA IF EXISTS "${APP}" CASCADE`);
  await db.end();
});

const run = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    if (skipReason) ctx.skip(skipReason);
    await fn();
  });

describe("liveness runner (integration)", () => {
  const deps = () => ({ repo: createLivenessRepository(db!, { indexer: IDX, app: APP }), probe, limiter: new HostLimiter(2, 0) });
  const row = async (url: string) => (await db!.query(`SELECT * FROM "${APP}".endpoint_status WHERE url = $1`, [url])).rows[0];
  const day = async (url: string) => (await db!.query(`SELECT * FROM "${APP}".endpoint_uptime_daily WHERE url = $1`, [url])).rows[0];

  run("checks each declared http endpoint once, from effective profiles only", async () => {
    outcomes.set("https://a.example/mcp", { kind: "response", httpStatus: 200, latencyMs: 40 });
    outcomes.set("https://shared.example/x402", { kind: "response", httpStatus: 402, latencyMs: 60 });
    outcomes.set("http://localhost:3000/api", { kind: "blocked", reason: "blocked: localhost resolves to non-public address 127.0.0.1" });

    const stats = await runLivenessBatch(deps(), { batchSize: 50, concurrency: 4 });
    expect(stats).toMatchObject({ checked: 3, up: 2, blocked: 1, failures: 0 });
    expect(probed.sort()).toEqual(["http://localhost:3000/api", "https://a.example/mcp", "https://shared.example/x402"]);

    expect(await row("https://shared.example/x402")).toMatchObject({ status: "up", http_status: 402, payment_required: true, host: "shared.example" });
    expect(await row("http://localhost:3000/api")).toMatchObject({ status: "blocked" });
    expect(await day("https://a.example/mcp")).toMatchObject({ checks: 1, up: 1, latency_ms_max: 40 });
    expect(await day("http://localhost:3000/api")).toBeUndefined(); // blocked is not an uptime measurement

    expect((await runLivenessBatch(deps(), { batchSize: 50, concurrency: 4 })).checked).toBe(0); // nothing due yet
  });

  run("counts failures and keeps the x402 flag once seen", async () => {
    outcomes.set("https://shared.example/x402", { kind: "no_response", reason: "timed out", latencyMs: 5000 });
    await db!.query(`UPDATE "${APP}".endpoint_status SET next_check_at = now() - interval '1 minute' WHERE url = 'https://shared.example/x402'`);
    await runLivenessBatch(deps(), { batchSize: 50, concurrency: 4 });
    expect(await row("https://shared.example/x402")).toMatchObject({ status: "down", consecutive_failures: 1, payment_required: true });
    expect(await day("https://shared.example/x402")).toMatchObject({ checks: 2, up: 1 });
  });
});
