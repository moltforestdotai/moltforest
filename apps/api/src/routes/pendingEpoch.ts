import { Router } from "express";
import { z } from "zod";
import { NETWORK_NAMES, NETWORKS, DEFAULT_NETWORK } from "@moltforest/chain";
import type { PendingEpochResponse } from "@moltforest/types";
import { table, type Db } from "../db.js";
import { isMissingRelation } from "../repositories/sync.js";
import { HttpError } from "../lib/errors.js";
import { requireScoresPendingKey } from "../lib/scoresAuth.js";

const Query = z.object({
  network: z.enum(NETWORK_NAMES).default(DEFAULT_NETWORK),
});

interface PendingRow {
  epoch_id: string;
  inputs_root: string;
  scores_root: string;
  algo_hash: string;
  signature_0: string;
  signature_1: string;
  signer_0: string;
  signer_1: string;
  score_registry: string;
  prepared_at: Date;
}

const NOTE =
  "Cosigned epoch ready for CreScorePublisher / ScoreRegistry.publishEpoch. Not a hiring verdict (C1).";

export function pendingEpochRouter(db: Db, appSchema: string, pendingApiKey?: string): Router {
  const router = Router();
  const pending = table(appSchema, "score_epoch_pending");

  // GET /v1/scores/pending-epoch?network=testnet|mainnet
  router.get("/scores/pending-epoch", requireScoresPendingKey(pendingApiKey), async (req, res) => {
    const { network } = Query.parse(req.query);
    const chainId = NETWORKS[network].chainId;
    try {
      const r = await db.query<PendingRow>(
        `SELECT epoch_id, inputs_root, scores_root, algo_hash,
                signature_0, signature_1, signer_0, signer_1, score_registry, prepared_at
         FROM ${pending} WHERE chain_id = $1`,
        [chainId],
      );
      const row = r.rows[0];
      if (!row) {
        throw new HttpError(
          404,
          "pending_epoch_not_found",
          "No prepared epoch. Run `pnpm scores:prepare-epoch -- --demo` (or --from-db).",
        );
      }
      const body: PendingEpochResponse = {
        network,
        chainId,
        epochId: String(row.epoch_id),
        inputsRoot: row.inputs_root,
        scoresRoot: row.scores_root,
        algoHash: row.algo_hash,
        signatures: [row.signature_0, row.signature_1],
        signers: [row.signer_0, row.signer_1],
        scoreRegistry: row.score_registry,
        preparedAt: row.prepared_at.toISOString(),
        note: NOTE,
      };
      res.json(body);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw isMissingRelation(err)
        ? new HttpError(503, "scores_not_ready", "Apply migrations (`pnpm db:migrate`).")
        : err;
    }
  });

  return router;
}
