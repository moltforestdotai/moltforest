/** Pure decisions for the enrichment worker: where to fetch, when to fetch again. */
import type { FetchOutcome } from "../net/fetchDocument.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const REFRESH_OK_MS = 6 * HOUR;
export const REFRESH_DEFINITIVE_FAILURE_MS = 24 * HOUR;
export const RETRY_BASE_MS = 5 * MINUTE;
export const RETRY_MAX_MS = 24 * HOUR;

/** URLs to try, in order, for an agentURI. ipfs:// goes through public gateways. */
export function fetchUrlsFor(uri: string, uriKind: string, ipfsGateways: string[]): string[] {
  const trimmed = uri.trim();
  if (uriKind === "ipfs") {
    const path = trimmed.replace(/^ipfs:\/\//i, "").replace(/^ipfs\//i, "");
    if (!path) return [];
    return ipfsGateways.map((gw) => `${gw.replace(/\/+$/, "")}/${path}`);
  }
  return [trimmed];
}

/**
 * Transient failures (timeouts, resets, 5xx, 408, 429) may fix themselves, so
 * the last good profile is kept. Everything else is definitive for this URI.
 */
export function isTransient(outcome: FetchOutcome): boolean {
  if (outcome.kind === "network_error") return true;
  if (outcome.kind === "http_error") return outcome.httpStatus >= 500 || outcome.httpStatus === 408 || outcome.httpStatus === 429;
  return false;
}

/** Adds ±10% jitter so thousands of agents fetched together do not refresh in lockstep. */
function jitter(ms: number, random: () => number): number {
  return Math.round(ms * (0.9 + random() * 0.2));
}

export function nextFetchDelayMs(
  result: { ok: true } | { ok: false; transient: boolean; failures: number },
  random: () => number = Math.random,
): number {
  if (result.ok) return jitter(REFRESH_OK_MS, random);
  if (!result.transient) return jitter(REFRESH_DEFINITIVE_FAILURE_MS, random);
  const backoff = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, result.failures - 1), RETRY_MAX_MS);
  return jitter(backoff, random);
}
