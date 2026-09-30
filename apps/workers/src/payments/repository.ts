import type pg from "pg";
import { table } from "../enrich/repository.js";
import type { Payment } from "./classify.js";

const ZERO = "0x0000000000000000000000000000000000000000";

export function createPaymentRepository(db: pg.Pool, schemas: { indexer: string; app: string }) {
  const agents = table(schemas.indexer, "Agent");
  const addresses = table(schemas.app, "payment_address");
  const cursors = table(schemas.app, "payment_cursor");
  const payments = table(schemas.app, "x402_payment");

  return {
    /** Adds every agent owner and agent wallet on the chain; returns how many are new. */
    async syncAddresses(chainId: number): Promise<number> {
      const r = await db.query(
        `INSERT INTO ${addresses} (chain_id, address)
         SELECT DISTINCT $1::int, addr FROM (
           SELECT lower(owner) AS addr FROM ${agents} WHERE chain_id = $1
           UNION SELECT lower(agent_wallet) FROM ${agents} WHERE chain_id = $1 AND agent_wallet IS NOT NULL
         ) s
         WHERE addr ~ '^0x[0-9a-f]{40}$' AND addr <> $2
         ON CONFLICT DO NOTHING`,
        [chainId, ZERO],
      );
      return r.rowCount ?? 0;
    },

    async addresses(chainId: number, caughtUp: boolean, limit = 1_000_000): Promise<string[]> {
      const r = await db.query<{ address: string }>(
        `SELECT address FROM ${addresses} WHERE chain_id = $1 AND caught_up = $2 ORDER BY address LIMIT $3`,
        [chainId, caughtUp, limit],
      );
      return r.rows.map((row) => row.address);
    },

    async markCaughtUp(chainId: number, list: string[]): Promise<void> {
      await db.query(`UPDATE ${addresses} SET caught_up = true WHERE chain_id = $1 AND address = ANY($2::text[])`, [chainId, list]);
    },

    async getCursor(chainId: number): Promise<number | null> {
      const r = await db.query<{ next_block: string }>(`SELECT next_block::text FROM ${cursors} WHERE chain_id = $1`, [chainId]);
      return r.rows[0] ? Number(r.rows[0].next_block) : null;
    },

    async setCursor(chainId: number, nextBlock: number): Promise<void> {
      await db.query(
        `INSERT INTO ${cursors} (chain_id, next_block, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (chain_id) DO UPDATE SET next_block = EXCLUDED.next_block, updated_at = now()`,
        [chainId, nextBlock],
      );
    },

    /** Idempotent: a payment already stored is left as is. Returns how many were new. */
    async savePayments(list: Payment[]): Promise<number> {
      let inserted = 0;
      for (let i = 0; i < list.length; i += 500) {
        const chunk = list.slice(i, i + 500);
        const values: unknown[] = [];
        const rows = chunk.map((p, j) => {
          values.push(p.chainId, p.txHash, p.logIndex, p.blockNumber, p.blockTime, p.asset, p.payer, p.payee, p.amount, p.facilitator);
          const o = j * 10;
          return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}, $${o + 9}, $${o + 10})`;
        });
        const r = await db.query(
          `INSERT INTO ${payments} (chain_id, tx_hash, log_index, block_number, block_time, asset, payer, payee, amount, facilitator)
           VALUES ${rows.join(", ")} ON CONFLICT DO NOTHING`,
          values,
        );
        inserted += r.rowCount ?? 0;
      }
      return inserted;
    },
  };
}

export type PaymentRepository = ReturnType<typeof createPaymentRepository>;
