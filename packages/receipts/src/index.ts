/**
 * Execution receipts (decision D06): EIP-712 typed data signed by the provider
 * agent (level 1) and co-signed by the client agent (level 2), anchored by our
 * ReceiptRegistry contract. Shared by the API, the relayer, demo agents and tests.
 *
 * A receipt is evidence that a job happened, not a proof of what happened
 * (constraint C4): `proofType` / `proofRef` are claims and never raise the level.
 *
 * The field order and types must match contracts/src/ReceiptRegistry.sol;
 * test/vector.test.ts pins a digest and a signature the contract tests check too.
 */
import { hashTypedData, recoverTypedDataAddress, type Address, type Hex, type LocalAccount, type TypedDataDomain } from "viem";
import { z } from "zod";

export const RECEIPT_DOMAIN_NAME = "MoltForestReceipts";
export const RECEIPT_DOMAIN_VERSION = "1";

export const RECEIPT_TYPES = {
  Receipt: [
    { name: "taskId", type: "bytes32" },
    { name: "clientAgentId", type: "uint256" },
    { name: "providerAgentId", type: "uint256" },
    { name: "requestHash", type: "bytes32" },
    { name: "resultHash", type: "bytes32" },
    { name: "paymentRef", type: "bytes32" },
    { name: "startedAt", type: "uint64" },
    { name: "completedAt", type: "uint64" },
    { name: "proofType", type: "uint8" },
    { name: "proofRef", type: "bytes32" },
  ],
} as const;

/** 1 = provider signed, 2 = client co-signed. Levels 3–5 are reserved (validation, ZK, TEE). */
export type ReceiptLevel = 1 | 2;
export const LEVEL_PROVIDER_SIGNED = 1;
export const LEVEL_CLIENT_COSIGNED = 2;

/** Claimed proof types by `proofType` value. Recorded, never verified or scored here. */
export const PROOF_TYPES = ["none", "zk", "tee", "validator"] as const;
export type ProofTypeName = (typeof PROOF_TYPES)[number] | "unknown";

export function proofTypeName(value: number): ProofTypeName {
  return PROOF_TYPES[value] ?? "unknown";
}

export const ZERO_BYTES32: Hex = `0x${"0".repeat(64)}`;

export interface Receipt {
  taskId: Hex;
  clientAgentId: bigint;
  providerAgentId: bigint;
  /** Commitment to the request / input. */
  requestHash: Hex;
  /** Commitment to the output. */
  resultHash: Hex;
  /** x402 settlement tx hash, or zero. */
  paymentRef: Hex;
  /** Unix seconds. */
  startedAt: bigint;
  /** Unix seconds. */
  completedAt: bigint;
  proofType: number;
  proofRef: Hex;
}

/** Wire format: agent ids as decimal strings, timestamps as unix seconds, bytes32 as 0x-hex. */
export interface ReceiptJson {
  taskId: string;
  clientAgentId: string;
  providerAgentId: string;
  requestHash: string;
  resultHash: string;
  paymentRef: string;
  startedAt: number;
  completedAt: number;
  proofType: number;
  proofRef: string;
}

const MAX_UINT256 = 2n ** 256n - 1n;
const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x followed by 64 hex characters")
  .transform((s) => s.toLowerCase() as Hex);
const agentId = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/, "must be a decimal agent id")
  .transform((s) => BigInt(s))
  .refine((v) => v <= MAX_UINT256, "exceeds uint256");
const unixSeconds = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const receiptJsonSchema = z
  .object({
    taskId: bytes32,
    clientAgentId: agentId,
    providerAgentId: agentId,
    requestHash: bytes32,
    resultHash: bytes32,
    paymentRef: bytes32,
    startedAt: unixSeconds,
    completedAt: unixSeconds,
    proofType: z.number().int().min(0).max(255),
    proofRef: bytes32,
  })
  .strict()
  .refine((r) => r.startedAt <= r.completedAt, { message: "startedAt must not be after completedAt", path: ["completedAt"] })
  .refine((r) => r.clientAgentId !== r.providerAgentId, { message: "client and provider must be different agents", path: ["clientAgentId"] })
  .transform(
    (r): Receipt => ({ ...r, startedAt: BigInt(r.startedAt), completedAt: BigInt(r.completedAt) }),
  );

/** 65-byte ECDSA signatures, or longer ERC-1271 smart-account signatures (capped at 8 KiB). */
export const MAX_SIGNATURE_BYTES = 8192;
export const signatureSchema = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})+$/, "must be 0x-prefixed hex bytes")
  .max(2 + MAX_SIGNATURE_BYTES * 2, `must be at most ${MAX_SIGNATURE_BYTES} bytes`)
  .transform((s) => s.toLowerCase() as Hex);

export function parseReceipt(json: unknown): Receipt {
  return receiptJsonSchema.parse(json);
}

export function receiptToJson(r: Receipt): ReceiptJson {
  return {
    taskId: r.taskId,
    clientAgentId: r.clientAgentId.toString(),
    providerAgentId: r.providerAgentId.toString(),
    requestHash: r.requestHash,
    resultHash: r.resultHash,
    paymentRef: r.paymentRef,
    startedAt: Number(r.startedAt),
    completedAt: Number(r.completedAt),
    proofType: r.proofType,
    proofRef: r.proofRef,
  };
}

export interface ReceiptDomain extends TypedDataDomain {
  name: typeof RECEIPT_DOMAIN_NAME;
  version: typeof RECEIPT_DOMAIN_VERSION;
  chainId: number;
  verifyingContract: Address;
}

export function receiptDomain(chainId: number, verifyingContract: Address): ReceiptDomain {
  return { name: RECEIPT_DOMAIN_NAME, version: RECEIPT_DOMAIN_VERSION, chainId, verifyingContract };
}

export function receiptTypedData(receipt: Receipt, domain: ReceiptDomain) {
  return { domain, types: RECEIPT_TYPES, primaryType: "Receipt" as const, message: receipt };
}

/** The EIP-712 digest both agents sign. It is also the receipt's id (`receiptHash`). */
export function hashReceipt(receipt: Receipt, domain: ReceiptDomain): Hex {
  return hashTypedData(receiptTypedData(receipt, domain));
}

export type ReceiptSigner = Pick<LocalAccount, "signTypedData">;

export function signReceipt(signer: ReceiptSigner, receipt: Receipt, domain: ReceiptDomain): Promise<Hex> {
  return signer.signTypedData(receiptTypedData(receipt, domain));
}

/**
 * Recovers the EOA that produced `signature`. Smart-account (ERC-1271) signatures
 * need an on-chain check instead: viem's `publicClient.verifyTypedData`.
 */
export function recoverReceiptSigner(receipt: Receipt, domain: ReceiptDomain, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({ ...receiptTypedData(receipt, domain), signature });
}

/** A fresh random task id. */
export function newTaskId(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

export * from "./verify.js";
export * from "./commitments.js";
