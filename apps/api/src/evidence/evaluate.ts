/**
 * Applies the *caller's* hiring policy to an evidence profile (POST /v1/evaluate).
 * MoltForest only reports whether each of the caller's own rules is met
 * (constraint C1: no score, no verdict of its own). A rule MoltForest cannot
 * measure is "not_measurable", and then the policy is not met: the caller
 * decides what that means.
 */
import { z } from "zod";
import type { EvidenceProfile, Metric, ObservationCode, Provenance } from "@moltforest/types";

const OBSERVATION_CODES = [
  "LOW_HISTORY",
  "STALE",
  "REVIEWS_NOT_COUNTED",
  "SELF_PAYMENTS_ONLY",
  "NO_RECEIPTS",
  "ENDPOINT_CHURN",
  "PROFILE_UNREACHABLE",
  "ENDPOINTS_DOWN",
  "ENDPOINTS_NOT_PUBLIC",
  "MARKED_INACTIVE",
] as const satisfies readonly ObservationCode[];

export const PolicySchema = z
  .object({
    minAgeDays: z.number().min(0).optional(),
    minCountedReviews: z.number().int().min(0).optional(),
    minCountedReviewers: z.number().int().min(0).optional(),
    /** Counted reviews attached to a checked payment. */
    minVerifiedReviews: z.number().int().min(0).optional(),
    minReceipts: z.number().int().min(0).optional(),
    /** 1 = provider-signed, 2 = client co-signed. */
    minReceiptLevel: z.union([z.literal(1), z.literal(2)]).optional(),
    minReceiptsWithPayment: z.number().int().min(0).optional(),
    minPaymentsFromOthers: z.number().int().min(0).optional(),
    minDistinctPayers: z.number().int().min(0).optional(),
    /** Share of liveness checks answered over 7 days, 0..1. */
    minUptime7d: z.number().min(0).max(1).optional(),
    maxEndpointLatencyMs: z.number().int().min(1).optional(),
    requireX402Support: z.boolean().optional(),
    requireActive: z.boolean().optional(),
    /** Observations the caller does not accept. */
    excludeObservations: z.array(z.enum(OBSERVATION_CODES)).max(OBSERVATION_CODES.length).optional(),
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;

export interface RequirementResult {
  rule: keyof Policy;
  required: number | boolean | string[];
  observed: number | boolean | string[] | null;
  result: "met" | "not_met" | "not_measurable";
  provenance: Provenance;
}

function atLeast(rule: keyof Policy, required: number | undefined, metric: Metric<number>): RequirementResult[] {
  if (required === undefined) return [];
  return [
    {
      rule,
      required,
      observed: metric.value,
      result: metric.value === null ? "not_measurable" : metric.value >= required ? "met" : "not_met",
      provenance: metric.provenance,
    },
  ];
}

export function evaluatePolicy(profile: EvidenceProfile, policy: Policy): { requirements: RequirementResult[]; policyMet: boolean } {
  const p = profile;
  const requirements: RequirementResult[] = [
    ...atLeast("minAgeDays", policy.minAgeDays, p.identity.ageDays),
    ...atLeast("minCountedReviews", policy.minCountedReviews, p.reputation.countedReviews),
    ...atLeast("minCountedReviewers", policy.minCountedReviewers, p.reputation.countedReviewers),
    ...atLeast("minVerifiedReviews", policy.minVerifiedReviews, p.reputation.verifiedReviews),
    ...atLeast("minReceipts", policy.minReceipts, p.verification.receipts),
    ...atLeast("minReceiptsWithPayment", policy.minReceiptsWithPayment, p.verification.receiptsWithPayment),
    ...atLeast("minPaymentsFromOthers", policy.minPaymentsFromOthers, p.economic.paymentsReceivedFromOthers),
    ...atLeast("minDistinctPayers", policy.minDistinctPayers, p.economic.distinctPayers),
    ...atLeast("minUptime7d", policy.minUptime7d, p.reliability.uptime7d),
  ];

  if (policy.minReceiptLevel !== undefined) {
    const level = p.verification.highestReceiptLevel;
    requirements.push({
      rule: "minReceiptLevel",
      required: policy.minReceiptLevel,
      observed: level.value,
      // No receipts at all is a measured fact: the level is not reached.
      result: (level.value ?? 0) >= policy.minReceiptLevel ? "met" : "not_met",
      provenance: level.provenance,
    });
  }
  if (policy.maxEndpointLatencyMs !== undefined) {
    const latency = p.reliability.endpointLatencyMs7d;
    requirements.push({
      rule: "maxEndpointLatencyMs",
      required: policy.maxEndpointLatencyMs,
      observed: latency.value,
      result: latency.value === null ? "not_measurable" : latency.value <= policy.maxEndpointLatencyMs ? "met" : "not_met",
      provenance: latency.provenance,
    });
  }
  if (policy.requireX402Support) {
    const x402 = p.identity.x402Support;
    requirements.push({ rule: "requireX402Support", required: true, observed: x402.value, result: x402.value === true ? "met" : "not_met", provenance: x402.provenance });
  }
  if (policy.requireActive) {
    const inactive = p.observations.some((o) => o.code === "MARKED_INACTIVE");
    requirements.push({ rule: "requireActive", required: true, observed: !inactive, result: inactive ? "not_met" : "met", provenance: { api: `/v1/agents/${p.network}/${p.agentId}` } });
  }
  if (policy.excludeObservations && policy.excludeObservations.length > 0) {
    const present = p.observations.filter((o) => policy.excludeObservations!.includes(o.code)).map((o) => o.code);
    requirements.push({
      rule: "excludeObservations",
      required: policy.excludeObservations,
      observed: present,
      result: present.length === 0 ? "met" : "not_met",
      provenance: { api: `/v1/agents/${p.network}/${p.agentId}/trust`, note: "See profile.observations for each observation's evidence." },
    });
  }
  return { requirements, policyMet: requirements.every((r) => r.result === "met") };
}
