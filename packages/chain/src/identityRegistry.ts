import { parseAbi, parseEventLogs, type Account, type Address, type Chain, type Hex, type PublicClient, type Transport, type WalletClient } from "viem";

/** The ERC-8004 Identity Registry calls used to register an agent and update its file. */
export const identityRegistryWriteAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

/** An ERC-8004 registration file stored on-chain as `data:application/json;base64,…` (decision D17). */
export function registrationDataUri(file: unknown): string {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(file), "utf8").toString("base64")}`;
}

/** `registrations[]` entry for an agent: `{ agentId, agentRegistry: "eip155:<chainId>:<registry>" }`. */
export function registrationEntry(chainId: number, registry: Address, agentId: bigint) {
  return { agentId: Number(agentId), agentRegistry: `eip155:${chainId}:${registry}` };
}

export interface RegisterAgentOptions {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  registry: Address;
  /** Builds the registration file; called without an id first, then with the new id. */
  fileFor: (agentId?: bigint) => unknown;
  confirmTimeoutMs?: number;
}

export interface RegisteredAgent {
  agentId: bigint;
  registerTx: Hex;
  setUriTx: Hex;
}

/**
 * Registers a new agent in two transactions: `register(uri)`, then
 * `setAgentURI` so the file's `registrations` lists the id it just received.
 */
export async function registerAgent(opts: RegisterAgentOptions): Promise<RegisteredAgent> {
  const { publicClient, walletClient, registry } = opts;
  const timeout = opts.confirmTimeoutMs ?? 120_000;
  const abi = identityRegistryWriteAbi;

  const registerTx = await walletClient.writeContract({ address: registry, abi, functionName: "register", args: [registrationDataUri(opts.fileFor())] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: registerTx, timeout });
  if (receipt.status !== "success") throw new Error(`register reverted (tx ${registerTx})`);
  const [registered] = parseEventLogs({ abi, logs: receipt.logs, eventName: "Registered" });
  if (!registered) throw new Error(`no Registered event in tx ${registerTx}`);
  const agentId = registered.args.agentId;

  const setUriTx = await walletClient.writeContract({
    address: registry,
    abi,
    functionName: "setAgentURI",
    args: [agentId, registrationDataUri(opts.fileFor(agentId))],
  });
  const second = await publicClient.waitForTransactionReceipt({ hash: setUriTx, timeout });
  if (second.status !== "success") throw new Error(`setAgentURI reverted (tx ${setUriTx}); agent ${agentId} is registered without its id in the file`);
  return { agentId, registerTx, setUriTx };
}

/**
 * Gas and cost of registering `file`. Monad charges for the gas limit, not the
 * gas used, so the estimate is what the transaction costs. Doubled for the
 * second (`setAgentURI`) transaction.
 */
export async function estimateRegistration(publicClient: PublicClient, account: Address, registry: Address, file: unknown) {
  const [gas, gasPrice] = await Promise.all([
    publicClient.estimateContractGas({
      account,
      address: registry,
      abi: identityRegistryWriteAbi,
      functionName: "register",
      args: [registrationDataUri(file)],
    }),
    publicClient.getGasPrice(),
  ]);
  return { gasPerTx: gas, gasPrice, totalCostWei: 2n * gas * gasPrice };
}
