import { buildEpoch, proofFor } from "@moltforest/scores";
import type { AgentScore } from "@moltforest/scores";
import type { AgentScoreProofResponse, NetworkName } from "@moltforest/types";
import { NETWORKS } from "@moltforest/chain";
import type { Hex } from "viem";
import { table, type Db } from "../db.js";
import { HttpError } from "../lib/errors.js";

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

/** How many newest epochs to scan when resolving "latest" (skip corrupt packages). */
const LATEST_SCAN_LIMIT = 64;

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

type EpochAttempt =
  | { kind: "ok"; body: AgentScoreProofResponse }
  | { kind: "no_leaves" }
  | { kind: "no_agent" }
  | { kind: "mismatch"; epochId: number; stored: string; rebuilt: string };

export function createScoreRepository(db: Db, appSchema: string) {
  const epochs = table(appSchema, "score_epoch");
  const agents = table(appSchema, "score_epoch_agent");

  async function loadLeaves(chainId: number, eid: number): Promise<AgentRow[]> {
    const leafResult = await db.query<AgentRow>(
      `SELECT agent_id, score_bps, confidence_bps, paid_reviews, independent_clusters, total_paid_volume
       FROM ${agents} WHERE chain_id = $1 AND epoch_id = $2`,
      [chainId, eid],
    );
    return leafResult.rows;
  }

  function attemptEpoch(
    network: NetworkName,
    chainId: number,
    agentId: string,
    epochRow: EpochRow,
    leafRows: AgentRow[],
  ): EpochAttempt {
    const eid = Number(epochRow.epoch_id);
    if (leafRows.length === 0) return { kind: "no_leaves" };

    const scores = leafRows.map(toAgentScore);
    const epoch = buildEpoch(BigInt(eid), scores);
    if (epoch.scoresRoot.toLowerCase() !== epochRow.scores_root.toLowerCase()) {
      return {
        kind: "mismatch",
        epochId: eid,
        stored: epochRow.scores_root,
        rebuilt: epoch.scoresRoot,
      };
    }

    const target = scores.find((s) => s.agentId.toString() === agentId);
    if (!target) return { kind: "no_agent" };

    const proof = proofFor(epoch, target) as Hex[];
    return {
      kind: "ok",
      body: {
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
      },
    };
  }

  return {
    /**
     * Score + Merkle proof for an agent.
     * - With `epochId`: that package only (409 if leaves don't match stored root).
     * - Without: newest epoch whose stored `scores_root` matches rebuilt leaves
     *   (skips corrupt in-between ids). Agent missing in that epoch → null (404).
     */
    async getAgentScoreProof(
      network: NetworkName,
      agentId: string,
      epochId?: number,
    ): Promise<AgentScoreProofResponse | null> {
      const chainId = NETWORKS[network].chainId;

      if (epochId !== undefined) {
        const epochResult = await db.query<EpochRow>(
          `SELECT epoch_id, inputs_root, scores_root, algo_hash, score_registry, publish_tx, published_at
           FROM ${epochs} WHERE chain_id = $1 AND epoch_id = $2`,
          [chainId, epochId],
        );
        const epochRow = epochResult.rows[0];
        if (!epochRow) return null;

        const attempt = attemptEpoch(network, chainId, agentId, epochRow, await loadLeaves(chainId, epochId));
        if (attempt.kind === "ok") return attempt.body;
        if (attempt.kind === "mismatch") {
          throw new HttpError(
            409,
            "scores_inconsistent",
            `Epoch ${attempt.epochId} on ${network} has inconsistent score leaves (stored root does not match). Try latest without epochId, or another epochId.`,
          );
        }
        return null;
      }

      const epochResult = await db.query<EpochRow>(
        `SELECT epoch_id, inputs_root, scores_root, algo_hash, score_registry, publish_tx, published_at
         FROM ${epochs} WHERE chain_id = $1
         ORDER BY epoch_id DESC
         LIMIT $2`,
        [chainId, LATEST_SCAN_LIMIT],
      );

      for (const epochRow of epochResult.rows) {
        const eid = Number(epochRow.epoch_id);
        const attempt = attemptEpoch(network, chainId, agentId, epochRow, await loadLeaves(chainId, eid));
        if (attempt.kind === "mismatch" || attempt.kind === "no_leaves") continue;
        // First consistent package (newest). Agent absent → 404 for "current" epoch.
        if (attempt.kind === "no_agent") return null;
        return attempt.body;
      }

      return null;
    },
  };
}

export type ScoreRepository = ReturnType<typeof createScoreRepository>;
