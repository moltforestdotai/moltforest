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
  /**
   * Our ReceiptRegistry (decision D06). Deployed on testnet only (D05);
   * undefined until deployed, which keeps receipt endpoints disabled.
   */
  receiptRegistry?: { address: `0x${string}`; deployBlock: number };
  /**
   * The chain's name in Nansen's API (decision D47). Undefined where Nansen
   * has no data, which keeps the Nansen lookups off for that network.
   */
  nansenChain?: string;
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
    nansenChain: "monad",
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
    // Deployed 2026-09-30, tx 0xfa900ba70c52562a1609e7de32972d57d820a3b9729e3317aa8dee66638c3a26.
    receiptRegistry: { address: "0x4d2a256fCaAc8e52e4B91e977EF6dDD56E980f98", deployBlock: 67037698 },
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
