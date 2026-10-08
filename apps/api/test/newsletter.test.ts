import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import type { ChainChecker } from "../src/services/chainCheck.js";
import type { Db } from "../src/db.js";

const fakeChain: ChainChecker = {
  highestAgentId: async () => ({ highestAgentId: null, checkedAt: null, error: null }),
};

/** Minimal pool stub: newsletter repo is the only path that must succeed. */
function fakeDb(subscribe: (email: string, source: string) => Promise<boolean>): Db {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (typeof sql === "string" && sql.includes("newsletter_subscriber")) {
        const inserted = await subscribe(String(params?.[0]), String(params?.[1]));
        return { rows: [], rowCount: inserted ? 1 : 0 };
      }
      if (typeof sql === "string" && sql.startsWith("SELECT 1")) return { rows: [{ "?column?": 1 }], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    }),
  } as unknown as Db;
}

function appWith(subscribe: (email: string, source: string) => Promise<boolean>) {
  return createApp({
    config: {
      INDEXER_DB_SCHEMA: "envio",
      APP_DB_SCHEMA: "app",
      CORS_ORIGINS: ["http://localhost:3000"],
      RATE_LIMIT_PER_MINUTE: 10_000,
    },
    db: fakeDb(subscribe),
    chain: fakeChain,
    newsletterSubmitPerMinute: 100,
  });
}

describe("POST /v1/newsletter", () => {
  it("stores a normalized email", async () => {
    const seen: { email: string; source: string }[] = [];
    const res = await request(appWith(async (email, source) => {
      seen.push({ email, source });
      return true;
    }))
      .post("/v1/newsletter")
      .send({ email: "  Jane@Example.COM " });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, alreadySubscribed: false });
    expect(seen).toEqual([{ email: "jane@example.com", source: "footer" }]);
  });

  it("flags duplicates so the UI can say already on the list", async () => {
    const res = await request(appWith(async () => false))
      .post("/v1/newsletter")
      .send({ email: "dup@example.com" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, alreadySubscribed: true });
  });

  it("ignores honeypot fills and does not write", async () => {
    const write = vi.fn(async () => true);
    const res = await request(appWith(write))
      .post("/v1/newsletter")
      .send({ email: "bot@spam.test", website: "https://evil.example" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, alreadySubscribed: false });
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects invalid emails", async () => {
    const write = vi.fn(async () => true);
    const res = await request(appWith(write)).post("/v1/newsletter").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects unknown fields", async () => {
    const res = await request(appWith(async () => true))
      .post("/v1/newsletter")
      .send({ email: "ok@example.com", extra: true });
    expect(res.status).toBe(400);
  });
});
