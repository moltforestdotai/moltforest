import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { databaseUrl } from "./env.js";

const pool = new pg.Pool({ connectionString: databaseUrl() });
try {
  await migrate(drizzle(pool), {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    migrationsSchema: "app",
  });
  console.log("app schema migrations applied");
} finally {
  await pool.end();
}
