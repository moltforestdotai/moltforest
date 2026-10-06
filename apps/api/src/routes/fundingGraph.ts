import { Router } from "express";
import { z } from "zod";
import { DEFAULT_GRAPH_LIMIT, MAX_GRAPH_LIMIT, type FundingGraphRepository } from "../repositories/fundingGraph.js";
import { isMissingRelation } from "../repositories/sync.js";
import { HttpError } from "../lib/errors.js";
import { AgentParams } from "./agents.js";

export const FundingGraphQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(MAX_GRAPH_LIMIT).default(DEFAULT_GRAPH_LIMIT),
  })
  .strict();

export function fundingGraphRouter(graphs: FundingGraphRepository): Router {
  const router = Router();

  // GET /v1/agents/:network/:agentId/funding-graph?limit (decisions D31, D39)
  router.get("/:network/:agentId/funding-graph", async (req, res) => {
    const { network, agentId } = AgentParams.parse(req.params);
    const { limit } = FundingGraphQuery.parse(req.query);
    try {
      const graph = await graphs.get(network, agentId, limit);
      if (!graph) throw new HttpError(404, "agent_not_found", `Agent ${agentId} is not indexed on ${network}.`);
      res.json(graph);
    } catch (err) {
      if (!isMissingRelation(err)) throw err;
      throw new HttpError(503, "index_not_ready", "Database tables are missing. Start the indexer and apply migrations.");
    }
  });

  return router;
}
