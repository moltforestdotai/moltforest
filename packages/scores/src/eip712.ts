import {
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type WalletClient,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
} from "viem";

export const SCORE_EIP712_NAME = "MoltForestScores";
export const SCORE_EIP712_VERSION = "1";

export const EPOCH_TYPES = {
  Epoch: [
    { name: "epochId", type: "uint64" },
    { name: "inputsRoot", type: "bytes32" },
    { name: "scoresRoot", type: "bytes32" },
    { name: "algoHash", type: "bytes32" },
  ],
} as const;

export function scoreDomain(chainId: number, verifyingContract: Address) {
  return {
    name: SCORE_EIP712_NAME,
    version: SCORE_EIP712_VERSION,
    chainId,
    verifyingContract,
  } as const;
}

export interface EpochMessage {
  epochId: bigint;
  inputsRoot: Hex;
  scoresRoot: Hex;
  algoHash: Hex;
}

/** Sign an epoch digest with a viem LocalAccount / PrivateKeyAccount. */
export async function signEpoch(
  account: PrivateKeyAccount,
  chainId: number,
  verifyingContract: Address,
  message: EpochMessage,
): Promise<{ signer: Address; signature: Hex }> {
  const signature = await account.signTypedData({
    domain: scoreDomain(chainId, verifyingContract),
    types: EPOCH_TYPES,
    primaryType: "Epoch",
    message: {
      epochId: message.epochId,
      inputsRoot: message.inputsRoot,
      scoresRoot: message.scoresRoot,
      algoHash: message.algoHash,
    },
  });
  return { signer: account.address, signature };
}

/**
 * Pick any 2 of the provided signatures, sort by signer address ascending
 * (ScoreRegistry requires strictly ascending distinct verifiers).
 */
export function selectThresholdSignatures(
  signed: readonly { signer: Address; signature: Hex }[],
  threshold = 2,
): { signers: Address[]; signatures: Hex[] } {
  const unique = new Map<string, { signer: Address; signature: Hex }>();
  for (const s of signed) unique.set(s.signer.toLowerCase(), s);
  const sorted = [...unique.values()].sort((a, b) =>
    a.signer.toLowerCase() < b.signer.toLowerCase() ? -1 : a.signer.toLowerCase() > b.signer.toLowerCase() ? 1 : 0,
  );
  if (sorted.length < threshold) {
    throw new Error(`need ${threshold} verifier signatures, got ${sorted.length}`);
  }
  const picked = sorted.slice(0, threshold);
  return {
    signers: picked.map((p) => p.signer),
    signatures: picked.map((p) => p.signature),
  };
}

/** Double-hash leaf matching ScoreRegistry.hashScoreLeaf / OZ StandardMerkleTree. */
export function hashScoreLeafManual(score: {
  agentId: bigint;
  scoreBps: number;
  confidenceBps: number;
  paidReviews: number;
  independentClusters: number;
  totalPaidVolume: bigint;
}): Hex {
  const inner = keccak256(
    encodeAbiParameters(parseAbiParameters("uint256, uint16, uint16, uint32, uint32, uint256"), [
      score.agentId,
      score.scoreBps,
      score.confidenceBps,
      score.paidReviews,
      score.independentClusters,
      score.totalPaidVolume,
    ]),
  );
  // bytes.concat(inner) ≡ hash the 32 raw bytes again (OZ StandardMerkleTree).
  return keccak256(inner);
}

export async function signEpochWithWallet(
  wallet: WalletClient,
  account: Address,
  chainId: number,
  verifyingContract: Address,
  message: EpochMessage,
): Promise<Hex> {
  return wallet.signTypedData({
    account,
    domain: scoreDomain(chainId, verifyingContract),
    types: EPOCH_TYPES,
    primaryType: "Epoch",
    message: {
      epochId: message.epochId,
      inputsRoot: message.inputsRoot,
      scoresRoot: message.scoresRoot,
      algoHash: message.algoHash,
    },
  });
}
