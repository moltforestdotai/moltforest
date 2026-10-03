import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { receiptRegistryAbi } from "@moltforest/chain";
import { hashReceipt, newTaskId, receiptDomain, signReceipt, ZERO_BYTES32, type Receipt } from "@moltforest/receipts";
import { decodeReceiptEvents, type HsLog } from "../src/receiptEvents/decode.js";

const CHAIN = 10143;
const REGISTRY: Address = "0x4d2a256fcaac8e52e4b91e977ef6ddd56e980f98";
const domain = receiptDomain(CHAIN, REGISTRY);
const provider = privateKeyToAccount(generatePrivateKey());
const client = privateKeyToAccount(generatePrivateKey());

const receipt = (): Receipt => ({
  taskId: newTaskId(),
  clientAgentId: 1988n,
  providerAgentId: 1987n,
  requestHash: `0x${"11".repeat(32)}`,
  resultHash: `0x${"22".repeat(32)}`,
  paymentRef: `0x${"33".repeat(32)}`,
  startedAt: 100n,
  completedAt: 101n,
  proofType: 0,
  proofRef: ZERO_BYTES32,
});

let n = 0;
function anchoredLog(tx: Hex, hash: Hex, r: Receipt, level: 1 | 2): HsLog {
  const topics = encodeEventTopics({
    abi: receiptRegistryAbi,
    eventName: "ReceiptAnchored",
    args: { receiptHash: hash, providerAgentId: r.providerAgentId, clientAgentId: r.clientAgentId },
  }) as Hex[];
  const data = encodeAbiParameters(
    [{ type: "uint8" }, { type: "address" }, { type: "address" }],
    [level, provider.address, level === 2 ? client.address : "0x0000000000000000000000000000000000000000"],
  );
  return { block_number: 500, log_index: n++, transaction_hash: tx, address: REGISTRY, topic0: topics[0], topic1: topics[1], topic2: topics[2], topic3: topics[3], data };
}

function coSignedLog(tx: Hex, hash: Hex, r: Receipt): HsLog {
  const topics = encodeEventTopics({ abi: receiptRegistryAbi, eventName: "ReceiptCoSigned", args: { receiptHash: hash, clientAgentId: r.clientAgentId } }) as Hex[];
  const data = encodeAbiParameters([{ type: "address" }], [client.address]);
  return { block_number: 501, log_index: n++, transaction_hash: tx, address: REGISTRY, topic0: topics[0], topic1: topics[1], topic2: topics[2], data };
}

const anchorInput = (r: Receipt, providerSig: Hex, clientSig: Hex) =>
  encodeFunctionData({ abi: receiptRegistryAbi, functionName: "anchor", args: [r, providerSig, clientSig] });

describe("decodeReceiptEvents", () => {
  it("decodes level-1 and level-2 anchors and a later co-signature from the anchor calldata", async () => {
    const one = receipt();
    const two = receipt();
    const [h1, h2] = [hashReceipt(one, domain), hashReceipt(two, domain)];
    const p1 = await signReceipt(provider, one, domain);
    const p2 = await signReceipt(provider, two, domain);
    const c1 = await signReceipt(client, one, domain);
    const c2 = await signReceipt(client, two, domain);
    const [txA, txB, txC] = [`0x${"a".repeat(64)}`, `0x${"b".repeat(64)}`, `0x${"c".repeat(64)}`] as [Hex, Hex, Hex];

    const out = decodeReceiptEvents(CHAIN, REGISTRY, [
      {
        logs: [anchoredLog(txA, h1, one, 1), anchoredLog(txB, h2, two, 2), coSignedLog(txC, h1, one)],
        transactions: [
          { hash: txA, input: anchorInput(one, p1, "0x") },
          { hash: txB, input: anchorInput(two, p2, c2) },
          { hash: txC, input: anchorInput(one, p1, c1) },
        ],
        blocks: [{ number: 500, timestamp: "0x6553f100" }],
      },
    ]);

    expect(out.undecodable).toEqual([]);
    expect(out.receipts.map((r) => [r.receiptHash, r.level, r.clientSignature !== null, r.providerSigner, r.clientSigner])).toEqual([
      [h1, 1, false, provider.address.toLowerCase(), null],
      [h2, 2, true, provider.address.toLowerCase(), client.address.toLowerCase()],
      [h1, 2, true, null, client.address.toLowerCase()],
    ]);
    expect(out.receipts[0]!.receipt).toMatchObject({ providerAgentId: "1987", clientAgentId: "1988", paymentRef: one.paymentRef });
    expect(out.receipts[0]!.blockTime).toEqual(new Date(0x6553f100 * 1000));
  });

  it("refuses calldata that does not hash to the logged receipt, or is not an anchor call", async () => {
    const r = receipt();
    const other = receipt();
    const sig = await signReceipt(provider, other, domain);
    const [txA, txB] = [`0x${"d".repeat(64)}`, `0x${"e".repeat(64)}`] as [Hex, Hex];
    const out = decodeReceiptEvents(CHAIN, REGISTRY, [
      {
        logs: [anchoredLog(txA, hashReceipt(r, domain), r, 1), anchoredLog(txB, hashReceipt(r, domain), r, 1)],
        transactions: [
          { hash: txA, input: anchorInput(other, sig, "0x") },
          { hash: txB, input: encodeFunctionData({ abi: receiptRegistryAbi, functionName: "levelOf", args: [ZERO_BYTES32] }) },
        ],
      },
    ]);
    expect(out.receipts).toEqual([]);
    expect(out.undecodable.map((u) => u.tx)).toEqual([txA, txB]);
  });
});
