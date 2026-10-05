import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";
import { assessReviews, reviewKey, type AgentAddresses, type FileFacts, type Funding, type LinkContext, type PaymentFact, type ReviewRow } from "../src/reviews/assess.js";
import { decodeDataUri, parseFeedbackFile, readFeedbackFile } from "../src/reviews/feedbackFiles.js";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const OWNER = addr(0xa1);
const PAYER = addr(0xb1);
const OTHER = addr(0xb2);
const opts = { hubMinAgents: 10, repeatWindowDays: 30 };

describe("parseFeedbackFile", () => {
  it("reads the ERC-8004 proofOfPayment, an executionReceipt and the endpoint", () => {
    const facts = parseFeedbackFile(
      JSON.stringify({
        agentId: 1987,
        value: 90,
        endpoint: "https://api.moltforest.ai/demo/email-verifier/verify",
        proofOfPayment: { fromAddress: `eip155:10143:${PAYER.toUpperCase().replace("0X", "0x")}`, toAddress: OWNER, chainId: "10143", txHash: tx(7).toUpperCase().replace("0X", "0x") },
        executionReceipt: { receiptHash: tx(9) },
      }),
    );
    expect(facts).toEqual({
      proofTx: tx(7),
      proofChainId: "10143",
      proofFrom: PAYER,
      proofTo: OWNER,
      receiptHash: tx(9),
      endpoint: "https://api.moltforest.ai/demo/email-verifier/verify",
    });
  });

  it("ignores malformed values and non-objects", () => {
    expect(parseFeedbackFile(JSON.stringify({ proofOfPayment: { txHash: "0x123" }, executionReceipt: { receiptHash: 5 } }))).toMatchObject({
      proofTx: null,
      receiptHash: null,
    });
    expect(parseFeedbackFile("[1,2]")).toBeNull();
    expect(parseFeedbackFile("not json")).toBeNull();
  });
});

describe("readFeedbackFile", () => {
  const fetchOpts = { fetch: { timeoutMs: 1000, maxBytes: 10_000, userAgent: "test" }, ipfsGateways: [] };
  const body = JSON.stringify({ proofOfPayment: { txHash: tx(7) } });

  it("decodes data: URIs and checks the content against feedbackHash", async () => {
    const uri = `data:application/json;base64,${Buffer.from(body).toString("base64")}`;
    expect(decodeDataUri(uri)).toBe(body);
    expect(await readFeedbackFile(uri, keccak256(stringToBytes(body)), fetchOpts)).toMatchObject({ status: "ok", proofTx: tx(7) });
    expect(await readFeedbackFile(uri, tx(1), fetchOpts)).toMatchObject({ status: "hash_mismatch" });
    expect(await readFeedbackFile(uri, tx(0), fetchOpts)).toMatchObject({ status: "ok" }); // zero hash: not given
  });

  it("accepts raw JSON written into the URI and refuses unknown schemes", async () => {
    expect(await readFeedbackFile(body, tx(0), fetchOpts)).toMatchObject({ status: "ok" });
    expect(await readFeedbackFile("ftp://x/y.json", tx(0), fetchOpts)).toMatchObject({ status: "unsupported" });
  });
});

describe("review <-> payment links", () => {
  let block = 1000;
  const review = (agentId: string, client: string): ReviewRow => ({ agentId, client, feedbackIndex: String(block), blockNumber: block++, timestamp: 1_000_000 + block * 86_400 * 40 });
  const agents = new Map<string, AgentAddresses>([
    ["1987", { owner: OWNER, wallet: null }],
    ["5", { owner: addr(0xc5), wallet: null }],
  ]);
  const pay = (n: number, payer: string, payee: string, atBlock: number): PaymentFact => ({ tx: tx(n), payer, payee, amount: "10000", block: atBlock });
  const file = (over: Partial<FileFacts>): FileFacts => ({ status: "ok", proofTx: null, proofChainId: null, receiptHash: null, endpoint: null, ...over });

  function context(reviews: ReviewRow[], files: FileFacts[], payments: PaymentFact[], receipts: LinkContext["receipts"] = new Map()): LinkContext {
    const paymentsByPayer = new Map<string, PaymentFact[]>();
    for (const p of payments) paymentsByPayer.set(p.payer, [...(paymentsByPayer.get(p.payer) ?? []), p]);
    return {
      chainId: 10143,
      files: new Map(reviews.map((r, i) => [reviewKey(r.agentId, r.client, r.feedbackIndex), files[i]!] as const).filter(([, f]) => f !== undefined)),
      payments: new Map(payments.map((p) => [p.tx, p])),
      receipts,
      paymentsByPayer,
    };
  }

  it("verifies a review attached through a receipt, and one through proofOfPayment", () => {
    const r1 = review("1987", PAYER);
    const r2 = review("1987", OTHER);
    const p1 = pay(1, PAYER, OWNER, r1.blockNumber - 5);
    const p2 = pay(2, OTHER, OWNER, r2.blockNumber - 5);
    const ctx = context(
      [r1, r2],
      [file({ receiptHash: tx(100), endpoint: "https://svc.example/verify" }), file({ proofTx: tx(2), proofChainId: "eip155:10143" })],
      [p1, p2],
      new Map([[tx(100), { providerAgentId: "1987", clientSigner: PAYER, paymentRef: tx(1) }]]),
    );
    const { labels, summaries } = assessReviews([r1, r2], agents, new Map(), opts, ctx);
    expect(labels.map((l) => l.link)).toEqual([
      { by: "receipt", paymentTx: tx(1), amount: "10000", receiptHash: tx(100), endpoint: "https://svc.example/verify" },
      { by: "payment_proof", paymentTx: tx(2), amount: "10000", receiptHash: null, endpoint: null },
    ]);
    expect(summaries[0]).toMatchObject({ countedReviews: 2, verifiedReviews: 2 });
  });

  it("explains every attachment that does not check out", () => {
    const rs = [review("1987", PAYER), review("1987", OTHER), review("1987", addr(0xd1)), review("1987", addr(0xd2)), review("1987", addr(0xd3))];
    const ctx = context(
      rs,
      [
        file({ proofTx: tx(10) }), // paid after the review
        file({ proofTx: tx(11) }), // paid by someone else
        file({ proofTx: tx(12) }), // paid to another agent
        file({ status: "hash_mismatch" }),
        file({ receiptHash: tx(200) }), // receipt for another agent
      ],
      [pay(10, PAYER, OWNER, rs[0]!.blockNumber + 1), pay(11, OTHER.replace("b2", "b9"), OWNER, 1), pay(12, addr(0xd1), addr(0xc5), 1)],
      new Map([[tx(200), { providerAgentId: "5", clientSigner: addr(0xd3), paymentRef: tx(12) }]]),
    );
    const { labels, summaries } = assessReviews(rs, agents, new Map(), opts, ctx);
    expect(labels.map((l) => l.linkProblem)).toEqual([
      "the payment came after the review",
      "proofOfPayment was not paid by the reviewer",
      "the payment did not go to this agent's owner or agent wallet",
      "the feedback file does not match its feedbackHash",
      "the named receipt is for another agent",
    ]);
    expect(labels.every((l) => l.link === null && l.counted)).toBe(true);
    expect(summaries[0]!.verifiedReviews).toBe(0);
  });

  it("lets one payment back only one review", () => {
    const [a, b] = [review("1987", PAYER), review("1987", PAYER)];
    b.timestamp = a.timestamp + 40 * 86_400; // past the repeat window, so both count
    const p = pay(20, PAYER, OWNER, a.blockNumber - 1);
    const { labels } = assessReviews([a, b], agents, new Map(), opts, context([a, b], [file({ proofTx: tx(20) }), file({ proofTx: tx(20) })], [p]));
    expect(labels.map((l) => [l.link?.paymentTx ?? null, l.linkProblem])).toEqual([
      [tx(20), null],
      [null, "the payment already backs another review"],
    ]);
  });

  it("does not verify a payment from a wallet the agent's owner funded (wash trade)", () => {
    const sock = addr(0xee);
    const r = review("1987", PAYER);
    const funding = new Map<string, Funding>([[sock, { status: "found", funder: OWNER, fundingTx: tx(300) }]]);
    const ctx = context([r], [file({ receiptHash: tx(400) })], [pay(30, sock, OWNER, r.blockNumber - 1)], new Map([[tx(400), { providerAgentId: "1987", clientSigner: PAYER, paymentRef: tx(30) }]]));
    const { labels } = assessReviews([r], agents, funding, opts, ctx);
    expect(labels[0]).toMatchObject({ counted: true, link: null, linkProblem: "the payer is linked to the agent's owner by funding" });
  });

  it("notes a reviewer who paid before reviewing but attached nothing", () => {
    const r = review("1987", PAYER);
    const { labels, summaries } = assessReviews([r], agents, new Map(), opts, context([r], [], [pay(40, PAYER, OWNER, r.blockNumber - 1)]));
    expect(labels[0]).toMatchObject({ link: null, linkProblem: null, paidUnattached: true });
    expect(summaries[0]!.verifiedReviews).toBe(0);
  });
});

describe("round trip with the agent kit's feedback files", () => {
  it("reads back what buildPaidFeedbackFile writes, hash included", async () => {
    const { buildPaidFeedbackFile } = await import("@moltforest/chain");
    const built = buildPaidFeedbackFile({
      chainId: 10143,
      identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      agentId: 1987n,
      clientAddress: PAYER as `0x${string}`,
      rating: 90,
      endpoint: "https://api.moltforest.ai/demo/email-verifier/verify",
      payment: { from: PAYER as `0x${string}`, to: OWNER as `0x${string}`, txHash: tx(7) as `0x${string}` },
      receipt: { registry: "0x4d2a256fCaAc8e52e4B91e977EF6dDD56E980f98", receiptHash: tx(9) as `0x${string}` },
    });
    const read = await readFeedbackFile(built.uri, built.hash, { fetch: { timeoutMs: 1000, maxBytes: 10_000, userAgent: "test" }, ipfsGateways: [] });
    expect(read).toMatchObject({
      status: "ok",
      proofTx: tx(7),
      proofChainId: "10143",
      proofFrom: PAYER,
      proofTo: OWNER,
      receiptHash: tx(9),
      endpoint: "https://api.moltforest.ai/demo/email-verifier/verify",
    });
  });
});
