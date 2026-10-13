import type { Address, Hex } from "viem";
import type { AgentScore } from "./types.js";
import type { BuiltEpoch } from "./publish.js";
import { buildEpoch } from "./publish.js";

/** Minimal query surface (pg.Pool / pg.Client). */
export interface SqlQueryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

type PoolLike = SqlQueryable & {
  connect: () => Promise<
    SqlQueryable & {
      release: () => void;
    }
  >;
};

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

function isPool(db: SqlQueryable): db is PoolLike {
  return typeof (db as PoolLike).connect === "function";
}

async function withTransaction(db: SqlQueryable, fn: (q: SqlQueryable) => Promise<void>): Promise<void> {
  if (!isPool(db)) {
    await fn(db);
    return;
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback errors */
    }
    throw err;
  } finally {
    client.release();
  }
}

const INSERT_CHUNK = 200;

/**
 * Upsert a published epoch and its agent leaves so the API can rebuild Merkle proofs.
 * Runs in a transaction when `db` is a pg.Pool so header + leaves never partially commit.
 */
export async function persistPublishedEpoch(opts: PersistEpochOpts): Promise<void> {
  const schema = quoteIdent(opts.schema ?? "app");
  const epochs = `${schema}."score_epoch"`;
  const agents = `${schema}."score_epoch_agent"`;
  const publishedAt = opts.publishedAt ?? new Date();
  const epochIdNum = Number(opts.epoch.epochId);

  // Sanity: leaves must produce the header root before we write anything.
  const check = buildEpoch(opts.epoch.epochId, opts.epoch.scores);
  if (check.scoresRoot.toLowerCase() !== opts.epoch.scoresRoot.toLowerCase()) {
    throw new Error(
      `refuse persist: epoch ${epochIdNum} scoresRoot mismatch built=${check.scoresRoot} claimed=${opts.epoch.scoresRoot}`,
    );
  }

  await withTransaction(opts.db, async (q) => {
    await q.query(
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
        epochIdNum,
        opts.epoch.inputsRoot,
        opts.epoch.scoresRoot,
        opts.epoch.algoHash,
        opts.scoreRegistry.toLowerCase(),
        opts.publishTx,
        publishedAt,
      ],
    );

    await q.query(`DELETE FROM ${agents} WHERE chain_id = $1 AND epoch_id = $2`, [opts.chainId, epochIdNum]);

    const scores = opts.epoch.scores;
    for (let i = 0; i < scores.length; i += INSERT_CHUNK) {
      const chunk = scores.slice(i, i + INSERT_CHUNK);
      const values: unknown[] = [];
      const placeholders: string[] = [];
      let p = 1;
      for (const s of chunk) {
        placeholders.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
        values.push(
          opts.chainId,
          epochIdNum,
          s.agentId.toString(),
          s.scoreBps,
          s.confidenceBps,
          s.paidReviews,
          s.independentClusters,
          s.totalPaidVolume.toString(),
        );
      }
      await q.query(
        `INSERT INTO ${agents}
           (chain_id, epoch_id, agent_id, score_bps, confidence_bps, paid_reviews, independent_clusters, total_paid_volume)
         VALUES ${placeholders.join(",")}`,
        values,
      );
    }
  });
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
