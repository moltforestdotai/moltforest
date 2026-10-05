/**
 * The evidence profile (phase 6): what MoltForest can show about one agent, in
 * five categories plus observations. Pure: agent detail and extra facts in,
 * profile out.
 *
 * Rules: no score and no verdict (C1); every metric names its source (C2);
 * observations are neutral and carry evidence (C5); what cannot be measured
 * says so and is never estimated.
 */
import { formatUnits } from "viem";
import { NETWORKS } from "@moltforest/chain";
import type {
  AgentDetail,
  ContextFact,
  EvidenceProfile,
  Metric,
  Observation,
  Provenance,
  ReviewExclusionReason,
  TaskContextQuery,
} from "@moltforest/types";
import type { EvidenceStats } from "./repository.js";

const DAY_MS = 86_400_000;
/** Below this many observed jobs plus payments from others, history is "low". */
export const LOW_HISTORY_THRESHOLD = 5;
/** No activity for this long makes a profile "stale". */
export const STALE_AFTER_DAYS = 90;
/** URI or registration-file changes from this many on count as churn. */
export const CHURN_THRESHOLD = 3;

const NOT_COUNTED_TEXT: Record<ReviewExclusionReason, string> = {
  SELF_REVIEW: "written by the agent's own owner or agent wallet",
  FUNDED_BY_TARGET: "from wallets funded by the agent's owner or agent wallet",
  REPEAT_REVIEWER: "repeat reviews from the same wallet within 30 days",
  COORDINATED_CLUSTER: "from wallets sharing a funder with another reviewer (counted as one)",
};

const measured = <T>(value: T, provenance: Provenance): Metric<T> => ({ value, status: "measured", provenance });
const notMeasured = <T>(provenance: Provenance): Metric<T> => ({ value: null, status: "not_measured", provenance });
const usdc = (units: string) => formatUnits(BigInt(units), 6);
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
/** The latest of some ISO timestamps, or null. */
const latestOf = (...dates: (string | null | undefined)[]): string | null =>
  dates.reduce<string | null>((latest, d) => (d && (!latest || Date.parse(d) > Date.parse(latest)) ? d : latest), null);

export function buildEvidenceProfile(agent: AgentDetail, stats: EvidenceStats, now: Date): EvidenceProfile {
  const network = NETWORKS[agent.network];
  const api = `/v1/agents/${agent.network}/${agent.agentId}`;
  const identityContract = { address: network.identityRegistry, events: ["Registered", "URIUpdated", "MetadataSet"] };
  const reputationContract = { address: network.reputationRegistry, events: ["NewFeedback", "FeedbackRevoked"] };
  const usdcContract = { address: network.usdc, events: ["AuthorizationUsed", "Transfer"] };
  const receiptContract = network.receiptRegistry
    ? { address: network.receiptRegistry.address, events: ["ReceiptAnchored", "ReceiptCoSigned"] }
    : undefined;

  const l = agent.liveness;
  const r = agent.reputation;
  const p = agent.payments;
  const rc = agent.receipts;
  const given = agent.reviewsGiven;

  const livenessSource: Provenance = {
    api,
    window: "last 7 days",
    note: "MoltForest probes each declared http(s) endpoint about every 15 minutes; any HTTP answer below 500 counts as up.",
  };
  // No declared endpoint (e.g. an agent that only hires others): there is nothing to check, which is not a failure.
  const noEndpointSource: Provenance = {
    ...livenessSource,
    note: "The registration file declares no http(s) endpoint, so there is nothing to check (for example an agent that only hires others).",
  };
  const uptimeSource = l.endpoints === 0 ? noEndpointSource : livenessSource;
  const latencies = agent.endpoints.map((e) => e.avgLatencyMs7d).filter((v): v is number => v !== null);
  const lastActivity = latestOf(p.lastPaymentAt, rc.lastCompletedAt, rc.lastAsClientAt, given.lastAt, agent.updatedAt);
  const activitySource: Provenance = {
    api,
    note: "Latest of the agent's own actions: x402 payment sent or received, execution receipt as provider or co-signed as client, review written, registration update.",
  };
  const reviewSource: Provenance = { api, contract: reputationContract, window: "all time" };
  const reviewsGivenSource: Provenance = {
    api,
    contract: reputationContract,
    window: "all time",
    note: "Non-revoked reviews whose client is the agent's owner or agent wallet, about other agents. Context only: they say nothing about this agent's own work.",
  };
  const paymentSource: Provenance = {
    api: `${api}/payments?direction=received`,
    contract: usdcContract,
    window: "all time",
    ...(stats.received.firstBlock && stats.received.lastBlock ? { blockRange: { from: stats.received.firstBlock, to: stats.received.lastBlock } } : {}),
    note: "x402 settlements (transferWithAuthorization) where the agent's owner or agent wallet is payer or payee.",
  };
  const receiptSource: Provenance = receiptContract
    ? { api: `${api}/receipts?role=provider`, contract: receiptContract, window: "all time" }
    : { api: `${api}/receipts?role=provider`, note: "Receipts are recorded on Monad testnet only for now." };
  const jobSource: Provenance = {
    note: "Not measurable yet: receipts are signed only for completed jobs, so failures and job durations are not observed.",
  };

  const notCountedTotal = r.counted ? Object.values(r.counted.notCounted).reduce((a, b) => a + (b ?? 0), 0) : 0;

  const profile: EvidenceProfile = {
    network: agent.network,
    agentId: agent.agentId,
    globalId: agent.globalId,
    name: agent.name,
    generatedAt: now.toISOString(),
    identity: {
      registeredAt: measured(agent.registeredAt, { contract: identityContract, note: `Registered in tx ${agent.registeredTx}.` }),
      ageDays: measured(Math.floor((now.getTime() - Date.parse(agent.registeredAt)) / DAY_MS), { contract: identityContract }),
      profileStatus: measured(agent.metadataStatus, {
        api,
        note: agent.profileSource === "remote" ? `Registration file fetched from ${agent.profileFetch?.fetchUrl ?? "its agentURI"}.` : "Registration file stored on-chain.",
      }),
      uriChanges: measured(agent.uriChangeCount, { api, contract: identityContract }),
      agentWalletSet: measured(agent.agentWallet !== null, { contract: identityContract }),
      declaredServices: measured(agent.serviceCount, { api, note: "Self-declared in the registration file." }),
      x402Support: agent.x402Support === null ? notMeasured({ api, note: "Not declared in the registration file." }) : measured(agent.x402Support, { api, note: "Self-declared in the registration file." }),
    },
    reliability: {
      endpoints: measured(l.endpoints, livenessSource),
      endpointsUp: l.checked > 0 ? measured(l.up, livenessSource) : notMeasured(uptimeSource),
      uptime7d: l.uptime7d === null ? notMeasured(uptimeSource) : measured(l.uptime7d, livenessSource),
      endpointLatencyMs7d: latencies.length > 0 ? measured(Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length), livenessSource) : notMeasured(uptimeSource),
      lastActivityAt: lastActivity ? measured(lastActivity, activitySource) : notMeasured(activitySource),
      jobSuccessRate: notMeasured(jobSource),
      jobLatencyMs: notMeasured(jobSource),
    },
    reputation: {
      reviews: measured(r.feedbackCount, reviewSource),
      reviewers: measured(r.uniqueReviewerCount, reviewSource),
      countedReviews: r.counted ? measured(r.counted.reviews, reviewSource) : notMeasured({ ...reviewSource, note: "Reviews not checked yet." }),
      countedReviewers: r.counted ? measured(r.counted.reviewers, reviewSource) : notMeasured({ ...reviewSource, note: "Reviews not checked yet." }),
      verifiedReviews: r.counted
        ? measured(r.counted.verifiedReviews, {
            ...reviewSource,
            note: "Counted reviews whose feedback file attaches an x402 payment (an execution receipt or ERC-8004 proofOfPayment) from the reviewer to this agent, before the review; one review per payment.",
          })
        : notMeasured({ ...reviewSource, note: "Reviews not checked yet." }),
      notCounted: r.counted ? measured(r.counted.notCounted, { ...reviewSource, note: "Each review that does not count keeps its reason and funding evidence in recentFeedback." }) : notMeasured(reviewSource),
      lastReviewAt: r.lastFeedbackAt ? measured(r.lastFeedbackAt, reviewSource) : notMeasured(reviewSource),
      reviewsGiven: measured(given.reviews, reviewsGivenSource),
      verifiedReviewsGiven: measured(given.verified, {
        ...reviewsGivenSource,
        note: "Reviews this agent wrote that the reviewed agent's assessment counts and attaches to a checked x402 payment (D39).",
      }),
    },
    economic: {
      paymentsReceivedFromOthers: measured(p.receivedFromOthers, paymentSource),
      receivedUsdc: measured(p.receivedAmount, paymentSource),
      distinctPayers: measured(stats.received.distinctPayers, paymentSource),
      largestPaymentUsdc: stats.received.largestAmount ? measured(usdc(stats.received.largestAmount), paymentSource) : notMeasured({ ...paymentSource, note: "No payments from other addresses observed." }),
      paymentsSent: measured(p.sent, { ...paymentSource, api: `${api}/payments?direction=sent` }),
      selfPayments: measured(p.selfPayments, { ...paymentSource, api: `${api}/payments?direction=self` }),
      lastPaymentAt: p.lastPaymentAt ? measured(p.lastPaymentAt, paymentSource) : notMeasured(paymentSource),
    },
    verification: {
      receipts: measured(rc.total, receiptSource),
      coSignedReceipts: measured(rc.coSigned, receiptSource),
      anchoredReceipts: measured(rc.anchored, receiptSource),
      receiptsWithPayment: measured(stats.receipts.withPayment, { ...receiptSource, note: "Receipts whose paymentRef names an indexed x402 payment." }),
      highestReceiptLevel: stats.receipts.highestLevel === null ? notMeasured({ ...receiptSource, note: "No receipts." }) : measured(stats.receipts.highestLevel, receiptSource),
      lastReceiptAt: rc.lastCompletedAt ? measured(rc.lastCompletedAt, receiptSource) : notMeasured(receiptSource),
      coSignedAsClient: measured(rc.coSignedAsClient, {
        ...receiptSource,
        api: `${api}/receipts?role=client`,
        note: "Level-2 receipts this agent co-signed as the client: jobs it hired another agent for.",
      }),
    },
    observations: [],
    coverage: [],
  };

  // Observations (C5): observable conditions with evidence.
  const obs: Observation[] = [];
  const history = rc.total + p.receivedFromOthers;
  if (history < LOW_HISTORY_THRESHOLD) {
    obs.push({
      code: "LOW_HISTORY",
      severity: "info",
      message: `Little observable work history: ${plural(rc.total, "receipt")} as provider and ${plural(p.receivedFromOthers, "x402 payment")} received from other addresses.${
        p.sent > 0 || rc.coSignedAsClient > 0
          ? ` As a client it sent ${plural(p.sent, "x402 payment")} and co-signed ${plural(rc.coSignedAsClient, "receipt")}.`
          : ""
      }`,
      provenance: { ...receiptSource, note: `Threshold: ${LOW_HISTORY_THRESHOLD} receipts plus payments.` },
    });
  }
  const lastSeen = latestOf(r.lastFeedbackAt, lastActivity);
  if (lastSeen && now.getTime() - Date.parse(lastSeen) > STALE_AFTER_DAYS * DAY_MS) {
    obs.push({
      code: "STALE",
      severity: "notice",
      message: `No reviews, payments, receipts or profile updates seen for more than ${STALE_AFTER_DAYS} days (last on ${lastSeen.slice(0, 10)}).`,
      provenance: { api, note: "Latest of: last review received or written, last payment, last receipt in either role, last registration update." },
    });
  }
  if (r.counted && notCountedTotal > 0) {
    const parts = (Object.entries(r.counted.notCounted) as [ReviewExclusionReason, number][])
      .filter(([, n]) => n > 0)
      .map(([reason, n]) => `${n} ${NOT_COUNTED_TEXT[reason]}`);
    obs.push({
      code: "REVIEWS_NOT_COUNTED",
      severity: "notice",
      message: `${notCountedTotal} of ${r.feedbackCount} reviews are not counted: ${parts.join("; ")}.`,
      provenance: { ...reviewSource, note: "Decision D31: reviewer funding traced on-chain; every review stays listed with its reason." },
    });
  }
  if (p.selfPayments > 0 && p.receivedFromOthers === 0 && p.sent === 0) {
    obs.push({
      code: "SELF_PAYMENTS_ONLY",
      severity: "notice",
      message: `The only x402 payments seen are ${plural(p.selfPayments, "payment")} between the agent's own addresses.`,
      provenance: { ...paymentSource, api: `${api}/payments?direction=self` },
    });
  }
  if (rc.total === 0) {
    obs.push({
      code: "NO_RECEIPTS",
      severity: "info",
      message: `No execution receipts where this agent is the provider${rc.coSignedAsClient > 0 ? ` (it co-signed ${plural(rc.coSignedAsClient, "receipt")} as a client)` : ""}.`,
      provenance: receiptSource,
    });
  }
  const fileChanges = agent.profileFetch?.contentChangeCount ?? 0;
  if (agent.uriChangeCount >= CHURN_THRESHOLD || fileChanges >= CHURN_THRESHOLD) {
    obs.push({
      code: "ENDPOINT_CHURN",
      severity: "info",
      message: `The registration changed often: ${plural(agent.uriChangeCount, "agentURI update")}${fileChanges ? `, ${plural(fileChanges, "change")} to the fetched file` : ""}.`,
      provenance: { api, contract: identityContract },
    });
  }
  if (agent.metadataStatus === "unreachable" || agent.metadataStatus === "invalid") {
    obs.push({
      code: "PROFILE_UNREACHABLE",
      severity: "warning",
      message: agent.metadataStatus === "invalid" ? "The registration file is not valid." : "The registration file could not be fetched.",
      provenance: { api, note: agent.metadataError ?? undefined },
    });
  }
  if (l.checked > 0 && l.up === 0 && l.notPublic < l.checked) {
    obs.push({ code: "ENDPOINTS_DOWN", severity: "warning", message: "No declared endpoint answered at the last check.", provenance: livenessSource });
  }
  if (l.notPublic > 0) {
    obs.push({
      code: "ENDPOINTS_NOT_PUBLIC",
      severity: "notice",
      message: `${plural(l.notPublic, "declared endpoint")} point${l.notPublic === 1 ? "s" : ""} at localhost or a private address.`,
      provenance: livenessSource,
    });
  }
  if (agent.active === false) {
    obs.push({ code: "MARKED_INACTIVE", severity: "notice", message: "The owner marked the agent inactive in its registration file.", provenance: { api } });
  }
  profile.observations = obs;

  const count = (metrics: Record<string, Metric<unknown>>) => {
    const list = Object.values(metrics);
    return { measured: list.filter((m) => m.status === "measured").length, total: list.length };
  };
  profile.coverage = (["identity", "reliability", "reputation", "economic", "verification"] as const).map((category) => ({
    category,
    ...count(profile[category] as unknown as Record<string, Metric<unknown>>),
  }));
  return profile;
}

const LEVEL_FOR: Partial<Record<NonNullable<TaskContextQuery["requiredProof"]>, number>> = { none: 0, "provider-signed": 1, "client-cosigned": 2 };

/** Puts each asked value next to what MoltForest observed. Comparisons of numbers, not a verdict. */
export function buildTaskContext(profile: EvidenceProfile, agent: AgentDetail, q: TaskContextQuery): ContextFact[] {
  const facts: ContextFact[] = [];
  const receipts = profile.verification.receipts.value ?? 0;

  if (q.minimumHistory !== undefined) {
    facts.push({
      parameter: "minimumHistory",
      asked: q.minimumHistory,
      observed: receipts,
      comparison: receipts >= q.minimumHistory ? "meets" : "below",
      note: "Observed jobs are execution receipts where this agent is the provider (Monad testnet only for now).",
    });
  }
  if (q.maxLatencyMs !== undefined) {
    const latency = profile.reliability.endpointLatencyMs7d.value;
    facts.push({
      parameter: "maxLatencyMs",
      asked: q.maxLatencyMs,
      observed: latency,
      comparison: latency === null ? "not_measurable" : latency <= q.maxLatencyMs ? "meets" : "above",
      note: "Average endpoint response time from MoltForest's liveness probes over 7 days; job duration is not measurable yet.",
    });
  }
  if (q.requiredProof !== undefined) {
    const need = LEVEL_FOR[q.requiredProof];
    const highest = profile.verification.highestReceiptLevel.value;
    facts.push(
      need === undefined
        ? {
            parameter: "requiredProof",
            asked: q.requiredProof,
            observed: highest === null ? "no receipts" : `level ${highest}`,
            comparison: "not_measurable",
            note: "MoltForest records receipt levels 1 (provider-signed) and 2 (client co-signed) only; validator, ZK and TEE evidence is not supported yet.",
          }
        : {
            parameter: "requiredProof",
            asked: q.requiredProof,
            observed: highest === null ? "no receipts" : `level ${highest} (${plural(receipts, "receipt")})`,
            comparison: (highest ?? 0) >= need ? "meets" : "below",
            note: "Highest receipt level seen for this agent as provider. A receipt is evidence that a job happened, not a proof of its output.",
          },
    );
  }
  if (q.valueAtRisk !== undefined) {
    const largest = profile.economic.largestPaymentUsdc.value;
    const largestNum = largest === null ? 0 : Number(largest);
    facts.push({
      parameter: "valueAtRisk",
      asked: q.valueAtRisk,
      observed: largest ?? "0",
      comparison: largestNum >= q.valueAtRisk ? "meets" : "below",
      note: `Largest single x402 payment the agent received from another address, in USDC.${receipts === 0 ? " There are no execution receipts for this agent." : ""}`,
    });
  }
  if (q.taskType !== undefined) {
    const haystack = [agent.name, agent.description, ...agent.services.map((s) => s.name)].filter(Boolean).join(" ").toLowerCase();
    const words = q.taskType.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    const mentioned = words.length > 0 && words.some((w) => haystack.includes(w));
    facts.push({
      parameter: "taskType",
      asked: q.taskType,
      observed: mentioned ? "mentioned in the registration file" : "not mentioned",
      comparison: mentioned ? "mentioned" : "not_mentioned",
      note: "Matched against the self-declared name, description and service names; not verified.",
    });
  }
  return facts;
}
