import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import type { AnchorChain, SimulateResult, TxOutcome } from "../src/anchor/chain.js";
import type { AnchorFact, AnchorRepository, DueReceipt } from "../src/anchor/repository.js";
import { retryDelayMs, runAnchorBatch, type AnchorOptions } from "../src/anchor/runner.js";

const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const T0 = new Date("2026-09-30T10:00:00Z");

function due(n: number, over: Partial<DueReceipt> = {}): DueReceipt {
  return {
    receiptHash: h(n),
    chainId: 10143,
    registry: "0x5555555555555555555555555555555555555555",
    taskId: h(1000 + n),
    clientAgentId: 0n,
    providerAgentId: 7n,
    requestHash: h(1),
    resultHash: h(2),
    paymentRef: h(0),
    startedAt: 1n,
    completedAt: 2n,
    proofType: 0,
    proofRef: h(0),
    level: 1,
    providerSignature: "0xaa",
    clientSignature: null,
    status: "queued",
    anchorLevel: null,
    anchorTx: null,
    attempts: 0,
    updatedAt: T0,
    ...over,
  };
}

type Call = [string, ...unknown[]];
function fakeRepo(rows: DueReceipt[], relayedToday = 0) {
  const calls: Call[] = [];
  const repo: AnchorRepository = {
    selectDue: async () => rows,
    relayedInLastDay: async () => relayedToday,
    markSending: async (hash, tx) => void calls.push(["sending", hash, tx]),
    markAnchored: async (hash, fact: AnchorFact) => void calls.push(["anchored", hash, fact]),
    markFailed: async (hash, error) => void calls.push(["failed", hash, error]),
    markSkipped: async (hash, reason) => void calls.push(["skipped", hash, reason]),
    retryLater: async (hash, error, delayMs, opts) => void calls.push(["retry", hash, error, delayMs, opts]),
  };
  return { repo, calls };
}

function fakeChain(over: Partial<AnchorChain> & { levels?: Record<string, number> } = {}) {
  const levels = over.levels ?? {};
  const sent: DueReceipt[] = [];
  const chain: AnchorChain = {
    relayer: "0x9999999999999999999999999999999999999999",
    balance: async () => 10n ** 18n,
    levelOf: async (hash) => levels[hash] ?? 0,
    simulate: async (): Promise<SimulateResult> => ({ ok: true }),
    send: async (r) => {
      sent.push(r);
      levels[r.receiptHash] = r.level;
      return h(9000 + sent.length);
    },
    wait: async (): Promise<TxOutcome> => ({ status: "success", blockNumber: 123n, blockTime: T0 }),
    ...over,
  };
  return { chain, sent, levels };
}

const opts: AnchorOptions = {
  chainId: 10143,
  batchSize: 20,
  maxPerAgentPerDay: 100,
  minBalanceWei: 10n ** 16n,
  txTimeoutMs: 1_000,
  droppedAfterMs: 10 * 60_000,
  maxAttempts: 3,
};
const run = (repo: AnchorRepository, chain: AnchorChain) => runAnchorBatch({ repo, chain, now: () => T0 }, opts);

describe("runAnchorBatch", () => {
  it("does nothing, not even a balance read, when the queue is empty", async () => {
    const { repo, calls } = fakeRepo([]);
    let balanceReads = 0;
    const { chain } = fakeChain({ balance: async () => (balanceReads++, 0n) });
    expect((await run(repo, chain)).selected).toBe(0);
    expect(balanceReads).toBe(0);
    expect(calls).toEqual([]);
  });

  it("sends, records the hash before waiting, then records the on-chain level", async () => {
    const { repo, calls } = fakeRepo([due(1)]);
    const { chain, sent } = fakeChain();
    const stats = await run(repo, chain);
    expect(stats.anchored).toBe(1);
    expect(sent).toHaveLength(1);
    expect(calls).toEqual([
      ["sending", h(1), h(9001)],
      ["anchored", h(1), { level: 1, txHash: h(9001), blockNumber: 123n, anchoredAt: T0 }],
    ]);
  });

  it("does not pay for a receipt that is already anchored at its level", async () => {
    const { repo, calls } = fakeRepo([due(1, { level: 2 })]);
    const { chain, sent } = fakeChain({ levels: { [h(1)]: 2 } });
    expect((await run(repo, chain)).alreadyAnchored).toBe(1);
    expect(sent).toHaveLength(0);
    expect(calls[0]).toEqual(["anchored", h(1), { level: 2, txHash: null, blockNumber: null, anchoredAt: T0 }]);
  });

  it("relays a co-signature for a receipt anchored at level 1", async () => {
    const { repo } = fakeRepo([due(1, { level: 2, clientSignature: "0xbb" })]);
    const { chain, sent } = fakeChain({ levels: { [h(1)]: 1 } });
    expect((await run(repo, chain)).anchored).toBe(1);
    expect(sent[0]?.level).toBe(2);
  });

  it("marks receipts the contract rejects as failed without sending", async () => {
    const { repo, calls } = fakeRepo([due(1)]);
    const { chain, sent } = fakeChain({ simulate: async () => ({ ok: false, revert: "InvalidProviderSignature" }) });
    expect((await run(repo, chain)).failed).toBe(1);
    expect(sent).toHaveLength(0);
    expect(calls[0]?.[0]).toBe("failed");
    expect(String(calls[0]?.[2])).toContain("InvalidProviderSignature");
  });

  it("treats an AlreadyAnchored dry run as a race someone else won", async () => {
    const levels: Record<string, number> = {};
    const { repo, calls } = fakeRepo([due(1)]);
    const { chain, sent } = fakeChain({
      levels,
      simulate: async () => {
        levels[h(1)] = 1;
        return { ok: false, revert: "AlreadyAnchored" };
      },
    });
    expect((await run(repo, chain)).alreadyAnchored).toBe(1);
    expect(sent).toHaveLength(0);
    expect(calls[0]).toEqual(["anchored", h(1), { level: 1, txHash: null, blockNumber: null, anchoredAt: T0 }]);
  });

  it("skips new anchors over the per-agent daily cap but still relays co-signatures", async () => {
    const { repo, calls } = fakeRepo([due(1), due(2, { level: 2, clientSignature: "0xbb" })], 100);
    const { chain, sent } = fakeChain({ levels: { [h(2)]: 1 } });
    const stats = await run(repo, chain);
    expect(stats).toMatchObject({ skipped: 1, anchored: 1 });
    expect(sent.map((r) => r.receiptHash)).toEqual([h(2)]);
    expect(calls[0]?.[0]).toBe("skipped");
  });

  it("sends nothing while the relayer balance is low", async () => {
    const { repo, calls } = fakeRepo([due(1)]);
    const { chain, sent } = fakeChain({ balance: async () => 1n });
    expect((await run(repo, chain)).lowBalance).toBe(true);
    expect(sent).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it("leaves a slow transaction as sending and resolves it in a later batch", async () => {
    const first = fakeRepo([due(1)]);
    const pending = fakeChain({ wait: async () => ({ status: "pending" }) });
    expect((await run(first.repo, pending.chain)).pending).toBe(1);
    expect(first.calls).toEqual([["sending", h(1), h(9001)]]);

    const later = fakeRepo([due(1, { status: "sending", anchorTx: h(9001) })]);
    const mined = fakeChain({ levels: { [h(1)]: 1 } });
    expect((await run(later.repo, mined.chain)).anchored).toBe(1);
    expect(mined.sent).toHaveLength(0);
    expect(later.calls[0]).toEqual(["anchored", h(1), { level: 1, txHash: h(9001), blockNumber: 123n, anchoredAt: T0 }]);
  });

  it("waits for a recent unknown transaction, and retries one presumed dropped", async () => {
    const recent = fakeRepo([due(1, { status: "sending", anchorTx: h(9001), updatedAt: new Date(T0.getTime() - 60_000) })]);
    const unknown = fakeChain({ wait: async () => ({ status: "pending" }) });
    expect((await run(recent.repo, unknown.chain)).pending).toBe(1);
    expect(unknown.sent).toHaveLength(0);

    const old = fakeRepo([due(1, { status: "sending", anchorTx: h(9001), updatedAt: new Date(T0.getTime() - 11 * 60_000) })]);
    let waits = 0;
    const dropped = fakeChain({ wait: async () => (waits++ === 0 ? { status: "pending" } : { status: "success", blockNumber: 5n, blockTime: T0 }) });
    expect((await run(old.repo, dropped.chain)).anchored).toBe(1);
    expect(dropped.sent).toHaveLength(1);
  });

  it("requeues after a reverted transaction unless someone else anchored meanwhile", async () => {
    const { repo, calls } = fakeRepo([due(1)]);
    const { chain } = fakeChain({
      send: async () => h(9001),
      wait: async () => ({ status: "reverted", blockNumber: 5n, blockTime: T0 }),
    });
    expect((await run(repo, chain)).retried).toBe(1);
    expect(calls[1]).toEqual(["retry", h(1), `transaction ${h(9001)} reverted`, retryDelayMs(0), { countAttempt: false, requeue: true }]);
  });

  it("backs off on RPC errors and gives up after maxAttempts", async () => {
    const boom = { levelOf: async () => Promise.reject(new Error("fetch failed\nstack")) };
    const early = fakeRepo([due(1, { attempts: 0 })]);
    expect((await run(early.repo, fakeChain(boom).chain)).retried).toBe(1);
    expect(early.calls[0]).toEqual(["retry", h(1), "fetch failed", 30_000, { countAttempt: true }]);

    const last = fakeRepo([due(1, { attempts: 2 })]);
    expect((await run(last.repo, fakeChain(boom).chain)).failed).toBe(1);
    expect(last.calls[0]).toEqual(["failed", h(1), "gave up after 3 attempts: fetch failed"]);
  });

  it("caps the backoff at 30 minutes", () => {
    expect(retryDelayMs(0)).toBe(30_000);
    expect(retryDelayMs(3)).toBe(240_000);
    expect(retryDelayMs(20)).toBe(30 * 60_000);
  });
});
