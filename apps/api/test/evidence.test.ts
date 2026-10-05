import { describe, expect, it } from "vitest";
import type { AgentDetail } from "@moltforest/types";
import { buildEvidenceProfile, buildTaskContext } from "../src/evidence/profile.js";
import { EMPTY_STATS, type EvidenceStats } from "../src/evidence/repository.js";

const NOW = new Date("2026-10-05T00:00:00Z");

function agent(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    network: "testnet",
    chainId: 10143,
    agentId: "1987",
    globalId: "eip155:10143:0x8004a818bfb912233c491871b3d84c89a494bd9e:1987",
    name: "MoltForest Email Verifier",
    description: "Checks an email address for 0.01 test USDC, paid with x402.",
    image: null,
    owner: "0x59a8581eb008d2284f182ee965db62339926e157",
    agentWallet: "0x59a8581eb008d2284f182ee965db62339926e157",
    uriKind: "data",
    metadataStatus: "ok",
    services: [{ name: "web", endpoint: "https://api.moltforest.ai/demo/email-verifier" }],
    serviceCount: 1,
    x402Support: true,
    active: true,
    supportedTrust: ["reputation"],
    registeredAt: "2026-10-03T11:46:44.000Z",
    registeredBlock: "67821029",
    updatedAt: "2026-10-03T11:46:46.000Z",
    reputation: { feedbackCount: 0, revokedFeedbackCount: 0, uniqueReviewerCount: 0, lastFeedbackAt: null, counted: null },
    liveness: { endpoints: 1, checked: 1, up: 1, notPublic: 0, paymentRequired: 0, uptime7d: 1, checks7d: 120 },
    receipts: { total: 1, coSigned: 1, anchored: 1, lastCompletedAt: "2026-10-03T11:48:35.000Z" },
    payments: { receivedFromOthers: 1, sent: 0, selfPayments: 0, receivedAmount: "0.01", sentAmount: "0", lastPaymentAt: "2026-10-03T11:48:36.000Z" },
    agentUri: "data:application/json;base64,...",
    agentUriTruncated: false,
    metadataError: null,
    registeredTx: "0x7d1796414d7c1a81c4cdbc48065404a54a768f415d50bcaed4e53aec7399f37f",
    uriChangeCount: 1,
    profileSource: "onchain",
    profileFetch: null,
    uriHistory: [],
    recentFeedback: [],
    endpoints: [
      {
        url: "https://api.moltforest.ai/demo/email-verifier",
        status: "up",
        httpStatus: 200,
        latencyMs: 40,
        paymentRequired: false,
        error: null,
        lastCheckedAt: "2026-10-05T00:00:00Z",
        lastUpAt: "2026-10-05T00:00:00Z",
        uptime7d: 1,
        checks7d: 120,
        avgLatencyMs7d: 42,
      },
    ],
    ...over,
  };
}

const STATS: EvidenceStats = {
  receipts: { withPayment: 1, highestLevel: 2 },
  received: { distinctPayers: 1, largestAmount: "10000", firstBlock: "67821500", lastBlock: "67821500" },
};

describe("buildEvidenceProfile", () => {
  it("fills every category with values and their provenance", () => {
    const p = buildEvidenceProfile(agent(), STATS, NOW);
    expect(p.identity.ageDays).toMatchObject({ value: 1, status: "measured" });
    expect(p.identity.registeredAt.provenance.contract?.events).toContain("Registered");
    expect(p.reliability.uptime7d).toMatchObject({ value: 1, status: "measured", provenance: { window: "last 7 days" } });
    expect(p.reliability.endpointLatencyMs7d.value).toBe(42);
    expect(p.economic.largestPaymentUsdc).toMatchObject({ value: "0.01", provenance: { api: "/v1/agents/testnet/1987/payments?direction=received", blockRange: { from: "67821500", to: "67821500" } } });
    expect(p.verification).toMatchObject({ receipts: { value: 1 }, receiptsWithPayment: { value: 1 }, highestReceiptLevel: { value: 2 } });
    expect(p.verification.receipts.provenance.contract?.address).toBe("0x4d2a256fCaAc8e52e4B91e977EF6dDD56E980f98");
  });

  it("says what it cannot measure instead of estimating it", () => {
    const p = buildEvidenceProfile(agent(), STATS, NOW);
    expect(p.reliability.jobSuccessRate).toMatchObject({ value: null, status: "not_measured" });
    expect(p.reliability.jobSuccessRate.provenance.note).toMatch(/not measurable yet/i);
    expect(p.reputation.countedReviews).toMatchObject({ value: null, status: "not_measured" });
    expect(p.coverage.find((c) => c.category === "reliability")).toEqual({ category: "reliability", measured: 4, total: 6 });
  });

  it("lists neutral observations with evidence", () => {
    const p = buildEvidenceProfile(
      agent({
        receipts: { total: 0, coSigned: 0, anchored: 0, lastCompletedAt: null },
        payments: { receivedFromOthers: 0, sent: 0, selfPayments: 3, receivedAmount: "0", sentAmount: "0", lastPaymentAt: "2026-01-01T00:00:00Z" },
        reputation: {
          feedbackCount: 7665,
          revokedFeedbackCount: 0,
          uniqueReviewerCount: 7665,
          lastFeedbackAt: "2026-02-17T00:00:00Z",
          counted: { reviews: 0, reviewers: 0, notCounted: { FUNDED_BY_TARGET: 7665 }, pendingReviewers: 0, assessedAt: "2026-10-03T00:00:00Z" },
        },
        updatedAt: "2026-02-01T00:00:00Z",
        liveness: { endpoints: 2, checked: 2, up: 0, notPublic: 1, paymentRequired: 0, uptime7d: 0, checks7d: 10 },
        uriChangeCount: 4,
        active: false,
      }),
      EMPTY_STATS,
      NOW,
    );
    expect(p.observations.map((o) => o.code)).toEqual([
      "LOW_HISTORY",
      "STALE",
      "REVIEWS_NOT_COUNTED",
      "SELF_PAYMENTS_ONLY",
      "NO_RECEIPTS",
      "ENDPOINT_CHURN",
      "ENDPOINTS_DOWN",
      "ENDPOINTS_NOT_PUBLIC",
      "MARKED_INACTIVE",
    ]);
    const notCounted = p.observations.find((o) => o.code === "REVIEWS_NOT_COUNTED")!;
    expect(notCounted.message).toBe("7665 of 7665 reviews are not counted: 7665 from wallets funded by the agent's owner or agent wallet.");
    expect(p.observations.map((o) => o.message).join(" ")).not.toMatch(/fake|fraud|scam/i);
  });
});

describe("buildTaskContext", () => {
  it("puts each asked value next to the observed one", () => {
    const a = agent();
    const p = buildEvidenceProfile(a, STATS, NOW);
    const facts = buildTaskContext(p, a, {
      minimumHistory: 25,
      maxLatencyMs: 100,
      requiredProof: "client-cosigned",
      valueAtRisk: 40,
      taskType: "email verification",
    });
    expect(facts.map((f) => [f.parameter, f.observed, f.comparison])).toEqual([
      ["minimumHistory", 1, "below"],
      ["maxLatencyMs", 42, "meets"],
      ["requiredProof", "level 2 (1 receipt)", "meets"],
      ["valueAtRisk", "0.01", "below"],
      ["taskType", "mentioned in the registration file", "mentioned"],
    ]);
  });

  it("marks proof kinds MoltForest does not record as not measurable", () => {
    const a = agent();
    const p = buildEvidenceProfile(a, STATS, NOW);
    const [fact] = buildTaskContext(p, a, { requiredProof: "zk" });
    expect(fact).toMatchObject({ comparison: "not_measurable", observed: "level 2" });
    expect(fact!.note).toMatch(/not supported yet/);
  });

  it("returns no facts without a task context", () => {
    const a = agent();
    expect(buildTaskContext(buildEvidenceProfile(a, STATS, NOW), a, {})).toEqual([]);
  });
});

describe("evaluatePolicy", async () => {
  const { evaluatePolicy, PolicySchema } = await import("../src/evidence/evaluate.js");
  const profile = buildEvidenceProfile(agent(), STATS, NOW);

  it("reports each of the caller's rules as met, not_met or not_measurable", () => {
    const policy = PolicySchema.parse({
      minReceipts: 1,
      minReceiptLevel: 2,
      minPaymentsFromOthers: 3,
      minUptime7d: 0.99,
      maxEndpointLatencyMs: 100,
      minCountedReviewers: 1,
      requireX402Support: true,
      excludeObservations: ["LOW_HISTORY", "STALE"],
    });
    const { requirements, policyMet } = evaluatePolicy(profile, policy);
    expect(requirements.map((r) => [r.rule, r.observed, r.result])).toEqual([
      ["minCountedReviewers", null, "not_measurable"],
      ["minReceipts", 1, "met"],
      ["minPaymentsFromOthers", 1, "not_met"],
      ["minUptime7d", 1, "met"],
      ["minReceiptLevel", 2, "met"],
      ["maxEndpointLatencyMs", 42, "met"],
      ["requireX402Support", true, "met"],
      ["excludeObservations", ["LOW_HISTORY"], "not_met"],
    ]);
    expect(policyMet).toBe(false);
  });

  it("meets a policy whose every rule is met", () => {
    expect(evaluatePolicy(profile, PolicySchema.parse({ minReceipts: 1, minReceiptLevel: 2 })).policyMet).toBe(true);
  });

  it("rejects unknown rules", () => {
    expect(() => PolicySchema.parse({ trustScoreAbove: 80 })).toThrow();
  });
});
