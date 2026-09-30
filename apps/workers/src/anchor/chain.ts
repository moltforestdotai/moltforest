import {
  BaseError,
  ContractFunctionRevertedError,
  WaitForTransactionReceiptTimeoutError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { receiptRegistryAbi, type NetworkConfig } from "@moltforest/chain";
import type { DueReceipt } from "./repository.js";

export type SimulateResult = { ok: true } | { ok: false; revert: string };
export type TxOutcome = { status: "success" | "reverted"; blockNumber: bigint; blockTime: Date } | { status: "pending" };

/** What the relayer needs from the chain; faked in tests. */
export interface AnchorChain {
  relayer: Address;
  balance(): Promise<bigint>;
  levelOf(receiptHash: Hex): Promise<number>;
  simulate(r: DueReceipt): Promise<SimulateResult>;
  send(r: DueReceipt): Promise<Hex>;
  /** Waits up to `timeoutMs`; "pending" when the transaction is not mined (or not known) yet. */
  wait(txHash: Hex, timeoutMs: number): Promise<TxOutcome>;
}

function anchorArgs(r: DueReceipt) {
  return [
    {
      taskId: r.taskId,
      clientAgentId: r.clientAgentId,
      providerAgentId: r.providerAgentId,
      requestHash: r.requestHash,
      resultHash: r.resultHash,
      paymentRef: r.paymentRef,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      proofType: r.proofType,
      proofRef: r.proofRef,
    },
    r.providerSignature,
    r.level === 2 && r.clientSignature ? r.clientSignature : "0x",
  ] as const;
}

/** The contract's custom error name when `err` is a revert of ours, else null (RPC or transport failure). */
export function revertName(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return null;
  return revert.data?.errorName ?? revert.reason ?? "reverted";
}

export function createAnchorChain(opts: { network: NetworkConfig; rpcUrl: string; registry: Address; privateKey: Hex }): AnchorChain {
  const chain = defineChain({
    id: opts.network.chainId,
    name: opts.network.label,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [opts.rpcUrl] } },
  });
  const transport = http(opts.rpcUrl, { timeout: 20_000, retryCount: 2 });
  const account = privateKeyToAccount(opts.privateKey);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account });
  const contract = { address: opts.registry, abi: receiptRegistryAbi } as const;

  return {
    relayer: account.address,
    balance: () => publicClient.getBalance({ address: account.address }),
    async levelOf(receiptHash) {
      return publicClient.readContract({ ...contract, functionName: "levelOf", args: [receiptHash] });
    },
    async simulate(r) {
      try {
        await publicClient.simulateContract({ ...contract, account, functionName: "anchor", args: anchorArgs(r) });
        return { ok: true };
      } catch (err) {
        const name = revertName(err);
        if (name) return { ok: false, revert: name };
        throw err;
      }
    },
    send(r) {
      return walletClient.writeContract({ ...contract, functionName: "anchor", args: anchorArgs(r) });
    },
    async wait(txHash, timeoutMs) {
      try {
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: timeoutMs, pollingInterval: 1_000 });
        const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
        return { status: receipt.status, blockNumber: receipt.blockNumber, blockTime: new Date(Number(block.timestamp) * 1000) };
      } catch (err) {
        if (err instanceof WaitForTransactionReceiptTimeoutError) return { status: "pending" };
        throw err;
      }
    },
  };
}
