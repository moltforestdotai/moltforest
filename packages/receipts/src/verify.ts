/**
 * Off-chain signature checks with exactly the rules ReceiptRegistry applies
 * (OpenZeppelin 5.4 SignatureChecker), so the API never accepts, and the
 * relayer never pays gas for, a receipt the contract would reject:
 *   - the signer is the agent wallet, or the agent owner when no wallet is set;
 *   - a signer without code must give a 65-byte ECDSA signature with low s and v 27/28;
 *   - a signer with code (smart account, EIP-7702) is asked via ERC-1271.
 * viem's own verifyTypedData is deliberately not used: it also accepts 64-byte
 * and ERC-6492 signatures that the contract rejects.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  RawContractError,
  encodeFunctionData,
  hexToBigInt,
  hexToNumber,
  isAddressEqual,
  padHex,
  recoverAddress,
  size,
  slice,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { ERC1271_MAGIC_VALUE, erc1271Abi, identityRegistrySignerAbi } from "@moltforest/chain";

const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const ERC1271_MAGIC_WORD = padHex(ERC1271_MAGIC_VALUE, { dir: "right", size: 32 });

export type SignatureReader = Pick<PublicClient, "readContract" | "getCode" | "call">;

export type AgentSignatureResult =
  | { ok: true; signer: Address }
  | { ok: false; reason: "unknown_agent" }
  | { ok: false; reason: "invalid_signature"; signer: Address };

/** True when a viem error is an EVM revert rather than a transport or RPC failure. */
export function isRevert(err: unknown): boolean {
  return (
    err instanceof BaseError &&
    Boolean(
      err.walk(
        (e) => e instanceof ContractFunctionRevertedError || e instanceof ExecutionRevertedError || e instanceof RawContractError,
      ),
    )
  );
}

/** OpenZeppelin ECDSA.tryRecover(bytes32, bytes): null wherever it returns an error. */
export async function recoverStrict(digest: Hex, signature: Hex): Promise<Address | null> {
  if (size(signature) !== 65) return null;
  const s = hexToBigInt(slice(signature, 32, 64));
  const v = hexToNumber(slice(signature, 64, 65));
  if (s > SECP256K1_HALF_N || (v !== 27 && v !== 28)) return null;
  try {
    const recovered = await recoverAddress({ hash: digest, signature });
    return isAddressEqual(recovered, zeroAddress) ? null : recovered;
  } catch {
    return null;
  }
}

export function createAgentSignatureVerifier(client: SignatureReader, identityRegistry: Address) {
  /** ReceiptRegistry.signerOf: the agent wallet, else the owner; null for an unknown agent. */
  async function signerOf(agentId: bigint): Promise<Address | null> {
    const wallet = await client.readContract({
      address: identityRegistry,
      abi: identityRegistrySignerAbi,
      functionName: "getAgentWallet",
      args: [agentId],
    });
    if (!isAddressEqual(wallet, zeroAddress)) return wallet;
    try {
      return await client.readContract({ address: identityRegistry, abi: identityRegistrySignerAbi, functionName: "ownerOf", args: [agentId] });
    } catch (err) {
      if (isRevert(err)) return null;
      throw err;
    }
  }

  /** SignatureChecker.isValidSignatureNow. */
  async function isValidSignature(signer: Address, digest: Hex, signature: Hex): Promise<boolean> {
    const code = await client.getCode({ address: signer });
    if (!code || code === "0x") {
      const recovered = await recoverStrict(digest, signature);
      return recovered !== null && isAddressEqual(recovered, signer);
    }
    try {
      const { data } = await client.call({
        to: signer,
        data: encodeFunctionData({ abi: erc1271Abi, functionName: "isValidSignature", args: [digest, signature] }),
      });
      return data !== undefined && size(data) >= 32 && slice(data, 0, 32).toLowerCase() === ERC1271_MAGIC_WORD;
    } catch (err) {
      if (isRevert(err)) return false;
      throw err;
    }
  }

  return {
    signerOf,
    isValidSignature,
    /** Checks that `signature` over `digest` is valid for `agentId` right now. RPC failures throw. */
    async verify(agentId: bigint, digest: Hex, signature: Hex): Promise<AgentSignatureResult> {
      const signer = await signerOf(agentId);
      if (!signer) return { ok: false, reason: "unknown_agent" };
      return (await isValidSignature(signer, digest, signature)) ? { ok: true, signer } : { ok: false, reason: "invalid_signature", signer };
    },
  };
}

export type AgentSignatureVerifier = ReturnType<typeof createAgentSignatureVerifier>;
