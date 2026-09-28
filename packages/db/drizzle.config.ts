import { defineConfig } from "drizzle-kit";
import { databaseUrl } from "./src/env.js";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  schemaFilter: ["app"],
  dbCredentials: { url: databaseUrl() },
});
