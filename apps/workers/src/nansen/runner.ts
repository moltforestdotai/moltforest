import type { Logger } from "pino";
import { NansenError, type NansenClient } from "./client.js";
import type { NansenRepository } from "./repository.js";

export interface NansenOptions {
  chainId: number;
  /** The chain's name in Nansen's API ("monad" for Monad mainnet). */
  nansenChain: string;
  /** Answered lookups allowed per UTC day; each costs credits. */
  dailyLookups: number;
  batchSize: number;
  /** Pause between two calls, to stay under Nansen's rate limits. */
  delayMs: number;
  maxAttempts: number;
  /** Agent ids whose reviewers are looked up first (e.g. the ones a demo shows). */
  focusAgents?: string[];
}

export interface NansenStats {
  selected: number;
  lookedUp: number;
  relations: number;
  errors: number;
  credits: number;
  /** Why the tick stopped early: the daily budget, or Nansen refusing the key, the credits or the rate. */
  stoppedBy: "budget" | "auth" | "credits" | "rate_limit" | null;
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One pass (decision D47): ask Nansen about the next reviewer wallets, within
 * the day's budget, and store its answers for the reviews worker. A refused
 * key, exhausted credits or a rate limit end the pass without marking the
 * wallet, so it is asked again on a later pass.
 */
export async function runNansenTick(
  deps: { repo: NansenRepository; client: NansenClient; logger?: Logger; sleep?: (ms: number) => Promise<void> },
  opts: NansenOptions,
): Promise<NansenStats> {
  const stats: NansenStats = { selected: 0, lookedUp: 0, relations: 0, errors: 0, credits: 0, stoppedBy: null };
  const room = Math.min(opts.batchSize, opts.dailyLookups - (await deps.repo.lookupsToday(opts.chainId)));
  if (room <= 0) {
    stats.stoppedBy = "budget";
    return stats;
  }
  const due = await deps.repo.dueWallets(opts.chainId, room, opts.maxAttempts, opts.focusAgents ?? []);
  stats.selected = due.length;
  const sleep = deps.sleep ?? sleepFor;

  for (const [i, address] of due.entries()) {
    if (i > 0 && opts.delayMs > 0) await sleep(opts.delayMs);
    try {
      const { relations, creditsCost } = await deps.client.relatedWallets(address, opts.nansenChain);
      await deps.repo.saveOk(opts.chainId, address, relations);
      stats.lookedUp++;
      stats.relations += relations.length;
      stats.credits += creditsCost ?? 0;
    } catch (err) {
      if (!(err instanceof NansenError)) throw err;
      if (err.kind === "auth" || err.kind === "credits" || err.kind === "rate_limit") {
        deps.logger?.warn({ kind: err.kind, status: err.status, error: err.message }, "Nansen refused the lookup; trying again on a later pass");
        stats.stoppedBy = err.kind;
        return stats;
      }
      await deps.repo.saveError(opts.chainId, address, err.message, err.transient);
      stats.errors++;
    }
  }
  return stats;
}
