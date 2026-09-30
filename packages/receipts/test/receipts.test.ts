import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  hashReceipt,
  newTaskId,
  parseReceipt,
  proofTypeName,
  receiptDomain,
  receiptJsonSchema,
  receiptToJson,
  recoverReceiptSigner,
  signatureSchema,
  signReceipt,
  type ReceiptJson,
} from "../src/index.js";

const h = (c: string) => `0x${c.repeat(64)}`;
const json: ReceiptJson = {
  taskId: h("a"),
  clientAgentId: "12",
  providerAgentId: "1937",
  requestHash: h("b"),
  resultHash: h("c"),
  paymentRef: h("0"),
  startedAt: 1_790_000_000,
  completedAt: 1_790_000_005,
  proofType: 0,
  proofRef: h("0"),
};
const domain = receiptDomain(10143, "0x2222222222222222222222222222222222222222");

describe("receipt JSON", () => {
  it("round-trips through parse and serialize", () => {
    const receipt = parseReceipt(json);
    expect(receipt.providerAgentId).toBe(1937n);
    expect(receipt.startedAt).toBe(1_790_000_000n);
    expect(receiptToJson(receipt)).toEqual(json);
  });

  it("normalizes hex to lowercase so equal receipts hash equally", () => {
    const upper = parseReceipt({ ...json, taskId: json.taskId.toUpperCase().replace("0X", "0x") });
    expect(hashReceipt(upper, domain)).toBe(hashReceipt(parseReceipt(json), domain));
  });

  it("accepts agent id 0 and the largest uint256", () => {
    expect(parseReceipt({ ...json, clientAgentId: "0" }).clientAgentId).toBe(0n);
    const max = (2n ** 256n - 1n).toString();
    expect(parseReceipt({ ...json, providerAgentId: max }).providerAgentId).toBe(2n ** 256n - 1n);
  });

  it.each([
    ["short bytes32", { taskId: "0x1234" }],
    ["non-hex bytes32", { resultHash: `0x${"g".repeat(64)}` }],
    ["numeric agent id", { providerAgentId: 1937 }],
    ["leading-zero agent id", { providerAgentId: "01937" }],
    ["negative agent id", { clientAgentId: "-1" }],
    ["agent id above uint256", { providerAgentId: (2n ** 256n).toString() }],
    ["fractional timestamp", { startedAt: 1.5 }],
    ["proofType above uint8", { proofType: 256 }],
    ["completed before started", { completedAt: 1_789_999_999 }],
    ["self receipt", { clientAgentId: "1937" }],
    ["unknown field", { service: "code-review" }],
  ])("rejects %s", (_label, patch) => {
    expect(receiptJsonSchema.safeParse({ ...json, ...patch }).success).toBe(false);
  });
});

describe("signatures", () => {
  it("recovers the signer and binds the signature to the domain", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const receipt = parseReceipt(json);
    const sig = await signReceipt(account, receipt, domain);
    expect(await recoverReceiptSigner(receipt, domain, sig)).toBe(account.address);

    const otherChain = receiptDomain(143, domain.verifyingContract);
    expect(await recoverReceiptSigner(receipt, otherChain, sig)).not.toBe(account.address);
    const tampered = { ...receipt, resultHash: h("d") as `0x${string}` };
    expect(await recoverReceiptSigner(tampered, domain, sig)).not.toBe(account.address);
  });

  it("validates signature encoding and size", () => {
    expect(signatureSchema.safeParse(`0x${"ab".repeat(65)}`).success).toBe(true);
    expect(signatureSchema.parse("0xABCD")).toBe("0xabcd");
    expect(signatureSchema.safeParse("0x").success).toBe(false);
    expect(signatureSchema.safeParse("0xabc").success).toBe(false);
    expect(signatureSchema.safeParse(`0x${"ab".repeat(8193)}`).success).toBe(false);
  });
});

describe("helpers", () => {
  it("names claimed proof types", () => {
    expect(proofTypeName(0)).toBe("none");
    expect(proofTypeName(1)).toBe("zk");
    expect(proofTypeName(3)).toBe("validator");
    expect(proofTypeName(9)).toBe("unknown");
  });

  it("creates random 32-byte task ids", () => {
    const id = newTaskId();
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(newTaskId()).not.toBe(id);
  });
});
