import { Router } from "express";
import { z } from "zod";
import { NETWORK_NAMES, NETWORKS, DEFAULT_NETWORK } from "@moltforest/chain";
import type { AgentListResponse } from "@moltforest/types";
import type { AgentRepository } from "../repositories/agents.js";
import { isMissingRelation } from "../repositories/sync.js";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";
import { HttpError } from "../lib/errors.js";

const boolParam = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

export const ListAgentsQuery = z.object({
  network: z.enum(NETWORK_NAMES).default(DEFAULT_NETWORK),
  sort: z.enum(["newest", "oldest", "most_reviewed"]).default("newest"),
  includeIncomplete: boolParam.default(false),
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => (v ? v : undefined)),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  cursor: z.string().max(512).optional(),
});

export const AgentParams = z.object({
  network: z.enum(NETWORK_NAMES),
  agentId: z
    .string()
    .regex(/^\d{1,78}$/, "agentId must be a non-negative integer")
    .transform((v) => BigInt(v).toString()),
});

const indexNotReady = () =>
  new HttpError(503, "index_not_ready", "The indexer has not created its tables yet. Start it with `pnpm indexer:up`.");

export function agentsRouter(repo: AgentRepository): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const q = ListAgentsQuery.parse(req.query);
    const cursor = q.cursor ? decodeCursor(q.cursor, q.sort) : undefined;
    try {
      const result = await repo.list({ ...q, cursor });
      const body: AgentListResponse = {
        network: q.network,
        chainId: NETWORKS[q.network].chainId,
        sort: q.sort,
        includeIncomplete: q.includeIncomplete,
        items: result.items,
        nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
        total: result.total,
        totalIndexed: result.totalIndexed,
      };
      res.json(body);
    } catch (err) {
      throw isMissingRelation(err) ? indexNotReady() : err;
    }
  });

  router.get("/:network/:agentId", async (req, res) => {
    const { network, agentId } = AgentParams.parse(req.params);
    try {
      const agent = await repo.get(network, agentId);
      if (!agent) throw new HttpError(404, "agent_not_found", `Agent ${agentId} is not indexed on ${network}`);
      res.json(agent);
    } catch (err) {
      throw isMissingRelation(err) ? indexNotReady() : err;
    }
  });

  return router;
}
