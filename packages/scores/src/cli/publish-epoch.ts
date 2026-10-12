/**
 * Publish an epoch to the testnet ScoreRegistry, then persist leaves to Postgres
 * so the API can serve Merkle proofs.
 *
 * Score sources (pick one):
 *   --from-db     live app.agent_review_summary (+ paid volume from review_assessment)
 *   --scores PATH JSON array of ScoreInputs
 *   --demo        fixed demo agents 7 / 42 / 100 (default when none of the above)
 *
 * Env (.env in repo root):
 *   DEPLOYER_PRIVATE_KEY          — pays gas for publishEpoch (not needed with --db-only)
 *   VERIFIER_1_PRIVATE_KEY        — at least two of three required (not needed with --db-only)
 *   VERIFIER_2_PRIVATE_KEY
 *   VERIFIER_3_PRIVATE_KEY
 *   MONAD_RPC_URL_TESTNET         — optional
 *   SCORE_REGISTRY                — optional override
 *   EPOCH_ID                      — optional (default: 1)
 *   DATABASE_URL                  — required for --from-db and for persist (unless --skip-db)
 *   APP_DB_SCHEMA                 — optional (default app)
 *   SCORE_LIMIT                   — optional max leaves when using --from-db
 *
 * Usage:
 *   pnpm scores:publish-epoch -- --from-db
 *   EPOCH_ID=2 pnpm scores:publish-epoch -- --from-db
 *   pnpm scores:publish-epoch -- --demo
 *   pnpm scores:publish-epoch -- --demo --network mainnet
 *   pnpm scores:publish-epoch -- --scores ./scores.json
 *   pnpm scores:publish-epoch -- --db-only --demo   # seed DB for an already-published epoch
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPublicClient, defineChain, http, type Hex, isAddress, isHex } from "viem";
import { NETWORKS, isNetworkName, type NetworkName } from "@moltforest/chain";
import { computeScore } from "../compute.js";
import { loadScoresFromDb } from "../fromDb.js";
import { buildEpoch, cosignEpoch, publishEpochOnChain, proofFor, verifyScoreOnChain } from "../publish.js";
import { persistPublishedEpoch } from "../persist.js";
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

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  return process.argv[i + 1];
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

async function resolveScores(pool: pg.Pool | null, schema: string, chainId: number): Promise<{ scores: AgentScore[]; source: string }> {
  const scoresPath = argValue("--scores");
  const fromDb = hasFlag("--from-db");
  const demo = hasFlag("--demo");
  const chosen = [scoresPath ? "--scores" : null, fromDb ? "--from-db" : null, demo ? "--demo" : null].filter(Boolean);
  if (chosen.length > 1) throw new Error(`Pick one score source; got ${chosen.join(" and ")}`);

  if (scoresPath) return { scores: loadScoresJson(resolve(scoresPath)), source: `json:${scoresPath}` };
  if (fromDb) {
    if (!pool) throw new Error("DATABASE_URL is required for --from-db");
    const limitRaw = process.env.SCORE_LIMIT;
    const limit = limitRaw ? Number(limitRaw) : undefined;
    if (limitRaw && (!Number.isFinite(limit) || limit! < 1)) throw new Error("SCORE_LIMIT must be a positive integer");
    const allAgents = hasFlag("--all-agents");
    const scores = await loadScoresFromDb({
      db: pool,
      chainId,
      schema,
      indexerSchema: process.env.INDEXER_DB_SCHEMA ?? "envio",
      limit,
      allAgents,
      requireSignal: allAgents ? false : !hasFlag("--include-zero"),
    });
    return {
      scores,
      source: allAgents
        ? `db:all-agents (chain ${chainId}, ${scores.length} agents)`
        : `db:${schema}.agent_review_summary (chain ${chainId}, ${scores.length} agents)`,
    };
  }
  return { scores: demoScores(), source: "demo" };
}

function resolveNetwork(): NetworkName {
  const raw = argValue("--network") ?? process.env.SCORE_NETWORK ?? "testnet";
  if (!isNetworkName(raw)) throw new Error(`--network must be mainnet|testnet (got ${raw})`);
  return raw;
}

async function main() {
  loadEnv(resolve(root, ".env"));

  const dbOnly = hasFlag("--db-only");
  const skipDb = hasFlag("--skip-db");
  if (dbOnly && skipDb) throw new Error("Cannot combine --db-only and --skip-db");

  const network = resolveNetwork();
  const net = NETWORKS[network];
  const rpcEnv = network === "mainnet" ? "MONAD_RPC_URL_MAINNET" : "MONAD_RPC_URL_TESTNET";
  const rpc = process.env[rpcEnv] ?? net.defaultRpcUrl;
  const registry = (process.env.SCORE_REGISTRY ?? net.scoreRegistry?.address) as `0x${string}` | undefined;
  if (!registry || !isAddress(registry)) {
    throw new Error(`SCORE_REGISTRY / ${network}.scoreRegistry missing — deploy Floor-3 first`);
  }

  const schema = process.env.APP_DB_SCHEMA ?? "app";
  const needsPool = hasFlag("--from-db") || !skipDb;
  const databaseUrl = process.env.DATABASE_URL;
  if (needsPool && !databaseUrl) {
    throw new Error("DATABASE_URL is required for --from-db and to persist the epoch (or pass --skip-db without --from-db)");
  }

  const pool = needsPool && databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : null;

  try {
    const { scores, source } = await resolveScores(pool, schema, net.chainId);
    console.log("network", network, "chainId", net.chainId);
    console.log("scoreSource", source);

    const epochId = BigInt(process.env.EPOCH_ID ?? "1");
    const epoch = buildEpoch(epochId, scores);
    console.log("epochId", epoch.epochId.toString());
    console.log("scoresRoot", epoch.scoresRoot);
    console.log("inputsRoot", epoch.inputsRoot);
    console.log("algoHash", epoch.algoHash);
    console.log(
      "scores",
      scores.slice(0, 20).map((s) => ({
        agentId: s.agentId.toString(),
        scoreBps: s.scoreBps,
        confidenceBps: s.confidenceBps,
        paidReviews: s.paidReviews,
        clusters: s.independentClusters,
        volume: s.totalPaidVolume.toString(),
      })),
      scores.length > 20 ? `… +${scores.length - 20} more` : "",
    );

    let publishTx: Hex | null = null;

    if (!dbOnly) {
      const publisher = needKey("DEPLOYER_PRIVATE_KEY");
      const verifierKeys = [
        optionalKey("VERIFIER_1_PRIVATE_KEY"),
        optionalKey("VERIFIER_2_PRIVATE_KEY"),
        optionalKey("VERIFIER_3_PRIVATE_KEY"),
      ].filter((k): k is Hex => !!k);
      if (verifierKeys.length < 2) {
        throw new Error(
          "Need at least two of VERIFIER_1_PRIVATE_KEY, VERIFIER_2_PRIVATE_KEY, VERIFIER_3_PRIVATE_KEY matching the on-chain verifier set",
        );
      }

      const { signers, signatures } = await cosignEpoch(verifierKeys, net.chainId, registry, epoch);
      console.log("signers", signers);

      const chain = defineChain({
        id: net.chainId,
        name: net.label,
        nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
        rpcUrls: { default: { http: [rpc] } },
      });

      publishTx = await publishEpochOnChain({
        rpcUrl: rpc,
        chain,
        publisherKey: publisher,
        scoreRegistry: registry,
        epoch,
        signatures,
      });
      console.log("publishEpoch tx", publishTx);

      const publicClient = createPublicClient({ transport: http(rpc) });
      await publicClient.waitForTransactionReceipt({ hash: publishTx });

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
    } else {
      const known = process.env.PUBLISH_TX;
      if (known) {
        if (!isHex(known) || known.length !== 66) throw new Error("PUBLISH_TX must be a 32-byte hex tx hash");
        publishTx = known as Hex;
      }
      console.log("db-only: skipping on-chain publish");
    }

    if (!skipDb) {
      if (!pool) throw new Error("DATABASE_URL is required to persist the epoch (or pass --skip-db)");
      await persistPublishedEpoch({
        db: pool,
        schema,
        chainId: net.chainId,
        scoreRegistry: registry,
        epoch,
        publishTx,
      });
      console.log(`persisted epoch ${epochId} to ${schema}.score_epoch (${scores.length} agents)`);
    }
  } finally {
    await pool?.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
