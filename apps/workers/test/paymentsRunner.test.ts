import { describe, expect, it } from "vitest";
import type { Payment } from "../src/payments/classify.js";
import type { HsResponse, HyperSync } from "../src/payments/hypersync.js";
import type { PaymentRepository } from "../src/payments/repository.js";
import { runPaymentsTick } from "../src/payments/runner.js";

const USDC = "0x534b2f3a21130d7a60830c2df862319e593943a3";

function fakeRepo(initial: string[]) {
  const state = { addresses: new Map(initial.map((a) => [a, false])), cursor: null as number | null, saved: [] as Payment[], toAdd: [] as string[] };
  const repo: PaymentRepository = {
    syncAddresses: async () => {
      let n = 0;
      for (const a of state.toAdd.splice(0)) if (!state.addresses.has(a)) (state.addresses.set(a, false), n++);
      return n;
    },
    addresses: async (_chain, caughtUp, limit = Infinity) => [...state.addresses].filter(([, c]) => c === caughtUp).map(([a]) => a).slice(0, limit),
    markCaughtUp: async (_chain, list) => void list.forEach((a) => state.addresses.set(a, true)),
    getCursor: async () => state.cursor,
    setCursor: async (_chain, next) => void (state.cursor = next),
    savePayments: async (list) => (state.saved.push(...list), list.length),
  };
  return { repo, state };
}

function fakeHyperSync(heights: number[]) {
  const queries: { from: number; to: number; addresses: number }[] = [];
  const hs: HyperSync = {
    height: async () => heights.shift() ?? 0,
    query: async (_chain, body: any): Promise<HsResponse> => {
      queries.push({ from: body.from_block, to: body.to_block, addresses: body.logs[0].topics[2].length });
      // Pages of at most 500 blocks.
      const next = Math.min(body.from_block + 500, body.to_block);
      return { data: [], next_block: next, archive_height: body.to_block };
    },
  };
  return { hs, queries };
}

describe("runPaymentsTick", () => {
  it("first run: cursor at the head, then backfills every address from block 0 in chunks", async () => {
    const { repo, state } = fakeRepo(["0xa", "0xb", "0xc"]);
    const { hs, queries } = fakeHyperSync([1000, 1000]);
    const stats = await runPaymentsTick({ repo, hs }, { chainId: 10143, usdc: USDC, chunkSize: 2 });
    expect(state.cursor).toBe(1000);
    expect(stats).toMatchObject({ backfilled: 3, scannedTo: 1000 });
    expect([...state.addresses.values()]).toEqual([true, true, true]);
    // 2 chunks × 2 pages over [0, 1000); no incremental scan because the head did not move.
    expect(queries).toEqual([
      { from: 0, to: 1000, addresses: 2 },
      { from: 500, to: 1000, addresses: 2 },
      { from: 0, to: 1000, addresses: 1 },
      { from: 500, to: 1000, addresses: 1 },
    ]);
  });

  it("next run: scans only [cursor, head) and backfills an address registered in between", async () => {
    const { repo, state } = fakeRepo(["0xa"]);
    state.addresses.set("0xa", true);
    state.cursor = 1000;
    state.toAdd.push("0xnew");
    const { hs, queries } = fakeHyperSync([1200]);
    const stats = await runPaymentsTick({ repo, hs }, { chainId: 10143, usdc: USDC });
    expect(stats).toMatchObject({ newAddresses: 1, backfilled: 1, scannedTo: 1200 });
    expect(state.cursor).toBe(1200);
    expect(queries).toEqual([
      { from: 0, to: 1000, addresses: 1 }, // backfill of 0xnew up to the old cursor
      { from: 500, to: 1000, addresses: 1 },
      { from: 1000, to: 1200, addresses: 2 }, // incremental for both, one page
    ]);
  });

  it("does nothing new when the head has not moved and no address is pending", async () => {
    const { repo, state } = fakeRepo(["0xa"]);
    state.addresses.set("0xa", true);
    state.cursor = 1000;
    const { hs, queries } = fakeHyperSync([1000]);
    await runPaymentsTick({ repo, hs }, { chainId: 10143, usdc: USDC });
    expect(queries).toEqual([]);
    expect(state.cursor).toBe(1000);
  });
});
