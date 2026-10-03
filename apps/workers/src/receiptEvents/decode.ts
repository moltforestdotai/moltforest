/**
 * Receipts anchored on the ReceiptRegistry by anyone (D29: "the indexer adds
 * receipts anchored by others"). Each ReceiptAnchored / ReceiptCoSigned log is
 * paired with its transaction; the `anchor(receipt, providerSig, clientSig)`
 * calldata holds the full receipt and the signatures, which the contract has
 * already verified. A decoded receipt is kept only when its EIP-712 hash equals
 * the logged receiptHash.
 */
import { decodeEventLog, decodeFunctionData, toEventSelector, type Address, type Hex } from "viem";
import { receiptRegistryAbi } from "@moltforest/chain";
import { hashReceipt, receiptDomain, receiptToJson, type Receipt, type ReceiptJson } from "@moltforest/receipts";

export const RECEIPT_ANCHORED = toEventSelector(receiptRegistryAbi.find((i) => i.type === "event" && i.name === "ReceiptAnchored")!);
export const RECEIPT_COSIGNED = toEventSelector(receiptRegistryAbi.find((i) => i.type === "event" && i.name === "ReceiptCoSigned")!);

export interface HsLog {
  block_number: number;
  log_index: number;
  transaction_hash: string;
  address: string;
  topic0?: string | null;
  topic1?: string | null;
  topic2?: string | null;
  topic3?: string | null;
  data?: string | null;
}

export interface HsTx {
  hash: string;
  input?: string | null;
}

export interface HsBlock {
  number: number;
  timestamp: string | number;
}

export interface ChainReceipt {
  receiptHash: Hex;
  /** Level after this event: 1 for a provider-only anchor, 2 once co-signed. */
  level: 1 | 2;
  receipt: ReceiptJson;
  providerSignature: Hex;
  clientSignature: Hex | null;
  /** From ReceiptAnchored; null for ReceiptCoSigned, which only names the client signer. */
  providerSigner: Address | null;
  clientSigner: Address | null;
  tx: Hex;
  block: number;
  logIndex: number;
  blockTime: Date;
}

export interface DecodeResult {
  receipts: ChainReceipt[];
  /** Logs whose transaction did not call `anchor` directly (e.g. through a smart account) or did not match. */
  undecodable: { tx: string; receiptHash: string }[];
}

const toDate = (ts: string | number) => new Date(Number(ts) * 1000);

export function decodeReceiptEvents(
  chainId: number,
  registry: Address,
  batches: { logs?: HsLog[]; transactions?: HsTx[]; blocks?: HsBlock[] }[],
): DecodeResult {
  const inputs = new Map<string, string>();
  const times = new Map<number, Date>();
  const logs: HsLog[] = [];
  for (const b of batches) {
    for (const t of b.transactions ?? []) if (t.input) inputs.set(t.hash.toLowerCase(), t.input);
    for (const bl of b.blocks ?? []) times.set(Number(bl.number), toDate(bl.timestamp));
    for (const l of b.logs ?? []) if (l.address.toLowerCase() === registry.toLowerCase()) logs.push(l);
  }
  logs.sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index);

  const domain = receiptDomain(chainId, registry);
  const out: DecodeResult = { receipts: [], undecodable: [] };
  for (const log of logs) {
    const topics = [log.topic0, log.topic1, log.topic2, log.topic3].filter((t): t is string => !!t) as [Hex, ...Hex[]];
    let event;
    try {
      event = decodeEventLog({ abi: receiptRegistryAbi, data: (log.data ?? "0x") as Hex, topics });
    } catch {
      continue; // not one of ours
    }
    if (event.eventName !== "ReceiptAnchored" && event.eventName !== "ReceiptCoSigned") continue;
    const receiptHash = event.args.receiptHash.toLowerCase() as Hex;
    const tx = log.transaction_hash.toLowerCase() as Hex;

    let call;
    try {
      call = decodeFunctionData({ abi: receiptRegistryAbi, data: (inputs.get(tx) ?? "0x") as Hex });
    } catch {
      out.undecodable.push({ tx, receiptHash });
      continue;
    }
    if (call.functionName !== "anchor") {
      out.undecodable.push({ tx, receiptHash });
      continue;
    }
    const [r, providerSig, clientSig] = call.args;
    const receipt = r as Receipt;
    if (hashReceipt(receipt, domain).toLowerCase() !== receiptHash) {
      out.undecodable.push({ tx, receiptHash });
      continue;
    }

    const lower = (a: string | null) => (a ? (a.toLowerCase() as Address) : null);
    const anchoredArgs = event.eventName === "ReceiptAnchored" ? event.args : null;
    const coSigned = anchoredArgs ? anchoredArgs.level === 2 : true;
    out.receipts.push({
      receiptHash,
      level: coSigned ? 2 : 1,
      receipt: receiptToJson(receipt),
      providerSignature: providerSig.toLowerCase() as Hex,
      clientSignature: coSigned && clientSig && clientSig !== "0x" ? (clientSig.toLowerCase() as Hex) : null,
      providerSigner: anchoredArgs ? lower(anchoredArgs.providerSigner) : null,
      clientSigner: coSigned ? lower(event.args.clientSigner) : null,
      tx,
      block: log.block_number,
      logIndex: log.log_index,
      blockTime: times.get(log.block_number) ?? new Date(0),
    });
  }
  return out;
}
