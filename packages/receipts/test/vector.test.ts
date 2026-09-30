import { describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashReceipt, receiptDomain, recoverReceiptSigner, signReceipt, ZERO_BYTES32, type Receipt } from "../src/index.js";

/**
 * Cross-language vector. contracts/test/ReceiptVector.t.sol deploys the real
 * contract at VERIFYING_CONTRACT on chain 10143 and checks the same digest and
 * signature, so TypeScript and Solidity cannot drift apart silently.
 */
const VERIFYING_CONTRACT = "0x1111111111111111111111111111111111111111";
const DIGEST = "0x94572fc1551f980d79934a1f789411f5d3cde61f606a925b656d94a87a92c6bc";
const SIGNATURE =
  "0xb32adb7a65c2d38dffdc3156b245c44e8e12698a8ffa18688d97c1257db8f08d05a307c4b10bd1893704cc9311649fe5a5549f2b68662fd35fb2d853a39610fa1c";
// Anvil's first well-known test key; never funded anywhere real.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const receipt: Receipt = {
  taskId: keccak256(toBytes("task-1")),
  clientAgentId: 0n,
  providerAgentId: 7n,
  requestHash: keccak256(toBytes("request")),
  resultHash: keccak256(toBytes("result")),
  paymentRef: ZERO_BYTES32,
  startedAt: 1_790_000_000n,
  completedAt: 1_790_000_042n,
  proofType: 0,
  proofRef: ZERO_BYTES32,
};
const domain = receiptDomain(10143, VERIFYING_CONTRACT);

describe("cross-language vector", () => {
  it("hashes to the digest the contract computes", () => {
    expect(hashReceipt(receipt, domain)).toBe(DIGEST);
  });

  it("signs deterministically to the signature the contract accepts", async () => {
    const account = privateKeyToAccount(TEST_KEY);
    expect(await signReceipt(account, receipt, domain)).toBe(SIGNATURE);
    expect(await recoverReceiptSigner(receipt, domain, SIGNATURE)).toBe(account.address);
  });
});
