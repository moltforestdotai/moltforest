/**
 * Registers the email-verifier demo agent on the Monad testnet Identity Registry,
 * or updates its registration file when EMAIL_VERIFIER_AGENT_ID is already set.
 *
 *   pnpm --filter @moltforest/demo-agents register           dry run: prints the file and the cost
 *   pnpm --filter @moltforest/demo-agents register --send    sends the transactions
 *
 * Needs EMAIL_VERIFIER_PRIVATE_KEY (a testnet-only key, constraint C6) holding a
 * little test MON for gas, and DEMO_AGENTS_PUBLIC_URL set to the public origin.
 */
import { createPublicClient, createWalletClient, formatEther, getAddress, http, isAddressEqual, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { estimateRegistration, identityRegistryWriteAbi as abi, NETWORKS, registerAgent, registrationDataUri } from "@moltforest/chain";
import { loadConfig } from "./config.js";
import { emailVerifierRegistration } from "./registration.js";

const send = process.argv.includes("--send");
const allowLocal = process.argv.includes("--allow-local");

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

const config = loadConfig();
const account = privateKeyToAccount(config.EMAIL_VERIFIER_PRIVATE_KEY);
const transport = http(config.MONAD_RPC_URL_TESTNET);
const publicClient = createPublicClient({ chain: monadTestnet, transport }) as PublicClient;
const walletClient = createWalletClient({ account, chain: monadTestnet, transport });
const registry = getAddress(NETWORKS.testnet.identityRegistry);
const fileFor = (agentId?: bigint) =>
  emailVerifierRegistration({ publicUrl: config.DEMO_AGENTS_PUBLIC_URL, webUrl: config.MOLTFOREST_WEB_URL, agentId });

if (send && !allowLocal && /^https?:\/\/(localhost|127\.|\[::1\])/.test(config.DEMO_AGENTS_PUBLIC_URL)) {
  fail(`DEMO_AGENTS_PUBLIC_URL is ${config.DEMO_AGENTS_PUBLIC_URL}; set the public origin first (or pass --allow-local).`);
}

const balance = await publicClient.getBalance({ address: account.address });
console.log(`signer   ${account.address}`);
console.log(`balance  ${formatEther(balance)} MON`);

function checkFunds(costWei: bigint) {
  console.log(`cost     ~${formatEther(costWei)} MON`);
  if (costWei <= balance) return;
  const message = `the signer needs at least ${formatEther(costWei)} MON for gas`;
  if (send) fail(message);
  console.warn(`warning: ${message}`);
}

const existing = config.EMAIL_VERIFIER_AGENT_ID;
if (existing !== undefined) {
  const owner = await publicClient
    .readContract({ address: registry, abi, functionName: "ownerOf", args: [existing] })
    .catch(() => fail(`agent ${existing} does not exist on testnet`));
  if (!isAddressEqual(owner, account.address)) fail(`agent ${existing} is owned by ${owner}, not by this key`);

  const uri = registrationDataUri(fileFor(existing));
  console.log(JSON.stringify(fileFor(existing), null, 2));
  if ((await publicClient.readContract({ address: registry, abi, functionName: "tokenURI", args: [existing] })) === uri) {
    console.log(`agent ${existing}: the registration file on-chain is already up to date`);
    process.exit(0);
  }
  const gas = await publicClient.estimateContractGas({ account, address: registry, abi, functionName: "setAgentURI", args: [existing, uri] });
  checkFunds(gas * (await publicClient.getGasPrice()));
  if (!send) {
    console.log("dry run: pass --send to update the registration file");
    process.exit(0);
  }
  const hash = await walletClient.writeContract({ address: registry, abi, functionName: "setAgentURI", args: [existing, uri] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") fail(`setAgentURI reverted (tx ${hash})`);
  console.log(`agent ${existing}: registration file updated (tx ${hash})`);
} else {
  const { result: predictedId } = await publicClient.simulateContract({
    account,
    address: registry,
    abi,
    functionName: "register",
    args: [registrationDataUri(fileFor())],
  });
  console.log(JSON.stringify(fileFor(predictedId), null, 2));
  checkFunds((await estimateRegistration(publicClient, account.address, registry, fileFor(predictedId))).totalCostWei);
  if (!send) {
    console.log(`dry run: would register as agent ${predictedId} (if no one registers first); pass --send to register`);
    process.exit(0);
  }
  const { agentId, registerTx, setUriTx } = await registerAgent({ publicClient, walletClient, registry, fileFor });
  console.log(`register tx ${registerTx}, setAgentURI tx ${setUriTx}`);
  console.log(`registered agent ${agentId}. Set EMAIL_VERIFIER_AGENT_ID=${agentId} where the service runs, then restart it.`);
}
