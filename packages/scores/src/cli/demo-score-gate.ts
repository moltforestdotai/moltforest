/**
 * ERC-8183 + ScoreGateHook demo on Monad testnet.
 *
 * 1) createJob + fund for providerAgentId=7  → PASS (high score)
 * 2) createJob + fund for providerAgentId=100 → FAIL (score too low)
 * 3) createJob + fund for agent 7 with colluding clusters → FAIL
 *
 * Env: DEPLOYER_PRIVATE_KEY (client), VERIFIER_1_PRIVATE_KEY (provider),
 *      VERIFIER_2_PRIVATE_KEY (evaluator), MONAD_RPC_URL_TESTNET optional.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  isHex,
  parseAbiParameters,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORKS } from "@moltforest/chain";
import { computeScore } from "../compute.js";
import { buildEpoch, proofFor } from "../publish.js";
import type { AgentScore } from "../types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");

const erc8183Abi = [
  {
    type: "function",
    name: "createJob",
    stateMutability: "nonpayable",
    inputs: [
      { name: "provider", type: "address" },
      { name: "evaluator", type: "address" },
      { name: "expiredAt", type: "uint48" },
      { name: "description", type: "string" },
      { name: "hook", type: "address" },
      { name: "providerAgentId", type: "uint256" },
    ],
    outputs: [{ name: "jobId", type: "uint256" }],
  },
  {
    type: "function",
    name: "setBudget",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "optParams", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "fund",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "expectedToken", type: "address" },
      { name: "expectedBudget", type: "uint256" },
      { name: "optParams", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getJob",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "client", type: "address" },
          { name: "status", type: "uint8" },
          { name: "provider", type: "address" },
          { name: "expiredAt", type: "uint48" },
          { name: "evaluator", type: "address" },
          { name: "submittedAt", type: "uint48" },
          { name: "budget", type: "uint256" },
          { name: "hook", type: "address" },
          { name: "paymentToken", type: "address" },
          { name: "providerAgentId", type: "uint256" },
          { name: "description", type: "string" },
          { name: "settledAmount", type: "uint256" },
          { name: "payoutReceiver", type: "address" },
        ],
      },
    ],
  },
] as const;

const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

function loadEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let val = m[2]!;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = val;
  }
}

function needKey(name: string): Hex {
  let v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  if (!v.startsWith("0x") && !v.startsWith("0X")) v = `0x${v}`;
  if (!isHex(v) || v.length !== 66) throw new Error(`${name} must be a 32-byte hex key`);
  return v as Hex;
}

function demoScores(): AgentScore[] {
  return [
    computeScore({ agentId: "7", verifiedReviews: 3, countedReviewers: 2, totalPaidVolume: 30_000 }),
    computeScore({ agentId: "42", verifiedReviews: 1, countedReviewers: 1, totalPaidVolume: 10_000 }),
    computeScore({ agentId: "100", verifiedReviews: 0, countedReviewers: 0 }),
  ];
}

function encodeFundOptParams(
  epochId: bigint,
  score: AgentScore,
  proof: Hex[],
  clientCluster: Hex,
  providerCluster: Hex,
  evaluatorCluster: Hex,
): Hex {
  return encodeAbiParameters(
    parseAbiParameters(
      "uint64, (uint256 agentId, uint16 scoreBps, uint16 confidenceBps, uint32 paidReviews, uint32 independentClusters, uint256 totalPaidVolume), bytes32[], bytes32, bytes32, bytes32",
    ),
    [
      epochId,
      {
        agentId: score.agentId,
        scoreBps: score.scoreBps,
        confidenceBps: score.confidenceBps,
        paidReviews: score.paidReviews,
        independentClusters: score.independentClusters,
        totalPaidVolume: score.totalPaidVolume,
      },
      proof,
      clientCluster,
      providerCluster,
      evaluatorCluster,
    ],
  );
}

async function main() {
  loadEnv(resolve(root, ".env"));
  const net = NETWORKS.testnet;
  const rpc = process.env.MONAD_RPC_URL_TESTNET ?? net.defaultRpcUrl;
  const market = net.agenticCommerce!.address;
  const hook = net.scoreGateHook!.address;
  const usdc = net.usdc;
  const budget = 10_000n; // 0.01 USDC

  const clientAccount = privateKeyToAccount(needKey("DEPLOYER_PRIVATE_KEY"));
  const providerAccount = privateKeyToAccount(needKey("VERIFIER_1_PRIVATE_KEY"));
  const evaluatorAccount = privateKeyToAccount(needKey("VERIFIER_2_PRIVATE_KEY"));

  const chain = defineChain({
    id: net.chainId,
    name: net.label,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const clientWallet = createWalletClient({ account: clientAccount, chain, transport: http(rpc) });
  const providerWallet = createWalletClient({ account: providerAccount, chain, transport: http(rpc) });

  const epochId = 1n;
  const epoch = buildEpoch(epochId, demoScores());
  const byId = new Map(epoch.scores.map((s) => [s.agentId.toString(), s]));

  const distinct = {
    client: ("0x" + "11".repeat(32)) as Hex,
    provider: ("0x" + "22".repeat(32)) as Hex,
    evaluator: ("0x" + "33".repeat(32)) as Hex,
  };
  const same = ("0x" + "aa".repeat(32)) as Hex;

  async function createAndBudget(agentId: bigint, label: string): Promise<bigint> {
    const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
    console.log(`\n=== ${label}: createJob agentId=${agentId} ===`);
    const createHash = await clientWallet.writeContract({
      address: market,
      abi: erc8183Abi,
      functionName: "createJob",
      args: [providerAccount.address, evaluatorAccount.address, Number(expiredAt), `demo-${label}`, hook, agentId],
    });
    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
    console.log("createJob tx", createHash, "status", createReceipt.status);

    // jobId from jobCounter / logs — read latest by probing getJob after create.
    // Simpler: parse JobCreated from logs if present; else scan jobCounter.
    let jobId = 0n;
    for (const log of createReceipt.logs) {
      // JobCreated(uint256 indexed jobId, ...) — topic0 + jobId topic
      if (log.topics[1]) jobId = BigInt(log.topics[1]);
    }
    if (jobId === 0n) throw new Error("could not parse jobId from createJob logs");
    console.log("jobId", jobId.toString());

    const budgetHash = await providerWallet.writeContract({
      address: market,
      abi: erc8183Abi,
      functionName: "setBudget",
      args: [jobId, usdc, budget, "0x"],
    });
    const budgetReceipt = await publicClient.waitForTransactionReceipt({ hash: budgetHash });
    console.log("setBudget tx", budgetHash, "status", budgetReceipt.status);
    return jobId;
  }

  async function tryFund(
    jobId: bigint,
    score: AgentScore,
    clusters: { client: Hex; provider: Hex; evaluator: Hex },
    expect: "pass" | "fail",
  ) {
    const proof = proofFor(epoch, score);
    const opt = encodeFundOptParams(epochId, score, proof, clusters.client, clusters.provider, clusters.evaluator);

    if (expect === "pass") {
      const approveHash = await clientWallet.writeContract({
        address: usdc,
        abi: erc20Abi,
        functionName: "approve",
        args: [market, budget],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
      console.log("approve tx", approveHash);
    }

    console.log(`fund expect=${expect} scoreBps=${score.scoreBps} confidence=${score.confidenceBps}`);
    try {
      const fundHash = await clientWallet.writeContract({
        address: market,
        abi: erc8183Abi,
        functionName: "fund",
        args: [jobId, usdc, budget, opt],
      });
      const fundReceipt = await publicClient.waitForTransactionReceipt({ hash: fundHash });
      const job = await publicClient.readContract({
        address: market,
        abi: erc8183Abi,
        functionName: "getJob",
        args: [jobId],
      });
      console.log("fund tx", fundHash, "status", fundReceipt.status, "job.status", job.status);
      if (expect === "fail") {
        console.error("EXPECTED FAIL but fund succeeded");
        process.exitCode = 1;
      } else if (fundReceipt.status !== "success" || job.status !== 1) {
        // JobStatus.Funded = 1
        console.error("EXPECTED PASS but job not Funded");
        process.exitCode = 1;
      } else {
        console.log("PASS as expected");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const short = msg.split("\n").slice(0, 4).join(" | ");
      console.log("fund reverted:", short);
      if (expect === "pass") {
        console.error("EXPECTED PASS but fund reverted");
        process.exitCode = 1;
      } else {
        console.log("FAIL as expected");
      }
    }
  }

  // 1) Pass — agent 7
  {
    const score = byId.get("7")!;
    const jobId = await createAndBudget(7n, "PASS-agent-7");
    await tryFund(jobId, score, distinct, "pass");
  }

  // 2) Fail — agent 100 (zero score)
  {
    const score = byId.get("100")!;
    const jobId = await createAndBudget(100n, "FAIL-agent-100");
    await tryFund(jobId, score, distinct, "fail");
  }

  // 3) Fail — colluding clusters (good score, same client/evaluator cluster)
  {
    const score = byId.get("7")!;
    const jobId = await createAndBudget(7n, "FAIL-collusion");
    await tryFund(
      jobId,
      score,
      { client: same, provider: distinct.provider, evaluator: same },
      "fail",
    );
  }

  console.log("\nDemo complete.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
