import { keccak256, parseAbi, stringToBytes, type Address, type Hex } from "viem";

/** ERC-8004 Reputation Registry write call (matches the deployed v2 ABI). */
export const reputationRegistryWriteAbi = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)",
]);

export interface PaidFeedbackInput {
  chainId: number;
  identityRegistry: Address;
  agentId: bigint;
  clientAddress: Address;
  /** 0–100 quality rating, reported with tag1 "starred" as ERC-8004 suggests. */
  rating: number;
  /** The service the review is about: the purpose of the payment. */
  endpoint: string;
  payment: { from: Address; to: Address; txHash: Hex };
  /** A MoltForest execution receipt for the job, when there is one. */
  receipt?: { registry: Address; receiptHash: Hex };
  createdAt?: Date;
}

/**
 * An ERC-8004 feedback file that attaches the payment the review is about:
 * the standard `proofOfPayment` (x402) and, when available, the
 * `executionReceipt` (a field the spec's "other fields" allow). Returned with
 * its data: URI and the feedbackHash (keccak256 of the content).
 */
export function buildPaidFeedbackFile(input: PaidFeedbackInput): { file: Record<string, unknown>; uri: string; hash: Hex } {
  const caip = (address: string) => `eip155:${input.chainId}:${address}`;
  const file: Record<string, unknown> = {
    agentRegistry: caip(input.identityRegistry),
    agentId: Number(input.agentId),
    clientAddress: caip(input.clientAddress),
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    value: input.rating,
    valueDecimals: 0,
    tag1: "starred",
    endpoint: input.endpoint,
    proofOfPayment: { fromAddress: input.payment.from, toAddress: input.payment.to, chainId: String(input.chainId), txHash: input.payment.txHash },
    ...(input.receipt ? { executionReceipt: { registry: caip(input.receipt.registry), receiptHash: input.receipt.receiptHash } } : {}),
  };
  const content = JSON.stringify(file);
  return {
    file,
    uri: `data:application/json;base64,${Buffer.from(content, "utf8").toString("base64")}`,
    hash: keccak256(stringToBytes(content)),
  };
}
