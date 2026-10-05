import express, { Router } from "express";
import { z } from "zod";
import { NETWORK_NAMES } from "@moltforest/chain";
import type { EvidenceProfile, TaskContextQuery } from "@moltforest/types";
import { evaluatePolicy, PolicySchema, type RequirementResult } from "../evidence/evaluate.js";
import type { EvidenceRepository } from "../evidence/repository.js";
import type { createAgentRepository } from "../repositories/agents.js";
import { TrustQuery, trustFor } from "./trust.js";

export const EvaluateBody = z
  .object({
    network: z.enum(NETWORK_NAMES),
    /** 1–10 agents, evaluated side by side. */
    agentIds: z.array(z.string().regex(/^\d{1,78}$/, "a decimal agent id")).min(1).max(10),
    policy: PolicySchema,
    /** Optional task context: adds the same facts as GET /trust. */
    context: TrustQuery.optional(),
    /** Include each agent's full evidence profile (default true). */
    includeProfile: z.boolean().default(true),
  })
  .strict();

export type EvaluateInput = z.infer<typeof EvaluateBody>;

export interface EvaluateResult {
  network: EvaluateInput["network"];
  results: {
    agentId: string;
    found: boolean;
    name: string | null;
    /** Whether *your* policy is met: every rule met. Not MoltForest's judgement. */
    policyMet: boolean | null;
    requirements: RequirementResult[];
    facts: unknown[];
    profile?: EvidenceProfile;
  }[];
  note: string;
}

export const EVALUATE_NOTE =
  "policyMet applies your own policy to the evidence; it is not a MoltForest verdict. A rule MoltForest cannot measure is not_measurable and leaves policyMet false.";

type AgentRepo = Pick<ReturnType<typeof createAgentRepository>, "get">;

export async function evaluateAgents(agents: AgentRepo, evidence: EvidenceRepository, input: EvaluateInput): Promise<EvaluateResult> {
  const context: TaskContextQuery = input.context ?? {};
  const results = await Promise.all(
    [...new Set(input.agentIds.map((id) => id.replace(/^0+(?=\d)/, "")))].map(async (agentId) => {
      const trust = await trustFor(agents, evidence, input.network, agentId, context);
      if (!trust) return { agentId, found: false, name: null, policyMet: null, requirements: [], facts: [] };
      const { requirements, policyMet } = evaluatePolicy(trust.profile, input.policy);
      return {
        agentId,
        found: true,
        name: trust.profile.name,
        policyMet,
        requirements,
        facts: trust.context.facts,
        ...(input.includeProfile ? { profile: trust.profile } : {}),
      };
    }),
  );
  return { network: input.network, results, note: EVALUATE_NOTE };
}

export function evaluateRouter(agents: AgentRepo, evidence: EvidenceRepository): Router {
  const router = Router();
  router.post("/evaluate", express.json({ limit: "16kb" }), async (req, res) => {
    res.json(await evaluateAgents(agents, evidence, EvaluateBody.parse(req.body)));
  });
  return router;
}
