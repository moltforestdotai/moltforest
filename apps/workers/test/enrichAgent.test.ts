import { describe, expect, it } from "vitest";
import { enrichAgent, type EnrichTarget, type Fetcher } from "../src/enrich/enrichAgent.js";
import { fetchUrlsFor, nextFetchDelayMs, REFRESH_OK_MS, RETRY_BASE_MS, RETRY_MAX_MS } from "../src/enrich/policy.js";
import type { FetchOutcome } from "../src/net/fetchDocument.js";

const NOW = new Date("2026-09-28T00:00:00Z");
const GATEWAYS = ["https://gw1.example/ipfs/", "https://gw2.example/ipfs"];
const doc = { name: "Remote Agent", services: [{ name: "A2A", endpoint: "https://a.example" }], x402Support: true };
const ok = (body: unknown, finalUrl = "https://h.example/r.json"): FetchOutcome => ({ kind: "ok", httpStatus: 200, body: JSON.stringify(body), finalUrl });
const fixed = (outcome: FetchOutcome): Fetcher => async () => outcome;
const opts = { ipfsGateways: GATEWAYS, now: () => NOW, random: () => 0.5 };

const target = (over: Partial<EnrichTarget> = {}): EnrichTarget => ({
  chainId: 143,
  agentId: "7",
  uri: "https://h.example/r.json",
  uriKind: "https",
  previous: null,
  ...over,
});

const previousOk = (uri = "https://h.example/r.json", contentHash = "old-hash") => ({
  uri,
  contentHash,
  failures: 0,
  changeCount: 0,
  firstFetchedAt: new Date("2026-09-01T00:00:00Z"),
  lastOkAt: new Date("2026-09-27T00:00:00Z"),
  lastChangedAt: null,
});

describe("fetchUrlsFor", () => {
  it("maps ipfs URIs onto every gateway", () => {
    expect(fetchUrlsFor("ipfs://bafyCID/agent.json", "ipfs", GATEWAYS)).toEqual([
      "https://gw1.example/ipfs/bafyCID/agent.json",
      "https://gw2.example/ipfs/bafyCID/agent.json",
    ]);
    expect(fetchUrlsFor("ipfs://ipfs/bafyCID", "ipfs", GATEWAYS)[0]).toBe("https://gw1.example/ipfs/bafyCID");
  });
});

describe("nextFetchDelayMs", () => {
  it("refreshes good profiles every ~6h and backs off failures exponentially", () => {
    expect(nextFetchDelayMs({ ok: true }, () => 0.5)).toBe(REFRESH_OK_MS);
    expect(nextFetchDelayMs({ ok: false, transient: true, failures: 1 }, () => 0.5)).toBe(RETRY_BASE_MS);
    expect(nextFetchDelayMs({ ok: false, transient: true, failures: 3 }, () => 0.5)).toBe(RETRY_BASE_MS * 4);
    expect(nextFetchDelayMs({ ok: false, transient: true, failures: 50 }, () => 0.5)).toBe(RETRY_MAX_MS);
  });
});

describe("enrichAgent", () => {
  it("parses a valid remote file and records a snapshot", async () => {
    const { row, snapshot } = await enrichAgent(target(), fixed(ok(doc)), opts);
    expect(row).toMatchObject({
      status: "ok",
      httpStatus: 200,
      error: null,
      fields: { name: "Remote Agent", serviceCount: 1, x402Support: true },
      lastOkAt: NOW,
      failures: 0,
      changeCount: 0,
      firstFetchedAt: NOW,
    });
    expect(row.nextFetchAt.getTime() - NOW.getTime()).toBe(REFRESH_OK_MS);
    expect(snapshot?.document).toEqual(doc);
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("counts content changes for the same agent", async () => {
    const { row, snapshot } = await enrichAgent(target({ previous: previousOk() }), fixed(ok(doc)), opts);
    expect(row).toMatchObject({ changeCount: 1, lastChangedAt: NOW });
    expect(snapshot).not.toBeNull();
  });

  it("does not count or snapshot an unchanged file", async () => {
    const first = await enrichAgent(target(), fixed(ok(doc)), opts);
    const { row, snapshot } = await enrichAgent(target({ previous: previousOk(undefined, first.row.contentHash!) }), fixed(ok(doc)), opts);
    expect(row.changeCount).toBe(0);
    expect(snapshot).toBeNull();
  });

  it("keeps the last good profile on a transient failure of the same URI", async () => {
    const prev = previousOk();
    const { row } = await enrichAgent(target({ previous: prev }), fixed({ kind: "http_error", httpStatus: 503, finalUrl: "x" }), opts);
    expect(row).toMatchObject({ status: "unreachable", fields: null, lastOkAt: prev.lastOkAt, contentHash: "old-hash", failures: 1 });
    expect(row.nextFetchAt.getTime() - NOW.getTime()).toBe(RETRY_BASE_MS);
  });

  it("clears the profile on a definitive failure (404)", async () => {
    const { row } = await enrichAgent(target({ previous: previousOk() }), fixed({ kind: "http_error", httpStatus: 404, finalUrl: "x" }), opts);
    expect(row).toMatchObject({ status: "unreachable", httpStatus: 404, lastOkAt: null, contentHash: null, fields: { name: null, serviceCount: 0 } });
  });

  it("does not carry an old URI's profile over to a new URI", async () => {
    const { row } = await enrichAgent(
      target({ uri: "https://new.example/r.json", previous: previousOk("https://old.example/r.json") }),
      fixed({ kind: "network_error", reason: "timed out" }),
      opts,
    );
    expect(row).toMatchObject({ lastOkAt: null, fields: { name: null }, failures: 1 });
  });

  it("marks HTML and non-object JSON as invalid", async () => {
    const html = await enrichAgent(target(), fixed({ kind: "ok", httpStatus: 200, body: "<html>hi</html>", finalUrl: "x" }), opts);
    expect(html.row).toMatchObject({ status: "invalid", error: "registration file is not valid JSON" });
    const arr = await enrichAgent(target(), fixed(ok([1, 2])), opts);
    expect(arr.row.status).toBe("invalid");
  });

  it("maps blocked and oversized fetches", async () => {
    expect((await enrichAgent(target(), fixed({ kind: "blocked", reason: "blocked: port 22" }), opts)).row).toMatchObject({ status: "blocked", error: "blocked: port 22" });
    expect((await enrichAgent(target(), fixed({ kind: "too_large", httpStatus: 200 }), opts)).row.status).toBe("too_large");
  });

  it("moves on to the next IPFS gateway even after a definitive gateway error (403)", async () => {
    const fetcher: Fetcher = async (url) => (url.includes("gw1") ? { kind: "http_error", httpStatus: 403, finalUrl: url } : ok(doc, url));
    const { row } = await enrichAgent(target({ uri: "ipfs://bafyCID", uriKind: "ipfs" }), fetcher, opts);
    expect(row).toMatchObject({ status: "ok", fetchUrl: "https://gw2.example/ipfs/bafyCID" });
  });

  it("does not retry other URLs after a definitive https error, and labels x402 paywalls", async () => {
    let calls = 0;
    const fetcher: Fetcher = async (url) => {
      calls++;
      return { kind: "http_error", httpStatus: 402, finalUrl: url };
    };
    const { row } = await enrichAgent(target(), fetcher, opts);
    expect(calls).toBe(1);
    expect(row).toMatchObject({ status: "unreachable", httpStatus: 402, error: expect.stringContaining("x402 paywall") });
  });

  it("falls back to the next IPFS gateway on transient errors", async () => {
    const seen: string[] = [];
    const fetcher: Fetcher = async (url) => {
      seen.push(url);
      return url.includes("gw1") ? { kind: "network_error", reason: "timed out" } : ok(doc, url);
    };
    const { row } = await enrichAgent(target({ uri: "ipfs://bafyCID", uriKind: "ipfs" }), fetcher, opts);
    expect(seen).toEqual(["https://gw1.example/ipfs/bafyCID", "https://gw2.example/ipfs/bafyCID"]);
    expect(row).toMatchObject({ status: "ok", fetchUrl: "https://gw2.example/ipfs/bafyCID" });
  });
});
