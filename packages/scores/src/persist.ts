import type { Address, Hex } from "viem";
import type { AgentScore } from "./types.js";
import type { BuiltEpoch } from "./publish.js";

/** Minimal query surface (pg.Pool / pg.Client). */
export interface SqlQueryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export interface PersistEpochOpts {
  db: SqlQueryable;
  /** Postgres schema holding score_epoch tables (default `app`). */
  schema?: string;
  chainId: number;
  scoreRegistry: Address;
  epoch: BuiltEpoch;
  publishTx: Hex | null;
  publishedAt?: Date;
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

/**
 * Upsert a published epoch and its agent leaves so the API can rebuild Merkle proofs.
 * Replaces all agent rows for (chainId, epochId) on conflict.
 */
export async function persistPublishedEpoch(opts: PersistEpochOpts): Promise<void> {
  const schema = quoteIdent(opts.schema ?? "app");
  const epochs = `${schema}."score_epoch"`;
  const agents = `${schema}."score_epoch_agent"`;
  const publishedAt = opts.publishedAt ?? new Date();

  await opts.db.query(
    `INSERT INTO ${epochs}
       (chain_id, epoch_id, inputs_root, scores_root, algo_hash, score_registry, publish_tx, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (chain_id, epoch_id) DO UPDATE SET
       inputs_root = EXCLUDED.inputs_root,
       scores_root = EXCLUDED.scores_root,
       algo_hash = EXCLUDED.algo_hash,
       score_registry = EXCLUDED.score_registry,
       publish_tx = COALESCE(EXCLUDED.publish_tx, ${epochs}.publish_tx),
       published_at = EXCLUDED.published_at`,
    [
      opts.chainId,
      Number(opts.epoch.epochId),
      opts.epoch.inputsRoot,
      opts.epoch.scoresRoot,
      opts.epoch.algoHash,
      opts.scoreRegistry.toLowerCase(),
      opts.publishTx,
      publishedAt,
    ],
  );

  await opts.db.query(`DELETE FROM ${agents} WHERE chain_id = $1 AND epoch_id = $2`, [
    opts.chainId,
    Number(opts.epoch.epochId),
  ]);

  for (const s of opts.epoch.scores) {
    await insertAgentRow(opts.db, agents, opts.chainId, opts.epoch.epochId, s);
  }
}

/** Attach the courier tx after CRE simulate / DON / break-glass publish. */
export async function updateEpochPublishTx(opts: {
  db: SqlQueryable;
  schema?: string;
  chainId: number;
  epochId: bigint;
  publishTx: Hex;
  publishedAt?: Date;
}): Promise<void> {
  const schema = quoteIdent(opts.schema ?? "app");
  const epochs = `${schema}."score_epoch"`;
  await opts.db.query(
    `UPDATE ${epochs}
     SET publish_tx = $3, published_at = $4
     WHERE chain_id = $1 AND epoch_id = $2`,
    [opts.chainId, Number(opts.epochId), opts.publishTx, opts.publishedAt ?? new Date()],
  );
}

async function insertAgentRow(
  db: SqlQueryable,
  agents: string,
  chainId: number,
  epochId: bigint,
  s: AgentScore,
): Promise<void> {
  await db.query(
    `INSERT INTO ${agents}
       (chain_id, epoch_id, agent_id, score_bps, confidence_bps, paid_reviews, independent_clusters, total_paid_volume)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      chainId,
      Number(epochId),
      s.agentId.toString(),
      s.scoreBps,
      s.confidenceBps,
      s.paidReviews,
      s.independentClusters,
      s.totalPaidVolume.toString(),
    ],
  );
}
