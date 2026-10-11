import { Router } from "express";
import { z } from "zod";
import type { AgentScoreProofResponse } from "@moltforest/types";
import type { ScoreRepository } from "../repositories/scores.js";
import { isMissingRelation } from "../repositories/sync.js";
import { HttpError } from "../lib/errors.js";
import { AgentParams } from "./agents.js";

export const ScoreQuery = z.object({
  epochId: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
});

const scoresNotReady = () =>
  new HttpError(
    503,
    "scores_not_ready",
    "Score epoch tables are missing. Apply migrations (`pnpm db:migrate`).",
  );

export function scoresRouter(repo: ScoreRepository): Router {
  const router = Router();

  // GET /v1/agents/:network/:agentId/score?epochId=
  router.get("/:network/:agentId/score", async (req, res) => {
    const { network, agentId } = AgentParams.parse(req.params);
    const { epochId } = ScoreQuery.parse(req.query);
    try {
      const body = await repo.getAgentScoreProof(network, agentId, epochId);
      if (!body) {
        throw new HttpError(
          404,
          "score_not_found",
          epochId
            ? `Agent ${agentId} has no published score in epoch ${epochId} on ${network}.`
            : `Agent ${agentId} has no published score on ${network}.`,
        );
      }
      const response: AgentScoreProofResponse = body;
      res.json(response);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw isMissingRelation(err) ? scoresNotReady() : err;
    }
  });

  return router;
}
