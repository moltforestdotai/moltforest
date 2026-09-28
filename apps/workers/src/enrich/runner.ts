import type { Logger } from "pino";
import { enrichAgent, type EnrichTarget, type Fetcher } from "./enrichAgent.js";
import { fetchUrlsFor } from "./policy.js";
import type { ProfileRepository } from "./repository.js";
import type { HostLimiter } from "../net/hostLimiter.js";

export interface RunnerOptions {
  batchSize: number;
  concurrency: number;
  ipfsGateways: string[];
}

export interface BatchStats {
  selected: number;
  ok: number;
  invalid: number;
  unreachable: number;
  blocked: number;
  tooLarge: number;
  errors: number;
}

function hostOf(target: EnrichTarget, gateways: string[]): string {
  const url = fetchUrlsFor(target.uri, target.uriKind, gateways)[0];
  try {
    return url ? new URL(url).host.toLowerCase() : "invalid";
  } catch {
    return "invalid";
  }
}

/** Runs one batch: select due agents, fetch with global + per-host limits, save results. */
export async function runBatch(
  deps: { repo: ProfileRepository; fetcher: Fetcher; limiter: HostLimiter; logger?: Logger },
  opts: RunnerOptions,
): Promise<BatchStats> {
  const targets = await deps.repo.selectDue(opts.batchSize);
  const stats: BatchStats = { selected: targets.length, ok: 0, invalid: 0, unreachable: 0, blocked: 0, tooLarge: 0, errors: 0 };

  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const target = targets[next++]!;
      try {
        const { row, snapshot } = await deps.limiter.run(hostOf(target, opts.ipfsGateways), () =>
          enrichAgent(target, deps.fetcher, { ipfsGateways: opts.ipfsGateways }),
        );
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
