import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../src/lib/cursor.js";
import { HttpError } from "../src/lib/errors.js";

describe("agent cursor", () => {
  it("round-trips", () => {
    const c = { sort: "most_reviewed" as const, agentId: "42", reviewCount: 7 };
    expect(decodeCursor(encodeCursor(c), "most_reviewed")).toEqual(c);
  });

  it("rejects a cursor from a different sort", () => {
    const raw = encodeCursor({ sort: "newest", agentId: "1" });
    expect(() => decodeCursor(raw, "oldest")).toThrow(HttpError);
  });

  it("rejects garbage and injection attempts", () => {
    expect(() => decodeCursor("not-base64-json", "newest")).toThrow(HttpError);
    const evil = Buffer.from(JSON.stringify({ sort: "newest", agentId: "1; DROP TABLE x" })).toString("base64url");
    expect(() => decodeCursor(evil, "newest")).toThrow(HttpError);
  });

  it("requires reviewCount for most_reviewed", () => {
    const raw = encodeCursor({ sort: "most_reviewed", agentId: "1" });
    expect(() => decodeCursor(raw, "most_reviewed")).toThrow(HttpError);
  });
});
