import type { Address, Hex } from "viem";
import type { NetworkName } from "@moltforest/chain";
import { buildEpoch, cosignEpoch, type BuiltEpoch } from "./publish.js";
import { persistPublishedEpoch, type SqlQueryable } from "./persist.js";
import { persistPendingEpoch, type PendingEpochPayload } from "./pending.js";
import { loadScoresFromDb } from "./fromDb.js";
import type { AgentScore } from "./types.js";

export interface PrepareEpochOpts {
  db: SqlQueryable;
  network: NetworkName;
  chainId: number;
  scoreRegistry: Address;
  epochId: bigint;
  verifierPrivateKeys: readonly Hex[];
  /** App schema (default `app`). */
  schema?: string;
  /** Indexer schema (default `envio`). */
  indexerSchema?: string;
  /**
   * Score every indexed ERC-8004 agent (zeros when no reviews).
   * Default false (signal-only summaries). Prefer true for testnet POC / hackathon.
   */
  allAgents?: boolean;
  /** When not allAgents: include assessed agents with zero signal. */
  includeZero?: boolean;
  limit?: number;
  /** Preloaded scores; skips DB load when set. */
  scores?: readonly AgentScore[];
}

export interface PreparedEpochResult {
  epoch: BuiltEpoch;
  pending: PendingEpochPayload;
  source: string;
  agentCount: number;
}

/** Cosign + stage pending + persist leaves (publish_tx null until courier writes it). */
export async function prepareAndStageEpoch(opts: PrepareEpochOpts): Promise<PreparedEpochResult> {
  if (opts.verifierPrivateKeys.length < 2) {
    throw new Error("Need at least two verifier private keys matching the on-chain set");
  }

  let scores: AgentScore[];
  let source: string;
  if (opts.scores) {
    scores = [...opts.scores];
    source = "provided";
  } else {
    scores = await loadScoresFromDb({
      db: opts.db,
      chainId: opts.chainId,
      schema: opts.schema,
      indexerSchema: opts.indexerSchema,
      allAgents: opts.allAgents === true,
      requireSignal: opts.allAgents ? false : !opts.includeZero,
      limit: opts.limit,
    });
    source = opts.allAgents
      ? `db:all-agents (${scores.length})`
      : `db:summaries (${scores.length})`;
  }

  const epoch = buildEpoch(opts.epochId, scores);
  const { signers, signatures } = await cosignEpoch(
    opts.verifierPrivateKeys,
    opts.chainId,
    opts.scoreRegistry,
    epoch,
  );
  if (signatures.length < 2 || signers.length < 2) {
    throw new Error("cosign produced fewer than 2 signatures");
  }

  const pending = await persistPendingEpoch({
    db: opts.db,
    schema: opts.schema,
    network: opts.network,
    chainId: opts.chainId,
    scoreRegistry: opts.scoreRegistry,
    epoch,
    signatures: [signatures[0]!, signatures[1]!],
    signers: [signers[0]!, signers[1]!],
  });

  await persistPublishedEpoch({
    db: opts.db,
    schema: opts.schema,
    chainId: opts.chainId,
    scoreRegistry: opts.scoreRegistry,
    epoch,
    publishTx: null,
  });

  return { epoch, pending, source, agentCount: scores.length };
}

/** Next epoch id = max(score_epoch.epoch_id, score_epoch_pending.epoch_id) + 1 for this chain. */
export async function nextEpochId(opts: {
  db: SqlQueryable;
  chainId: number;
  schema?: string;
}): Promise<bigint> {
  const schema = quoteIdent(opts.schema ?? "app");
  const result = await opts.db.query(
    `SELECT GREATEST(
       COALESCE((SELECT MAX(epoch_id) FROM ${schema}."score_epoch" WHERE chain_id = $1), 0),
       COALESCE((SELECT MAX(epoch_id) FROM ${schema}."score_epoch_pending" WHERE chain_id = $1), 0)
     )::bigint AS m`,
    [opts.chainId],
  );
  const rows = (result as { rows: { m: string | number | bigint }[] }).rows;
  const max = BigInt(rows[0]?.m ?? 0);
  return max + 1n;
}

/** Latest published scores_root for skip-if-unchanged. */
export async function latestPublishedScoresRoot(opts: {
  db: SqlQueryable;
  chainId: number;
  schema?: string;
}): Promise<Hex | null> {
  const schema = quoteIdent(opts.schema ?? "app");
  const result = await opts.db.query(
    `SELECT scores_root FROM ${schema}."score_epoch"
     WHERE chain_id = $1 AND publish_tx IS NOT NULL
     ORDER BY epoch_id DESC LIMIT 1`,
    [opts.chainId],
  );
  const rows = (result as { rows: { scores_root: string }[] }).rows;
  return (rows[0]?.scores_root as Hex | undefined) ?? null;
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}
