import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { databaseUrl } from "./env.js";
import { createPool, sslFromEnv } from "./pool.js";

const pool = createPool(databaseUrl(), { max: 1, ...sslFromEnv() });
try {
  await migrate(drizzle(pool), {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    migrationsSchema: "app",
  });
  console.log("app schema migrations applied");
} finally {
  await pool.end();
}
