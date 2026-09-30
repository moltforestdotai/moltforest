/**
 * Turns HyperSync logs into x402-style payments (decision D33).
 *
 * x402 "exact" on EVM settles with USDC `transferWithAuthorization` (EIP-3009),
 * which emits `AuthorizationUsed(authorizer, nonce)` and then
 * `Transfer(authorizer → payTo, value)` in the same transaction. A payment is
 * that pair. Plain transfers (no authorization) are not payments here.
 */

export const AUTHORIZATION_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
export const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface HsLog {
  block_number: number;
  log_index: number;
  transaction_hash: string;
  address: string;
  topic0?: string | null;
  topic1?: string | null;
  topic2?: string | null;
  data?: string | null;
}
export interface HsTransaction {
  hash: string;
  from?: string | null;
}
export interface HsBlock {
  number: number;
  timestamp: string | number;
}
export interface HsBatch {
  logs?: HsLog[];
  transactions?: HsTransaction[];
  blocks?: HsBlock[];
}

export interface Payment {
  chainId: number;
  txHash: string;
  /** Log index of the Transfer. */
  logIndex: number;
  blockNumber: number;
  blockTime: Date;
  asset: string;
  payer: string;
  payee: string;
  /** Token base units. */
  amount: string;
  facilitator: string | null;
}

const topicAddress = (topic: string | null | undefined): string | null =>
  topic && topic.length === 66 ? `0x${topic.slice(26)}`.toLowerCase() : null;

export function extractPayments(chainId: number, asset: string, batches: HsBatch[], tracked: (address: string) => boolean): Payment[] {
  const token = asset.toLowerCase();
  const logsByTx = new Map<string, HsLog[]>();
  const senderByTx = new Map<string, string>();
  const timeByBlock = new Map<number, Date>();
  for (const batch of batches) {
    for (const log of batch.logs ?? []) {
      if (log.address?.toLowerCase() !== token) continue;
      const list = logsByTx.get(log.transaction_hash) ?? [];
      list.push(log);
      logsByTx.set(log.transaction_hash, list);
    }
    for (const tx of batch.transactions ?? []) if (tx.from) senderByTx.set(tx.hash, tx.from.toLowerCase());
    for (const block of batch.blocks ?? []) timeByBlock.set(block.number, new Date(Number(BigInt(block.timestamp)) * 1000));
  }

  const payments = new Map<string, Payment>();
  for (const [txHash, logs] of logsByTx) {
    logs.sort((a, b) => a.log_index - b.log_index);
    const used = new Set<number>();
    for (const auth of logs) {
      if (auth.topic0 !== AUTHORIZATION_USED) continue;
      const payer = topicAddress(auth.topic1);
      if (!payer) continue;
      // The Transfer that spends this authorization: from the authorizer, normally right after it.
      const fromPayer = logs.filter((l) => l.topic0 === TRANSFER && topicAddress(l.topic1) === payer && !used.has(l.log_index));
      const transfer = fromPayer.find((l) => l.log_index > auth.log_index) ?? fromPayer[0];
      if (!transfer) continue;
      used.add(transfer.log_index);
      const payee = topicAddress(transfer.topic2);
      if (!payee || (!tracked(payer) && !tracked(payee))) continue;
      const blockTime = timeByBlock.get(transfer.block_number);
      if (!blockTime) continue;
      payments.set(`${txHash}:${transfer.log_index}`, {
        chainId,
        txHash: txHash.toLowerCase(),
        logIndex: transfer.log_index,
        blockNumber: transfer.block_number,
        blockTime,
        asset: token,
        payer,
        payee,
        amount: BigInt(transfer.data && transfer.data !== "0x" ? transfer.data : "0x0").toString(),
        facilitator: senderByTx.get(txHash) ?? null,
      });
    }
  }
  return [...payments.values()];
}
