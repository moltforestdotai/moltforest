import { describe, expect, it } from "vitest";
import { NansenError, type NansenClient, type NansenRelatedWallet } from "../src/nansen/client.js";
import type { NansenRepository } from "../src/nansen/repository.js";
import { runNansenTick, type NansenOptions } from "../src/nansen/runner.js";

const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const opts: NansenOptions = { chainId: 143, nansenChain: "monad", dailyLookups: 10, batchSize: 5, delayMs: 0, maxAttempts: 4 };

function fakeRepo(due: string[], usedToday = 0) {
  const saved: { address: string; related: NansenRelatedWallet[] }[] = [];
  const errors: { address: string; error: string; transient: boolean }[] = [];
  const asked: number[] = [];
  const focus: string[][] = [];
  const repo = {
    lookupsToday: async () => usedToday,
    dueWallets: async (_chainId: number, limit: number, _maxAttempts: number, focusAgents: string[]) => {
      asked.push(limit);
      focus.push(focusAgents);
      return due.slice(0, limit);
    },
    saveOk: async (_chainId: number, address: string, related: NansenRelatedWallet[]) => {
      saved.push({ address, related });
    },
    saveError: async (_chainId: number, address: string, error: string, transient: boolean) => {
      errors.push({ address, error, transient });
    },
  } as unknown as NansenRepository;
  return { repo, saved, errors, asked, focus };
}

function fakeClient(answer: (address: string) => NansenRelatedWallet[] | NansenError) {
  const calls: string[] = [];
  const client = {
    relatedWallets: async (address: string, chain: string) => {
      calls.push(`${chain}:${address}`);
      const a = answer(address);
      if (a instanceof NansenError) throw a;
      return { relations: a, creditsCost: 1 };
    },
  } as unknown as NansenClient;
  return { client, calls };
}

const funder = (address: string): NansenRelatedWallet => ({ address, relation: "First Funder", label: null, txHash: null, blockTime: null });

describe("runNansenTick", () => {
  it("looks up due wallets on Nansen's chain and stores each answer", async () => {
    const { repo, saved } = fakeRepo([wallet(1), wallet(2)]);
    const { client, calls } = fakeClient((a) => (a === wallet(1) ? [funder(wallet(9))] : []));
    const stats = await runNansenTick({ repo, client }, opts);
    expect(calls).toEqual([`monad:${wallet(1)}`, `monad:${wallet(2)}`]);
    expect(saved).toEqual([
      { address: wallet(1), related: [funder(wallet(9))] },
      { address: wallet(2), related: [] },
    ]);
    expect(stats).toMatchObject({ selected: 2, lookedUp: 2, relations: 1, credits: 2, errors: 0, stoppedBy: null });
  });

  it("asks for no more than the batch and what is left of the daily budget", async () => {
    const many = Array.from({ length: 20 }, (_, i) => wallet(i + 1));
    const a = fakeRepo(many, 0);
    await runNansenTick({ repo: a.repo, client: fakeClient(() => []).client }, opts);
    expect(a.asked).toEqual([5]);

    const b = fakeRepo(many, 8);
    await runNansenTick({ repo: b.repo, client: fakeClient(() => []).client }, opts);
    expect(b.asked).toEqual([2]);
  });

  it("does nothing once the day's budget is spent", async () => {
    const { repo, asked } = fakeRepo([wallet(1)], 10);
    const { client, calls } = fakeClient(() => []);
    const stats = await runNansenTick({ repo, client }, opts);
    expect(stats.stoppedBy).toBe("budget");
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each(["auth", "credits", "rate_limit"] as const)("stops on %s without marking the wallet", async (kind) => {
    const { repo, saved, errors } = fakeRepo([wallet(1), wallet(2), wallet(3)]);
    const { client, calls } = fakeClient((a) => (a === wallet(2) ? new NansenError("refused", kind, 401) : []));
    const stats = await runNansenTick({ repo, client }, opts);
    expect(stats.stoppedBy).toBe(kind);
    expect(calls).toHaveLength(2);
    expect(saved.map((s) => s.address)).toEqual([wallet(1)]);
    expect(errors).toEqual([]);
  });

  it("records other failures, retrying only transient ones, and carries on", async () => {
    const { repo, saved, errors } = fakeRepo([wallet(1), wallet(2), wallet(3)]);
    const { client } = fakeClient((a) =>
      a === wallet(1) ? new NansenError("HTTP 503", "server", 503) : a === wallet(2) ? new NansenError("HTTP 400", "bad_request", 400) : [],
    );
    const stats = await runNansenTick({ repo, client }, opts);
    expect(errors).toEqual([
      { address: wallet(1), error: "HTTP 503", transient: true },
      { address: wallet(2), error: "HTTP 400", transient: false },
    ]);
    expect(saved.map((s) => s.address)).toEqual([wallet(3)]);
    expect(stats).toMatchObject({ lookedUp: 1, errors: 2, stoppedBy: null });
  });

  it("passes the focus agents to the queue", async () => {
    const a = fakeRepo([wallet(1)]);
    await runNansenTick({ repo: a.repo, client: fakeClient(() => []).client }, { ...opts, focusAgents: ["182", "9"] });
    expect(a.focus).toEqual([["182", "9"]]);

    const b = fakeRepo([wallet(1)]);
    await runNansenTick({ repo: b.repo, client: fakeClient(() => []).client }, opts);
    expect(b.focus).toEqual([[]]);
  });

  it("waits between calls", async () => {
    const { repo } = fakeRepo([wallet(1), wallet(2), wallet(3)]);
    const waits: number[] = [];
    await runNansenTick({ repo, client: fakeClient(() => []).client, sleep: async (ms) => void waits.push(ms) }, { ...opts, delayMs: 250 });
    expect(waits).toEqual([250, 250]);
  });
});
