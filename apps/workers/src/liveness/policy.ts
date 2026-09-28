/** Pure liveness decisions: how a probe outcome maps to a status, and when to check again. */
import type { EndpointStatus } from "@moltforest/db";
import type { ProbeOutcome } from "../net/fetchDocument.js";

const MINUTE = 60_000;
export const CHECK_INTERVAL_MS = 15 * MINUTE;
export const BLOCKED_RECHECK_MS = 24 * 60 * MINUTE;

export interface ProbeResult {
  status: EndpointStatus;
  httpStatus: number | null;
  latencyMs: number | null;
  paymentRequired: boolean;
  error: string | null;
}

/**
 * Any HTTP answer below 500 means the server is there and responding: 401,
 * 402 (x402 paywall), 404 and 405 all count as up. 5xx is an error; no answer
 * at all is down.
 */
export function classifyProbe(outcome: ProbeOutcome): ProbeResult {
  switch (outcome.kind) {
    case "blocked":
      return { status: "blocked", httpStatus: null, latencyMs: null, paymentRequired: false, error: outcome.reason };
    case "no_response":
      return { status: "down", httpStatus: null, latencyMs: null, paymentRequired: false, error: outcome.reason };
    case "response":
      return {
        status: outcome.httpStatus >= 500 ? "error" : "up",
        httpStatus: outcome.httpStatus,
        latencyMs: outcome.latencyMs,
        paymentRequired: outcome.httpStatus === 402,
        error: outcome.httpStatus >= 500 ? `HTTP ${outcome.httpStatus}` : null,
      };
  }
}

export function nextCheckDelayMs(status: EndpointStatus, random: () => number = Math.random): number {
  const base = status === "blocked" ? BLOCKED_RECHECK_MS : CHECK_INTERVAL_MS;
  return Math.round(base * (0.9 + random() * 0.2));
}
