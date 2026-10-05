import { table, type Db } from "../db.js";
import { isMissingRelation } from "../repositories/sync.js";

/** Per-agent facts the evidence profile needs beyond the agent summary. */
export interface EvidenceStats {
  receipts: { withPayment: number; highestLevel: number | null };
  /** Payments received from other addresses (self-payments excluded). Amounts in USDC base units. */
  received: { distinctPayers: number; largestAmount: string | null; firstBlock: string | null; lastBlock: string | null };
}

export const EMPTY_STATS: EvidenceStats = {
  receipts: { withPayment: 0, highestLevel: null },
  received: { distinctPayers: 0, largestAmount: null, firstBlock: null, lastBlock: null },
};

export function createEvidenceRepository(db: Db, appSchema: string) {
  const receipts = table(appSchema, "receipt");
  const payments = table(appSchema, "x402_payment");

  async function orEmpty<T>(query: () => Promise<T>, empty: T): Promise<T> {
    try {
      return await query();
    } catch (err) {
      if (isMissingRelation(err)) return empty;
      throw err;
    }
  }

  return {
    /** `addresses`: the agent's owner and agent wallet, lowercase. */
    async stats(chainId: number, agentId: string, addresses: string[]): Promise<EvidenceStats> {
      const [r, p] = await Promise.all([
        orEmpty(
          async () =>
            (
              await db.query<{ with_payment: string; highest: number | null }>(
                `SELECT count(*) FILTER (WHERE EXISTS (
                          SELECT 1 FROM ${payments} x WHERE x.chain_id = r.chain_id AND x.tx_hash = r.payment_ref))::text AS with_payment,
                        max(r.level) AS highest
                   FROM ${receipts} r WHERE r.chain_id = $1 AND r.provider_agent_id = $2`,
                [chainId, agentId],
              )
            ).rows[0],
          undefined,
        ),
        orEmpty(
          async () =>
            (
              await db.query<{ payers: string; largest: string | null; first_block: string | null; last_block: string | null }>(
                `SELECT count(DISTINCT payer)::text AS payers, max(amount)::text AS largest,
                        min(block_number)::text AS first_block, max(block_number)::text AS last_block
                   FROM ${payments}
                  WHERE chain_id = $1 AND payee = ANY($2::text[]) AND NOT (payer = ANY($2::text[]))`,
                [chainId, addresses],
              )
            ).rows[0],
          undefined,
        ),
      ]);
      return {
        receipts: { withPayment: Number(r?.with_payment ?? 0), highestLevel: r?.highest ?? null },
        received: {
          distinctPayers: Number(p?.payers ?? 0),
          largestAmount: p?.largest ?? null,
          firstBlock: p?.first_block ?? null,
          lastBlock: p?.last_block ?? null,
        },
      };
    },
  };
}

export type EvidenceRepository = ReturnType<typeof createEvidenceRepository>;
