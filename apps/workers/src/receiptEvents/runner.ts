import type { Logger } from "pino";
import type { Address } from "viem";
import type { HyperSync } from "../payments/hypersync.js";
import { decodeReceiptEvents, RECEIPT_ANCHORED, RECEIPT_COSIGNED, type HsBlock, type HsLog, type HsTx } from "./decode.js";
import type { ReceiptEventRepository } from "./repository.js";

export const CURSOR_NAME = "receipt_events";

export interface ReceiptEventsOptions {
  chainId: number;
  registry: Address;
  /** The registry's deployment block: where the first scan starts. */
  deployBlock: number;
}

export interface ReceiptEventsStats {
  scannedTo: number;
  inserted: number;
  updated: number;
  undecodable: number;
  orphans: number;
}

const FIELDS = {
  log: ["block_number", "log_index", "transaction_hash", "address", "topic0", "topic1", "topic2", "topic3", "data"],
  transaction: ["hash", "input"],
  block: ["number", "timestamp"],
};

/** Scans the registry's ReceiptAnchored / ReceiptCoSigned logs from the cursor to the head, page by page. */
export async function runReceiptEventsTick(
  deps: { repo: ReceiptEventRepository; hs: HyperSync; logger?: Logger },
  opts: ReceiptEventsOptions,
): Promise<ReceiptEventsStats> {
  const { repo, hs } = deps;
  let next = (await repo.getCursor(CURSOR_NAME, opts.chainId)) ?? opts.deployBlock;
  const head = await hs.height(opts.chainId);
  const stats: ReceiptEventsStats = { scannedTo: next, inserted: 0, updated: 0, undecodable: 0, orphans: 0 };

  while (next < head) {
    const res = await hs.query(opts.chainId, {
      from_block: next,
      to_block: head,
      logs: [{ address: [opts.registry], topics: [[RECEIPT_ANCHORED, RECEIPT_COSIGNED]] }],
      field_selection: FIELDS,
      join_mode: "JoinAll",
    });
    const decoded = decodeReceiptEvents(opts.chainId, opts.registry, (res.data ?? []) as { logs?: HsLog[]; transactions?: HsTx[]; blocks?: HsBlock[] }[]);
    for (const r of decoded.receipts) {
      const outcome = await repo.apply(opts.chainId, opts.registry, r);
      if (outcome === "inserted") stats.inserted++;
      else if (outcome === "updated") stats.updated++;
      else stats.orphans++;
    }
    stats.undecodable += decoded.undecodable.length;
    for (const u of decoded.undecodable) deps.logger?.warn(u, "anchored receipt not decodable from its transaction");

    const reached = res.next_block && res.next_block > next ? Math.min(res.next_block, head) : head;
    await repo.setCursor(CURSOR_NAME, opts.chainId, reached);
    next = reached;
  }
  stats.scannedTo = next;
  return stats;
}
