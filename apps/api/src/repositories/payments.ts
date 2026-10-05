import { formatUnits } from "viem";
import { networkByChainId } from "@moltforest/chain";
import type { AgentPaymentSummary, AgentPaymentView, AgentPaymentsResponse, PaymentDirection, PaymentView } from "@moltforest/types";
import { table, type Db } from "../db.js";
import { isMissingRelation } from "./sync.js";

const USDC_DECIMALS = 6;
const MAX_AGENT_IDS = 10;

export const EMPTY_PAYMENT_SUMMARY: AgentPaymentSummary = {
  receivedFromOthers: 0,
  sent: 0,
  selfPayments: 0,
  receivedAmount: "0",
  sentAmount: "0",
  lastPaymentAt: null,
};

export interface AgentAddresses {
  agentId: string;
  owner: string;
  wallet: string | null;
}

export interface PaymentCursor {
  blockNumber: string;
  txHash: string;
  logIndex: number;
}

interface PaymentRow {
  chain_id: number;
  tx_hash: string;
  log_index: number;
  block_number: string;
  block_time: Date;
  asset: string;
  payer: string;
  payee: string;
  amount: string;
  facilitator: string | null;
}

const usdc = (units: string) => formatUnits(BigInt(units), USDC_DECIMALS);
const lower = (a: string | null) => (a ? a.toLowerCase() : null);

export function createPaymentRepository(db: Db, schemas: { indexer: string; app: string }) {
  const payments = table(schemas.app, "x402_payment");
  const agents = table(schemas.indexer, "Agent");
  const receipts = table(schemas.app, "receipt");
  const assessments = table(schemas.app, "review_assessment");
  const feedback = table(schemas.indexer, "Feedback");

  /** Reviews attached to each payment transaction on one chain (from the review assessment). */
  async function reviewsByTransaction(chainId: number, txHashes: string[]): Promise<Map<string, PaymentView["reviews"]>> {
    const out = new Map<string, PaymentView["reviews"]>();
    if (txHashes.length === 0) return out;
    try {
      const r = await db.query<{
        tx: string;
        agent_id: string;
        client: string;
        feedback_index: string;
        endpoint: string | null;
        counted: boolean;
        value: string | null;
        value_decimals: number | null;
        tag1: string | null;
      }>(
        `SELECT ra.link->>'paymentTx' AS tx, ra.agent_id::text, ra.client, ra.feedback_index::text, ra.link->>'endpoint' AS endpoint,
                ra.counted, f.value::text, f.value_decimals, f.tag1
           FROM ${assessments} ra
           LEFT JOIN ${feedback} f
             ON f.chain_id = ra.chain_id AND f.agent_id = ra.agent_id::text AND lower(f.client) = ra.client AND f.feedback_index = ra.feedback_index
          WHERE ra.chain_id = $1 AND ra.link->>'paymentTx' = ANY($2::text[])`,
        [chainId, txHashes],
      );
      for (const row of r.rows) {
        out.set(row.tx, [
          ...(out.get(row.tx) ?? []),
          {
            agentId: row.agent_id,
            client: row.client,
            feedbackIndex: row.feedback_index,
            endpoint: row.endpoint,
            counted: row.counted,
            value: row.value,
            valueDecimals: row.value_decimals,
            tag1: row.tag1,
          },
        ]);
      }
    } catch (err) {
      if (!isMissingRelation(err)) throw err;
    }
    return out;
  }

  /** Receipt hashes per payment transaction on one chain (receipt.payment_ref = tx hash). */
  async function receiptsByTransaction(chainId: number, txHashes: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (txHashes.length === 0) return out;
    try {
      const r = await db.query<{ payment_ref: string; hashes: string[] }>(
        `SELECT payment_ref, array_agg(receipt_hash ORDER BY receipt_hash) AS hashes
           FROM ${receipts} WHERE chain_id = $1 AND payment_ref = ANY($2::text[]) GROUP BY payment_ref`,
        [chainId, txHashes],
      );
      for (const row of r.rows) out.set(row.payment_ref, row.hashes);
    } catch (err) {
      if (!isMissingRelation(err)) throw err;
    }
    return out;
  }

  /** Agent ids (first few) and counts for each address: agents it owns or is the wallet of. */
  async function agentsByAddress(chainId: number, addresses: string[]): Promise<Map<string, { ids: string[]; count: number }>> {
    const out = new Map<string, { ids: string[]; count: number }>();
    if (addresses.length === 0) return out;
    const r = await db.query<{ address: string; ids: string[]; count: string }>(
      `SELECT x.address, (array_agg(a.agent_id::text ORDER BY a.agent_id))[1:${MAX_AGENT_IDS}] AS ids, count(a.agent_id)::text AS count
         FROM unnest($2::text[]) AS x(address)
         JOIN ${agents} a ON a.chain_id = $1 AND (lower(a.owner) = x.address OR lower(a.agent_wallet) = x.address)
        GROUP BY x.address`,
      [chainId, addresses],
    );
    for (const row of r.rows) out.set(row.address, { ids: row.ids, count: Number(row.count) });
    return out;
  }

  async function toViews(rows: PaymentRow[]): Promise<PaymentView[]> {
    const byChain = new Map<number, string[]>();
    for (const row of rows) byChain.set(row.chain_id, [...(byChain.get(row.chain_id) ?? []), row.payer, row.payee]);
    const lookups = new Map<number, Map<string, { ids: string[]; count: number }>>();
    const receiptLinks = new Map<number, Map<string, string[]>>();
    const reviewLinks = new Map<number, Map<string, PaymentView["reviews"]>>();
    for (const [chainId, list] of byChain) {
      lookups.set(chainId, await agentsByAddress(chainId, [...new Set(list)]));
      const txs = [...new Set(rows.filter((r) => r.chain_id === chainId).map((r) => r.tx_hash))];
      receiptLinks.set(chainId, await receiptsByTransaction(chainId, txs));
      reviewLinks.set(chainId, await reviewsByTransaction(chainId, txs));
    }
    return rows.map((row) => {
      const network = networkByChainId(row.chain_id);
      const known = lookups.get(row.chain_id)!;
      const payer = known.get(row.payer);
      const payee = known.get(row.payee);
      return {
        network: network!.name,
        chainId: row.chain_id,
        txHash: row.tx_hash,
        logIndex: row.log_index,
        blockNumber: row.block_number,
        blockTime: row.block_time.toISOString(),
        asset: row.asset,
        assetSymbol: "USDC",
        amount: usdc(row.amount),
        payer: row.payer,
        payee: row.payee,
        facilitator: row.facilitator,
        payerAgentIds: payer?.ids ?? [],
        payerAgentCount: payer?.count ?? 0,
        payeeAgentIds: payee?.ids ?? [],
        payeeAgentCount: payee?.count ?? 0,
        receiptHashes: receiptLinks.get(row.chain_id)?.get(row.tx_hash) ?? [],
        reviews: reviewLinks.get(row.chain_id)?.get(row.tx_hash) ?? [],
      };
    });
  }

  return {
    /**
     * Payment counts per agent. An agent's addresses are its owner and agent
     * wallet; payments between them are self-payments. A missing table counts
     * as no payments.
     */
    async summaries(chainId: number, list: AgentAddresses[]): Promise<Map<string, AgentPaymentSummary>> {
      const out = new Map<string, AgentPaymentSummary>();
      if (list.length === 0) return out;
      try {
        const r = await db.query<{
          agent_id: string;
          received: string;
          sent: string;
          self: string;
          received_amount: string;
          sent_amount: string;
          last_at: Date | null;
        }>(
          `WITH a AS (
             SELECT agent_id, owner, coalesce(wallet, owner) AS wallet
               FROM unnest($2::text[], $3::text[], $4::text[]) AS t(agent_id, owner, wallet)
           ), m AS (
             SELECT a.agent_id, p.amount, p.block_time,
                    p.payer IN (a.owner, a.wallet) AS out_side, p.payee IN (a.owner, a.wallet) AS in_side
               FROM a JOIN ${payments} p
                 ON p.chain_id = $1 AND (p.payer IN (a.owner, a.wallet) OR p.payee IN (a.owner, a.wallet))
           )
           SELECT agent_id,
                  count(*) FILTER (WHERE in_side AND NOT out_side)::text AS received,
                  count(*) FILTER (WHERE out_side AND NOT in_side)::text AS sent,
                  count(*) FILTER (WHERE in_side AND out_side)::text AS self,
                  coalesce(sum(amount) FILTER (WHERE in_side AND NOT out_side), 0)::text AS received_amount,
                  coalesce(sum(amount) FILTER (WHERE out_side AND NOT in_side), 0)::text AS sent_amount,
                  max(block_time) AS last_at
             FROM m GROUP BY agent_id`,
          [chainId, list.map((a) => a.agentId), list.map((a) => a.owner.toLowerCase()), list.map((a) => lower(a.wallet))],
        );
        for (const row of r.rows) {
          out.set(row.agent_id, {
            receivedFromOthers: Number(row.received),
            sent: Number(row.sent),
            selfPayments: Number(row.self),
            receivedAmount: usdc(row.received_amount),
            sentAmount: usdc(row.sent_amount),
            lastPaymentAt: row.last_at?.toISOString() ?? null,
          });
        }
      } catch (err) {
        if (!isMissingRelation(err)) throw err;
      }
      return out;
    },

    /** One agent's payments, newest first. Null when the agent is not indexed. */
    async listForAgent(params: {
      chainId: number;
      agentId: string;
      direction: PaymentDirection | "any";
      limit: number;
      cursor?: PaymentCursor;
    }): Promise<Omit<AgentPaymentsResponse, "network" | "agentId" | "direction" | "nextCursor"> & { nextCursor: PaymentCursor | null } | null> {
      const a = await db.query<{ owner: string; wallet: string | null }>(
        `SELECT lower(owner) AS owner, lower(agent_wallet) AS wallet FROM ${agents} WHERE chain_id = $1 AND id = $2`,
        [params.chainId, params.agentId],
      );
      const agent = a.rows[0];
      if (!agent) return null;
      const own = [...new Set([agent.owner, agent.wallet ?? agent.owner])];
      const shared = await agentsByAddress(params.chainId, own);
      const addresses = own.map((address) => ({
        address,
        roles: [...(address === agent.owner ? (["owner"] as const) : []), ...(address === (agent.wallet ?? agent.owner) ? (["wallet"] as const) : [])],
        agentCount: shared.get(address)?.count ?? 1,
      }));

      const values: unknown[] = [params.chainId, own];
      const direction =
        params.direction === "received"
          ? "AND payee = ANY($2) AND NOT payer = ANY($2)"
          : params.direction === "sent"
            ? "AND payer = ANY($2) AND NOT payee = ANY($2)"
            : params.direction === "self"
              ? "AND payer = ANY($2) AND payee = ANY($2)"
              : "";
      let after = "";
      if (params.cursor) {
        values.push(params.cursor.blockNumber, params.cursor.txHash, params.cursor.logIndex);
        after = "AND (block_number, tx_hash, log_index) < ($3::bigint, $4, $5::int)";
      }
      values.push(params.limit + 1);
      let rows: PaymentRow[] = [];
      try {
        const r = await db.query<PaymentRow>(
          `SELECT chain_id, tx_hash, log_index, block_number::text, block_time, asset, payer, payee, amount::text, facilitator
             FROM ${payments}
            WHERE chain_id = $1 AND (payer = ANY($2) OR payee = ANY($2)) ${direction} ${after}
            ORDER BY block_number DESC, tx_hash DESC, log_index DESC
            LIMIT $${values.length}`,
          values,
        );
        rows = r.rows;
      } catch (err) {
        if (!isMissingRelation(err)) throw err;
      }
      const page = rows.slice(0, params.limit);
      const last = page.at(-1);
      const views = await toViews(page);
      const items: AgentPaymentView[] = views.map((v) => {
        const out = own.includes(v.payer);
        const into = own.includes(v.payee);
        return { ...v, direction: out && into ? "self" : into ? "received" : "sent" };
      });
      return {
        addresses,
        items,
        nextCursor: rows.length > params.limit && last ? { blockNumber: last.block_number, txHash: last.tx_hash, logIndex: last.log_index } : null,
      };
    },

    /** The first payment in each of `txHashes` on one chain (an x402 settlement has one). */
    async firstByTransactions(chainId: number, txHashes: string[]): Promise<Map<string, PaymentView>> {
      const out = new Map<string, PaymentView>();
      if (txHashes.length === 0) return out;
      try {
        const r = await db.query<PaymentRow>(
          `SELECT DISTINCT ON (tx_hash) chain_id, tx_hash, log_index, block_number::text, block_time, asset, payer, payee, amount::text, facilitator
             FROM ${payments} WHERE chain_id = $1 AND tx_hash = ANY($2::text[]) ORDER BY tx_hash, log_index`,
          [chainId, txHashes],
        );
        for (const view of await toViews(r.rows)) out.set(view.txHash, view);
      } catch (err) {
        if (!isMissingRelation(err)) throw err;
      }
      return out;
    },

    /** Payments in one transaction, on one or all chains. */
    async byTransaction(txHash: string, chainIds: number[]): Promise<PaymentView[]> {
      try {
        const r = await db.query<PaymentRow>(
          `SELECT chain_id, tx_hash, log_index, block_number::text, block_time, asset, payer, payee, amount::text, facilitator
             FROM ${payments} WHERE tx_hash = $1 AND chain_id = ANY($2::int[]) ORDER BY chain_id, log_index`,
          [txHash, chainIds],
        );
        return toViews(r.rows);
      } catch (err) {
        if (isMissingRelation(err)) return [];
        throw err;
      }
    },
  };
}

export type PaymentRepository = ReturnType<typeof createPaymentRepository>;
