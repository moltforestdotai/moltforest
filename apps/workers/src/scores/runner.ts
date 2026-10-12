import type { Logger } from "pino";
import type { Address, Hex } from "viem";
import { createPublicClient, http, defineChain, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  prepareAndStageEpoch,
  nextEpochId,
  latestPublishedScoresRoot,
  updateEpochPublishTx,
  publishEpochOnChain,
  loadScoresFromDb,
  buildEpoch,
  type SqlQueryable,
} from "@moltforest/scores";
import type { NetworkConfig, NetworkName } from "@moltforest/chain";
import { runCreSimulateBroadcast } from "./creBroadcast.js";

export interface EpochPipelineOpts {
  network: NetworkName;
  net: NetworkConfig;
  db: SqlQueryable;
  appSchema: string;
  indexerSchema: string;
  verifierKeys: Hex[];
  allAgents: boolean;
  creBroadcast: boolean;
  creDir: string;
  creTarget: string;
  /** If CRE broadcast fails or is off, publish with 2-of-3 via ScoreRegistry (break-glass). */
  fallbackPublish: boolean;
  publisherKey?: Hex;
  rpcUrl: string;
  logger: Logger;
}

export interface EpochPipelineStats {
  prepared: boolean;
  published: boolean;
  skipped: boolean;
  reason: string;
  epochId: string | null;
  agentCount: number;
  scoresRoot: string | null;
  publishTx: string | null;
  courier: "cre-simulate" | "break-glass" | "none";
}

function monadChain(net: NetworkConfig) {
  return defineChain({
    id: net.chainId,
    name: net.label,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [net.defaultRpcUrl] } },
  });
}

async function onChainEpochExists(rpcUrl: string, registry: Address, epochId: bigint): Promise<boolean> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  try {
    await client.readContract({
      address: registry,
      abi: [
        {
          type: "function",
          name: "getEpoch",
          stateMutability: "view",
          inputs: [{ name: "epochId", type: "uint64" }],
          outputs: [
            {
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
      ] as const,
      functionName: "getEpoch",
      args: [epochId],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Cosign all (or signal) agents → stage pending → CRE simulate --broadcast (or break-glass).
 * Skips when scoresRoot matches the latest published epoch (no epoch id burned).
 */
export async function runEpochPipelineTick(opts: EpochPipelineOpts): Promise<EpochPipelineStats> {
  const log = opts.logger;
  const registry = opts.net.scoreRegistry?.address;
  if (!registry) {
    return emptySkip("no_score_registry");
  }
  if (opts.verifierKeys.length < 2) {
    return emptySkip("need_two_verifier_keys");
  }

  const scores = await loadScoresFromDb({
    db: opts.db,
    chainId: opts.net.chainId,
    schema: opts.appSchema,
    indexerSchema: opts.indexerSchema,
    allAgents: opts.allAgents,
  });

  const probe = buildEpoch(1n, scores);
  const lastRoot = await latestPublishedScoresRoot({
    db: opts.db,
    chainId: opts.net.chainId,
    schema: opts.appSchema,
  });
  if (lastRoot && lastRoot.toLowerCase() === probe.scoresRoot.toLowerCase()) {
    log.info({ scoresRoot: probe.scoresRoot, agents: scores.length }, "scores unchanged; skip");
    return {
      prepared: false,
      published: false,
      skipped: true,
      reason: "scores_unchanged",
      epochId: null,
      agentCount: scores.length,
      scoresRoot: probe.scoresRoot,
      publishTx: null,
      courier: "none",
    };
  }

  let epochId = await nextEpochId({ db: opts.db, chainId: opts.net.chainId, schema: opts.appSchema });
  while (await onChainEpochExists(opts.rpcUrl, registry, epochId)) {
    log.warn({ epochId: String(epochId) }, "epoch id already on-chain; trying next");
    epochId += 1n;
  }

  const prepared = await prepareAndStageEpoch({
    db: opts.db,
    network: opts.network,
    chainId: opts.net.chainId,
    scoreRegistry: registry,
    epochId,
    verifierPrivateKeys: opts.verifierKeys,
    schema: opts.appSchema,
    indexerSchema: opts.indexerSchema,
    scores,
  });

  let publishTx: Hex | null = null;
  let courier: EpochPipelineStats["courier"] = "none";

  if (opts.creBroadcast) {
    log.info({ creDir: opts.creDir, target: opts.creTarget }, "CRE simulate --broadcast");
    const cre = await runCreSimulateBroadcast({ creDir: opts.creDir, target: opts.creTarget });
    if (cre.ok && cre.txHash) {
      publishTx = cre.txHash;
      courier = "cre-simulate";
    } else if (cre.skipped) {
      return {
        prepared: true,
        published: false,
        skipped: true,
        reason: "cre_skipped_already_published",
        epochId: prepared.pending.epochId,
        agentCount: prepared.agentCount,
        scoresRoot: prepared.epoch.scoresRoot,
        publishTx: null,
        courier: "cre-simulate",
      };
    } else {
      log.warn({ err: cre.error, tail: cre.output.slice(-800) }, "CRE broadcast failed");
    }
  }

  if (!publishTx && opts.fallbackPublish && opts.publisherKey) {
    log.warn("using break-glass ScoreRegistry.publishEpoch");
    publishTx = await publishEpochOnChain({
      rpcUrl: opts.rpcUrl,
      chain: monadChain(opts.net),
      publisherKey: opts.publisherKey,
      scoreRegistry: registry,
      epoch: prepared.epoch,
      signatures: prepared.pending.signatures,
    });
    courier = "break-glass";
  }

  if (!publishTx) {
    return {
      prepared: true,
      published: false,
      skipped: false,
      reason: opts.creBroadcast ? "cre_failed_no_fallback" : "publish_disabled",
      epochId: prepared.pending.epochId,
      agentCount: prepared.agentCount,
      scoresRoot: prepared.epoch.scoresRoot,
      publishTx: null,
      courier,
    };
  }

  await updateEpochPublishTx({
    db: opts.db,
    schema: opts.appSchema,
    chainId: opts.net.chainId,
    epochId,
    publishTx,
  });

  log.info(
    { epochId: prepared.pending.epochId, publishTx, courier, agents: prepared.agentCount },
    "epoch published",
  );

  return {
    prepared: true,
    published: true,
    skipped: false,
    reason: "published",
    epochId: prepared.pending.epochId,
    agentCount: prepared.agentCount,
    scoresRoot: prepared.epoch.scoresRoot,
    publishTx,
    courier,
  };
}

function emptySkip(reason: string): EpochPipelineStats {
  return {
    prepared: false,
    published: false,
    skipped: true,
    reason,
    epochId: null,
    agentCount: 0,
    scoresRoot: null,
    publishTx: null,
    courier: "none",
  };
}

export function parseVerifierKeys(env: NodeJS.ProcessEnv): Hex[] {
  const keys: Hex[] = [];
  for (const name of ["VERIFIER_1_PRIVATE_KEY", "VERIFIER_2_PRIVATE_KEY", "VERIFIER_3_PRIVATE_KEY"] as const) {
    let v = env[name];
    if (!v) continue;
    if (!v.startsWith("0x") && !v.startsWith("0X")) v = `0x${v}`;
    if (isHex(v) && v.length === 66) keys.push(v);
  }
  return keys;
}

export function optionalPublisherKey(env: NodeJS.ProcessEnv): Hex | undefined {
  let v = env.DEPLOYER_PRIVATE_KEY ?? env.CRE_ETH_PRIVATE_KEY;
  if (!v) return undefined;
  if (!v.startsWith("0x") && !v.startsWith("0X")) v = `0x${v}`;
  if (!isHex(v) || v.length !== 66) return undefined;
  privateKeyToAccount(v);
  return v;
}
