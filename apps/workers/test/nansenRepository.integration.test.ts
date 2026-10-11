/**
 * The Nansen lookup queue and stores (decision D47) against real Postgres
 * tables cloned from the `app` schema. Skipped when the database or the app
 * migrations are missing.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { loadConfig } from "../src/config.js";
import { createNansenRepository } from "../src/nansen/repository.js";
import { createReviewRepository } from "../src/reviews/repository.js";

const APP = `wk_test_nansen_${randomBytes(3).toString("hex")}`;
let db: pg.Pool | undefined;
let skipReason: string | null = null;

const w = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const CHAIN = 143;

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
    const r = await pool.query(`SELECT to_regclass('app.nansen_wallet') AS n, to_regclass('app.review_assessment') AS a`);
    if (!r.rows[0]?.n || !r.rows[0]?.a) {
      skipReason = "needs `pnpm db:migrate`";
      await pool.end();
      return;
    }
  } catch (err) {
    skipReason = `database unreachable: ${(err as Error).message}`;
    await pool.end();
    return;
  }
  db = pool;
  await db.query(`CREATE SCHEMA "${APP}"`);
  for (const t of ["nansen_wallet", "nansen_relation", "wallet_funding", "review_assessment"]) {
    await db.query(`CREATE TABLE "${APP}"."${t}" (LIKE app."${t}" INCLUDING ALL)`);
  }
});

afterAll(async () => {
  if (!db) return;
  await db.query(`DROP SCHEMA IF EXISTS "${APP}" CASCADE`);
  await db.end();
});

const run = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    if (skipReason) ctx.skip(skipReason);
    await fn();
  });

describe("Nansen repository (integration)", () => {
  const repo = () => createNansenRepository(db!, { app: APP });

  run("orders the queue, stores answers and failures, and counts the day's lookups", async () => {
    const review = (agentId: number, client: string, counted: boolean) =>
      db!.query(`INSERT INTO "${APP}".review_assessment (chain_id, agent_id, client, feedback_index, counted) VALUES ($1, $2, $3, 1, $4)`, [CHAIN, agentId, client, counted]);
    const funding = (address: string, status: string, funder: string | null) =>
      db!.query(`INSERT INTO "${APP}".wallet_funding (chain_id, address, status, funder) VALUES ($1, $2, $3, $4)`, [CHAIN, address, status, funder]);

    // Tier 1: counted reviewers. Tier 2: funding unknown. Tier 3: one wallet per funder of two or more.
    await review(1, w(0x30), true);
    await review(1, w(0x31), false);
    await review(2, w(0x40), false);
    await funding(w(0x31), "none", null);
    await funding(w(0x51), "found", w(0xf1));
    await funding(w(0x52), "found", w(0xf1));
    await funding(w(0x53), "found", w(0xf2));
    // Another chain never shows up.
    await db!.query(`INSERT INTO "${APP}".review_assessment (chain_id, agent_id, client, feedback_index, counted) VALUES (10143, 1, $1, 1, true)`, [w(0x99)]);

    const r = repo();
    expect(await r.dueWallets(CHAIN, 10, 4)).toEqual([w(0x30), w(0x31), w(0x51)]);
    // Focus agents come first.
    expect(await r.dueWallets(CHAIN, 10, 4, ["2"])).toEqual([w(0x40), w(0x30), w(0x31), w(0x51)]);
    expect(await r.dueWallets(CHAIN, 2, 4)).toEqual([w(0x30), w(0x31)]);

    await r.saveOk(CHAIN, w(0x30), [
      { address: w(0xf9), relation: "First Funder", label: "Binance 14", txHash: `0x${"ab".repeat(32)}`, blockTime: "2026-09-01T00:00:00.000Z" },
      { address: w(0x77), relation: "Signer", label: null, txHash: null, blockTime: null },
    ]);
    await r.saveError(CHAIN, w(0x31), "HTTP 503", true);
    await r.saveError(CHAIN, w(0x51), "HTTP 400", false);
    expect(await r.lookupsToday(CHAIN)).toBe(1);
    expect(await r.dueWallets(CHAIN, 10, 4)).toEqual([]);

    const stored = await db!.query(`SELECT wallet, related, relation, label, tx_hash, block_time FROM "${APP}".nansen_relation ORDER BY relation`);
    expect(stored.rows).toEqual([
      { wallet: w(0x30), related: w(0xf9), relation: "First Funder", label: "Binance 14", tx_hash: `0x${"ab".repeat(32)}`, block_time: new Date("2026-09-01T00:00:00Z") },
      { wallet: w(0x30), related: w(0x77), relation: "Signer", label: null, tx_hash: null, block_time: null },
    ]);
    const wallets = await db!.query(`SELECT address, status, relation_count, attempts, error, next_fetch_at = 'infinity' AS never FROM "${APP}".nansen_wallet ORDER BY address`);
    expect(wallets.rows).toEqual([
      { address: w(0x30), status: "ok", relation_count: 2, attempts: 1, error: null, never: true },
      { address: w(0x31), status: "error", relation_count: 0, attempts: 1, error: "HTTP 503", never: false },
      { address: w(0x51), status: "error", relation_count: 0, attempts: 1, error: "HTTP 400", never: true },
    ]);

    // A transient failure comes back once its backoff has passed, and a later answer replaces it.
    await db!.query(`UPDATE "${APP}".nansen_wallet SET next_fetch_at = now() - interval '1 minute' WHERE address = $1`, [w(0x31)]);
    expect(await r.dueWallets(CHAIN, 10, 4)).toEqual([w(0x31)]);
    expect(await r.dueWallets(CHAIN, 10, 1)).toEqual([]);
    await r.saveOk(CHAIN, w(0x31), []);
    const retried = await db!.query(`SELECT status, attempts, error FROM "${APP}".nansen_wallet WHERE address = $1`, [w(0x31)]);
    expect(retried.rows[0]).toEqual({ status: "ok", attempts: 2, error: null });

    // The reviews worker reads the stored rows back as links and service addresses.
    const facts = await createReviewRepository(db!, { indexer: "envio", app: APP }).nansenFacts(CHAIN);
    expect(facts.links).toEqual([
      { wallet: w(0x30), other: w(0x77), relation: "Signer", kind: "control", tx: null },
      { wallet: w(0x30), other: w(0xf9), relation: "First Funder", kind: "funding", tx: `0x${"ab".repeat(32)}` },
    ]);
    expect(facts.services).toEqual(new Map([[w(0xf9), "Binance 14"]]));
  });
});
