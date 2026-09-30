import type { Logger } from "pino";
import { AUTHORIZATION_USED, TRANSFER, extractPayments, type HsBatch, type Payment } from "./classify.js";
import type { HyperSync } from "./hypersync.js";
import type { PaymentRepository } from "./repository.js";

export interface PaymentsOptions {
  chainId: number;
  /** USDC contract on this chain. */
  usdc: string;
  /** Addresses per HyperSync selection. */
  chunkSize?: number;
  /** New addresses backfilled per tick (history from block 0). */
  backfillBatch?: number;
}

export interface PaymentsStats {
  newAddresses: number;
  backfilled: number;
  scannedTo: number;
  saved: number;
}

const FIELDS = {
  log: ["block_number", "log_index", "transaction_hash", "address", "topic0", "topic1", "topic2", "data"],
  transaction: ["hash", "from"],
  block: ["number", "timestamp"],
};
const pad = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;

/**
 * Payments that touch `addresses` in blocks [from, to). Two selections per
 * query: USDC received by the addresses, and authorizations they signed. JoinAll
 * returns every log of the matching transactions, so each Transfer comes with
 * its AuthorizationUsed and the pair can be classified.
 */
async function scanRange(
  hs: HyperSync,
  opts: PaymentsOptions,
  addresses: string[],
  from: number,
  to: number,
  tracked: (address: string) => boolean,
): Promise<Payment[]> {
  const topics = addresses.map(pad);
  const found: Payment[] = [];
  let next = from;
  while (next < to) {
    const res = await hs.query(opts.chainId, {
      from_block: next,
      to_block: to,
      logs: [
        { address: [opts.usdc], topics: [[TRANSFER], [], topics] },
        { address: [opts.usdc], topics: [[AUTHORIZATION_USED], topics] },
      ],
      field_selection: FIELDS,
      join_mode: "JoinAll",
    });
    found.push(...extractPayments(opts.chainId, opts.usdc, (res.data ?? []) as HsBatch[], tracked));
    if (!res.next_block || res.next_block <= next) break;
    next = res.next_block;
  }
  return found;
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * One pass for one chain: track new agent addresses, backfill their history up
 * to the cursor, then scan every caught-up address from the cursor to the head.
 * Invariant: a caught-up address is complete for all blocks below the cursor.
 */
export async function runPaymentsTick(deps: { repo: PaymentRepository; hs: HyperSync; logger?: Logger }, opts: PaymentsOptions): Promise<PaymentsStats> {
  const { repo, hs } = deps;
  const chunkSize = opts.chunkSize ?? 1000;
  const stats: PaymentsStats = { newAddresses: await repo.syncAddresses(opts.chainId), backfilled: 0, scannedTo: 0, saved: 0 };

  let cursor = await repo.getCursor(opts.chainId);
  if (cursor === null) {
    cursor = await hs.height(opts.chainId);
    await repo.setCursor(opts.chainId, cursor);
  }

  const known = new Set([...(await repo.addresses(opts.chainId, true)), ...(await repo.addresses(opts.chainId, false))]);
  const tracked = (address: string) => known.has(address);

  // Backfill: new addresses, from genesis up to the cursor.
  const pending = await repo.addresses(opts.chainId, false, opts.backfillBatch ?? 5000);
  for (const chunk of chunks(pending, chunkSize)) {
    const found = await scanRange(hs, opts, chunk, 0, cursor, tracked);
    stats.saved += await repo.savePayments(found);
    await repo.markCaughtUp(opts.chainId, chunk);
    stats.backfilled += chunk.length;
    deps.logger?.info({ chainId: opts.chainId, addresses: chunk.length, payments: found.length }, "payments backfill chunk done");
  }

  // Incremental: every caught-up address, from the cursor to the current head.
  const head = await hs.height(opts.chainId);
  if (head > cursor) {
    const caughtUp = await repo.addresses(opts.chainId, true);
    for (const chunk of chunks(caughtUp, chunkSize)) {
      stats.saved += await repo.savePayments(await scanRange(hs, opts, chunk, cursor, head, tracked));
    }
    await repo.setCursor(opts.chainId, head);
    cursor = head;
  }
  stats.scannedTo = cursor;
  return stats;
}
