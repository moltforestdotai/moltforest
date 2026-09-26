import { describe, expect, it } from "vitest";
import { agentGlobalId, findHighestAgentId, isNetworkName, networkByChainId, type AgentsExist } from "../src/index.js";

/** A fake chain with `count` agents (ids 0..count-1) that records each batched request. */
const chainWith = (count: number) => {
  let requests = 0;
  const exist: AgentsExist = async (ids) => {
    requests++;
    return ids.map((id) => id >= 0n && id < BigInt(count));
  };
  return { exist, requests: () => requests };
};

describe("findHighestAgentId", () => {
  it.each([1, 2, 3, 17, 1_930, 10_259])("finds the last id when %i agents exist", async (count) => {
    expect(await findHighestAgentId(chainWith(count).exist, null)).toBe(BigInt(count - 1));
  });

  it("returns null when no agent exists", async () => {
    expect(await findHighestAgentId(chainWith(0).exist, null)).toBeNull();
  });

  it("needs few batched requests for mainnet-sized registries", async () => {
    const chain = chainWith(10_260);
    expect(await findHighestAgentId(chain.exist, null)).toBe(10_259n);
    expect(chain.requests()).toBeLessThanOrEqual(8);
  });

  it("starts from a known id", async () => {
    const chain = chainWith(10_300);
    expect(await findHighestAgentId(chain.exist, 10_250n)).toBe(10_299n);
    expect(chain.requests()).toBeLessThanOrEqual(5);
  });

  it("recovers when the known id is ahead of the chain", async () => {
    expect(await findHighestAgentId(chainWith(5).exist, 50n)).toBe(4n);
  });

  it.each([1, 2, 7, 8, 9])("works with fanout %i", async (fanout) => {
    expect(await findHighestAgentId(chainWith(1_000).exist, null, { fanout })).toBe(999n);
  });
});

describe("network helpers", () => {
  it("validates names and resolves chain ids", () => {
    expect(isNetworkName("mainnet")).toBe(true);
    expect(isNetworkName("ethereum")).toBe(false);
    expect(networkByChainId(10143)?.name).toBe("testnet");
    expect(networkByChainId(1)).toBeUndefined();
  });

  it("builds ERC-8004 style global ids", () => {
    expect(agentGlobalId("mainnet", 17n)).toBe("eip155:143:0x8004a169fb4a3325136eb29fa0ceb6d2e539a432:17");
  });
});
