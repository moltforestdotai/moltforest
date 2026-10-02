/**
 * Receipts a demo provider issues after a paid job: a level-1 MoltForest receipt
 * (decision D06) whose `paymentRef` is the x402 settlement transaction, signed
 * by the provider agent's signer and submitted to the MoltForest API, which
 * relays it on-chain (D29). The client co-signs it later to raise it to level 2.
 */
import { getAddress, isAddressEqual, zeroAddress, type Address, type Hex, type LocalAccount, type PublicClient } from "viem";
import { identityRegistrySignerAbi, NETWORKS, receiptRegistryAbi } from "@moltforest/chain";
import {
  hashReceipt,
  newTaskId,
  receiptDomain,
  receiptToJson,
  signReceipt,
  ZERO_BYTES32,
  type Receipt,
  type ReceiptDomain,
  type ReceiptJson,
} from "@moltforest/receipts";

const TESTNET = NETWORKS.testnet;

export interface AgentAddresses {
  owner: Address;
  /** null when the agent has no agent wallet set. */
  wallet: Address | null;
}

/** On-chain lookups the demo agents need from the testnet registries. */
export interface AgentDirectory {
  /** The agent's owner and agent wallet; null when the agent does not exist. */
  addressesOf(agentId: bigint): Promise<AgentAddresses | null>;
  /** The address that must sign receipts for the agent (ReceiptRegistry.signerOf). */
  receiptSignerOf(agentId: bigint): Promise<Address>;
}

export function createAgentDirectory(client: PublicClient): AgentDirectory {
  const registry = getAddress(TESTNET.identityRegistry);
  return {
    async addressesOf(agentId) {
      const [owner, wallet] = await client.multicall({
        contracts: [
          { address: registry, abi: identityRegistrySignerAbi, functionName: "ownerOf", args: [agentId] },
          { address: registry, abi: identityRegistrySignerAbi, functionName: "getAgentWallet", args: [agentId] },
        ],
      });
      // ownerOf reverts for unknown agents (verified on testnet, see the erc-8004 note).
      if (owner.status === "failure") return null;
      if (wallet.status === "failure") throw wallet.error;
      return { owner: owner.result, wallet: isAddressEqual(wallet.result, zeroAddress) ? null : wallet.result };
    },
    async receiptSignerOf(agentId) {
      return client.readContract({
        address: getAddress(TESTNET.receiptRegistry!.address),
        abi: receiptRegistryAbi,
        functionName: "signerOf",
        args: [agentId],
      });
    },
  };
}

/** True when `payer` is the agent's owner or agent wallet. */
export function isAgentAddress(addresses: AgentAddresses, payer: Address): boolean {
  return isAddressEqual(addresses.owner, payer) || (addresses.wallet !== null && isAddressEqual(addresses.wallet, payer));
}

export interface ReceiptSubmission {
  ok: boolean;
  /** HTTP status from the MoltForest API, when it answered. */
  status?: number;
  error?: string;
}

export interface ReceiptSubmitBody {
  network: "testnet";
  receipt: ReceiptJson;
  providerSignature: Hex;
}

export type SubmitReceipt = (body: ReceiptSubmitBody) => Promise<ReceiptSubmission>;

export function createReceiptSubmitter(apiUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): SubmitReceipt {
  return async (body) => {
    try {
      const res = await fetchImpl(`${apiUrl}/v1/receipts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return { ok: true, status: res.status };
      const err = (await res.json().catch(() => null)) as { error?: { message?: unknown } } | null;
      const message = typeof err?.error?.message === "string" ? err.error.message : `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: message };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

export interface IssuedReceipt {
  network: "testnet";
  /** The ReceiptRegistry whose EIP-712 domain the signatures use. */
  registry: Address;
  chainId: number;
  /** EIP-712 digest; also the receipt's id on MoltForest and on-chain. */
  receiptHash: Hex;
  level: 1;
  receipt: ReceiptJson;
  providerSignature: Hex;
  /** Whether MoltForest accepted the receipt for anchoring. */
  submitted: ReceiptSubmission;
}

export interface JobFacts {
  clientAgentId: bigint;
  requestHash: Hex;
  resultHash: Hex;
  /** x402 settlement transaction hash. */
  paymentRef: Hex;
  startedAt: number;
  completedAt: number;
}

export class ReceiptIssuer {
  readonly domain: ReceiptDomain = receiptDomain(TESTNET.chainId, getAddress(TESTNET.receiptRegistry!.address));

  constructor(
    readonly providerAgentId: bigint,
    private readonly signer: LocalAccount,
    private readonly submit: SubmitReceipt,
  ) {}

  async issue(job: JobFacts): Promise<IssuedReceipt> {
    const receipt: Receipt = {
      taskId: newTaskId(),
      clientAgentId: job.clientAgentId,
      providerAgentId: this.providerAgentId,
      requestHash: job.requestHash,
      resultHash: job.resultHash,
      paymentRef: job.paymentRef,
      startedAt: BigInt(job.startedAt),
      completedAt: BigInt(job.completedAt),
      proofType: 0, // "none": a receipt is evidence a job happened, not a proof of its output (C4)
      proofRef: ZERO_BYTES32,
    };
    const providerSignature = await signReceipt(this.signer, receipt, this.domain);
    const json = receiptToJson(receipt);
    const submitted = await this.submit({ network: "testnet", receipt: json, providerSignature });
    return {
      network: "testnet",
      registry: this.domain.verifyingContract,
      chainId: this.domain.chainId,
      receiptHash: hashReceipt(receipt, this.domain),
      level: 1,
      receipt: json,
      providerSignature,
      submitted,
    };
  }
}
