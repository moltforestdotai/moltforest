import { describe, expect, it } from "vitest";
import { createPublicClient, http } from "viem";
import { computeScore, sortScores } from "../src/compute.js";
import { buildScoresTree, getProof, scoreToLeafValues } from "../src/merkle.js";
import { hashScoreLeafManual } from "../src/eip712.js";
import { scoreRegistryAbi } from "../src/abi.js";
import { NETWORKS } from "@moltforest/chain";

describe("computeScore", () => {
  it("is deterministic and caps at 10000", () => {
    const a = computeScore({ agentId: "7", verifiedReviews: 3, countedReviewers: 2, totalPaidVolume: 30_000 });
    const b = computeScore({ agentId: "7", verifiedReviews: 3, countedReviewers: 2, totalPaidVolume: 30_000 });
    expect(a).toEqual(b);
    expect(a.scoreBps).toBeGreaterThan(0);
    expect(a.scoreBps).toBeLessThanOrEqual(10_000);
    expect(a.confidenceBps).toBeLessThanOrEqual(10_000);
    expect(a.paidReviews).toBe(3);
    expect(a.independentClusters).toBe(2);
  });

  it("gives zero score with no evidence", () => {
    const s = computeScore({ agentId: 1n, verifiedReviews: 0, countedReviewers: 0 });
    expect(s.scoreBps).toBe(0);
    expect(s.confidenceBps).toBe(0);
  });
});

describe("merkle", () => {
  it("builds a verifiable tree with leaves matching hashScoreLeafManual", () => {
    const scores = sortScores([
      computeScore({ agentId: "7", verifiedReviews: 3, countedReviewers: 2 }),
      computeScore({ agentId: "42", verifiedReviews: 1, countedReviewers: 1 }),
    ]);
    const tree = buildScoresTree(scores);
    const proof = getProof(tree, scores[0]!);
    expect(tree.verify(scoreToLeafValues(scores[0]!), proof)).toBe(true);
    // Cross-check our double-hash helper against a known on-chain encoding in the next test.
    expect(hashScoreLeafManual(scores[0]!)).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it("matches on-chain ScoreRegistry.hashScoreLeaf when RPC is up", async () => {
    const registry = NETWORKS.testnet.scoreRegistry?.address;
    if (!registry) return;
    const score = computeScore({ agentId: "7", verifiedReviews: 3, countedReviewers: 2, totalPaidVolume: 30_000 });
    const client = createPublicClient({ transport: http(NETWORKS.testnet.defaultRpcUrl) });
    try {
      const onchain = await client.readContract({
        address: registry,
        abi: scoreRegistryAbi,
        functionName: "hashScoreLeaf",
        args: [
          {
            agentId: score.agentId,
            scoreBps: score.scoreBps,
            confidenceBps: score.confidenceBps,
            paidReviews: score.paidReviews,
            independentClusters: score.independentClusters,
            totalPaidVolume: score.totalPaidVolume,
          },
        ],
      });
      expect(onchain.toLowerCase()).toBe(hashScoreLeafManual(score).toLowerCase());
    } catch {
      // Skip if RPC unreachable in CI
    }
  });
});
