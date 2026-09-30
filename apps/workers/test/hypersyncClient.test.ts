import { describe, expect, it } from "vitest";
import { createHyperSync } from "../src/payments/hypersync.js";

const response = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

function client(replies: (Response | Error)[], opts: { minRemaining?: number } = {}) {
  const sleeps: number[] = [];
  const calls: string[] = [];
  let bodyReadBeforeSleep = true;
  let lastBodyRead = true;
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const next = replies.shift()!;
    if (next instanceof Error) throw next;
    lastBodyRead = false;
    const text = next.text.bind(next);
    Object.defineProperty(next, "text", { value: async () => ((lastBodyRead = true), text()) });
    return next;
  }) as unknown as typeof fetch;
  const hs = createHyperSync({
    token: "t",
    fetchImpl,
    minRemaining: opts.minRemaining,
    sleep: async (ms) => {
      if (!lastBodyRead) bodyReadBeforeSleep = false;
      sleeps.push(ms);
    },
  });
  return { hs, sleeps, calls, bodyReadBeforeSleep: () => bodyReadBeforeSleep };
}

describe("HyperSync client", () => {
  it("returns the parsed query response", async () => {
    const { hs, calls } = client([response(200, { next_block: 10, data: [] })]);
    expect(await hs.query(10143, { from_block: 0 })).toEqual({ next_block: 10, data: [] });
    expect(calls).toEqual(["https://10143.hypersync.xyz/query"]);
  });

  it("waits for the window reset on 429 and retries", async () => {
    const { hs, sleeps } = client([response(429, "", { "x-ratelimit-reset": "7" }), response(200, { height: 42 })]);
    expect(await hs.height(143)).toBe(42);
    expect(sleeps).toEqual([9000]);
  });

  it("reads the body before pausing for a low budget (a pause must not time out the download)", async () => {
    const { hs, sleeps, bodyReadBeforeSleep } = client(
      [response(200, { next_block: 5 }, { "x-ratelimit-remaining": "1000", "x-ratelimit-reset": "30" })],
      { minRemaining: 6000 },
    );
    expect(await hs.query(143, {})).toEqual({ next_block: 5 });
    expect(sleeps).toEqual([31000]);
    expect(bodyReadBeforeSleep()).toBe(true);
  });

  it("retries network failures, then gives up", async () => {
    const ok = client([new TypeError("fetch failed"), response(200, { height: 1 })]);
    expect(await ok.hs.height(143)).toBe(1);
    expect(ok.sleeps).toEqual([5000]);

    const down = client(Array.from({ length: 7 }, () => new TypeError("fetch failed")));
    await expect(down.hs.height(143)).rejects.toThrow("fetch failed");
  });

  it("throws on other HTTP errors with the response text", async () => {
    const { hs } = client([response(400, "invalid JSON")]);
    await expect(hs.query(143, {})).rejects.toThrow("hypersync HTTP 400: invalid JSON");
  });
});
