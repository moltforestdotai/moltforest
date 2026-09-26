import { Router } from "express";
import { z } from "zod";
import { DEFAULT_NETWORK, NETWORK_NAMES, NETWORKS } from "@moltforest/chain";
import type { NetworkInfo, SyncStatus } from "@moltforest/types";
import type { Db } from "../db.js";
import { isMissingRelation, type SyncRepository } from "../repositories/sync.js";
import type { ChainChecker } from "../services/chainCheck.js";

const SyncQuery = z.object({ network: z.enum(NETWORK_NAMES).default(DEFAULT_NETWORK) });

export function metaRouter(db: Db, sync: SyncRepository, chain: ChainChecker): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.json({ status: "ok", database: "ok" });
    } catch {
      res.status(503).json({ status: "degraded", database: "unreachable" });
    }
  });

  router.get("/v1/networks", (_req, res) => {
    const networks: NetworkInfo[] = NETWORK_NAMES.map((name) => ({
      network: name,
      chainId: NETWORKS[name].chainId,
      label: NETWORKS[name].label,
      isTestnet: NETWORKS[name].isTestnet,
      isDefault: name === DEFAULT_NETWORK,
      identityRegistry: NETWORKS[name].identityRegistry.toLowerCase(),
      reputationRegistry: NETWORKS[name].reputationRegistry.toLowerCase(),
    }));
    res.json({ networks });
  });

  router.get("/v1/sync-status", async (req, res) => {
    const { network } = SyncQuery.parse(req.query);
    let progress = null;
    let stats = { indexedCount: 0, highestIndexedAgentId: null as string | null };
    try {
      [progress, stats] = await Promise.all([sync.progress(network), sync.agentStats(network)]);
    } catch (err) {
      if (!isMissingRelation(err)) throw err;
    }

    const check = await chain.highestAgentId(network, stats.highestIndexedAgentId);
    const missing =
      check.highestAgentId === null
        ? null
        : (BigInt(check.highestAgentId) - (stats.highestIndexedAgentId === null ? -1n : BigInt(stats.highestIndexedAgentId))).toString();

    const body: SyncStatus = {
      network,
      chainId: NETWORKS[network].chainId,
      indexed: progress !== null,
      indexer: progress && {
        ready: progress.readyAt !== null,
        readyAt: progress.readyAt?.toISOString() ?? null,
        usingHyperSync: progress.usingHyperSync,
        startBlock: progress.startBlock,
        progressBlock: progress.progressBlock,
        chainHeadBlock: progress.chainHeadBlock,
        lagBlocks: (BigInt(progress.chainHeadBlock) - BigInt(progress.progressBlock)).toString(),
        progressBlockTime: progress.progressBlockTime?.toISOString() ?? null,
        eventsProcessed: progress.eventsProcessed,
      },
      agents: stats,
      chain: {
        highestAgentId: check.highestAgentId,
        checkedAt: check.checkedAt?.toISOString() ?? null,
        error: check.error,
      },
      missingAgents: missing,
    };
    res.json(body);
  });

  return router;
}
