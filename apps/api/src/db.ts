import pg from "pg";
import { createPool, type PoolOptions } from "@moltforest/db";

// Return NUMERIC (agent ids, block numbers) and INT8 as strings: they can exceed 2^53.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);

export type Db = pg.Pool;

export function createDb(connectionString: string, opts: PoolOptions = {}): Db {
  return createPool(connectionString, { max: 10, statementTimeoutMs: 10_000, ...opts });
}

/** Quotes a validated schema name and table name, e.g. "envio"."Agent". */
export function table(schema: string, name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema) || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(`unsafe identifier ${schema}.${name}`);
  }
  return `"${schema}"."${name}"`;
}
