import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { NetworkStats } from "@moltforest/types";
import type { NetworkCounts } from "../src/repositories/stats.js";
import { buildNetworkStats, STATS_TTL_MS, statsRouter } from "../src/routes/stats.js";
import { errorHandler } from "../src/lib/errors.js";

const NOW = new Date("2026-10-06T08:00:00Z");

const COUNTS: NetworkCounts = {
  progress: {
    startBlock: "0",
    progressBlock: "68618710",
    chainHeadBlock: "68618712",
    eventsProcessed: "10237",
    readyAt: NOW,
    usingHyperSync: true,
    progressBlockTime: NOW,
  },
  agents: 2015,
  reviews: 120,
  assessed: { counted: 40, verified: 1, pendingReviewers: 0 },
  payments: { x402: 963, nextBlock: "68618000", pendingAddresses: 0 },
  receipts: { total: 2, coSigned: 1, anchored: 1 },
};

const EMPTY: NetworkCounts = { progress: null, agents: null, reviews: null, assessed: null, payments: null, receipts: null };

describe("buildNetworkStats", () => {
  it("returns each count with its source", () => {
    const s = buildNetworkStats("testnet", COUNTS, NOW);
    expect(s).toMatchObject({ network: "testnet", chainId: 10143, generatedAt: NOW.toISOString() });
    expect(s.agents.indexed).toMatchObject({
      value: 2015,
      status: "measured",
      provenance: {
        api: "/v1/agents?network=testnet&includeIncomplete=true",
        contract: { address: "0x8004A818BFB912233c491871b3d84c89A494BD9e", events: ["Registered"] },
        blockRange: { from: "0", to: "68618710" },
      },
    });
    expect([s.reviews.total.value, s.reviews.counted.value, s.reviews.verified.value]).toEqual([120, 40, 1]);
    expect(s.reviews.counted.provenance.note).not.toContain("still being checked");
    // Payments are complete below the scan cursor.
    expect(s.payments.x402).toMatchObject({ value: 963, provenance: { blockRange: { from: "0", to: "68617999" } } });
    expect(s.payments.x402.provenance.note).not.toContain("can still grow");
    expect(s.receipts.total.provenance.contract?.address).toBe("0x4d2a256fCaAc8e52e4B91e977EF6dDD56E980f98");
    expect([s.receipts.total.value, s.receipts.coSigned.value, s.receipts.anchored.value]).toEqual([2, 1, 1]);
  });

  it("says when reviewer checks or payment backfills are still running", () => {
    const s = buildNetworkStats(
      "mainnet",
      { ...COUNTS, assessed: { counted: 40, verified: 1, pendingReviewers: 3 }, payments: { x402: 963, nextBlock: "68618000", pendingAddresses: 2 } },
      NOW,
    );
    expect(s.reviews.counted.provenance.note).toContain("can still drop");
    expect(s.payments.x402).toMatchObject({ value: 963, status: "measured" });
    expect(s.payments.x402.provenance.note).toContain("can still grow");
  });

  it("reports payments on a network that was never scanned as not measured, not zero", () => {
    const s = buildNetworkStats("mainnet", { ...COUNTS, payments: { x402: 0, nextBlock: null, pendingAddresses: 0 } }, NOW);
    expect(s.payments.x402).toMatchObject({ value: null, status: "not_measured" });
    expect(s.payments.x402.provenance.note).toContain("not indexed yet");
    expect(s.payments.x402.provenance.blockRange).toBeUndefined();
  });

  it("points mainnet receipts at the live ReceiptRegistry", () => {
    const s = buildNetworkStats("mainnet", { ...COUNTS, receipts: { total: 0, coSigned: 0, anchored: 0 } }, NOW);
    expect(s.receipts.total).toMatchObject({
      value: 0,
      status: "measured",
      provenance: { contract: { address: "0xbd5f1114092A92EF24Aa3ebE00e3c462f572eBFB" } },
    });
    expect(s.receipts.coSigned.provenance.contract?.address).toBe("0xbd5f1114092A92EF24Aa3ebE00e3c462f572eBFB");
  });

  it("reports what is not indexed yet as not measured, never as zero", () => {
    const s = buildNetworkStats("mainnet", EMPTY, NOW);
    for (const m of [s.agents.indexed, s.reviews.total, s.reviews.counted, s.reviews.verified, s.payments.x402, s.receipts.total, s.receipts.anchored]) {
      expect(m).toMatchObject({ value: null, status: "not_measured" });
    }
    expect(s.agents.indexed.provenance.blockRange).toBeUndefined();
    expect(s.payments.x402.provenance.blockRange).toBeUndefined();
  });
});

describe("GET /v1/stats", () => {
  function setup(read: () => Promise<NetworkCounts>) {
    let now = NOW.getTime();
    const calls: string[] = [];
    const counts = (network: string) => {
      calls.push(network);
      return read();
    };
    const app = express()
      .use("/v1", statsRouter({ counts }, () => new Date(now)))
      .use(errorHandler);
    return { app, calls, advance: (ms: number) => (now += ms) };
  }

  it("defaults to mainnet and serves one read per network for a minute", async () => {
    const { app, calls, advance } = setup(async () => COUNTS);
    const first = await request(app).get("/v1/stats");
    expect(first.status).toBe(200);
    expect((first.body as NetworkStats).network).toBe("mainnet");
    await request(app).get("/v1/stats?network=mainnet");
    await request(app).get("/v1/stats?network=testnet");
    expect(calls).toEqual(["mainnet", "testnet"]);

    advance(STATS_TTL_MS);
    const later = await request(app).get("/v1/stats");
    expect(calls).toEqual(["mainnet", "testnet", "mainnet"]);
    expect((later.body as NetworkStats).generatedAt).toBe(new Date(NOW.getTime() + STATS_TTL_MS).toISOString());
  });

  it("shares one read between concurrent requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app, calls } = setup(async () => {
      await gate;
      return COUNTS;
    });
    const pending = Promise.all([request(app).get("/v1/stats"), request(app).get("/v1/stats")]);
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [a, b] = await pending;
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(calls).toEqual(["mainnet"]);
  });

  it("does not cache a failed read", async () => {
    let fail = true;
    const { app, calls } = setup(async () => {
      if (fail) throw new Error("database down");
      return COUNTS;
    });
    expect((await request(app).get("/v1/stats")).status).toBe(500);
    fail = false;
    expect((await request(app).get("/v1/stats")).status).toBe(200);
    expect(calls).toEqual(["mainnet", "mainnet"]);
  });

  it("rejects an unknown network", async () => {
    const { app, calls } = setup(async () => COUNTS);
    const res = await request(app).get("/v1/stats?network=goerli");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
    expect(calls).toEqual([]);
  });
});
