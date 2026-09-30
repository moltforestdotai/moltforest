import { parseAbi } from "viem";

/**
 * ABI of contracts/src/ReceiptRegistry.sol (decision D06). The full compiler
 * ABI is committed at apps/indexer/abis/ReceiptRegistry.json; a test checks
 * that every item here matches it.
 */
export const receiptRegistryAbi = parseAbi([
  "struct Receipt { bytes32 taskId; uint256 clientAgentId; uint256 providerAgentId; bytes32 requestHash; bytes32 resultHash; bytes32 paymentRef; uint64 startedAt; uint64 completedAt; uint8 proofType; bytes32 proofRef; }",
  "function anchor(Receipt r, bytes providerSig, bytes clientSig) returns (bytes32 receiptHash, uint8 level)",
  "function hashReceipt(Receipt r) view returns (bytes32)",
  "function signerOf(uint256 agentId) view returns (address)",
  "function levelOf(bytes32 receiptHash) view returns (uint8)",
  "function identityRegistry() view returns (address)",
  "event ReceiptAnchored(bytes32 indexed receiptHash, uint256 indexed providerAgentId, uint256 indexed clientAgentId, uint8 level, address providerSigner, address clientSigner)",
  "event ReceiptCoSigned(bytes32 indexed receiptHash, uint256 indexed clientAgentId, address clientSigner)",
  "error SelfReceipt()",
  "error InvalidTimestamps()",
  "error UnknownAgent(uint256 agentId)",
  "error InvalidProviderSignature()",
  "error InvalidClientSignature()",
  "error AlreadyAnchored(bytes32 receiptHash, uint8 level)",
]);

/** The ERC-8004 Identity Registry reads that decide who signs for an agent. */
export const identityRegistrySignerAbi = parseAbi([
  "function ownerOf(uint256 agentId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
]);

/** ERC-1271 smart-account signature check. */
export const erc1271Abi = parseAbi(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);
export const ERC1271_MAGIC_VALUE = "0x1626ba7e";
