import type { Logger } from "pino";
import type { HostLimiter } from "../net/hostLimiter.js";
import type { ProbeOutcome } from "../net/fetchDocument.js";
import { classifyProbe, nextCheckDelayMs } from "./policy.js";
import type { LivenessRepository } from "./repository.js";

export type Prober = (url: string) => Promise<ProbeOutcome>;

export interface LivenessStats {
  checked: number;
  up: number;
  error: number;
  down: number;
  blocked: number;
  failures: number;
}

/** Checks every due endpoint once, respecting per-host politeness limits. */
export async function runLivenessBatch(
  deps: { repo: LivenessRepository; probe: Prober; limiter: HostLimiter; logger?: Logger; now?: () => Date },
  opts: { batchSize: number; concurrency: number },
): Promise<LivenessStats> {
  const due = await deps.repo.selectDue(opts.batchSize);
  const stats: LivenessStats = { checked: due.length, up: 0, error: 0, down: 0, blocked: 0, failures: 0 };

  let next = 0;
  const worker = async () => {
    while (next < due.length) {
      const endpoint = due[next++]!;
      try {
        const outcome = await deps.limiter.run(endpoint.host, () => deps.probe(endpoint.url));
        const result = classifyProbe(outcome);
        const checkedAt = deps.now?.() ?? new Date();
        await deps.repo.save(endpoint, result, checkedAt, new Date(checkedAt.getTime() + nextCheckDelayMs(result.status)));
        stats[result.status]++;
      } catch (err) {
        stats.failures++;
        deps.logger?.error({ err, url: endpoint.url }, "liveness check failed to save");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, due.length) }, worker));
  return stats;
}
