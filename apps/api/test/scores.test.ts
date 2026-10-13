/**
 * Score + Merkle proof endpoint against real Postgres score_epoch tables.
 * Skipped when the database or tables are missing (`pnpm db:up` + `pnpm db:migrate`).
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { buildEpoch, computeScore, persistPublishedEpoch } from "@moltforest/scores";
import type { AgentScoreProofResponse } from "@moltforest/types";
import { loadConfig } from "../src/config.js";
import { createDb, type Db } from "../src/db.js";
import { createApp } from "../src/app.js";
import type { ChainChecker } from "../src/services/chainCheck.js";

const SCHEMA = `sc_test_${randomBytes(4).toString("hex")}`;
const fakeChain: ChainChecker = { highestAgentId: async () => ({ highestAgentId: null, checkedAt: null, error: null }) };

let db: Db | undefined;
let app: Express;
let skipReason: string | null = null;
let expectedRoot: string;

beforeAll(async () => {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    skipReason = (err as Error).message;
    return;
  }
  const pool = createDb(config.DATABASE_URL);
  try {
    const r = await pool.query(`SELECT to_regclass('app.score_epoch') AS t`);
    if (!r.rows[0]?.t) {
      skipReason = "needs `pnpm db:migrate` (score_epoch)";
      await pool.end();
      return;
    }
  } catch (err) {
    skipReason = `database unreachable: ${(err as Error).message}`;
    await pool.end();
    return;
  }
  db = pool;
  await db.query(`CREATE SCHEMA "${SCHEMA}"`);
  await db.query(`CREATE TABLE "${SCHEMA}"."score_epoch" (LIKE app."score_epoch" INCLUDING ALL)`);
  await db.query(`CREATE TABLE "${SCHEMA}"."score_epoch_agent" (LIKE app."score_epoch_agent" INCLUDING ALL)`);

  const scores = [
    computeScore({ agentId: "7", verifiedReviews: 3, countedReviewers: 2, totalPaidVolume: 30_000 }),
    computeScore({ agentId: "42", verifiedReviews: 1, countedReviewers: 1, totalPaidVolume: 10_000 }),
    computeScore({ agentId: "100", verifiedReviews: 0, countedReviewers: 0 }),
  ];
  const epoch = buildEpoch(1n, scores);
  expectedRoot = epoch.scoresRoot;
  await persistPublishedEpoch({
    db,
    schema: SCHEMA,
    chainId: 10143,
    scoreRegistry: "0x7d86edfedbe012f7fce72a95f51febea2f215785",
    epoch,
    publishTx: "0x732e970c8441cef4387d105c94a10988ba1db54619961e7c607cc98e473f99bf",
  });

  app = createApp({
    config: { INDEXER_DB_SCHEMA: SCHEMA, APP_DB_SCHEMA: SCHEMA, CORS_ORIGINS: [], RATE_LIMIT_PER_MINUTE: 10_000 },
    db,
    chain: fakeChain,
  });
});

afterAll(async () => {
  if (!db) return;
  await db.query(`DROP SCHEMA "${SCHEMA}" CASCADE`);
  await db.end();
});

describe("GET /v1/agents/:network/:agentId/score", () => {
  it("returns score + Merkle proof for a published agent", async () => {
    if (skipReason) return;
    const res = await request(app).get("/v1/agents/testnet/7/score");
    expect(res.status).toBe(200);
    const body = res.body as AgentScoreProofResponse;
    expect(body.agentId).toBe("7");
    expect(body.epochId).toBe("1");
    expect(body.chainId).toBe(10143);
    expect(body.scoresRoot.toLowerCase()).toBe(expectedRoot.toLowerCase());
    expect(body.score.scoreBps).toBeGreaterThan(0);
    expect(body.proof.length).toBeGreaterThan(0);
    expect(body.note).toMatch(/not a hiring verdict/i);
  });

  it("404 when agent has no leaf", async () => {
    if (skipReason) return;
    const res = await request(app).get("/v1/agents/testnet/999/score");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("score_not_found");
  });

  it("honors epochId query", async () => {
    if (skipReason) return;
    const missing = await request(app).get("/v1/agents/testnet/7/score").query({ epochId: 99 });
    expect(missing.status).toBe(404);
    const ok = await request(app).get("/v1/agents/testnet/7/score").query({ epochId: 1 });
    expect(ok.status).toBe(200);
    expect((ok.body as AgentScoreProofResponse).epochId).toBe("1");
  });

  it("skips corrupt newer epochs when resolving latest", async () => {
    if (skipReason || !db) return;
    // Insert a newer epoch header with the wrong root / incomplete leaves.
    await db.query(
      `INSERT INTO "${SCHEMA}"."score_epoch"
         (chain_id, epoch_id, inputs_root, scores_root, algo_hash, score_registry, publish_tx, published_at)
       VALUES ($1, 2, $2, $3, $4, $5, $6, now())`,
      [
        10143,
        expectedRoot,
        "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        "0x15514fa4836c653976d246bb270872ae0130ca5f7cd56178df50e1c1c16851a7",
        "0x7d86edfedbe012f7fce72a95f51febea2f215785",
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ],
    );
    await db.query(
      `INSERT INTO "${SCHEMA}"."score_epoch_agent"
         (chain_id, epoch_id, agent_id, score_bps, confidence_bps, paid_reviews, independent_clusters, total_paid_volume)
       VALUES ($1, 2, 7, 4000, 2500, 0, 1, 0)`,
      [10143],
    );

    const latest = await request(app).get("/v1/agents/testnet/7/score");
    expect(latest.status).toBe(200);
    expect((latest.body as AgentScoreProofResponse).epochId).toBe("1");

    const bad = await request(app).get("/v1/agents/testnet/7/score").query({ epochId: 2 });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe("scores_inconsistent");
  });
});
