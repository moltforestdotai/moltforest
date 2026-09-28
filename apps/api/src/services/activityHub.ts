import type { Logger } from "pino";
import { NETWORK_NAMES, type NetworkName } from "@moltforest/chain";
import type { ActivityEvent, ActivityStreamStatus } from "@moltforest/types";
import type { ActivityRepository } from "../repositories/activity.js";
import type { SyncRepository } from "../repositories/sync.js";

export type HubMessage = { kind: "activity"; event: ActivityEvent } | { kind: "status"; status: ActivityStreamStatus };
type Listener = (message: HubMessage) => void;

/**
 * Polls the indexer's progress and fans new on-chain activity out to SSE
 * subscribers. It uses Envio's own progress watermark (envio_chains), so an
 * event is only emitted once its block is fully processed, and each block
 * range is read exactly once.
 */
export class ActivityHub {
  private readonly listeners = new Map<NetworkName, Set<Listener>>();
  private readonly watermark = new Map<NetworkName, bigint>();
  private readonly lastStatus = new Map<NetworkName, string>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(
    private readonly deps: { activity: ActivityRepository; sync: SyncRepository; logger?: Logger },
    private readonly opts: { pollMs: number; maxEventsPerTick: number; maxSubscribers: number },
  ) {}

  get subscriberCount(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  /** Returns an unsubscribe function, or null when the subscriber limit is reached. */
  subscribe(network: NetworkName, listener: Listener): (() => void) | null {
    if (this.subscriberCount >= this.opts.maxSubscribers) return null;
    let set = this.listeners.get(network);
    if (!set) {
      set = new Set();
      this.listeners.set(network, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), this.opts.pollMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One polling round (public for tests). */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const network of NETWORK_NAMES) await this.tickNetwork(network);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "42P01" && code !== "3F000") this.deps.logger?.error({ err }, "activity poll failed");
    } finally {
      this.ticking = false;
    }
  }

  private async tickNetwork(network: NetworkName): Promise<void> {
    const progress = await this.deps.sync.progress(network);
    if (!progress) return;
    const upTo = BigInt(progress.progressBlock);
    const from = this.watermark.get(network);
    this.watermark.set(network, upTo);
    const listeners = this.listeners.get(network);

    const statusKey = `${progress.progressBlock}/${progress.chainHeadBlock}`;
    if (listeners?.size && this.lastStatus.get(network) !== statusKey) {
      this.lastStatus.set(network, statusKey);
      this.broadcast(network, { kind: "status", status: { network, progressBlock: progress.progressBlock, chainHeadBlock: progress.chainHeadBlock } });
    }

    // First sighting only sets the watermark: history is served by GET /v1/activity, not replayed.
    if (from === undefined || upTo <= from || !listeners?.size) return;

    const events = await this.deps.activity.list(network, { limit: this.opts.maxEventsPerTick, after: from.toString(), upTo: upTo.toString() });
    for (const event of events.reverse()) this.broadcast(network, { kind: "activity", event });
  }

  private broadcast(network: NetworkName, message: HubMessage): void {
    for (const listener of this.listeners.get(network) ?? []) {
      try {
        listener(message);
      } catch (err) {
        this.deps.logger?.warn({ err }, "activity listener failed");
      }
    }
  }
}
