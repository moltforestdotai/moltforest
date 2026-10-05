/** Monad testnet access for the kit. The kit never touches mainnet. */
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
  type LocalAccount,
  type PublicClient,
} from "viem";
import { monadTestnet } from "viem/chains";
import { NETWORKS, receiptRegistryAbi } from "@moltforest/chain";

export const TESTNET = NETWORKS.testnet;
export const TESTNET_CAIP2 = `eip155:${TESTNET.chainId}` as const;
export const USDC = getAddress(TESTNET.usdc);
export const IDENTITY_REGISTRY = getAddress(TESTNET.identityRegistry);
export const REPUTATION_REGISTRY = getAddress(TESTNET.reputationRegistry);
export const RECEIPT_REGISTRY = getAddress(TESTNET.receiptRegistry!.address);

export const formatUsdc = (atomic: bigint) => formatUnits(atomic, 6);
export const formatMon = (wei: bigint) => formatEther(wei);

export function createTestnetClients(rpcUrl?: string) {
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: monadTestnet, transport }) as PublicClient;
  return {
    publicClient,
    walletClientFor: (account: LocalAccount) => createWalletClient({ account, chain: monadTestnet, transport }),
  };
}

export async function balancesOf(client: PublicClient, address: Address) {
  const [monWei, usdcAtomic] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
  ]);
  return { monWei, usdcAtomic };
}

/** The address that must sign receipts for an agent (its agent wallet, else its owner). */
export function receiptSignerOf(client: PublicClient, agentId: bigint): Promise<Address> {
  return client.readContract({ address: RECEIPT_REGISTRY, abi: receiptRegistryAbi, functionName: "signerOf", args: [agentId] });
}

/** true / false once mined; null when the transaction is unknown. */
export async function transactionSucceeded(client: PublicClient, hash: Hex): Promise<boolean | null> {
  try {
    return (await client.getTransactionReceipt({ hash })).status === "success";
  } catch {
    return null;
  }
}
