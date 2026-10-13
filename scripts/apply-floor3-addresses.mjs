#!/usr/bin/env node
/**
 * Plug Floor-3 addresses into NETWORKS.mainnet + CRE config.mainnet.json after deploy.
 *
 *   SCORE_REGISTRY=0x… ERC8183=0x… SCORE_GATE_HOOK=0x… CRE_SCORE_PUBLISHER=0x… \
 *   DEPLOY_BLOCK=12345678 \
 *   node scripts/apply-floor3-addresses.mjs
 *
 * Or: pnpm record:floor3-mainnet
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function need(name, ...aliases) {
  for (const k of [name, ...aliases]) {
    const v = process.env[k]?.trim();
    if (v) return v;
  }
  console.error(`Missing ${name}${aliases.length ? ` (or ${aliases.join(", ")})` : ""}`);
  process.exit(1);
}

function needAddr(name, ...aliases) {
  const v = need(name, ...aliases);
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    console.error(`${name} must be a 0x address`);
    process.exit(1);
  }
  return v;
}

const scoreRegistry = needAddr("SCORE_REGISTRY", "REGISTRY");
const agenticCommerce = needAddr("ERC8183", "AGENTIC_COMMERCE");
const scoreGateHook = needAddr("SCORE_GATE_HOOK", "HOOK");
const creScorePublisher = needAddr("CRE_SCORE_PUBLISHER", "PUBLISHER");
const deployBlock = Number(need("DEPLOY_BLOCK"));
if (!Number.isFinite(deployBlock) || deployBlock < 1) {
  console.error("DEPLOY_BLOCK must be a positive integer");
  process.exit(1);
}

const floor3Block = `    // Floor-3 (Monad mainnet) — applied by scripts/apply-floor3-addresses.mjs
    scoreRegistry: { address: "${scoreRegistry}", deployBlock: ${deployBlock} },
    agenticCommerce: { address: "${agenticCommerce}", deployBlock: ${deployBlock} },
    scoreGateHook: { address: "${scoreGateHook}", deployBlock: ${deployBlock} },
    creScorePublisher: { address: "${creScorePublisher}", deployBlock: ${deployBlock} },
`;

const networksPath = resolve(root, "packages/chain/src/networks.ts");
let networks = readFileSync(networksPath, "utf8");

const placeholder =
  /    \/\/ Floor-3: fill after[\s\S]*?\/\/ scoreRegistry \/ agenticCommerce \/ scoreGateHook \/ creScorePublisher\n/;
const existing =
  /    \/\/ Floor-3 \(Monad mainnet\)[\s\S]*?creScorePublisher: \{ address: "0x[0-9a-fA-F]{40}", deployBlock: \d+ \},\n/;

if (placeholder.test(networks)) {
  networks = networks.replace(placeholder, floor3Block);
} else if (existing.test(networks)) {
  networks = networks.replace(existing, floor3Block);
} else {
  console.error("Could not find Floor-3 placeholder/entry in networks.ts mainnet block");
  process.exit(1);
}

writeFileSync(networksPath, networks);
console.log("updated", networksPath);

const crePath = resolve(root, "cre/epoch-publisher/config.mainnet.json");
const cre = JSON.parse(readFileSync(crePath, "utf8"));
cre.pendingEpochUrl =
  process.env.PENDING_EPOCH_URL?.trim() ||
  "https://api.moltforest.ai/v1/scores/pending-epoch?network=mainnet";
cre.evms[0].creScorePublisherAddress = creScorePublisher;
cre.evms[0].scoreRegistryAddress = scoreRegistry;
cre.evms[0].chainName = "monad-mainnet";
writeFileSync(crePath, `${JSON.stringify(cre, null, 2)}\n`);
console.log("updated", crePath);

console.log(`
Mainnet Floor-3 plugged in.
Next:
  1) Fund CRE_ETH_PRIVATE_KEY (and verifiers/deployer as needed) with real MON
  2) EPOCH_PIPELINE_NETWORKS=mainnet EPOCH_PIPELINE_CRE_TARGET=mainnet-simulation
  3) pnpm scores:prepare-epoch -- --from-db --all-agents --network mainnet
  4) cre workflow simulate epoch-publisher --target mainnet-simulation --broadcast
`);
