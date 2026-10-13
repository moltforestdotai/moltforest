import { createPublicClient, http, type Address } from "viem";
import { NETWORK_NAMES, NETWORKS, receiptRegistryAbi, type NetworkName } from "@moltforest/chain";
import { createAgentSignatureVerifier, type AgentSignatureVerifier } from "@moltforest/receipts";

/** A network where receipts can be submitted: our ReceiptRegistry is deployed there. */
export interface ReceiptNetwork {
  network: NetworkName;
  chainId: number;
  registry: Address;
  verifier: Pick<AgentSignatureVerifier, "verify">;
  /** On-chain level of a receipt on the ReceiptRegistry (0 = not anchored). */
  levelOf?: (receiptHash: `0x${string}`) => Promise<number>;
}

export type ReceiptNetworks = Partial<Record<NetworkName, ReceiptNetwork>>;

/**
 * Networks with a ReceiptRegistry: the deployed address in @moltforest/chain,
 * or an override (e.g. a local Anvil deployment). Live on testnet and mainnet.
 */
export function createReceiptNetworks(opts: {
  rpcUrls: Partial<Record<NetworkName, string>>;
  registryOverrides?: Partial<Record<NetworkName, Address>>;
  timeoutMs?: number;
}): ReceiptNetworks {
  const result: ReceiptNetworks = {};
  for (const name of NETWORK_NAMES) {
    const net = NETWORKS[name];
    const registry = opts.registryOverrides?.[name] ?? net.receiptRegistry?.address;
    if (!registry) continue;
    const client = createPublicClient({
      transport: http(opts.rpcUrls[name] ?? net.defaultRpcUrl, { timeout: opts.timeoutMs ?? 10_000, retryCount: 1 }),
    });
    result[name] = {
      network: name,
      chainId: net.chainId,
      registry: registry.toLowerCase() as Address,
      verifier: createAgentSignatureVerifier(client, net.identityRegistry),
      levelOf: (receiptHash) => client.readContract({ address: registry, abi: receiptRegistryAbi, functionName: "levelOf", args: [receiptHash] }),
    };
  }
  return result;
}
