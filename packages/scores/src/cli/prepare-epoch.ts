/**
 * Cosign an epoch and stage it for CRE (CreScorePublisher) without publishing on-chain.
 *
 * Writes:
 *   - app.score_epoch_pending (GET /v1/scores/pending-epoch)
 *   - app.score_epoch + agents (proof API; publish_tx null until CRE publishes)
 *   - optional JSON fixture for offline CRE config
 *
 * Usage:
 *   pnpm scores:prepare-epoch -- --demo
 *   EPOCH_ID=2 pnpm scores:prepare-epoch -- --from-db
 *   pnpm scores:prepare-epoch -- --demo --network mainnet
 *   pnpm scores:prepare-epoch -- --demo --out ../../cre/epoch-publisher/pending-epoch.json
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { type Hex, isAddress, isHex } from "viem";
import { NETWORKS, isNetworkName, type NetworkName } from "@moltforest/chain";
import { computeScore } from "../compute.js";
import { loadScoresFromDb } from "../fromDb.js";
import { buildEpoch, cosignEpoch } from "../publish.js";
import { persistPublishedEpoch } from "../persist.js";
import { persistPendingEpoch } from "../pending.js";
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

function resolveNetwork(): NetworkName {
  const raw = argValue("--network") ?? process.env.SCORE_NETWORK ?? "testnet";
  if (!isNetworkName(raw)) throw new Error(`--network must be mainnet|testnet (got ${raw})`);
  return raw;
}

async function main() {
  loadEnv(resolve(root, ".env"));

  const network = resolveNetwork();
  const net = NETWORKS[network];
  const registry = (process.env.SCORE_REGISTRY ?? net.scoreRegistry?.address) as `0x${string}` | undefined;
  if (!registry || !isAddress(registry)) {
    throw new Error(`SCORE_REGISTRY / ${network}.scoreRegistry missing — deploy Floor-3 first`);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const schema = process.env.APP_DB_SCHEMA ?? "app";
  const pool = new pg.Pool({ connectionString: databaseUrl });

  try {
    const scoresPath = argValue("--scores");
    const fromDb = hasFlag("--from-db");
    let scores: AgentScore[];
    let source: string;
    if (scoresPath) {
      scores = loadScoresJson(resolve(scoresPath));
      source = `json:${scoresPath}`;
    } else if (fromDb) {
      scores = await loadScoresFromDb({
        db: pool,
        chainId: net.chainId,
        schema,
        requireSignal: !hasFlag("--include-zero"),
      });
      source = "db";
    } else {
      scores = demoScores();
      source = "demo";
    }
    console.log("network", network, "chainId", net.chainId);
    console.log("scoreSource", source);

    const epochId = BigInt(process.env.EPOCH_ID ?? "2");
    const epoch = buildEpoch(epochId, scores);

    const verifierKeys = [
      optionalKey("VERIFIER_1_PRIVATE_KEY"),
      optionalKey("VERIFIER_2_PRIVATE_KEY"),
      optionalKey("VERIFIER_3_PRIVATE_KEY"),
    ].filter((k): k is Hex => !!k);
    if (verifierKeys.length < 2) {
      throw new Error("Need at least two VERIFIER_*_PRIVATE_KEY values matching the on-chain set");
    }

    const { signers, signatures } = await cosignEpoch(verifierKeys, net.chainId, registry, epoch);
    if (signatures.length < 2 || signers.length < 2) throw new Error("cosign produced fewer than 2 signatures");

    const pending = await persistPendingEpoch({
      db: pool,
      schema,
      network,
      chainId: net.chainId,
      scoreRegistry: registry,
      epoch,
      signatures: [signatures[0]!, signatures[1]!],
      signers: [signers[0]!, signers[1]!],
    });

    await persistPublishedEpoch({
      db: pool,
      schema,
      chainId: net.chainId,
      scoreRegistry: registry,
      epoch,
      publishTx: null,
    });

    console.log("prepared epoch", pending.epochId);
    console.log("scoresRoot", pending.scoresRoot);
    console.log("signers", pending.signers);
    console.log(`GET /v1/scores/pending-epoch?network=${network}`);

    const out = argValue("--out");
    if (out) {
      // Resolve relative to repo root (moltforest/), not cwd.
      const path = resolve(root, out);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(pending, null, 2)}\n`);
      console.log("wrote", path);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
