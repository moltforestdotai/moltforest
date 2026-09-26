/**
 * Monad networks MoltForest indexes (decision D16: both chains, mainnet default).
 * Registry addresses verified on-chain 2026-09-25.
 */
export const NETWORK_NAMES = ["mainnet", "testnet"] as const;
export type NetworkName = (typeof NETWORK_NAMES)[number];
export const DEFAULT_NETWORK: NetworkName = "mainnet";

export interface NetworkConfig {
  name: NetworkName;
  chainId: number;
  label: string;
  isTestnet: boolean;
  defaultRpcUrl: string;
  identityRegistry: `0x${string}`;
  reputationRegistry: `0x${string}`;
  usdc: `0x${string}`;
}

export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  mainnet: {
    name: "mainnet",
    chainId: 143,
    label: "Monad Mainnet",
    isTestnet: false,
    defaultRpcUrl: "https://rpc.monad.xyz",
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputationRegistry: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  },
  testnet: {
    name: "testnet",
    chainId: 10143,
    label: "Monad Testnet",
    isTestnet: true,
    defaultRpcUrl: "https://testnet-rpc.monad.xyz",
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    usdc: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
  },
};

export function isNetworkName(value: unknown): value is NetworkName {
  return typeof value === "string" && (NETWORK_NAMES as readonly string[]).includes(value);
}

export function networkByChainId(chainId: number): NetworkConfig | undefined {
  return Object.values(NETWORKS).find((n) => n.chainId === chainId);
}

/** Globally unique agent reference, matching ERC-8004's `registrations` format. */
export function agentGlobalId(network: NetworkName, agentId: string | bigint): string {
  const n = NETWORKS[network];
  return `eip155:${n.chainId}:${n.identityRegistry.toLowerCase()}:${agentId}`;
}
