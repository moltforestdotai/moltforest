/**
 * Hackathon POC hiring agent:
 *   1. Load (or create + register) a buyer ERC-8004 agent
 *   2. Discover email-verifier candidates (AskOptimus #10389 + fake #10390)
 *   3. API only couriers the proof — buyer verifies on ScoreRegistry (getEpoch + verifyScore)
 *   4. Choose the winner under a simple policy (verified leaves only)
 *   5. Hire the winner over x402 and print the email check result
 *
 * Env (see README.md). Run: pnpm demo:hire-poc
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Load apps/demo-hire-poc/.env without overriding already-exported vars. */
function loadDotEnv(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Fix common mistake: DEMO_HIRE_URL=DEMO_HIRE_URL=https://...
    if (val.startsWith(`${key}=`)) val = val.slice(key.length + 1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { monad } from "viem/chains";
import { NETWORKS, registerAgent, registrationEntry, type NetworkName } from "@moltforest/chain";
import { scoreRegistryAbi, verifyScoreOnChain } from "@moltforest/scores";
import { formatUsdc, payAndCall, requestQuote } from "./x402Hire.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const STATE_PATH = resolve(PKG_ROOT, ".demo-buyer.json");
loadDotEnv(resolve(PKG_ROOT, ".env"));

const API = (process.env.DEMO_API_URL ?? process.env.MOLTFOREST_API_URL ?? "https://api.moltforest.ai").replace(/\/$/, "");
const WEB = (process.env.DEMO_WEB_URL ?? "https://www.moltforest.ai").replace(/\/$/, "");
/** Hackathon POC is Monad mainnet only (scores + ERC-8004 buyer + x402 USDC). */
const SCORE_NETWORK = "mainnet" as const satisfies NetworkName;
const BUYER_NETWORK = "mainnet" as const satisfies NetworkName;
const EMAIL = process.env.DEMO_EMAIL ?? "zeeshanpaalo@gmail.com";
const MAX_USDC = process.env.DEMO_MAX_USDC ?? "0.05";
const SKIP_HIRE = process.env.DEMO_SKIP_HIRE === "true";
const DRY_REGISTER = process.env.DEMO_DRY_REGISTER === "true";

/** Mainnet demo email-verifiers: AskOptimus (legit) then sybil/fake. Override with DEMO_CANDIDATE_IDS. */
const DEFAULT_CANDIDATE_IDS = ["10389", "10390"] as const;
/** Default paid skill for AskOptimus #10389 (info page alone is GET-only / 404 on POST). */
const DEFAULT_ASKOPTIMUS_VERIFY_URL =
  "https://api.askoptimus.ai/agents/mainnet/email-verifier";

type BuyerState = { privateKey: Hex; address: Address; agentId?: string; network: NetworkName };

function log(step: string, msg: string, data?: unknown) {
  const line = data === undefined ? msg : `${msg}\n${JSON.stringify(data, null, 2)}`;
  console.log(`\n══ ${step} ══\n${line}`);
}

function chainFor(_network: NetworkName) {
  return monad;
}

function rpcFor(_network: NetworkName): string {
  return process.env.MONAD_RPC_URL_MAINNET ?? NETWORKS.mainnet.defaultRpcUrl;
}

function readSavedBuyer(): BuyerState | null {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as BuyerState;
  } catch {
    return null;
  }
}

function loadOrCreateBuyer(): BuyerState {
  const saved = readSavedBuyer();
  const fromEnv = process.env.DEMO_BUYER_PRIVATE_KEY ?? process.env.BUYER_PRIVATE_KEY;

  if (fromEnv) {
    let key = fromEnv.trim();
    if (!key.startsWith("0x")) key = `0x${key}`;
    const account = privateKeyToAccount(key as Hex);
    // Prefer explicit env agent id, else reuse id from state when the same key was registered before.
    const agentId =
      process.env.DEMO_BUYER_AGENT_ID ??
      (saved?.privateKey?.toLowerCase() === key.toLowerCase() ? saved.agentId : undefined);
    const state: BuyerState = {
      privateKey: key as Hex,
      address: account.address,
      agentId,
      network: BUYER_NETWORK,
    };
    saveBuyer(state);
    return state;
  }

  if (saved?.privateKey) {
    return { ...saved, network: BUYER_NETWORK };
  }

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const state: BuyerState = { privateKey, address: account.address, network: BUYER_NETWORK };
  saveBuyer(state);
  return state;
}

function saveBuyer(state: BuyerState) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

async function ensureRegistered(state: BuyerState): Promise<BuyerState> {
  // One-time mainnet register: agentId is persisted in .demo-buyer.json (or DEMO_BUYER_AGENT_ID).
  if (state.agentId) {
    log("1. buyer", `Reusing mainnet buyer agent #${state.agentId} (from state — no re-register)`, {
      address: state.address,
      network: state.network,
      profile: `${WEB}/agents/${state.network}/${state.agentId}`,
      stateFile: STATE_PATH,
    });
    return state;
  }

  const net = NETWORKS[state.network];
  const account = privateKeyToAccount(state.privateKey);
  const transport = http(rpcFor(state.network));
  const publicClient = createPublicClient({ chain: chainFor(state.network), transport });
  const walletClient = createWalletClient({ account, chain: chainFor(state.network), transport });

  const [mon, usdc] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({ address: getAddress(net.usdc), abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
  ]);

  log("1. buyer", "New wallet — fund with MON (gas) + USDC before register/hire", {
    address: state.address,
    network: state.network,
    mon: formatEther(mon),
    usdc: formatUnits(usdc, 6),
    stateFile: STATE_PATH,
  });

  if (DRY_REGISTER) {
    throw new Error("DEMO_DRY_REGISTER=true — fund the address, set DEMO_BUYER_PRIVATE_KEY, re-run without DRY_REGISTER to register.");
  }
  if (mon === 0n) {
    throw new Error(`Fund ${state.address} with ${state.network} MON, then re-run.`);
  }

  const fileFor = (agentId?: bigint) => ({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: process.env.DEMO_BUYER_NAME ?? "MoltForest Demo Hiring Agent",
    description: "Hackathon POC buyer: verifies Floor-3 score leaves on-chain, then hires an email verifier over x402.",
    image: "",
    active: true,
    x402Support: true,
    services: [],
    registrations: agentId !== undefined ? [registrationEntry(net.chainId, getAddress(net.identityRegistry), agentId)] : [],
  });

  log("1. buyer", "Registering ERC-8004 agent…");
  const result = await registerAgent({
    publicClient,
    walletClient,
    registry: getAddress(net.identityRegistry),
    fileFor,
  });
  state.agentId = result.agentId.toString();
  saveBuyer(state);
  log("1. buyer", `Registered agent #${state.agentId}`, {
    registerTx: result.registerTx,
    setUriTx: result.setUriTx,
    profile: `${WEB}/agents/${state.network}/${state.agentId}`,
  });
  return state;
}

interface AgentCard {
  agentId: string;
  name: string;
  description?: string;
  services: Array<{ name: string; endpoint: string }>;
  profile: string;
}

async function fetchAgent(network: NetworkName, agentId: string): Promise<AgentCard> {
  const res = await fetch(`${API}/v1/agents/${network}/${agentId}`);
  if (!res.ok) throw new Error(`GET agent ${agentId}: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    agentId: string;
    name: string;
    description?: string;
    services?: Array<{ name: string; endpoint: string }>;
  };
  return {
    agentId: body.agentId,
    name: body.name,
    description: body.description,
    services: body.services ?? [],
    profile: `${WEB}/agents/${network}/${body.agentId}`,
  };
}

async function discoverCandidates(network: NetworkName): Promise<AgentCard[]> {
  const rawIds =
    process.env.DEMO_CANDIDATE_IDS?.split(/[,\s]+/).filter(Boolean) ?? [...DEFAULT_CANDIDATE_IDS];
  const cards: AgentCard[] = [];
  for (const id of rawIds) {
    const card = await fetchAgent(network, id);
    cards.push({
      ...card,
      // Annotate known demo roles for clear logs / video narration.
      name:
        id === "10389"
          ? `${card.name} [legit / AskOptimus]`
          : id === "10390"
            ? `${card.name} [sybil / fake]`
            : card.name,
    });
  }
  return cards;
}

interface ScorePackage {
  agentId: string;
  epochId: string;
  scoreRegistry: Address;
  /** Root claimed by the API response (courier only — not trusted alone). */
  apiScoresRoot: string;
  /** Root from ScoreRegistry.getEpoch on Monad mainnet. */
  onChainScoresRoot: string;
  rootMatchesChain: boolean;
  leafVerifiedOnChain: boolean;
  /** True only when API root matches chain AND verifyScore(proof) succeeds. */
  onChainOk: boolean;
  publishTx: string | null;
  score: {
    scoreBps: number;
    confidenceBps: number;
    paidReviews: number;
    independentClusters: number;
    totalPaidVolume: string;
  };
  proof: Hex[];
}

/**
 * API is a courier for leaf + Merkle proof. Trust comes from Monad:
 *   1) ScoreRegistry.getEpoch(epochId) → canonical scoresRoot
 *   2) ScoreRegistry.verifyScore(epochId, leaf, proof) → leaf inclusion
 */
async function loadAndVerifyScore(network: NetworkName, agentId: string): Promise<ScorePackage | null> {
  const res = await fetch(`${API}/v1/agents/${network}/${agentId}/score`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`score ${agentId}: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    epochId: string;
    scoreRegistry: string;
    scoresRoot: string;
    publishTx: string | null;
    score: ScorePackage["score"];
    proof: string[];
  };

  const configured = NETWORKS[network].scoreRegistry?.address;
  if (!configured) throw new Error(`No ScoreRegistry configured for ${network}`);
  const registry = getAddress(configured);
  if (body.scoreRegistry && getAddress(body.scoreRegistry) !== registry) {
    throw new Error(
      `API scoreRegistry ${body.scoreRegistry} != configured ${registry} — refusing to trust courier`,
    );
  }

  const epochId = BigInt(body.epochId);
  const rpcUrl = rpcFor(network);
  const client = createPublicClient({ chain: monad, transport: http(rpcUrl) });

  let onChainScoresRoot: string;
  try {
    const epoch = await client.readContract({
      address: registry,
      abi: scoreRegistryAbi,
      functionName: "getEpoch",
      args: [epochId],
    });
    onChainScoresRoot = epoch.scoresRoot;
  } catch (err) {
    throw new Error(
      `ScoreRegistry.getEpoch(${body.epochId}) failed on-chain: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const apiScoresRoot = body.scoresRoot;
  const rootMatchesChain = apiScoresRoot.toLowerCase() === onChainScoresRoot.toLowerCase();

  const score = {
    agentId: BigInt(agentId),
    scoreBps: body.score.scoreBps,
    confidenceBps: body.score.confidenceBps,
    paidReviews: body.score.paidReviews,
    independentClusters: body.score.independentClusters,
    totalPaidVolume: BigInt(body.score.totalPaidVolume),
  };
  const proof = body.proof as Hex[];

  const leafVerifiedOnChain = await verifyScoreOnChain({
    rpcUrl,
    scoreRegistry: registry,
    epochId,
    score,
    proof,
  });

  return {
    agentId,
    epochId: body.epochId,
    scoreRegistry: registry,
    apiScoresRoot,
    onChainScoresRoot,
    rootMatchesChain,
    leafVerifiedOnChain,
    onChainOk: rootMatchesChain && leafVerifiedOnChain,
    publishTx: body.publishTx,
    score: body.score,
    proof,
  };
}

/** Turn agent info URLs into the paid POST skill when possible. */
function normalizeHireUrl(url: string): string {
  const u = url.trim().replace(/\/$/, "");
  // AskOptimus info page → verify skill
  if (/\/agents\/mainnet\/email-verifier$/i.test(u) && !/\/verify$/i.test(u)) {
    return `${u}/verify`;
  }
  return u;
}

function pickHireUrl(card: AgentCard): string {
  if (process.env.DEMO_HIRE_URL?.trim()) {
    return normalizeHireUrl(process.env.DEMO_HIRE_URL);
  }
  if (card.agentId === "10389") {
    return DEFAULT_ASKOPTIMUS_VERIFY_URL;
  }
  const services = card.services ?? [];
  const verify = services.find(
    (s) => /\/verify\/?$/i.test(s.endpoint) || /verify/i.test(s.name),
  );
  const any = verify ?? services.find((s) => /^https?:\/\//i.test(s.endpoint));
  if (!any) {
    throw new Error(
      `No hire URL for agent #${card.agentId} (${card.name}). Set DEMO_HIRE_URL to its POST verify endpoint (…/verify).`,
    );
  }
  return normalizeHireUrl(any.endpoint);
}

function parseMaxUsdc(s: string): bigint {
  const [whole, frac = ""] = s.trim().split(".");
  const f = (frac + "000000").slice(0, 6);
  return BigInt(whole || "0") * 1_000_000n + BigInt(f);
}

async function main() {
  console.log("\nMoltForest demo hire POC — evidence → on-chain verify → x402 hire\n");

  const scoreNet = SCORE_NETWORK;
  let buyer = loadOrCreateBuyer();
  buyer = await ensureRegistered(buyer);
  const account = privateKeyToAccount(buyer.privateKey);

  const candidates = await discoverCandidates(scoreNet);
  log(
    "2. discover",
    "Email-verifier candidates (mainnet defaults: #10389 AskOptimus / legit, #10390 sybil / fake)",
    candidates.map((c) => ({ id: c.agentId, name: c.name, profile: c.profile, services: c.services.map((s) => s.endpoint) })),
  );

  const scored: Array<{ card: AgentCard; score: ScorePackage }> = [];
  for (const card of candidates) {
    const score = await loadAndVerifyScore(scoreNet, card.agentId);
    if (!score) {
      log("3. score", `Agent #${card.agentId} (${card.name}): no published score`);
      continue;
    }
    log("3. score (API courier → on-chain verify)", `Agent #${card.agentId} (${card.name})`, {
      epochId: score.epochId,
      scoreRegistry: score.scoreRegistry,
      scoreBps: score.score.scoreBps,
      confidenceBps: score.score.confidenceBps,
      paidReviews: score.score.paidReviews,
      independentClusters: score.score.independentClusters,
      apiScoresRoot: score.apiScoresRoot,
      onChainScoresRoot: score.onChainScoresRoot,
      stepA_getEpoch_rootMatchesApi: score.rootMatchesChain,
      stepB_verifyScore_leafInTree: score.leafVerifiedOnChain,
      trusted: score.onChainOk,
      publishTx: score.publishTx,
      note: score.onChainOk
        ? "Trusted: getEpoch root matches courier AND verifyScore(proof)=true on Monad. API was not trusted alone."
        : "REJECTED: root mismatch and/or verifyScore failed — will not hire from this package.",
    });
    scored.push({ card, score });
  }

  const verified = scored.filter((s) => s.score.onChainOk);
  if (verified.length === 0) throw new Error("No candidate passed on-chain score verification.");

  // Prefer higher independent clusters, then scoreBps, then confidence.
  // With defaults, 10389 (AskOptimus) should win over 10390 (sybil).
  verified.sort((a, b) => {
    const ca = a.score.score.independentClusters;
    const cb = b.score.score.independentClusters;
    if (cb !== ca) return cb - ca;
    if (b.score.score.scoreBps !== a.score.score.scoreBps) return b.score.score.scoreBps - a.score.score.scoreBps;
    return b.score.score.confidenceBps - a.score.score.confidenceBps;
  });
  const winner = verified[0]!;
  const runnerUp = verified[1];
  if (winner.card.agentId !== "10389") {
    console.warn(
      `\n⚠ Expected AskOptimus (#10389) to win under cluster/score policy; winner is #${winner.card.agentId}. Check live scores before recording.\n`,
    );
  }

  log("4. decide", `Hire ${winner.card.name} (#${winner.card.agentId})`, {
    policy: "onChainVerify && max(independentClusters, then scoreBps, then confidenceBps)",
    winner: {
      name: winner.card.name,
      agentId: winner.card.agentId,
      clusters: winner.score.score.independentClusters,
      scoreBps: winner.score.score.scoreBps,
      confidenceBps: winner.score.score.confidenceBps,
    },
    runnerUp: runnerUp
      ? {
          name: runnerUp.card.name,
          agentId: runnerUp.card.agentId,
          clusters: runnerUp.score.score.independentClusters,
          scoreBps: runnerUp.score.score.scoreBps,
          confidenceBps: runnerUp.score.score.confidenceBps,
          whyNot: "Fewer independent clusters and/or lower score after on-chain verify",
        }
      : null,
  });

  if (SKIP_HIRE) {
    log("5. hire", "DEMO_SKIP_HIRE=true — stopped after decision");
    return;
  }

  const hireUrl = pickHireUrl(winner.card);
  log("5. hire", `Quoting paid skill ${hireUrl}`);
  const quote = await requestQuote({
    url: hireUrl,
    method: "POST",
    body: { email: EMAIL, clientAgentId: buyer.agentId },
  });

  if (quote.kind === "http_error") {
    throw new Error(
      `Hire URL returned HTTP ${quote.status} (expected 402 Payment Required). ` +
        `Use the POST …/verify skill, not the agent info page. body=${JSON.stringify(quote.body)}`,
    );
  }
  if (quote.kind === "no_payment") {
    throw new Error(
      `Service returned HTTP ${quote.status} without asking for payment — refuse to treat as free hire. body=${JSON.stringify(quote.body)}`,
    );
  }

  log("5. hire", "x402 PAYMENT-REQUIRED (unpaid probe)", {
    description: quote.description,
    options: quote.options,
    willPay: quote.payable
      ? { network: quote.payable.network, amount: formatUsdc(BigInt(quote.payable.amount)), payTo: quote.payable.payTo }
      : null,
  });

  if (!quote.payable) {
    throw new Error(
      "No payable mainnet USDC option in the 402 (need scheme=exact, network=eip155:143, asset=Monad mainnet USDC).",
    );
  }

  const limit = parseMaxUsdc(MAX_USDC);
  const price = BigInt(quote.payable.amount);
  if (price > limit) throw new Error(`Price ${formatUsdc(price)} USDC exceeds DEMO_MAX_USDC=${MAX_USDC}`);

  log("5. hire", `Paying ${formatUsdc(price)} USDC and calling verify…`, { email: EMAIL, clientAgentId: buyer.agentId });
  const paid = await payAndCall(
    account,
    { url: hireUrl, method: "POST", body: { email: EMAIL, clientAgentId: buyer.agentId } },
    limit,
  );

  log("6. result", "Email verification response (after x402 settlement)", {
    httpStatus: paid.status,
    paymentTx: paid.paymentTx,
    paidNetwork: paid.paid?.network ?? null,
    body: paid.body,
  });

  if (paid.status >= 200 && paid.status < 300 && typeof paid.body === "object" && paid.body && "result" in paid.body) {
    const result = (paid.body as { result: unknown }).result;
    log("6. result", "Email check summary", result);
  }

  console.log("\n✓ POC complete: on-chain score verify → choose → x402 hire → email result\n");
}

main().catch((err) => {
  console.error("\n✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
