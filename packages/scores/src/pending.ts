import type { Address, Hex } from "viem";
import type { NetworkName } from "@moltforest/chain";
import type { BuiltEpoch } from "./publish.js";
import type { SqlQueryable } from "./persist.js";

export interface PendingEpochPayload {
  network: NetworkName;
  chainId: number;
  epochId: string;
  inputsRoot: Hex;
  scoresRoot: Hex;
  algoHash: Hex;
  signatures: [Hex, Hex];
  signers: [Address, Address];
  scoreRegistry: Address;
  preparedAt: string;
  note: string;
}

export interface PersistPendingOpts {
  db: SqlQueryable;
  schema?: string;
  network: NetworkName;
  chainId: number;
  scoreRegistry: Address;
  epoch: BuiltEpoch;
  signatures: readonly [Hex, Hex];
  signers: readonly [Address, Address];
  preparedAt?: Date;
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

const PENDING_NOTE =
  "Cosigned epoch ready for CreScorePublisher / ScoreRegistry.publishEpoch. Not a hiring verdict (C1).";

/** Upsert the single pending epoch row for a chain (CRE HTTP fetch target). */
export async function persistPendingEpoch(opts: PersistPendingOpts): Promise<PendingEpochPayload> {
  const schema = quoteIdent(opts.schema ?? "app");
  const table = `${schema}."score_epoch_pending"`;
  const preparedAt = opts.preparedAt ?? new Date();

  await opts.db.query(
    `INSERT INTO ${table}
       (chain_id, epoch_id, inputs_root, scores_root, algo_hash,
        signature_0, signature_1, signer_0, signer_1, score_registry, prepared_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (chain_id) DO UPDATE SET
       epoch_id = EXCLUDED.epoch_id,
       inputs_root = EXCLUDED.inputs_root,
       scores_root = EXCLUDED.scores_root,
       algo_hash = EXCLUDED.algo_hash,
       signature_0 = EXCLUDED.signature_0,
       signature_1 = EXCLUDED.signature_1,
       signer_0 = EXCLUDED.signer_0,
       signer_1 = EXCLUDED.signer_1,
       score_registry = EXCLUDED.score_registry,
       prepared_at = EXCLUDED.prepared_at`,
    [
      opts.chainId,
      Number(opts.epoch.epochId),
      opts.epoch.inputsRoot,
      opts.epoch.scoresRoot,
      opts.epoch.algoHash,
      opts.signatures[0],
      opts.signatures[1],
      opts.signers[0].toLowerCase(),
      opts.signers[1].toLowerCase(),
      opts.scoreRegistry.toLowerCase(),
      preparedAt,
    ],
  );

  return {
    network: opts.network,
    chainId: opts.chainId,
    epochId: opts.epoch.epochId.toString(),
    inputsRoot: opts.epoch.inputsRoot,
    scoresRoot: opts.epoch.scoresRoot,
    algoHash: opts.epoch.algoHash,
    signatures: [opts.signatures[0], opts.signatures[1]],
    signers: [opts.signers[0], opts.signers[1]],
    scoreRegistry: opts.scoreRegistry,
    preparedAt: preparedAt.toISOString(),
    note: PENDING_NOTE,
  };
}
