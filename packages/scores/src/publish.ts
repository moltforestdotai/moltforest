import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type Transport,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { scoreRegistryAbi } from "./abi.js";
import { algoHash, buildInputsRoot, buildScoresTree, getProof } from "./merkle.js";
import { selectThresholdSignatures, signEpoch, type EpochMessage } from "./eip712.js";
import type { AgentScore } from "./types.js";

export interface BuiltEpoch {
  epochId: bigint;
  inputsRoot: Hex;
  scoresRoot: Hex;
  algoHash: Hex;
  scores: AgentScore[];
  tree: ReturnType<typeof buildScoresTree>;
}

export function buildEpoch(epochId: bigint, scores: readonly AgentScore[]): BuiltEpoch {
  const tree = buildScoresTree(scores);
  return {
    epochId,
    inputsRoot: buildInputsRoot(scores),
    scoresRoot: tree.root as Hex,
    algoHash: algoHash(),
    scores: [...scores],
    tree,
  };
}

export function proofFor(epoch: BuiltEpoch, score: AgentScore): Hex[] {
  return getProof(epoch.tree, score);
}

export async function cosignEpoch(
  verifierPrivateKeys: readonly Hex[],
  chainId: number,
  scoreRegistry: Address,
  epoch: BuiltEpoch,
): Promise<{ signers: Address[]; signatures: Hex[] }> {
  const message: EpochMessage = {
    epochId: epoch.epochId,
    inputsRoot: epoch.inputsRoot,
    scoresRoot: epoch.scoresRoot,
    algoHash: epoch.algoHash,
  };
  const signed = [];
  for (const key of verifierPrivateKeys) {
    const account = privateKeyToAccount(key);
    signed.push(await signEpoch(account, chainId, scoreRegistry, message));
  }
  return selectThresholdSignatures(signed, 2);
}

export async function publishEpochOnChain(opts: {
  rpcUrl: string;
  chain: Chain;
  publisherKey: Hex;
  scoreRegistry: Address;
  epoch: BuiltEpoch;
  signatures: Hex[];
}): Promise<Hex> {
  const account = privateKeyToAccount(opts.publisherKey);
  const wallet = createWalletClient({
    account,
    chain: opts.chain,
    transport: http(opts.rpcUrl),
  }) as WalletClient<Transport, Chain, Account>;

  const hash = await wallet.writeContract({
    address: opts.scoreRegistry,
    abi: scoreRegistryAbi,
    functionName: "publishEpoch",
    args: [
      opts.epoch.epochId,
      opts.epoch.inputsRoot,
      opts.epoch.scoresRoot,
      opts.epoch.algoHash,
      [opts.signatures[0]!, opts.signatures[1]!],
    ],
    chain: opts.chain,
    account,
  });
  return hash;
}

export async function verifyScoreOnChain(opts: {
  rpcUrl: string;
  scoreRegistry: Address;
  epochId: bigint;
  score: AgentScore;
  proof: Hex[];
}): Promise<boolean> {
  const client = createPublicClient({ transport: http(opts.rpcUrl) });
  return client.readContract({
    address: opts.scoreRegistry,
    abi: scoreRegistryAbi,
    functionName: "verifyScore",
    args: [
      opts.epochId,
      {
        agentId: opts.score.agentId,
        scoreBps: opts.score.scoreBps,
        confidenceBps: opts.score.confidenceBps,
        paidReviews: opts.score.paidReviews,
        independentClusters: opts.score.independentClusters,
        totalPaidVolume: opts.score.totalPaidVolume,
      },
      opts.proof,
    ],
  });
}
