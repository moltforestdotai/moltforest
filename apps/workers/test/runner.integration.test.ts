/**
 * Runs enrichment batches against real Postgres tables cloned from the live
 * `envio` and `app` schemas, with a fake fetcher. Skipped when the database,
 * the indexer tables, or the app migrations are missing.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { loadConfig } from "../src/config.js";
import { createProfileRepository } from "../src/enrich/repository.js";
import { runBatch } from "../src/enrich/runner.js";
import { HostLimiter } from "../src/net/hostLimiter.js";
import type { Fetcher } from "../src/enrich/enrichAgent.js";
import type { FetchOutcome } from "../src/net/fetchDocument.js";

const IDX = `wk_test_idx_${randomBytes(3).toString("hex")}`;
const APP = `wk_test_app_${randomBytes(3).toString("hex")}`;
let db: pg.Pool | undefined;
let skipReason: string | null = null;

const docs = new Map<string, FetchOutcome>();
const calls = new Map<string, number>();
const fetcher: Fetcher = async (url) => {
  calls.set(url, (calls.get(url) ?? 0) + 1);
  return docs.get(url) ?? { kind: "http_error", httpStatus: 404, finalUrl: url };
};
const okDoc = (url: string, name: string, services = 1): FetchOutcome => ({
  kind: "ok",
  httpStatus: 200,
  finalUrl: url,
  body: JSON.stringify({ name, services: Array.from({ length: services }, (_, i) => ({ name: `s${i}`, endpoint: `https://s${i}.example` })) }),
});

async function addAgent(chainId: number, id: number, uri: string, uriKind: string) {
  await db!.query(
    `INSERT INTO "${IDX}"."Agent" (id, chain_id, agent_id, owner, agent_uri, uri_kind, metadata_status, services, service_count,
       supported_trust, registered_block, registered_at, registered_tx, updated_block, updated_at, uri_change_count,
       feedback_count, revoked_feedback_count, unique_reviewer_count)
     VALUES ($1, $2, $3, '0x00', $4, $5, 'pending', '[]', 0, '{}', 1, now(), '0x', 1, now(), 0, 0, 0, 0)`,
    [String(id), chainId, id, uri, uriKind],
  );
}

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
    const r = await pool.query(`SELECT to_regclass('envio."Agent"') AS a, to_regclass('app.agent_profile') AS p`);
    if (!r.rows[0]?.a || !r.rows[0]?.p) {
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
  for (const t of ["agent_profile", "agent_profile_snapshot"]) {
    await db.query(`CREATE TABLE "${APP}"."${t}" (LIKE app."${t}" INCLUDING ALL)`);
  }
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

describe("enrichment runner (integration)", () => {
  const deps = () => ({
    repo: createProfileRepository(db!, { indexer: IDX, app: APP }),
    fetcher,
    limiter: new HostLimiter(4, 0),
  });
  const opts = { batchSize: 100, concurrency: 4, ipfsGateways: ["https://gw.example/ipfs/"] };
  const profile = async (chainId: number, id: number) =>
    (await db!.query(`SELECT * FROM "${APP}"."agent_profile" WHERE chain_id = $1 AND agent_id = $2`, [chainId, id])).rows[0];

  run("fetches only remote agents, stores results, and is idempotent", async () => {
    await addAgent(143, 1, "https://h.example/1.json", "https");
    await addAgent(143, 2, "ipfs://bafyTWO", "ipfs");
    await addAgent(143, 3, "https://h.example/missing.json", "https");
    await addAgent(143, 4, "data:application/json;base64,e30=", "data");
    await addAgent(10143, 1, "https://h.example/1.json", "https"); // same id + URI on testnet: separate row
    docs.set("https://h.example/1.json", okDoc("https://h.example/1.json", "One", 2));
    docs.set("https://gw.example/ipfs/bafyTWO", okDoc("https://gw.example/ipfs/bafyTWO", "Two"));

    const stats = await runBatch(deps(), opts);
    expect(stats).toMatchObject({ selected: 4, ok: 3, unreachable: 1, errors: 0 });

    expect(await profile(143, 1)).toMatchObject({ status: "ok", name: "One", service_count: 2, change_count: 0 });
    expect(await profile(143, 2)).toMatchObject({ status: "ok", name: "Two", fetch_url: "https://gw.example/ipfs/bafyTWO" });
    expect(await profile(143, 3)).toMatchObject({ status: "unreachable", http_status: 404, last_ok_at: null });
    expect(await profile(143, 4)).toBeUndefined();
    expect(await profile(10143, 1)).toMatchObject({ status: "ok" });

    const snapshots = await db!.query(`SELECT count(*)::int AS n FROM "${APP}"."agent_profile_snapshot"`);
    expect(snapshots.rows[0].n).toBe(3);

    // Nothing is due right after a run.
    expect((await runBatch(deps(), opts)).selected).toBe(0);
  });

  run("refetches immediately when the on-chain URI changes, and tracks content changes", async () => {
    await db!.query(`UPDATE "${IDX}"."Agent" SET agent_uri = 'https://h.example/1b.json' WHERE chain_id = 143 AND id = '1'`);
    docs.set("https://h.example/1b.json", okDoc("https://h.example/1b.json", "One B"));
    const stats = await runBatch(deps(), opts);
    expect(stats.selected).toBe(1);
    expect(await profile(143, 1)).toMatchObject({ uri: "https://h.example/1b.json", name: "One B", change_count: 1 });
  });

  run("fetches a URL shared by many agents only once per batch", async () => {
    const shared = "https://h.example/shared.json";
    for (const id of [20, 21, 22, 23, 24]) await addAgent(143, id, shared, "https");
    docs.set(shared, okDoc(shared, "Shared"));
    calls.delete(shared);
    const stats = await runBatch(deps(), opts);
    expect(stats).toMatchObject({ selected: 5, requests: 1, ok: 5 });
    expect(calls.get(shared)).toBe(1);
    expect(await profile(143, 24)).toMatchObject({ status: "ok", name: "Shared" });
  });

  run("keeps the last good profile through a transient outage", async () => {
    docs.set("https://h.example/1b.json", { kind: "http_error", httpStatus: 503, finalUrl: "https://h.example/1b.json" });
    await db!.query(`UPDATE "${APP}"."agent_profile" SET next_fetch_at = now() - interval '1 minute' WHERE chain_id = 143 AND agent_id = 1`);
    await runBatch(deps(), opts);
    const p = await profile(143, 1);
    expect(p).toMatchObject({ status: "unreachable", http_status: 503, name: "One B", failures: 1 });
    expect(p.last_ok_at).not.toBeNull();
  });
});
