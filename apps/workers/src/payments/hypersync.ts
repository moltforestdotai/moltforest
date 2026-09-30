import type { Logger } from "pino";
import type { HsBatch } from "./classify.js";

export interface HsResponse {
  data?: HsBatch[];
  next_block: number;
  archive_height?: number;
}

export interface HyperSync {
  /** Latest block HyperSync has for the chain. */
  height(chainId: number): Promise<number>;
  query(chainId: number, body: object): Promise<HsResponse>;
}

/**
 * Minimal HyperSync JSON API client. The API token is shared with the Envio
 * indexer (30 000 units per minute, ~1 000 per query), so this client backs off
 * on 429 and pauses when the remaining budget runs low, leaving room for it.
 * The body is always read before any pause: the request timeout covers the
 * body download too.
 */
export function createHyperSync(opts: {
  token: string;
  urlTemplate?: string;
  logger?: Logger;
  /** Pause until the window resets when fewer units than this remain. */
  minRemaining?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}): HyperSync {
  const template = opts.urlTemplate ?? "https://{chainId}.hypersync.xyz";
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const doFetch = opts.fetchImpl ?? fetch;
  const minRemaining = opts.minRemaining ?? 6_000;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const base = (chainId: number) => template.replace("{chainId}", String(chainId));

  async function request<T>(url: string, init: RequestInit): Promise<T> {
    let failures = 0;
    for (let rateLimited = 0; rateLimited < 30; ) {
      let status: number;
      let headers: Headers;
      let text: string;
      try {
        const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        status = res.status;
        headers = res.headers;
        text = await res.text();
      } catch (err) {
        // Connection, DNS, TLS or timeout (including a slow body download).
        if (++failures > 6) throw err;
        opts.logger?.warn({ err: (err as Error).message, attempt: failures }, "hypersync request failed; retrying");
        await sleep(Math.min(5_000 * failures, 30_000));
        continue;
      }
      const reset = Number(headers.get("x-ratelimit-reset") ?? "20");
      if (status === 429) {
        rateLimited++;
        await sleep((reset + 2) * 1000);
        continue;
      }
      if (status < 200 || status >= 300) throw new Error(`hypersync HTTP ${status}: ${text.slice(0, 200)}`);
      const remaining = Number(headers.get("x-ratelimit-remaining") ?? "Infinity");
      if (remaining < minRemaining) await sleep((reset + 1) * 1000);
      return JSON.parse(text) as T;
    }
    throw new Error("hypersync: still rate limited after 30 waits");
  }

  return {
    async height(chainId) {
      const body = await request<{ height: number }>(`${base(chainId)}/height`, { headers: { authorization: `Bearer ${opts.token}` } });
      return Number(body.height);
    },
    query(chainId, body) {
      return request<HsResponse>(`${base(chainId)}/query`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
        body: JSON.stringify(body),
      });
    },
  };
}
