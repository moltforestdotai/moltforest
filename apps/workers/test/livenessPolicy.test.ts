import { describe, expect, it } from "vitest";
import { BLOCKED_RECHECK_MS, CHECK_INTERVAL_MS, classifyProbe, nextCheckDelayMs } from "../src/liveness/policy.js";

describe("classifyProbe", () => {
  it.each([200, 301, 401, 403, 404, 405])("HTTP %i means the server answers: up", (httpStatus) => {
    expect(classifyProbe({ kind: "response", httpStatus, latencyMs: 12 })).toMatchObject({ status: "up", latencyMs: 12, error: null });
  });

  it("flags 402 as an x402 paywall, still up", () => {
    expect(classifyProbe({ kind: "response", httpStatus: 402, latencyMs: 30 })).toMatchObject({ status: "up", paymentRequired: true });
  });

  it("maps 5xx to error, no answer to down, and guards to blocked", () => {
    expect(classifyProbe({ kind: "response", httpStatus: 502, latencyMs: 5 })).toMatchObject({ status: "error", error: "HTTP 502" });
    expect(classifyProbe({ kind: "no_response", reason: "timed out", latencyMs: 5000 })).toMatchObject({ status: "down", latencyMs: null, error: "timed out" });
    expect(classifyProbe({ kind: "blocked", reason: "blocked: localhost" })).toMatchObject({ status: "blocked", error: "blocked: localhost" });
  });
});

describe("nextCheckDelayMs", () => {
  it("checks live endpoints every ~15 min and blocked ones daily", () => {
    expect(nextCheckDelayMs("up", () => 0.5)).toBe(CHECK_INTERVAL_MS);
    expect(nextCheckDelayMs("down", () => 0.5)).toBe(CHECK_INTERVAL_MS);
    expect(nextCheckDelayMs("blocked", () => 0.5)).toBe(BLOCKED_RECHECK_MS);
    expect(nextCheckDelayMs("up", () => 0)).toBe(CHECK_INTERVAL_MS * 0.9);
  });
});
