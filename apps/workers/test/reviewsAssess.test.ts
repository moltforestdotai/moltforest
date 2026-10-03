import { describe, expect, it } from "vitest";
import { assessReviews, type AgentAddresses, type Funding, type ReviewRow } from "../src/reviews/assess.js";
import { extractFunding, type HsTx } from "../src/reviews/funding.js";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const OWNER = addr(0xa1);
const WALLET = addr(0xa2);
const DAY = 86_400;
const opts = { hubMinAgents: 3, repeatWindowDays: 30 };

let block = 100;
const review = (agentId: string, client: string, timestamp = 1_000_000): ReviewRow => ({
  agentId,
  client,
  feedbackIndex: String(block),
  blockNumber: block++,
  timestamp,
});
const funded = (funder: string, extra: Partial<Funding> = {}): Funding => ({ status: "found", funder, fundingTx: `0xtx-${funder.slice(-4)}`, ...extra });
const agents = (...ids: string[]) => new Map<string, AgentAddresses>(ids.map((id) => [id, { owner: OWNER, wallet: WALLET }]));

describe("assessReviews", () => {
  it("does not count the agent's own owner or agent wallet", () => {
    const { labels, summaries } = assessReviews([review("1", OWNER), review("1", WALLET), review("1", addr(1))], agents("1"), new Map(), opts);
    expect(labels.map((l) => l.reason)).toEqual(["SELF_REVIEW", "SELF_REVIEW", null]);
    expect(labels[0]!.evidence).toEqual({ reviewer: OWNER, role: "owner" });
    expect(summaries[0]).toMatchObject({ countedReviews: 1, countedReviewers: 1, excluded: { SELF_REVIEW: 2 } });
  });

  it("does not count wallets the owner funded, directly or through another wallet", () => {
    const middle = addr(0x50);
    const funding = new Map<string, Funding>([
      [addr(1), funded(OWNER, { sweepTx: "0xsweep" })],
      [addr(2), funded(OWNER)],
      [addr(3), funded(middle)],
      [middle, funded(OWNER)],
    ]);
    const { labels, summaries } = assessReviews([review("1", addr(1)), review("1", addr(2)), review("1", addr(3))], agents("1"), funding, opts);
    expect(labels.map((l) => [l.reason, l.evidence?.link])).toEqual([
      ["FUNDED_BY_TARGET", "direct"],
      ["FUNDED_BY_TARGET", "direct"],
      ["FUNDED_BY_TARGET", "cluster"],
    ]);
    expect(labels[0]!.evidence).toMatchObject({ funder: OWNER, fundingTx: "0xtx-00a1", sweepTx: "0xsweep" });
    expect(summaries[0]).toMatchObject({ countedReviews: 0, countedReviewers: 0, excluded: { FUNDED_BY_TARGET: 3 } });
  });

  it("counts an unlinked cluster as one reviewer", () => {
    const F = addr(0xf0);
    const funding = new Map<string, Funding>([1, 2, 3].map((n) => [addr(n), funded(F)]));
    const { labels, summaries } = assessReviews([review("1", addr(1)), review("1", addr(2)), review("1", addr(3)), review("1", addr(4))], agents("1"), funding, opts);
    expect(labels.map((l) => l.reason)).toEqual([null, "COORDINATED_CLUSTER", "COORDINATED_CLUSTER", null]);
    expect(labels[1]!.evidence).toMatchObject({ funder: F, clusterSize: 3, countedAs: addr(1) });
    expect(summaries[0]).toMatchObject({ countedReviews: 2, countedReviewers: 2 });
  });

  it("does not link wallets through a hub (a funder whose wallets reviewed many agents)", () => {
    const HUB = addr(0xbb);
    const funding = new Map<string, Funding>([1, 2, 3, 4].map((n) => [addr(n), funded(HUB)]));
    const reviews = [review("1", addr(1)), review("1", addr(2)), review("2", addr(3)), review("3", addr(4))];
    const { labels, hubs } = assessReviews(reviews, agents("1", "2", "3"), funding, opts);
    expect(hubs).toEqual(new Set([HUB]));
    expect(labels.every((l) => l.counted)).toBe(true);
  });

  it("still catches an owner that funds so widely it looks like a hub", () => {
    const funding = new Map<string, Funding>([1, 2, 3].map((n) => [addr(n), funded(OWNER)]));
    const reviews = [review("1", addr(1)), review("2", addr(2)), review("3", addr(3))];
    const { labels, hubs } = assessReviews(reviews, agents("1", "2", "3"), funding, opts);
    expect(hubs.has(OWNER)).toBe(true);
    expect(labels.map((l) => [l.reason, l.evidence?.link])).toEqual([
      ["FUNDED_BY_TARGET", "direct"],
      ["FUNDED_BY_TARGET", "direct"],
      ["FUNDED_BY_TARGET", "direct"],
    ]);
  });

  it("counts a wallet once per repeat window", () => {
    const t0 = 1_000_000;
    const reviews = [review("1", addr(1), t0), review("1", addr(1), t0 + 5 * DAY), review("1", addr(1), t0 + 31 * DAY)];
    const { labels, summaries } = assessReviews(reviews, agents("1"), new Map(), opts);
    expect(labels.map((l) => l.reason)).toEqual([null, "REPEAT_REVIEWER", null]);
    expect(summaries[0]).toMatchObject({ countedReviews: 2, countedReviewers: 1, excluded: { REPEAT_REVIEWER: 1 } });
  });

  it("counts reviewers whose funding is not looked up yet, and says how many are pending", () => {
    const funding = new Map<string, Funding>([[addr(1), { status: "pending" }]]);
    const { summaries } = assessReviews([review("1", addr(1)), review("1", addr(2))], agents("1"), funding, opts);
    expect(summaries[0]).toMatchObject({ countedReviews: 2, pendingReviewers: 2 });
  });

  it("changes the assessment hash only when the labels change", () => {
    const reviews = [review("1", addr(1)), review("1", addr(2))];
    const a = assessReviews(reviews, agents("1"), new Map(), opts).summaries[0]!.assessmentHash;
    const b = assessReviews(reviews, agents("1"), new Map(), opts).summaries[0]!.assessmentHash;
    const c = assessReviews(reviews, agents("1"), new Map([[addr(2), funded(OWNER)]]), opts).summaries[0]!.assessmentHash;
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });
});

describe("extractFunding", () => {
  const W = addr(1);
  const F = addr(0xf0);
  const tx = (over: Partial<HsTx>): HsTx => ({ block_number: 10, transaction_index: 0, hash: `0x${block++}`, status: 1, value: "0x01", ...over });

  it("takes the earliest successful incoming MON transfer as the funding", () => {
    const txs = [
      tx({ block_number: 20, from: addr(0xee), to: W, hash: "0xlater" }),
      tx({ block_number: 5, from: addr(0xdd), to: W, value: "0x00", hash: "0xzero" }),
      tx({ block_number: 6, from: addr(0xcc), to: W, status: 0, hash: "0xfailed" }),
      tx({ block_number: 7, transaction_index: 3, from: F, to: W, value: "0x0de0b6b3a7640000", hash: "0xFUND" }),
    ];
    expect(extractFunding([W], txs)[0]).toMatchObject({
      status: "found",
      funder: F,
      fundingTx: "0xfund",
      fundingBlock: 7,
      fundingValue: "1000000000000000000",
    });
  });

  it("finds a transfer back to the funder and counts sent transactions", () => {
    const txs = [
      tx({ block_number: 7, from: F, to: W, hash: "0xfund" }),
      tx({ block_number: 8, from: W, to: addr(0x8004), value: "0x00" }),
      tx({ block_number: 9, from: W, to: F, value: "0x05", hash: "0xsweep" }),
    ];
    expect(extractFunding([W], txs)[0]).toMatchObject({ funder: F, sweepTx: "0xsweep", sentTxCount: 2 });
  });

  it("reports none when the wallet never received MON in a transaction", () => {
    expect(extractFunding([W], [tx({ from: W, to: F, value: "0x00" })])[0]).toMatchObject({ status: "none", funder: null, sentTxCount: 1 });
  });
});
