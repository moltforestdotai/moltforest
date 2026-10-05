import { getAddress } from "viem";
import type { AgentReviewsGiven } from "@moltforest/types";
import { table, type Db } from "../db.js";
import type { AgentAddresses } from "./payments.js";
import { isMissingRelation } from "./sync.js";

export const EMPTY_REVIEWS_GIVEN: AgentReviewsGiven = { reviews: 0, verified: 0, lastAt: null };

/** Reviews an agent wrote about other agents: ERC-8004 feedback whose client is the agent's owner or agent wallet. */
export function createReviewsGivenRepository(db: Db, schemas: { indexer: string; app: string }) {
  const feedback = table(schemas.indexer, "Feedback");
  const assessments = table(schemas.app, "review_assessment");

  return {
    /**
     * Per agent: non-revoked reviews about other agents, how many of them are
     * verified (counted and attached to a checked x402 payment, D39), and the
     * latest. The indexer stores the reviewer as the event's checksummed
     * address, so both spellings are matched to keep the index on `client`.
     */
    async summaries(chainId: number, list: AgentAddresses[]): Promise<Map<string, AgentReviewsGiven>> {
      const out = new Map<string, AgentReviewsGiven>();
      const ids: string[] = [];
      const clients: string[] = [];
      for (const a of list) {
        const spellings = new Set<string>();
        for (const address of [a.owner, a.wallet]) {
          if (!address) continue;
          spellings.add(address.toLowerCase());
          spellings.add(getAddress(address));
        }
        for (const client of spellings) {
          ids.push(a.agentId);
          clients.push(client);
        }
      }
      if (ids.length === 0) return out;
      try {
        const r = await db.query<{ agent_id: string; reviews: string; verified: string; last_at: Date | null }>(
          `SELECT a.agent_id, count(*)::text AS reviews,
                  count(*) FILTER (WHERE ra.counted AND ra.link ? 'by')::text AS verified,
                  max(f."timestamp") AS last_at
             FROM unnest($2::text[], $3::text[]) AS a(agent_id, client)
             JOIN ${feedback} f ON f.chain_id = $1 AND f.client = a.client AND f.agent_id <> a.agent_id AND NOT f.revoked
             LEFT JOIN ${assessments} ra
               ON ra.chain_id = f.chain_id AND ra.agent_id = f.agent_id::numeric AND ra.client = lower(f.client) AND ra.feedback_index = f.feedback_index
            GROUP BY a.agent_id`,
          [chainId, ids, clients],
        );
        for (const row of r.rows) {
          out.set(row.agent_id, { reviews: Number(row.reviews), verified: Number(row.verified), lastAt: row.last_at?.toISOString() ?? null });
        }
      } catch (err) {
        if (!isMissingRelation(err)) throw err;
      }
      return out;
    },
  };
}
