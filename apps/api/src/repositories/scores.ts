import { buildEpoch, proofFor } from "@moltforest/scores";
import type { AgentScore } from "@moltforest/scores";
import type { AgentScoreProofResponse, NetworkName } from "@moltforest/types";
import { NETWORKS } from "@moltforest/chain";
import type { Hex } from "viem";
import { table, type Db } from "../db.js";

interface EpochRow {
  epoch_id: string;
  inputs_root: string;
  scores_root: string;
  algo_hash: string;
  score_registry: string;
  publish_tx: string | null;
  published_at: Date;
}

interface AgentRow {
  agent_id: string;
  score_bps: number;
  confidence_bps: number;
  paid_reviews: number;
  independent_clusters: number;
  total_paid_volume: string;
}

const SCORE_NOTE =
  "Published Floor-3 epoch leaf for on-chain market gates (ERC-8183). Not a hiring verdict — evidence and policy remain yours (C1).";

function toAgentScore(row: AgentRow): AgentScore {
  return {
    agentId: BigInt(row.agent_id),
    scoreBps: row.score_bps,
    confidenceBps: row.confidence_bps,
    paidReviews: row.paid_reviews,
    independentClusters: row.independent_clusters,
    totalPaidVolume: BigInt(row.total_paid_volume),
  };
}

export function createScoreRepository(db: Db, appSchema: string) {
  const epochs = table(appSchema, "score_epoch");
  const agents = table(appSchema, "score_epoch_agent");

  return {
    /**
     * Latest published epoch for the chain, or a specific epochId when provided.
     * Rebuilds the Merkle tree from stored leaves and returns the agent's proof.
     */
    async getAgentScoreProof(
      network: NetworkName,
      agentId: string,
      epochId?: number,
    ): Promise<AgentScoreProofResponse | null> {
      const chainId = NETWORKS[network].chainId;

      const epochResult = epochId
        ? await db.query<EpochRow>(
            `SELECT epoch_id, inputs_root, scores_root, algo_hash, score_registry, publish_tx, published_at
             FROM ${epochs} WHERE chain_id = $1 AND epoch_id = $2`,
            [chainId, epochId],
          )
        : await db.query<EpochRow>(
            `SELECT epoch_id, inputs_root, scores_root, algo_hash, score_registry, publish_tx, published_at
             FROM ${epochs} WHERE chain_id = $1
             ORDER BY epoch_id DESC LIMIT 1`,
            [chainId],
          );

      const epochRow = epochResult.rows[0];
      if (!epochRow) return null;

      const eid = Number(epochRow.epoch_id);
      const leafResult = await db.query<AgentRow>(
        `SELECT agent_id, score_bps, confidence_bps, paid_reviews, independent_clusters, total_paid_volume
         FROM ${agents} WHERE chain_id = $1 AND epoch_id = $2`,
        [chainId, eid],
      );
      if (leafResult.rows.length === 0) return null;

      const scores = leafResult.rows.map(toAgentScore);
      const target = scores.find((s) => s.agentId.toString() === agentId);
      if (!target) return null;

      const epoch = buildEpoch(BigInt(eid), scores);
      if (epoch.scoresRoot.toLowerCase() !== epochRow.scores_root.toLowerCase()) {
        throw new Error(
          `stored scores_root mismatch for chain ${chainId} epoch ${eid}: db=${epochRow.scores_root} rebuilt=${epoch.scoresRoot}`,
        );
      }

      const proof = proofFor(epoch, target) as Hex[];

      return {
        network,
        chainId,
        agentId,
        epochId: eid.toString(),
        scoreRegistry: epochRow.score_registry,
        inputsRoot: epochRow.inputs_root,
        scoresRoot: epochRow.scores_root,
        algoHash: epochRow.algo_hash,
        publishTx: epochRow.publish_tx,
        publishedAt: epochRow.published_at.toISOString(),
        score: {
          scoreBps: target.scoreBps,
          confidenceBps: target.confidenceBps,
          paidReviews: target.paidReviews,
          independentClusters: target.independentClusters,
          totalPaidVolume: target.totalPaidVolume.toString(),
        },
        proof,
        note: SCORE_NOTE,
      };
    },
  };
}

export type ScoreRepository = ReturnType<typeof createScoreRepository>;
