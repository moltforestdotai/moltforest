import type { Logger } from "pino";
import { enrichAgent, type Fetcher } from "./enrichAgent.js";
import type { ProfileRepository } from "./repository.js";
import type { HostLimiter } from "../net/hostLimiter.js";
import type { FetchOutcome } from "../net/fetchDocument.js";

export interface RunnerOptions {
  batchSize: number;
  concurrency: number;
  ipfsGateways: string[];
  /** How long a host is paused after it answers HTTP 429. */
  rateLimitPauseMs?: number;
}

export interface BatchStats {
  selected: number;
  requests: number;
  ok: number;
  invalid: number;
  unreachable: number;
  blocked: number;
  tooLarge: number;
  errors: number;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "invalid";
  }
}

/**
 * Wraps the raw fetcher for one batch:
 * - politeness limits apply per real network request (per host), and a host
 *   that answers 429 is paused;
 * - each URL is fetched once per batch. Many agents share one registration
 *   URL (8,093 mainnet agents point at the same file), so this matters.
 */
function batchFetcher(raw: Fetcher, limiter: HostLimiter, pauseMs: number, count: () => void): Fetcher {
  const cache = new Map<string, Promise<FetchOutcome>>();
  return (url) => {
    let pending = cache.get(url);
    if (!pending) {
      const host = hostOf(url);
      pending = limiter.run(host, () => {
        count();
        return raw(url);
      }).then((outcome) => {
        if (outcome.kind === "http_error" && outcome.httpStatus === 429) limiter.pause(host, pauseMs);
        return outcome;
      });
      cache.set(url, pending);
    }
    return pending;
  };
}

/** Runs one batch: select due agents, fetch (deduplicated, rate-limited), save results. */
export async function runBatch(
  deps: { repo: ProfileRepository; fetcher: Fetcher; limiter: HostLimiter; logger?: Logger },
  opts: RunnerOptions,
): Promise<BatchStats> {
  const targets = await deps.repo.selectDue(opts.batchSize);
  const stats: BatchStats = { selected: targets.length, requests: 0, ok: 0, invalid: 0, unreachable: 0, blocked: 0, tooLarge: 0, errors: 0 };
  const fetcher = batchFetcher(deps.fetcher, deps.limiter, opts.rateLimitPauseMs ?? 30_000, () => stats.requests++);

  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const target = targets[next++]!;
      try {
        const { row, snapshot } = await enrichAgent(target, fetcher, { ipfsGateways: opts.ipfsGateways });
        await deps.repo.save(row, snapshot);
        if (row.status === "ok") stats.ok++;
        else if (row.status === "invalid") stats.invalid++;
        else if (row.status === "too_large") stats.tooLarge++;
        else if (row.status === "blocked") stats.blocked++;
        else stats.unreachable++;
      } catch (err) {
        stats.errors++;
        deps.logger?.error({ err, chainId: target.chainId, agentId: target.agentId }, "failed to save profile");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, targets.length) }, worker));
  return stats;
}
