import { describe, expect, it } from "vitest";
import { assessReviews, type AgentAddresses, type Funding, type NansenFacts, type ReviewRow, type WalletLink } from "../src/reviews/assess.js";
import { extractFunding, type HsTx } from "../src/reviews/funding.js";
import { nansenFactsFromRows } from "../src/nansen/facts.js";

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

  it("gives wallets of one cluster the same root, and a lone wallet its own", () => {
    const F = addr(0xf0);
    const funding = new Map<string, Funding>([1, 2].map((n) => [addr(n), funded(F)]));
    const { clusterRoots } = assessReviews([review("1", addr(1)), review("1", addr(2)), review("1", addr(3))], agents("1"), funding, opts);
    expect(clusterRoots.get(addr(1))).toBe(clusterRoots.get(addr(2)));
    expect(clusterRoots.get(addr(1))).toBe(clusterRoots.get(F));
    // A reviewer with no known funding links to nothing, so it is its own cluster.
    expect(clusterRoots.get(addr(3))).toBe(addr(3));
  });

  it("does not put wallets of a hub in one cluster", () => {
    const HUB = addr(0xbb);
    const funding = new Map<string, Funding>([1, 2, 3, 4].map((n) => [addr(n), funded(HUB)]));
    const reviews = [review("1", addr(1)), review("1", addr(2)), review("2", addr(3)), review("3", addr(4))];
    const { clusterRoots } = assessReviews(reviews, agents("1", "2", "3"), funding, opts);
    expect(clusterRoots.get(addr(1))).toBe(addr(1));
    expect(clusterRoots.get(addr(2))).toBe(addr(2));
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

describe("assessReviews with Nansen facts (decision D47)", () => {
  const link = (wallet: string, other: string, relation = "Signer", kind: WalletLink["kind"] = "control"): WalletLink => ({
    wallet,
    other,
    relation,
    kind,
    tx: `0xn-${other.slice(-4)}`,
  });
  const facts = (links: WalletLink[], services: [string, string][] = []): NansenFacts => ({ links, services: new Map(services) });

  it("counts two wallets controlled by one signer as one reviewer", () => {
    const S = addr(0x51);
    const { labels, summaries } = assessReviews([review("1", addr(1)), review("1", addr(2))], agents("1"), new Map(), opts, undefined, facts([link(addr(1), S), link(addr(2), S)]));
    expect(labels.map((l) => l.reason)).toEqual([null, "COORDINATED_CLUSTER"]);
    expect(labels[1]!.evidence).toMatchObject({ nansen: [{ address: S, relation: "Signer", tx: "0xn-0051" }], countedAs: addr(1) });
    expect(summaries[0]).toMatchObject({ countedReviews: 1, countedReviewers: 1 });
  });

  it("does not link wallets through an address Nansen labels as an exchange", () => {
    const EX = addr(0xe0);
    const funding = new Map<string, Funding>([1, 2].map((n) => [addr(n), funded(EX)]));
    const reviews = [review("1", addr(1)), review("1", addr(2))];
    expect(assessReviews(reviews, agents("1"), funding, opts).labels.map((l) => l.reason)).toEqual([null, "COORDINATED_CLUSTER"]);

    const { labels, hubs } = assessReviews(reviews, agents("1"), funding, opts, undefined, facts([], [[EX, "Binance 14"]]));
    expect(labels.every((l) => l.counted)).toBe(true);
    expect(hubs.has(EX)).toBe(true);
  });

  it("uses Nansen's first funder where our own scan found none", () => {
    const F = addr(0xf1);
    const funding = new Map<string, Funding>([1, 2].map((n) => [addr(n), { status: "none" }]));
    const nansen = facts([link(addr(1), F, "First Funder", "funding"), link(addr(2), F, "First Funder", "funding")]);
    const { labels } = assessReviews([review("1", addr(1)), review("1", addr(2))], agents("1"), funding, opts, undefined, nansen);
    expect(labels.map((l) => l.reason)).toEqual([null, "COORDINATED_CLUSTER"]);
  });

  it("does not count a wallet whose signer is the agent's owner", () => {
    const { labels } = assessReviews([review("1", addr(1))], agents("1"), new Map(), opts, undefined, facts([link(addr(1), OWNER)]));
    expect(labels[0]).toMatchObject({ reason: "FUNDED_BY_TARGET", evidence: { link: "direct", nansen: [{ address: OWNER, relation: "Signer" }] } });
  });

  it("treats a Nansen first funder of wallets that reviewed many agents as a hub, but never a signer", () => {
    const F = addr(0xf2);
    const S = addr(0x52);
    const reviews = [review("1", addr(1)), review("1", addr(2)), review("2", addr(3)), review("3", addr(4))];

    const byFunder = assessReviews(reviews, agents("1", "2", "3"), new Map(), opts, undefined, facts([1, 2, 3, 4].map((n) => link(addr(n), F, "First Funder", "funding"))));
    expect(byFunder.hubs.has(F)).toBe(true);
    expect(byFunder.labels.every((l) => l.counted)).toBe(true);

    const bySigner = assessReviews(reviews, agents("1", "2", "3"), new Map(), opts, undefined, facts([1, 2, 3, 4].map((n) => link(addr(n), S))));
    expect(bySigner.hubs.has(S)).toBe(false);
    expect(bySigner.labels.map((l) => l.reason)).toEqual([null, "COORDINATED_CLUSTER", null, null]);
  });

  it("gives the same assessment hash whatever order the facts come in", () => {
    const S = addr(0x53);
    const T = addr(0x54);
    const reviews = [review("1", addr(1)), review("1", addr(2))];
    const links = [link(addr(1), S), link(addr(2), S), link(addr(2), T, "Multisig Signer of")];
    const a = assessReviews(reviews, agents("1"), new Map(), opts, undefined, facts(links)).summaries[0]!.assessmentHash;
    const b = assessReviews(reviews, agents("1"), new Map(), opts, undefined, facts([...links].reverse())).summaries[0]!.assessmentHash;
    expect(a).toBe(b);
  });

  it("leaves an assessment without Nansen links exactly as before", () => {
    const reviews = [review("1", addr(1)), review("1", addr(2))];
    const funding = new Map<string, Funding>([[addr(2), funded(addr(0xf0))]]);
    const before = assessReviews(reviews, agents("1"), funding, opts);
    const after = assessReviews(reviews, agents("1"), funding, opts, undefined, facts([]));
    expect(after.summaries[0]!.assessmentHash).toBe(before.summaries[0]!.assessmentHash);
  });
});

describe("nansenFactsFromRows", () => {
  it("keeps the relations MoltForest uses and collects exchange, bridge and faucet labels", () => {
    const W = addr(1);
    const F = addr(0xf0);
    const S = addr(0x51);
    const D = addr(0xd0);
    const result = nansenFactsFromRows([
      { wallet: W, related: F, relation: "First Funder", label: "Binance 14", txHash: "0xf" },
      { wallet: W, related: S, relation: "Signer", label: null, txHash: "0xs" },
      { wallet: W, related: D, relation: "Deployed by", label: "Account Factory", txHash: "0xd" },
      { wallet: W, related: W, relation: "Signer", label: null, txHash: null },
    ]);
    expect(result.links).toEqual([
      { wallet: W, other: F, relation: "First Funder", kind: "funding", tx: "0xf" },
      { wallet: W, other: S, relation: "Signer", kind: "control", tx: "0xs" },
    ]);
    expect(result.services).toEqual(new Map([[F, "Binance 14"]]));
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
