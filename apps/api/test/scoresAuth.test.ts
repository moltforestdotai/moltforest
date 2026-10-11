import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { requireScoresPendingKey } from "../src/lib/scoresAuth.js";
import { HttpError } from "../src/lib/errors.js";

function run(mw: ReturnType<typeof requireScoresPendingKey>, auth?: string) {
  return new Promise<unknown>((resolve) => {
    const req = { header: (name: string) => (name.toLowerCase() === "authorization" ? auth : undefined) } as Request;
    mw(req, {} as Response, (err?: unknown) => resolve(err));
  });
}

describe("requireScoresPendingKey", () => {
  it("allows all when key unset", async () => {
    expect(await run(requireScoresPendingKey(undefined))).toBeUndefined();
  });

  it("rejects missing bearer when key set", async () => {
    const err = await run(requireScoresPendingKey("test-key-at-least-16chars"));
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
  });

  it("accepts matching bearer", async () => {
    const key = "test-key-at-least-16chars";
    expect(await run(requireScoresPendingKey(key), `Bearer ${key}`)).toBeUndefined();
  });
});
