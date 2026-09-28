import { Agent, fetch, type Dispatcher } from "undici";
import { assertPublicHost, BlockedHostError, guardedLookup } from "./ssrf.js";

export type FetchOutcome =
  | { kind: "ok"; httpStatus: number; body: string; finalUrl: string }
  | { kind: "http_error"; httpStatus: number; finalUrl: string }
  | { kind: "too_large"; httpStatus: number | null }
  | { kind: "blocked"; reason: string }
  | { kind: "network_error"; reason: string };

export interface FetchOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  userAgent: string;
  /** Tests only: allow loopback/private targets and any port. */
  allowPrivateNetwork?: boolean;
}

const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

let guardedDispatcher: Dispatcher | undefined;
let openDispatcher: Dispatcher | undefined;

function dispatcherFor(allowPrivate: boolean): Dispatcher {
  if (allowPrivate) return (openDispatcher ??= new Agent({ connect: { timeout: 5_000 } }));
  return (guardedDispatcher ??= new Agent({ connect: { timeout: 5_000, lookup: guardedLookup } }));
}

function checkUrl(raw: string, allowPrivate: boolean): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new BlockedHostError(`blocked: scheme ${url.protocol}`);
  if (url.username || url.password) throw new BlockedHostError("blocked: credentials in URL");
  if (!allowPrivate) {
    if (!ALLOWED_PORTS.has(url.port)) throw new BlockedHostError(`blocked: port ${url.port}`);
    assertPublicHost(url.hostname);
  }
  return url;
}

function describe(err: unknown): string {
  if (!(err instanceof Error)) return "fetch failed";
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof BlockedHostError) return cause.message;
  if (err.name === "TimeoutError" || err.name === "AbortError") return "timed out";
  const code = (cause as { code?: string } | undefined)?.code;
  return (code ? `${code}: ` : "") + (cause instanceof Error ? cause.message : err.message).slice(0, 200);
}

/**
 * GETs a small public document with SSRF protection, manual redirect handling
 * (each hop re-validated), an overall timeout, and a hard size cap.
 */
export async function fetchDocument(rawUrl: string, opts: FetchOptions): Promise<FetchOutcome> {
  const allowPrivate = opts.allowPrivateNetwork === true;
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let current = rawUrl;

  try {
    for (let hop = 0; ; hop++) {
      const url = checkUrl(current, allowPrivate);
      const res = await fetch(url, {
        redirect: "manual",
        signal,
        dispatcher: dispatcherFor(allowPrivate),
        headers: { "user-agent": opts.userAgent, accept: "application/json, text/plain;q=0.9, */*;q=0.1" },
      });

      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel();
        if (hop >= opts.maxRedirects) return { kind: "network_error", reason: `too many redirects (>${opts.maxRedirects})` };
        current = new URL(res.headers.get("location")!, url).toString();
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        return { kind: "http_error", httpStatus: res.status, finalUrl: url.toString() };
      }

      const declared = Number(res.headers.get("content-length") ?? NaN);
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        await res.body?.cancel();
        return { kind: "too_large", httpStatus: res.status };
      }

      const chunks: Uint8Array[] = [];
      let total = 0;
      if (res.body) {
        for await (const chunk of res.body) {
          total += chunk.byteLength;
          if (total > opts.maxBytes) {
            await res.body.cancel();
            return { kind: "too_large", httpStatus: res.status };
          }
          chunks.push(chunk);
        }
      }
      return { kind: "ok", httpStatus: res.status, body: Buffer.concat(chunks).toString("utf8"), finalUrl: url.toString() };
    }
  } catch (err) {
    // Thrown directly by checkUrl, or wrapped as `cause` when raised inside the socket lookup.
    const blocked = err instanceof BlockedHostError ? err : (err as { cause?: unknown })?.cause;
    if (blocked instanceof BlockedHostError) return { kind: "blocked", reason: blocked.message };
    if (err instanceof TypeError && /Invalid URL/i.test(err.message)) return { kind: "blocked", reason: "invalid URL" };
    return { kind: "network_error", reason: describe(err) };
  }
}
