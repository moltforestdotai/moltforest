import { describe, expect, it } from "vitest";
import type { AgentsExist } from "@moltforest/chain";
import { createChainChecker } from "../src/services/chainCheck.js";

const below =
  (limit: () => bigint): AgentsExist =>
  async (ids) =>
    ids.map((id) => id < limit());

describe("chain checker", () => {
  it("caches results per network and shares in-flight probes", async () => {
    let requests = 0;
    const checker = createChainChecker({
      ttlMs: 60_000,
      existsFactory: () => async (ids) => {
        requests++;
        return ids.map((id) => id < 10n);
      },
    });
    const [a, b] = await Promise.all([checker.highestAgentId("mainnet", "5"), checker.highestAgentId("mainnet", "5")]);
    expect(a.highestAgentId).toBe("9");
    expect(b).toBe(a);
    const afterFirst = requests;
    await checker.highestAgentId("mainnet", "5");
    expect(requests).toBe(afterFirst);
  });

  it("reports RPC failures without throwing", async () => {
    const checker = createChainChecker({
      ttlMs: 60_000,
      existsFactory: () => async () => {
        throw new Error("fetch failed\nstack...");
      },
    });
    const result = await checker.highestAgentId("testnet", null);
    expect(result).toEqual({ highestAgentId: null, checkedAt: null, error: "fetch failed" });
  });

  it("serves a stale result immediately and refreshes in the background", async () => {
    let highest = 10n;
    const checker = createChainChecker({ ttlMs: 0, existsFactory: () => below(() => highest) });
    expect((await checker.highestAgentId("mainnet", null)).highestAgentId).toBe("9");
    highest = 20n;
    expect((await checker.highestAgentId("mainnet", "9")).highestAgentId).toBe("9"); // stale, refresh kicked off
    await new Promise((r) => setTimeout(r, 20));
    expect((await checker.highestAgentId("mainnet", "9")).highestAgentId).toBe("19");
  });

  it("times out slow RPCs", async () => {
    const checker = createChainChecker({
      ttlMs: 60_000,
      timeoutMs: 50,
      existsFactory: () => () => new Promise<boolean[]>(() => {}),
    });
    const result = await checker.highestAgentId("mainnet", "1");
    expect(result.error).toMatch(/timed out/);
  });
});
