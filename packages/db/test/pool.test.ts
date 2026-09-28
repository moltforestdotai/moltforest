import { describe, expect, it } from "vitest";
import { pgSsl, sslFromEnv, stripSslParams } from "../src/pool.js";

describe("stripSslParams", () => {
  it("removes libpq TLS parameters and keeps everything else", () => {
    const url = stripSslParams("postgresql://u:p%40ss@aws-1.pooler.supabase.com:5432/postgres?sslmode=require&application_name=mf");
    expect(url).toBe("postgresql://u:p%40ss@aws-1.pooler.supabase.com:5432/postgres?application_name=mf");
  });
});

describe("pgSsl / sslFromEnv", () => {
  it("maps modes to node-postgres TLS options", () => {
    expect(pgSsl("disable")).toBe(false);
    expect(pgSsl("require")).toEqual({ rejectUnauthorized: false });
    expect(pgSsl("verify-full")).toEqual({ rejectUnauthorized: true });
  });

  it("defaults to disable and validates values", () => {
    expect(sslFromEnv({})).toEqual({ ssl: "disable", sslCaFile: undefined });
    expect(sslFromEnv({ DATABASE_SSL: "require" }).ssl).toBe("require");
    expect(() => sslFromEnv({ DATABASE_SSL: "yes" })).toThrow(/DATABASE_SSL/);
    expect(() => sslFromEnv({ DATABASE_SSL: "verify-full" })).toThrow(/CA_FILE/);
  });
});
