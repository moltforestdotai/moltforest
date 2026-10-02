import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { newTaskId, receiptDomain, receiptToJson, signReceipt, ZERO_BYTES32, type Receipt } from "@moltforest/receipts";
import { RECEIPT_REGISTRY, TESTNET } from "../src/chain.js";
import { loadConfig } from "../src/config.js";
import { extractReceipt } from "../src/cosign.js";
import { isPayable } from "../src/hire.js";
import { checkUrl, createSafeFetch, isPublicAddress, KitError } from "../src/net.js";
import { spentInLastDay, type LedgerFile } from "../src/store.js";

describe("config", () => {
  it("defaults to the owner's caps: 0.10 USDC per payment, 1 USDC per day", () => {
    const c = loadConfig({});
    expect(c.MOLTFOREST_KIT_MAX_PER_PAYMENT_USDC).toBe(100_000n);
    expect(c.MOLTFOREST_KIT_MAX_PER_DAY_USDC).toBe(1_000_000n);
    expect(c.MOLTFOREST_KIT_ALLOW_LOCAL).toBe(false);
  });

  it("rejects a per-payment cap above the daily cap", () => {
    expect(() => loadConfig({ MOLTFOREST_KIT_MAX_PER_PAYMENT_USDC: "2" })).toThrow(/above the daily cap/);
  });
});

describe("spentInLastDay", () => {
  it("sums payments from the last 24 hours only", () => {
    const now = Date.parse("2026-10-02T12:00:00Z");
    const ledger: LedgerFile = {
      version: 1,
      jobs: [],
      payments: [
        { at: "2026-10-01T11:59:00Z", url: "u", amount: "500000", payTo: "0x0000000000000000000000000000000000000001", transaction: "0x01" },
        { at: "2026-10-01T12:01:00Z", url: "u", amount: "10000", payTo: "0x0000000000000000000000000000000000000001", transaction: "0x02" },
        { at: "2026-10-02T11:00:00Z", url: "u", amount: "20000", payTo: "0x0000000000000000000000000000000000000001", transaction: "0x03" },
      ],
    };
    expect(spentInLastDay(ledger, now)).toBe(30_000n);
  });
});

describe("isPayable", () => {
  it("accepts only the exact scheme with USDC on Monad testnet", () => {
    const ok = { scheme: "exact", network: "eip155:10143" as `${string}:${string}`, asset: TESTNET.usdc as string };
    expect(isPayable(ok)).toBe(true);
    expect(isPayable({ ...ok, asset: TESTNET.usdc.toLowerCase() })).toBe(true);
    expect(isPayable({ ...ok, network: "eip155:143" as const })).toBe(false);
    expect(isPayable({ ...ok, scheme: "upto" })).toBe(false);
    expect(isPayable({ ...ok, asset: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" })).toBe(false);
  });
});

describe("checkUrl and the guarded fetch", () => {
  it("allows public https URLs only", () => {
    expect(checkUrl("https://api.moltforest.ai/demo", false).hostname).toBe("api.moltforest.ai");
    for (const bad of ["http://example.com", "ftp://example.com", "https://user:pw@example.com", "https://127.0.0.1/x", "https://[::1]/", "https://10.0.0.5/", "not a url"]) {
      expect(() => checkUrl(bad, false)).toThrow(KitError);
    }
    expect(checkUrl("http://127.0.0.1:7051/x", true).port).toBe("7051");
  });

  it("classifies addresses", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    for (const a of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1"]) expect(isPublicAddress(a)).toBe(false);
  });

  it("refuses hostnames that resolve to private addresses at connect time", async () => {
    const safeFetch = createSafeFetch({ allowLocal: false });
    await expect(safeFetch("https://localhost/")).rejects.toThrow(/non-public address/);
  });
});

describe("extractReceipt", () => {
  it("recognises a MoltForest testnet receipt and recomputes its hash", async () => {
    const provider = privateKeyToAccount(generatePrivateKey());
    const receipt: Receipt = {
      taskId: newTaskId(),
      clientAgentId: 1720n,
      providerAgentId: 4242n,
      requestHash: ZERO_BYTES32,
      resultHash: ZERO_BYTES32,
      paymentRef: ZERO_BYTES32,
      startedAt: 1n,
      completedAt: 2n,
      proofType: 0,
      proofRef: ZERO_BYTES32,
    };
    const domain = receiptDomain(TESTNET.chainId, RECEIPT_REGISTRY);
    const body = {
      receipt: {
        chainId: TESTNET.chainId,
        registry: RECEIPT_REGISTRY,
        receiptHash: `0x${"00".repeat(32)}`,
        receipt: receiptToJson(receipt),
        providerSignature: await signReceipt(provider, receipt, domain),
      },
    };
    const found = extractReceipt(body);
    expect(found?.receiptHash).not.toBe(body.receipt.receiptHash);
    expect(found?.receipt.providerAgentId).toBe("4242");
    expect(extractReceipt({ receipt: { ...body.receipt, chainId: 143 } })).toBeNull();
    expect(extractReceipt({ receipt: { ...body.receipt, registry: "0x0000000000000000000000000000000000000001" } })).toBeNull();
    expect(extractReceipt({ result: "no receipt" })).toBeNull();
  });
});
