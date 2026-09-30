import { Router } from "express";
import { z } from "zod";
import { NETWORK_NAMES, NETWORKS } from "@moltforest/chain";
import type { AgentPaymentsResponse, PaymentLookupResponse } from "@moltforest/types";
import { AgentParams } from "./agents.js";
import type { PaymentCursor, PaymentRepository } from "../repositories/payments.js";
import { isMissingRelation } from "../repositories/sync.js";
import { HttpError } from "../lib/errors.js";

const AgentPaymentsQuery = z.object({
  direction: z.enum(["received", "sent", "self", "any"]).default("any"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(512).optional(),
});

const TxParams = z.object({
  txHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "txHash must be 0x followed by 64 hex characters")
    .transform((s) => s.toLowerCase()),
});
const TxQuery = z.object({ network: z.enum(NETWORK_NAMES).optional() });

const encodeCursor = (c: PaymentCursor) => Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
function decodeCursor(raw: string): PaymentCursor {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<PaymentCursor>;
    if (typeof c.blockNumber === "string" && /^\d{1,20}$/.test(c.blockNumber) && typeof c.txHash === "string" && /^0x[0-9a-f]{64}$/.test(c.txHash) && Number.isInteger(c.logIndex)) {
      return { blockNumber: c.blockNumber, txHash: c.txHash, logIndex: c.logIndex as number };
    }
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "invalid_cursor", "cursor is malformed");
}

/** x402 payments (decision D33): per agent, and by transaction hash. */
export function paymentsRouter(repo: PaymentRepository): Router {
  const router = Router();

  router.get("/agents/:network/:agentId/payments", async (req, res) => {
    const { network, agentId } = AgentParams.parse(req.params);
    const q = AgentPaymentsQuery.parse(req.query);
    const cursor = q.cursor ? decodeCursor(q.cursor) : undefined;
    try {
      const page = await repo.listForAgent({ chainId: NETWORKS[network].chainId, agentId, direction: q.direction, limit: q.limit, cursor });
      if (!page) throw new HttpError(404, "agent_not_found", `Agent ${agentId} is not indexed on ${network}`);
      const body: AgentPaymentsResponse = {
        network,
        agentId,
        addresses: page.addresses,
        direction: q.direction,
        items: page.items,
        nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
      };
      res.json(body);
    } catch (err) {
      if (isMissingRelation(err)) throw new HttpError(503, "index_not_ready", "The agent tables are missing.");
      throw err;
    }
  });

  router.get("/payments/:txHash", async (req, res) => {
    const { txHash } = TxParams.parse(req.params);
    const { network } = TxQuery.parse(req.query);
    const chainIds = network ? [NETWORKS[network].chainId] : NETWORK_NAMES.map((n) => NETWORKS[n].chainId);
    const body: PaymentLookupResponse = { txHash, items: await repo.byTransaction(txHash, chainIds) };
    res.json(body);
  });

  return router;
}
