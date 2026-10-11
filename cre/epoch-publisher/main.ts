/**
 * CRE workflow: fetch a cosigned pending epoch and publish via CreScorePublisher.
 *
 * Production behavior:
 * - HTTP-fetch pending epoch (optional Bearer auth)
 * - Read ScoreRegistry on-chain; skip if that epochId is already published (idempotent)
 * - writeReport → CreScorePublisher → publishEpoch
 *
 * Simulate (from moltforest/cre):
 *   cre workflow simulate epoch-publisher --target local-simulation
 *   cre workflow simulate epoch-publisher --target local-simulation --broadcast
 */
import {
  CronCapability,
  EVMClient,
  HTTPClient,
  LAST_FINALIZED_BLOCK_NUMBER,
  Runner,
  bytesToHex,
  consensusIdenticalAggregation,
  encodeCallMsg,
  getNetwork,
  handler,
  hexToBase64,
  type NodeRuntime,
  type Runtime,
} from "@chainlink/cre-sdk";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  isAddress,
  isHex,
  parseAbiParameters,
  zeroAddress,
  type Hex,
} from "viem";

type EvmConfig = {
  creScorePublisherAddress: string;
  scoreRegistryAddress: string;
  chainName: string;
  gasLimit: string;
};

/** Flat shape for CRE identical consensus (primitives only). */
type PendingFlat = {
  epochId: string;
  inputsRoot: string;
  scoresRoot: string;
  algoHash: string;
  signature0: string;
  signature1: string;
};

type Config = {
  schedule: string;
  pendingEpochUrl: string;
  /**
   * Optional API key for Authorization: Bearer … (staging). Prefer CRE secrets in production.
   * When empty, the pending endpoint must be open or auth disabled on the API.
   */
  pendingEpochApiKey?: string;
  /** Optional inline payload when the API is unreachable (offline simulate). */
  pendingEpoch?: {
    epochId: string;
    inputsRoot: string;
    scoresRoot: string;
    algoHash: string;
    signatures: [string, string];
  };
  evms: EvmConfig[];
};

type WorkflowResult = {
  epochId: string;
  scoresRoot: string;
  txHash: string;
  skipped: boolean;
  reason: string;
};

const REPORT_PARAMS =
  "uint64 epochId, bytes32 inputsRoot, bytes32 scoresRoot, bytes32 algoHash, bytes sig0, bytes sig1";

const SCORE_REGISTRY_ABI = [
  {
    type: "function",
    name: "getEpoch",
    stateMutability: "view",
    inputs: [{ name: "epochId", type: "uint64" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "inputsRoot", type: "bytes32" },
          { name: "scoresRoot", type: "bytes32" },
          { name: "algoHash", type: "bytes32" },
          { name: "publishedAt", type: "uint64" },
        ],
      },
    ],
  },
] as const;

const initWorkflow = (config: Config) => {
  const cron = new CronCapability();
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};

const onCronTrigger = (runtime: Runtime<Config>): WorkflowResult => {
  const evmConfig = runtime.config.evms[0];
  if (!evmConfig) throw new Error("config.evms[0] required");

  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: evmConfig.chainName,
  });
  if (!network) throw new Error(`Unknown chain: ${evmConfig.chainName}`);

  if (!isAddress(evmConfig.creScorePublisherAddress) || evmConfig.creScorePublisherAddress.startsWith("REPLACE")) {
    throw new Error("creScorePublisherAddress is not set — deploy CreScorePublisher and update config");
  }
  if (!isAddress(evmConfig.scoreRegistryAddress)) {
    throw new Error("scoreRegistryAddress is not set");
  }

  const pending = runtime
    .runInNodeMode(fetchPendingEpoch, consensusIdenticalAggregation<PendingFlat>())()
    .result();

  runtime.log(
    `Pending epoch ${pending.epochId} scoresRoot=${pending.scoresRoot} publisher=${evmConfig.creScorePublisherAddress}`,
  );

  const evmClient = new EVMClient(network.chainSelector.selector);

  if (epochAlreadyPublished(runtime, evmClient, evmConfig.scoreRegistryAddress, pending.epochId)) {
    runtime.log(`Epoch ${pending.epochId} already on-chain — skipping publish (idempotent)`);
    return {
      epochId: pending.epochId,
      scoresRoot: pending.scoresRoot,
      txHash: "0x",
      skipped: true,
      reason: "already_published",
    };
  }

  const reportData = encodeAbiParameters(parseAbiParameters(REPORT_PARAMS), [
    BigInt(pending.epochId),
    pending.inputsRoot as Hex,
    pending.scoresRoot as Hex,
    pending.algoHash as Hex,
    pending.signature0 as Hex,
    pending.signature1 as Hex,
  ]);

  const reportResponse = runtime
    .report({
      encodedPayload: hexToBase64(reportData),
      encoderName: "evm",
      signingAlgo: "ecdsa",
      hashingAlgo: "keccak256",
    })
    .result();

  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: evmConfig.creScorePublisherAddress,
      report: reportResponse,
      gasConfig: { gasLimit: evmConfig.gasLimit },
    })
    .result();

  const txHash = bytesToHex(writeResult.txHash || new Uint8Array(32));
  runtime.log(`CreScorePublisher write tx: ${txHash}`);

  return {
    epochId: pending.epochId,
    scoresRoot: pending.scoresRoot,
    txHash,
    skipped: false,
    reason: "published",
  };
};

/** True when ScoreRegistry.getEpoch(epochId) succeeds with publishedAt > 0. */
function epochAlreadyPublished(
  runtime: Runtime<Config>,
  evmClient: EVMClient,
  scoreRegistry: string,
  epochId: string,
): boolean {
  try {
    const callData = encodeFunctionData({
      abi: SCORE_REGISTRY_ABI,
      functionName: "getEpoch",
      args: [BigInt(epochId)],
    });
    const result = evmClient
      .callContract(runtime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: scoreRegistry as `0x${string}`,
          data: callData,
        }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result();

    const decoded = decodeFunctionResult({
      abi: SCORE_REGISTRY_ABI,
      functionName: "getEpoch",
      data: bytesToHex(result.data),
    }) as { publishedAt: bigint };

    return decoded.publishedAt > 0n;
  } catch {
    // getEpoch reverts when unpublished — treat as not published.
    return false;
  }
}

const fetchPendingEpoch = (nodeRuntime: NodeRuntime<Config>): PendingFlat => {
  const inline = nodeRuntime.config.pendingEpoch;
  const url = nodeRuntime.config.pendingEpochUrl?.trim();
  const apiKey = nodeRuntime.config.pendingEpochApiKey?.trim();

  if (url) {
    const http = new HTTPClient();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    try {
      const resp = http
        .sendRequest(nodeRuntime, {
          url,
          method: "GET" as const,
          headers,
        })
        .result();
      if (resp.statusCode >= 200 && resp.statusCode < 300) {
        const body = JSON.parse(new TextDecoder().decode(resp.body)) as {
          epochId: string;
          inputsRoot: string;
          scoresRoot: string;
          algoHash: string;
          signatures: [string, string];
        };
        return toFlat(body);
      }
      nodeRuntime.log(`pending-epoch HTTP ${resp.statusCode}; trying inline config`);
    } catch (err) {
      nodeRuntime.log(`pending-epoch fetch failed: ${String(err)}; trying inline config`);
    }
  }

  if (inline) return toFlat(inline);
  throw new Error("No pending epoch: set pendingEpochUrl (API up) or config.pendingEpoch");
};

function toFlat(p: {
  epochId: string;
  inputsRoot: string;
  scoresRoot: string;
  algoHash: string;
  signatures: [string, string];
}): PendingFlat {
  if (!/^\d+$/.test(p.epochId) || BigInt(p.epochId) < 1n) {
    throw new Error("invalid pending epochId");
  }
  if (!isHex(p.inputsRoot) || p.inputsRoot.length !== 66) throw new Error("invalid inputsRoot");
  if (!isHex(p.scoresRoot) || p.scoresRoot.length !== 66) throw new Error("invalid scoresRoot");
  if (!isHex(p.algoHash) || p.algoHash.length !== 66) throw new Error("invalid algoHash");
  if (!Array.isArray(p.signatures) || p.signatures.length < 2) throw new Error("need 2 signatures");
  if (!isHex(p.signatures[0]) || p.signatures[0].length !== 132) throw new Error("invalid signature0");
  if (!isHex(p.signatures[1]) || p.signatures[1].length !== 132) throw new Error("invalid signature1");
  return {
    epochId: p.epochId,
    inputsRoot: p.inputsRoot.toLowerCase(),
    scoresRoot: p.scoresRoot.toLowerCase(),
    algoHash: p.algoHash.toLowerCase(),
    signature0: p.signatures[0],
    signature1: p.signatures[1],
  };
}

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
