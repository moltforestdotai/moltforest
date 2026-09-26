import { createPublicClient, http, type PublicClient } from "viem";
import { NETWORKS, type NetworkName } from "./networks.js";

/** Multicall3, deployed at the same address on both Monad networks (verified 2026-09-25). */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const ownerOfAbi = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/**
 * For each agent id, whether the ERC-721 token (agent) exists. One call checks
 * a whole batch so each search round is a single RPC request.
 */
export type AgentsExist = (agentIds: bigint[]) => Promise<boolean[]>;

export function createAgentsExist(network: NetworkName, rpcUrl?: string): AgentsExist {
  const client: PublicClient = createPublicClient({
    transport: http(rpcUrl ?? NETWORKS[network].defaultRpcUrl, { timeout: 10_000, retryCount: 3, retryDelay: 300 }),
  });
  const registry = NETWORKS[network].identityRegistry;
  return async (agentIds) => {
    // ownerOf reverts for unknown ids; allowFailure turns that revert into a per-call failure,
    // while network/RPC errors still reject the whole request.
    const results = await client.multicall({
      multicallAddress: MULTICALL3_ADDRESS,
      allowFailure: true,
      contracts: agentIds.map((id) => ({ address: registry, abi: ownerOfAbi, functionName: "ownerOf" as const, args: [id] as const })),
    });
    return results.map((r) => r.status === "success");
  };
}

/**
 * Finds the highest existing agent id on-chain, starting from a known-good id
 * (e.g. the highest id the indexer has). Agent ids are sequential ERC-721 token
 * ids, so a galloping probe followed by a k-ary search needs O(log n) checks,
 * batched `fanout` per round (~7 rounds for 10k agents).
 * Burned tokens can create gaps, so the result is a lower bound.
 */
export async function findHighestAgentId(
  exist: AgentsExist,
  knownId: bigint | null,
  { fanout = 8 }: { fanout?: number } = {},
): Promise<bigint | null> {
  const one = async (id: bigint) => (await exist([id]))[0] === true;

  let lo = knownId ?? -1n;
  if (lo >= 0n && !(await one(lo))) lo = -1n;
  if (lo < 0n) {
    if (!(await one(0n))) return null;
    lo = 0n;
  }

  // Gallop: check base+2^e … base+2^(e+fanout-1) together until one is missing.
  const base = lo;
  let hi = -1n; // first missing id; -1 until found
  for (let e = 0n; hi < 0n; e += BigInt(fanout)) {
    const candidates = Array.from({ length: fanout }, (_, i) => base + (1n << (e + BigInt(i))));
    const miss = (await exist(candidates)).indexOf(false);
    if (miss === -1) {
      lo = candidates[fanout - 1]!;
    } else {
      if (miss > 0) lo = candidates[miss - 1]!;
      hi = candidates[miss]!;
    }
  }

  // k-ary search. Invariant: exists(lo) && !exists(hi).
  while (hi - lo > 1n) {
    const span = hi - lo;
    const points = [...new Set(Array.from({ length: fanout }, (_, i) => lo + (span * BigInt(i + 1)) / BigInt(fanout + 1)))]
      .filter((p) => p > lo && p < hi)
      .sort((a, b) => (a < b ? -1 : 1));
    const miss = (await exist(points)).indexOf(false);
    if (miss === -1) {
      lo = points.at(-1)!;
    } else {
      if (miss > 0) lo = points[miss - 1]!;
      hi = points[miss]!;
    }
  }
  return lo;
}
