import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchDocument, probeEndpoint, type FetchOptions } from "../src/net/fetchDocument.js";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    switch (url.pathname) {
      case "/ok":
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ name: "Agent", ua: req.headers["user-agent"] }));
        return;
      case "/redirect":
        res.writeHead(302, { location: "/ok" }).end();
        return;
      case "/loop":
        res.writeHead(302, { location: "/loop" }).end();
        return;
      case "/to-metadata":
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
        return;
      case "/big":
        res.end("x".repeat(5_000)); // no content-length check path: chunked
        return;
      case "/declared-big":
        res.setHeader("content-length", "999999");
        res.end("x");
        return;
      case "/slow":
        setTimeout(() => res.end("{}"), 2_000);
        return;
      case "/missing":
        res.writeHead(404).end("nope");
        return;
      case "/paywall":
        res.writeHead(402, { "content-type": "application/json" }).end('{"x402Version":1}');
        return;
      case "/broken":
        res.writeHead(503).end();
        return;
      default:
        res.writeHead(500).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const opts: FetchOptions = { timeoutMs: 1_000, maxBytes: 1_024, maxRedirects: 3, userAgent: "TestBot/1", allowPrivateNetwork: true };

describe("fetchDocument", () => {
  it("fetches a small JSON document and sends our user agent", async () => {
    const r = await fetchDocument(`${base}/ok`, opts);
    expect(r).toMatchObject({ kind: "ok", httpStatus: 200 });
    if (r.kind === "ok") expect(JSON.parse(r.body)).toEqual({ name: "Agent", ua: "TestBot/1" });
  });

  it("follows redirects and reports the final URL", async () => {
    const r = await fetchDocument(`${base}/redirect`, opts);
    expect(r).toMatchObject({ kind: "ok", finalUrl: `${base}/ok` });
  });

  it("stops redirect loops", async () => {
    expect(await fetchDocument(`${base}/loop`, opts)).toMatchObject({ kind: "network_error", reason: expect.stringMatching(/redirect/) });
  });

  it("enforces the size cap on streamed and declared bodies", async () => {
    expect((await fetchDocument(`${base}/big`, opts)).kind).toBe("too_large");
    expect((await fetchDocument(`${base}/declared-big`, opts)).kind).toBe("too_large");
  });

  it("times out slow servers", async () => {
    expect(await fetchDocument(`${base}/slow`, { ...opts, timeoutMs: 200 })).toMatchObject({ kind: "network_error", reason: "timed out" });
  });

  it("reports HTTP errors with their status", async () => {
    expect(await fetchDocument(`${base}/missing`, opts)).toMatchObject({ kind: "http_error", httpStatus: 404 });
  });

  it("rejects non-http schemes and credentials", async () => {
    expect((await fetchDocument("file:///etc/passwd", opts)).kind).toBe("blocked");
    expect((await fetchDocument("http://user:pw@example.com/", opts)).kind).toBe("blocked");
    expect((await fetchDocument("not a url", opts)).kind).toBe("blocked");
  });

  describe("probeEndpoint", () => {
    const probeOpts = { timeoutMs: 500, userAgent: "TestBot/1", allowPrivateNetwork: true };

    it("reports the HTTP status and latency without following redirects", async () => {
      expect(await probeEndpoint(`${base}/ok`, probeOpts)).toMatchObject({ kind: "response", httpStatus: 200, latencyMs: expect.any(Number) });
      expect(await probeEndpoint(`${base}/redirect`, probeOpts)).toMatchObject({ kind: "response", httpStatus: 302 });
      expect(await probeEndpoint(`${base}/paywall`, probeOpts)).toMatchObject({ kind: "response", httpStatus: 402 });
      expect(await probeEndpoint(`${base}/broken`, probeOpts)).toMatchObject({ kind: "response", httpStatus: 503 });
    });

    it("reports no response on timeouts and refused connections", async () => {
      expect(await probeEndpoint(`${base}/slow`, { ...probeOpts, timeoutMs: 100 })).toMatchObject({ kind: "no_response", reason: "timed out" });
      expect((await probeEndpoint("http://127.0.0.1:1/", probeOpts)).kind).toBe("no_response");
    });

    it("blocks localhost endpoints in production mode", async () => {
      expect(await probeEndpoint("http://localhost:3000/api", { timeoutMs: 500, userAgent: "TestBot/1" })).toMatchObject({ kind: "blocked" });
    });
  });

  describe("with the SSRF guard on (production mode)", () => {
    const guarded = { ...opts, allowPrivateNetwork: false };

    it("blocks loopback and private IP literals", async () => {
      expect((await fetchDocument(`${base}/ok`, guarded)).kind).toBe("blocked");
      expect((await fetchDocument("http://10.0.0.1/", guarded)).kind).toBe("blocked");
      expect((await fetchDocument("http://[::1]/", guarded)).kind).toBe("blocked");
    });

    it("blocks hostnames that resolve to private addresses", async () => {
      const r = await fetchDocument("http://localhost/", guarded);
      expect(r).toMatchObject({ kind: "blocked", reason: expect.stringMatching(/non-public/) });
    });

    it("blocks unusual ports", async () => {
      expect(await fetchDocument("http://example.com:22/", guarded)).toMatchObject({ kind: "blocked", reason: "blocked: port 22" });
    });
  });
});
