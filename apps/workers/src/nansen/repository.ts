import type pg from "pg";
import { table } from "../enrich/repository.js";
import type { NansenRelatedWallet } from "./client.js";

export function createNansenRepository(db: pg.Pool, schemas: { app: string }) {
  const wallets = table(schemas.app, "nansen_wallet");
  const relations = table(schemas.app, "nansen_relation");
  const funding = table(schemas.app, "wallet_funding");
  const assessment = table(schemas.app, "review_assessment");

  return {
    /** Lookups answered since midnight UTC: the daily credit budget counts these. */
    async lookupsToday(chainId: number): Promise<number> {
      const r = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${wallets}
          WHERE chain_id = $1 AND status = 'ok' AND fetched_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        [chainId],
      );
      return r.rows[0]?.n ?? 0;
    },

    /**
     * Reviewer wallets to look up next, most useful first (decision D47):
     * 0. reviewers of the focus agents (e.g. the ones a demo shows), when any are set;
     * 1. wallets with a counted review, which a hidden link could merge;
     * 2. wallets whose first funder our scan could not see (funded through a contract);
     * 3. one wallet per address that funded two or more reviewers, whose answer names that funder.
     * Answered wallets are skipped; failed ones come back after their backoff.
     */
    async dueWallets(chainId: number, limit: number, maxAttempts: number, focusAgents: string[] = []): Promise<string[]> {
      const r = await db.query<{ address: string }>(
        `WITH candidates AS (
           SELECT DISTINCT client AS address, 0 AS tier FROM ${assessment} WHERE chain_id = $1 AND agent_id = ANY($4::numeric[])
           UNION ALL
           SELECT DISTINCT client AS address, 1 AS tier FROM ${assessment} WHERE chain_id = $1 AND counted
           UNION ALL
           SELECT address, 2 FROM ${funding} WHERE chain_id = $1 AND status = 'none'
           UNION ALL
           SELECT address, 3 FROM (
             SELECT DISTINCT ON (funder) address FROM ${funding}
              WHERE chain_id = $1 AND status = 'found'
                AND funder IN (SELECT funder FROM ${funding} WHERE chain_id = $1 AND status = 'found' GROUP BY funder HAVING count(*) >= 2)
              ORDER BY funder, address
           ) one_per_funder
         )
         SELECT c.address FROM candidates c
           LEFT JOIN ${wallets} n ON n.chain_id = $1 AND n.address = c.address
          WHERE c.address ~ '^0x[0-9a-f]{40}$'
            AND (n.address IS NULL OR (n.status = 'error' AND n.next_fetch_at <= now() AND n.attempts < $3))
          GROUP BY c.address
          ORDER BY min(c.tier), c.address
          LIMIT $2`,
        [chainId, limit, maxAttempts, focusAgents],
      );
      return r.rows.map((row) => row.address);
    },

    /** Replaces what is stored for one wallet with Nansen's answer. An answer is kept for good: first funders do not change. */
    async saveOk(chainId: number, address: string, related: NansenRelatedWallet[]): Promise<void> {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query(`DELETE FROM ${relations} WHERE chain_id = $1 AND wallet = $2`, [chainId, address]);
        if (related.length > 0) {
          const values: unknown[] = [chainId, address];
          const rows = related.map((rel, j) => {
            values.push(rel.address, rel.relation, rel.label, rel.txHash, rel.blockTime);
            const o = j * 5 + 2;
            return `($1, $2, $${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}::timestamptz, now())`;
          });
          await client.query(
            `INSERT INTO ${relations} (chain_id, wallet, related, relation, label, tx_hash, block_time, fetched_at)
             VALUES ${rows.join(", ")} ON CONFLICT DO NOTHING`,
            values,
          );
        }
        await client.query(
          `INSERT INTO ${wallets} (chain_id, address, status, relation_count, attempts, error, fetched_at, next_fetch_at)
           VALUES ($1, $2, 'ok', $3, 1, NULL, now(), 'infinity')
           ON CONFLICT (chain_id, address) DO UPDATE SET
             status = 'ok', relation_count = EXCLUDED.relation_count, attempts = ${wallets}.attempts + 1,
             error = NULL, fetched_at = now(), next_fetch_at = 'infinity'`,
          [chainId, address, related.length],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },

    /** Records a failed lookup. Transient failures come back after 1 h, 2 h, 4 h…; the rest never do. */
    async saveError(chainId: number, address: string, error: string, transient: boolean): Promise<void> {
      await db.query(
        `INSERT INTO ${wallets} (chain_id, address, status, attempts, error, fetched_at, next_fetch_at)
         VALUES ($1, $2, 'error', 1, $3, now(), CASE WHEN $4 THEN now() + interval '1 hour' ELSE 'infinity'::timestamptz END)
         ON CONFLICT (chain_id, address) DO UPDATE SET
           status = 'error', attempts = ${wallets}.attempts + 1, error = EXCLUDED.error, fetched_at = now(),
           next_fetch_at = CASE WHEN $4 THEN now() + interval '1 hour' * power(2, ${wallets}.attempts) ELSE 'infinity'::timestamptz END`,
        [chainId, address, error.slice(0, 500), transient],
      );
    },
  };
}

export type NansenRepository = ReturnType<typeof createNansenRepository>;
