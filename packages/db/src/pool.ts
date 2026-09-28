import { readFileSync } from "node:fs";
import pg from "pg";

/**
 * TLS for Postgres connections.
 * - disable:     plain TCP (local Docker Postgres)
 * - require:     encrypted, server certificate not verified
 * - verify-full: encrypted and verified against DATABASE_SSL_CA_FILE (e.g. Supabase's CA)
 */
export type SslMode = "disable" | "require" | "verify-full";

export interface PoolOptions {
  max?: number;
  ssl?: SslMode;
  sslCaFile?: string;
  statementTimeoutMs?: number;
}

const SSL_PARAMS = ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"];

/**
 * Removes libpq TLS parameters from a connection URL. node-postgres lets URL
 * parameters override the `ssl` option, so they are stripped and TLS is
 * configured explicitly instead.
 */
export function stripSslParams(connectionString: string): string {
  const url = new URL(connectionString);
  for (const p of SSL_PARAMS) url.searchParams.delete(p);
  return url.toString();
}

export function pgSsl(mode: SslMode, caFile?: string): pg.PoolConfig["ssl"] {
  switch (mode) {
    case "disable":
      return false;
    case "require":
      return { rejectUnauthorized: false };
    case "verify-full":
      return { rejectUnauthorized: true, ...(caFile ? { ca: readFileSync(caFile, "utf8") } : {}) };
  }
}

export function sslFromEnv(env: NodeJS.ProcessEnv = process.env): { ssl: SslMode; sslCaFile?: string } {
  const raw = (env.DATABASE_SSL ?? "disable").trim();
  if (raw !== "disable" && raw !== "require" && raw !== "verify-full") {
    throw new Error(`DATABASE_SSL must be disable, require or verify-full (got "${raw}")`);
  }
  if (raw === "verify-full" && !env.DATABASE_SSL_CA_FILE) {
    throw new Error("DATABASE_SSL=verify-full needs DATABASE_SSL_CA_FILE (the provider's CA certificate)");
  }
  return { ssl: raw, sslCaFile: env.DATABASE_SSL_CA_FILE || undefined };
}

export function createPool(connectionString: string, opts: PoolOptions = {}): pg.Pool {
  return new pg.Pool({
    connectionString: stripSslParams(connectionString),
    ssl: pgSsl(opts.ssl ?? "disable", opts.sslCaFile),
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    ...(opts.statementTimeoutMs ? { statement_timeout: opts.statementTimeoutMs } : {}),
  });
}
