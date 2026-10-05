import { Router } from "express";
import { z } from "zod";
import { NETWORKS } from "@moltforest/chain";
import type { TrustResponse } from "@moltforest/types";
import { buildEvidenceProfile, buildTaskContext } from "../evidence/profile.js";
import type { EvidenceRepository } from "../evidence/repository.js";
import type { createAgentRepository } from "../repositories/agents.js";
import { HttpError } from "../lib/errors.js";
import { AgentParams } from "./agents.js";

export const TrustQuery = z
  .object({
    taskType: z.string().trim().min(1).max(100).optional(),
    valueAtRisk: z.coerce.number().min(0).max(1_000_000_000).optional(),
    requiredProof: z.enum(["none", "provider-signed", "client-cosigned", "validator", "zk", "tee"]).optional(),
    maxLatencyMs: z.coerce.number().int().min(1).max(3_600_000).optional(),
    minimumHistory: z.coerce.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

export const TRUST_NOTE =
  "Evidence and comparisons only. MoltForest gives no score and no verdict; the hiring decision is yours, under your own policy.";

type AgentRepo = Pick<ReturnType<typeof createAgentRepository>, "get">;

/** Builds the evidence profile and task context for one agent; null when the agent is unknown. */
export async function trustFor(agents: AgentRepo, evidence: EvidenceRepository, network: keyof typeof NETWORKS, agentId: string, query: z.infer<typeof TrustQuery>, now = new Date()): Promise<TrustResponse | null> {
  const agent = await agents.get(network, agentId);
  if (!agent) return null;
  const addresses = [...new Set([agent.owner, agent.agentWallet].filter((a): a is string => !!a).map((a) => a.toLowerCase()))];
  const stats = await evidence.stats(NETWORKS[network].chainId, agent.agentId, addresses);
  const profile = buildEvidenceProfile(agent, stats, now);
  return { profile, context: { query, facts: buildTaskContext(profile, agent, query) }, note: TRUST_NOTE };
}

export function trustRouter(agents: AgentRepo, evidence: EvidenceRepository): Router {
  const router = Router();

  // GET /v1/agents/:network/:agentId/trust?taskType&valueAtRisk&requiredProof&maxLatencyMs&minimumHistory (constraint C3)
  router.get("/:network/:agentId/trust", async (req, res) => {
    const { network, agentId } = AgentParams.parse(req.params);
    const query = TrustQuery.parse(req.query);
    const body = await trustFor(agents, evidence, network, agentId, query);
    if (!body) throw new HttpError(404, "agent_not_found", `Agent ${agentId} is not indexed on ${network}.`);
    res.json(body);
  });

  return router;
}
