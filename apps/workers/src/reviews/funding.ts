/**
 * How reviewer wallets were first funded (decision D31), from HyperSync.
 *
 * One pass over [0, head) per chunk of wallets, with two selections:
 * transactions sent *to* the wallets (the earliest successful one carrying MON
 * is the funding) and transactions sent *from* them (counted, and checked for a
 * transfer back to the funder). Funding through a contract (an internal
 * transfer) is invisible here; such wallets get status "none".
 */
import type { HyperSync } from "../payments/hypersync.js";

export interface HsTx {
  block_number: number;
  transaction_index: number;
  hash: string;
  from?: string | null;
  to?: string | null;
  value?: string | null;
  status?: number | null;
}

export interface FundingResult {
  address: string;
  status: "found" | "none";
  funder: string | null;
  fundingTx: string | null;
  fundingBlock: number | null;
  /** Wei, decimal string. */
  fundingValue: string | null;
  sweepTx: string | null;
  sentTxCount: number;
}

const FIELDS = { transaction: ["block_number", "transaction_index", "hash", "from", "to", "value", "status"] };

const isEarlier = (a: HsTx, b: HsTx) => a.block_number < b.block_number || (a.block_number === b.block_number && a.transaction_index < b.transaction_index);
const wei = (value: string | null | undefined): bigint => {
  try {
    return value ? BigInt(value) : 0n;
  } catch {
    return 0n;
  }
};

/** Pure: funding facts for `addresses` from the transactions that touch them. */
export function extractFunding(addresses: string[], txs: HsTx[]): FundingResult[] {
  const wanted = new Set(addresses);
  const first = new Map<string, HsTx>();
  const sent = new Map<string, HsTx[]>();
  for (const tx of txs) {
    if (tx.status !== 1) continue; // failed transactions move no MON
    const from = tx.from?.toLowerCase() ?? null;
    const to = tx.to?.toLowerCase() ?? null;
    if (to && wanted.has(to) && from && from !== to && wei(tx.value) > 0n) {
      const current = first.get(to);
      if (!current || isEarlier(tx, current)) first.set(to, tx);
    }
    if (from && wanted.has(from)) {
      let list = sent.get(from);
      if (!list) sent.set(from, (list = []));
      list.push(tx);
    }
  }
  return addresses.map((address) => {
    const f = first.get(address);
    const outgoing = (sent.get(address) ?? []).sort((a, b) => (isEarlier(a, b) ? -1 : 1));
    const funder = f?.from?.toLowerCase() ?? null;
    const sweep = funder ? outgoing.find((tx) => tx.to?.toLowerCase() === funder && wei(tx.value) > 0n && !isEarlier(tx, f!)) : undefined;
    return {
      address,
      status: f ? "found" : "none",
      funder,
      fundingTx: f?.hash.toLowerCase() ?? null,
      fundingBlock: f?.block_number ?? null,
      fundingValue: f ? wei(f.value).toString() : null,
      sweepTx: sweep?.hash.toLowerCase() ?? null,
      sentTxCount: outgoing.length,
    };
  });
}

/** Looks up funding for `addresses` (lowercase) over blocks [0, head). */
export async function lookupFunding(hs: HyperSync, chainId: number, addresses: string[], head: number): Promise<FundingResult[]> {
  // A transfer between two wallets of the chunk matches both selections: keep it once.
  const txs = new Map<string, HsTx>();
  let next = 0;
  while (next < head) {
    const res = await hs.query(chainId, {
      from_block: next,
      to_block: head,
      transactions: [{ to: addresses }, { from: addresses }],
      field_selection: FIELDS,
      join_mode: "JoinNothing",
    });
    for (const batch of (res.data ?? []) as { transactions?: HsTx[] }[]) for (const tx of batch.transactions ?? []) txs.set(tx.hash, tx);
    if (!res.next_block || res.next_block <= next) break;
    next = res.next_block;
  }
  return extractFunding(addresses, [...txs.values()]);
}
