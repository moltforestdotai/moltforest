/**
 * Publish a demo (or JSON) epoch to the testnet ScoreRegistry.
 *
 * Env (.env in repo root):
 *   DEPLOYER_PRIVATE_KEY          — pays gas for publishEpoch
 *   VERIFIER_1_PRIVATE_KEY        — at least two of three required
 *   VERIFIER_2_PRIVATE_KEY
 *   VERIFIER_3_PRIVATE_KEY
 *   MONAD_RPC_URL_TESTNET         — optional
 *   SCORE_REGISTRY                — optional override
 *   EPOCH_ID                      — optional (default: latest+1 or 1)
 *
 * Usage:
 *   pnpm --filter @moltforest/scores publish-epoch
 *   pnpm --filter @moltforest/scores publish-epoch -- --scores ./scores.json
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineChain, type Hex, isAddress, isHex } from "viem";
import { NETWORKS } from "@moltforest/chain";
import { computeScore } from "../compute.js";
import { buildEpoch, cosignEpoch, publishEpochOnChain, proofFor, verifyScoreOnChain } from "../publish.js";
import type { AgentScore, ScoreInputs } from "../types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");

function loadEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function needKey(name: string): Hex {
  let v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in env`);
  if (!v.startsWith("0x") && !v.startsWith("0X")) v = `0x${v}`;
  if (!isHex(v) || v.length !== 66) throw new Error(`${name} must be a 32-byte hex private key`);
  return v as Hex;
}

function optionalKey(name: string): Hex | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  return needKey(name);
}

function demoScores(): AgentScore[] {
  const inputs: ScoreInputs[] = [
    { agentId: "7", verifiedReviews: 3, countedReviewers: 2, totalPaidVolume: 30_000 },
    { agentId: "42", verifiedReviews: 1, countedReviewers: 1, totalPaidVolume: 10_000 },
    { agentId: "100", verifiedReviews: 0, countedReviewers: 0 },
  ];
  return inputs.map(computeScore);
}

function loadScoresJson(path: string): AgentScore[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as ScoreInputs[];
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("scores JSON must be a non-empty array");
  return raw.map(computeScore);
}

async function main() {
  loadEnv(resolve(root, ".env"));

  const net = NETWORKS.testnet;
  const rpc = process.env.MONAD_RPC_URL_TESTNET ?? net.defaultRpcUrl;
  const registry = (process.env.SCORE_REGISTRY ?? net.scoreRegistry?.address) as `0x${string}` | undefined;
  if (!registry || !isAddress(registry)) throw new Error("SCORE_REGISTRY / testnet.scoreRegistry missing");

  const scoresArg = process.argv.includes("--scores")
    ? process.argv[process.argv.indexOf("--scores") + 1]
    : undefined;
  const scores = scoresArg ? loadScoresJson(resolve(scoresArg)) : demoScores();

  const publisher = needKey("DEPLOYER_PRIVATE_KEY");
  const verifierKeys = [optionalKey("VERIFIER_1_PRIVATE_KEY"), optionalKey("VERIFIER_2_PRIVATE_KEY"), optionalKey("VERIFIER_3_PRIVATE_KEY")].filter(
    (k): k is Hex => !!k,
  );
  if (verifierKeys.length < 2) {
    throw new Error(
      "Need at least two of VERIFIER_1_PRIVATE_KEY, VERIFIER_2_PRIVATE_KEY, VERIFIER_3_PRIVATE_KEY matching the on-chain verifier set",
    );
  }

  const epochId = BigInt(process.env.EPOCH_ID ?? "1");
  const epoch = buildEpoch(epochId, scores);
  console.log("epochId", epoch.epochId.toString());
  console.log("scoresRoot", epoch.scoresRoot);
  console.log("inputsRoot", epoch.inputsRoot);
  console.log("algoHash", epoch.algoHash);
  console.log(
    "scores",
    scores.map((s) => ({
      agentId: s.agentId.toString(),
      scoreBps: s.scoreBps,
      confidenceBps: s.confidenceBps,
      paidReviews: s.paidReviews,
      clusters: s.independentClusters,
    })),
  );

  const { signers, signatures } = await cosignEpoch(verifierKeys, net.chainId, registry, epoch);
  console.log("signers", signers);

  const monadTestnet = defineChain({
    id: net.chainId,
    name: net.label,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });

  const tx = await publishEpochOnChain({
    rpcUrl: rpc,
    chain: monadTestnet,
    publisherKey: publisher,
    scoreRegistry: registry,
    epoch,
    signatures,
  });
  console.log("publishEpoch tx", tx);

  const sample = scores[0]!;
  const proof = proofFor(epoch, sample);
  const ok = await verifyScoreOnChain({
    rpcUrl: rpc,
    scoreRegistry: registry,
    epochId,
    score: sample,
    proof,
  });
  console.log(`verifyScore agent ${sample.agentId}:`, ok);
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
