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
   * Our ReceiptRegistry (decision D06). Deployed on testnet and mainnet;
   * undefined until deployed, which keeps receipt endpoints disabled for that network.
   */
  receiptRegistry?: { address: `0x${string}`; deployBlock: number };
  /**
   * Floor 3 ScoreRegistry (epoch Merkle roots). Filled after deploy per network.
   */
  scoreRegistry?: { address: `0x${string}`; deployBlock: number };
  /**
   * Our ERC-8183 Agentic Commerce deploy (QNTX mainnet instance is not used).
   */
  agenticCommerce?: { address: `0x${string}`; deployBlock: number };
  /**
   * ScoreGateHook attached to ERC-8183 jobs.
   */
  scoreGateHook?: { address: `0x${string}`; deployBlock: number };
  /**
   * CRE consumer that calls ScoreRegistry.publishEpoch.
   */
  creScorePublisher?: { address: `0x${string}`; deployBlock: number };
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
    // Deployed 2026-10-13, tx 0x50a29f7a317d48440d1d6a98bd9f14759b3d1d50bce9fd6868cebe75129cd3b0.
    receiptRegistry: { address: "0xbd5f1114092A92EF24Aa3ebE00e3c462f572eBFB", deployBlock: 113000318 },
    // Floor-3 (Monad mainnet) — applied by scripts/apply-floor3-addresses.mjs
    scoreRegistry: { address: "0x764c5C04736ceB34D69409733bb2015F840e12a5", deployBlock: 112997166 },
    agenticCommerce: { address: "0xC56C3C1aDB951f7747eF88310b036F612606d217", deployBlock: 112997166 },
    scoreGateHook: { address: "0x7d86EdFEdbE012F7fcE72A95F51fEbEa2f215785", deployBlock: 112997166 },
    creScorePublisher: { address: "0x21487DdF77f01Ba10d147946D44dFD3fD55fd015", deployBlock: 112997166 },
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
    // Deployed 2026-10-09, tx 0x3b9943758042d0c69cb5ef02acb226361d66580ca56ad204c754111835d93751.
    scoreRegistry: { address: "0x7d86EdFEdbE012F7fcE72A95F51fEbEa2f215785", deployBlock: 69566892 },
    // Deployed 2026-10-09 (QNTX ERC8183 vendor), tx 0x70f7962d0819787d717c5a6fc52fb12465698c89c9f223a21a2545931ba0b7d9.
    agenticCommerce: { address: "0xa3062BA91612782020EA0310De0e068D9bcEFF6a", deployBlock: 69568083 },
    // Deployed 2026-10-09, tx 0xf447861f60965b82562e99c4c8a348de31c34b4ec116a12e315ca97e1c025e16.
    scoreGateHook: { address: "0xbd5f1114092A92EF24Aa3ebE00e3c462f572eBFB", deployBlock: 69568091 },
    // Deployed 2026-10-10 (simulation MockKeystoneForwarder), tx 0x29472c41e3884805ba77a05ff469c068e1e65d6e69755fb7e82963c8999a7c38.
    creScorePublisher: { address: "0xEDAffF4855de733de33aF792b7DD4ddf1670A3c5", deployBlock: 69_722_712 },
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
