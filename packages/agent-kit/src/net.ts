/**
 * Fetching provider URLs. Endpoints come from registration files, which anyone
 * can write (constraint C7), so a listed URL must not make the kit call into the
 * user's own network: only https, only public addresses (checked when the socket
 * connects, so DNS rebinding cannot slip past), no redirects, capped bodies.
 * Mirrors apps/workers/src/net/ssrf.ts.
 */
import dns, { type LookupAddress, type LookupOptions } from "node:dns";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

export class KitError extends Error {}

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let ip = ipaddr.parse(address);
  if (ip.kind() === "ipv6" && (ip as ipaddr.IPv6).isIPv4MappedAddress()) ip = (ip as ipaddr.IPv6).toIPv4Address();
  return ip.range() === "unicast";
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (list.length === 0 || bad) {
      return callback(Object.assign(new Error(`${hostname} resolves to a non-public address`), { code: "EBLOCKED" }), "");
    }
    if (options.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

let guarded: Dispatcher | undefined;
let open: Dispatcher | undefined;

/** Throws unless the URL may be fetched. Returns the parsed URL. */
export function checkUrl(raw: string, allowLocal: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new KitError(`Not a valid URL: ${raw}`);
  }
  if (url.username || url.password) throw new KitError("URLs with credentials are not allowed.");
  if (url.protocol !== "https:" && !(allowLocal && url.protocol === "http:")) {
    throw new KitError(`Only https:// URLs are allowed (got ${url.protocol}).`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!allowLocal && ipaddr.isValid(host) && !isPublicAddress(host)) {
    throw new KitError(`${url.hostname} is not a public address.`);
  }
  return url;
}

export interface SafeFetchOptions {
  allowLocal: boolean;
  timeoutMs?: number;
}

/** A `fetch` for untrusted URLs, usable by the x402 client wrapper. */
export function createSafeFetch(opts: SafeFetchOptions): typeof globalThis.fetch {
  const dispatcher = opts.allowLocal
    ? (open ??= new Agent({ connect: { timeout: 10_000 } }))
    : (guarded ??= new Agent({ connect: { timeout: 10_000, lookup: guardedLookup } }));
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const req = new Request(input, init);
    checkUrl(req.url, opts.allowLocal);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    try {
      const res = await undiciFetch(req.url, {
        method: req.method,
        headers: [...req.headers.entries()],
        body,
        redirect: "error",
        dispatcher,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      return res as unknown as Response;
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      if (cause?.code === "EBLOCKED") throw new KitError(cause.message ?? "blocked address");
      throw err;
    }
  }) as typeof globalThis.fetch;
}

export const MAX_BODY_BYTES = 256 * 1024;

/** Reads a response body as JSON (or text when it is not JSON), refusing bodies over `MAX_BODY_BYTES`. */
export async function readBody(res: Response, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new KitError(`The response is larger than ${maxBytes / 1024} kB.`);
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.length > 4_000 ? `${text.slice(0, 4_000)}…` : text;
  }
}
