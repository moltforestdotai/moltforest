/**
 * Registers the email-verifier demo agent on the Monad testnet Identity Registry,
 * or updates its registration file when EMAIL_VERIFIER_AGENT_ID is already set.
 *
 *   pnpm --filter @moltforest/demo-agents register           dry run: prints the file and the cost
 *   pnpm --filter @moltforest/demo-agents register --send    sends the transactions
 *
 * Needs EMAIL_VERIFIER_PRIVATE_KEY (a testnet-only key, constraint C6) holding a
 * little test MON for gas, and DEMO_AGENTS_PUBLIC_URL set to the public origin.
 * A first registration takes two transactions: `register`, then `setAgentURI`
 * to list the new agent id in the file's `registrations`.
 */
import { createPublicClient, createWalletClient, formatEther, getAddress, http, isAddressEqual, parseEventLogs, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { NETWORKS } from "@moltforest/chain";
import { loadConfig } from "./config.js";
import { emailVerifierRegistration, identityRegistryWriteAbi as abi, toDataUri } from "./registration.js";

const send = process.argv.includes("--send");
const allowLocal = process.argv.includes("--allow-local");

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

const config = loadConfig();
const account = privateKeyToAccount(config.EMAIL_VERIFIER_PRIVATE_KEY);
const transport = http(config.MONAD_RPC_URL_TESTNET);
const publicClient = createPublicClient({ chain: monadTestnet, transport });
const walletClient = createWalletClient({ account, chain: monadTestnet, transport });
const registry = getAddress(NETWORKS.testnet.identityRegistry);
const fileFor = (agentId?: bigint) =>
  emailVerifierRegistration({ publicUrl: config.DEMO_AGENTS_PUBLIC_URL, webUrl: config.MOLTFOREST_WEB_URL, agentId });

if (send && !allowLocal && /^https?:\/\/(localhost|127\.|\[::1\])/.test(config.DEMO_AGENTS_PUBLIC_URL)) {
  fail(`DEMO_AGENTS_PUBLIC_URL is ${config.DEMO_AGENTS_PUBLIC_URL}; set the public origin first (or pass --allow-local).`);
}

const [balance, gasPrice] = await Promise.all([publicClient.getBalance({ address: account.address }), publicClient.getGasPrice()]);
console.log(`signer   ${account.address}`);
console.log(`balance  ${formatEther(balance)} MON`);

/** Monad charges for the gas limit, not the gas used, so the estimate is the cost. */
async function report(functionName: "register" | "setAgentURI", args: readonly [string] | readonly [bigint, string]) {
  const gas = await publicClient.estimateContractGas({ account, address: registry, abi, functionName, args } as never);
  const cost = gas * gasPrice;
  console.log(`${functionName}: ~${gas} gas, ~${formatEther(cost)} MON`);
  if (cost > balance) {
    const message = `the signer needs at least ${formatEther(cost)} MON for gas`;
    if (send) fail(message);
    console.warn(`warning: ${message}`);
  }
}

async function confirm(hash: Hex, what: string) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") fail(`${what} reverted (tx ${hash})`);
  console.log(`${what}: tx ${hash}, block ${receipt.blockNumber}`);
  return receipt;
}

const existing = config.EMAIL_VERIFIER_AGENT_ID;
if (existing !== undefined) {
  const owner = await publicClient
    .readContract({ address: registry, abi, functionName: "ownerOf", args: [existing] })
    .catch(() => fail(`agent ${existing} does not exist on testnet`));
  if (!isAddressEqual(owner, account.address)) fail(`agent ${existing} is owned by ${owner}, not by this key`);

  const uri = toDataUri(fileFor(existing));
  const current = await publicClient.readContract({ address: registry, abi, functionName: "tokenURI", args: [existing] });
  console.log(JSON.stringify(fileFor(existing), null, 2));
  if (current === uri) {
    console.log(`agent ${existing}: the registration file on-chain is already up to date`);
    process.exit(0);
  }
  await report("setAgentURI", [existing, uri]);
  if (!send) {
    console.log("dry run: pass --send to update the registration file");
    process.exit(0);
  }
  const hash = await walletClient.writeContract({ address: registry, abi, functionName: "setAgentURI", args: [existing, uri] });
  await confirm(hash, "setAgentURI");
  console.log(`agent ${existing}: registration file updated`);
} else {
  const firstUri = toDataUri(fileFor());
  const { result: predictedId } = await publicClient.simulateContract({ account, address: registry, abi, functionName: "register", args: [firstUri] });
  console.log(JSON.stringify(fileFor(predictedId), null, 2));
  await report("register", [firstUri]);
  if (!send) {
    console.log(`dry run: would register as agent ${predictedId} (if no one registers first); pass --send to register`);
    process.exit(0);
  }

  const hash = await walletClient.writeContract({ address: registry, abi, functionName: "register", args: [firstUri] });
  const receipt = await confirm(hash, "register");
  const [registered] = parseEventLogs({ abi, logs: receipt.logs, eventName: "Registered" });
  if (!registered) fail(`no Registered event in tx ${hash}`);
  const agentId = registered.args.agentId;

  const listHash = await walletClient.writeContract({
    address: registry,
    abi,
    functionName: "setAgentURI",
    args: [agentId, toDataUri(fileFor(agentId))],
  });
  await confirm(listHash, "setAgentURI");
  console.log(`registered agent ${agentId}. Set EMAIL_VERIFIER_AGENT_ID=${agentId} where the service runs, then restart it.`);
}
