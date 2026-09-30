import { describe, expect, it } from "vitest";
import { AUTHORIZATION_USED, TRANSFER, extractPayments, type HsBatch, type HsLog } from "../src/payments/classify.js";

const USDC = "0x534b2f3a21130d7a60830c2df862319e593943a3";
const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
const amount = (units: bigint) => `0x${units.toString(16).padStart(64, "0")}`;
const A1722 = "0x9e3f2fa5177b2efc7542efaa1d588832d4bdf1b1";
const A1720 = "0xd792e62177584ebf5237d24d26eb4842387ba93a";
const OTHER = "0x1111111111111111111111111111111111111111";
const FACILITATOR = "0x7f6a2850669202519f0fe8aa912451238820db86";

function auth(tx: string, block: number, logIndex: number, payer: string): HsLog {
  return { block_number: block, log_index: logIndex, transaction_hash: tx, address: USDC, topic0: AUTHORIZATION_USED, topic1: topic(payer), topic2: `0x${"ab".repeat(32)}`, data: "0x" };
}
function transfer(tx: string, block: number, logIndex: number, from: string, to: string, units: bigint, address = USDC): HsLog {
  return { block_number: block, log_index: logIndex, transaction_hash: tx, address, topic0: TRANSFER, topic1: topic(from), topic2: topic(to), data: amount(units) };
}
const batch = (logs: HsLog[], txs: string[], blocks: number[]): HsBatch => ({
  logs,
  transactions: txs.map((hash) => ({ hash, from: FACILITATOR })),
  blocks: blocks.map((number) => ({ number, timestamp: `0x${(0x69cc2baf + number - 22475874).toString(16)}` })),
});
const tracked = (...list: string[]) => (address: string) => list.includes(address);

describe("extractPayments", () => {
  it("pairs AuthorizationUsed with the Transfer from the authorizer (the verified #1722 → #1720 payment)", () => {
    const tx = "0xa84fd537ecbb7fe7471a41a8430dc617635a0664adb34957579a13b39a4f4e32";
    const payments = extractPayments(10143, USDC, [batch([auth(tx, 22475874, 5, A1722), transfer(tx, 22475874, 6, A1722, A1720, 1_000_000n)], [tx], [22475874])], tracked(A1720));
    expect(payments).toEqual([
      {
        chainId: 10143,
        txHash: tx,
        logIndex: 6,
        blockNumber: 22475874,
        blockTime: new Date(0x69cc2baf * 1000),
        asset: USDC,
        payer: A1722,
        payee: A1720,
        amount: "1000000",
        facilitator: FACILITATOR,
      },
    ]);
  });

  it("ignores plain transfers without an authorization", () => {
    const tx = "0x01";
    expect(extractPayments(10143, USDC, [batch([transfer(tx, 5, 0, OTHER, A1720, 20_000_000n)], [tx], [5])], tracked(A1720))).toEqual([]);
  });

  it("ignores an authorization whose transfer comes from someone else", () => {
    const tx = "0x02";
    expect(extractPayments(10143, USDC, [batch([auth(tx, 5, 0, A1722), transfer(tx, 5, 1, OTHER, A1720, 1n)], [tx], [5])], tracked(A1720))).toEqual([]);
  });

  it("keeps only payments that touch a tracked address", () => {
    const tx = "0x03";
    expect(extractPayments(10143, USDC, [batch([auth(tx, 5, 0, OTHER), transfer(tx, 5, 1, OTHER, OTHER, 1n)], [tx], [5])], tracked(A1720))).toEqual([]);
  });

  it("finds several settlements in one transaction and other tokens are skipped", () => {
    const tx = "0x04";
    const logs = [
      auth(tx, 7, 0, A1722),
      transfer(tx, 7, 1, A1722, A1720, 1n),
      transfer(tx, 7, 2, A1722, A1720, 99n, "0x2222222222222222222222222222222222222222"),
      auth(tx, 7, 3, A1720),
      transfer(tx, 7, 4, A1720, OTHER, 2n),
    ];
    const payments = extractPayments(10143, USDC, [batch(logs, [tx], [7])], tracked(A1720));
    expect(payments.map((p) => [p.payer, p.payee, p.amount, p.logIndex])).toEqual([
      [A1722, A1720, "1", 1],
      [A1720, OTHER, "2", 4],
    ]);
  });

  it("records a self-payment (payer and payee are the same agent address)", () => {
    const tx = "0x05";
    const [p] = extractPayments(10143, USDC, [batch([auth(tx, 9, 0, A1720), transfer(tx, 9, 1, A1720, A1720, 10_000_000n)], [tx], [9])], tracked(A1720));
    expect(p).toMatchObject({ payer: A1720, payee: A1720, amount: "10000000" });
  });

  it("merges logs, transactions and blocks spread over several batches and de-duplicates", () => {
    const tx = "0x06";
    const a = auth(tx, 11, 0, A1722);
    const t = transfer(tx, 11, 1, A1722, A1720, 5n);
    const batches: HsBatch[] = [{ logs: [a] }, { logs: [t, t], transactions: [{ hash: tx, from: FACILITATOR }] }, { blocks: [{ number: 11, timestamp: 1_790_000_000 }] }];
    const payments = extractPayments(10143, USDC, batches, tracked(A1720));
    expect(payments).toHaveLength(1);
    expect(payments[0]!.blockTime).toEqual(new Date(1_790_000_000_000));
  });
});
