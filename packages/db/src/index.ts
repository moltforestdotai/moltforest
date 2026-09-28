import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import * as schema from "./schema.js";

export * from "./schema.js";
export * from "./pool.js";
export { schema };

export function createDrizzle(pool: pg.Pool) {
  return drizzle(pool, { schema });
}
export type Drizzle = ReturnType<typeof createDrizzle>;
