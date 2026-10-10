import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { keccak256, stringToHex, type Hex } from "viem";
import { ALGO_HASH_PREIMAGE, sortScores } from "./compute.js";
import type { AgentScore } from "./types.js";

/** Leaf value types matching ScoreRegistry.hashScoreLeaf abi.encode order. */
export const SCORE_LEAF_TYPES = ["uint256", "uint16", "uint16", "uint32", "uint32", "uint256"] as const;

export type ScoreLeafValues = [bigint, number, number, number, number, bigint];
export type ScoresTree = StandardMerkleTree<ScoreLeafValues>;

export function scoreToLeafValues(s: AgentScore): ScoreLeafValues {
  return [s.agentId, s.scoreBps, s.confidenceBps, s.paidReviews, s.independentClusters, s.totalPaidVolume];
}

export function buildScoresTree(scores: readonly AgentScore[]): ScoresTree {
  const rows = sortScores(scores).map(scoreToLeafValues);
  // Empty tree is invalid for publish; callers should pass at least one leaf.
  if (rows.length === 0) {
    throw new Error("scores tree requires at least one agent");
  }
  return StandardMerkleTree.of(rows, [...SCORE_LEAF_TYPES]) as ScoresTree;
}

/** Inputs root: hash of sorted assessment facts (placeholder until full input leaves exist). */
export function buildInputsRoot(scores: readonly AgentScore[]): Hex {
  const sorted = sortScores(scores);
  const preimage = sorted
    .map(
      (s) =>
        `${s.agentId}:${s.paidReviews}:${s.independentClusters}:${s.totalPaidVolume}:${s.scoreBps}:${s.confidenceBps}`,
    )
    .join("|");
  return keccak256(stringToHex(preimage));
}

export function algoHash(): Hex {
  return keccak256(stringToHex(ALGO_HASH_PREIMAGE));
}

export function getProof(tree: ScoresTree, score: AgentScore): Hex[] {
  const values = scoreToLeafValues(score);
  for (const [i, v] of tree.entries()) {
    if (
      BigInt(v[0]) === values[0] &&
      Number(v[1]) === values[1] &&
      Number(v[2]) === values[2] &&
      Number(v[3]) === values[3] &&
      Number(v[4]) === values[4] &&
      BigInt(v[5]) === values[5]
    ) {
      return tree.getProof(i) as Hex[];
    }
  }
  throw new Error(`score for agent ${score.agentId} not in tree`);
}
