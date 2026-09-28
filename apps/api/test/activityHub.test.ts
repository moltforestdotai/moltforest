import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@moltforest/types";
import { ActivityHub, type HubMessage } from "../src/services/activityHub.js";
import type { ActivityRepository } from "../src/repositories/activity.js";
import type { IndexerProgress, SyncRepository } from "../src/repositories/sync.js";

const event = (block: number): ActivityEvent => ({
  id: `143:feedback_given:${block}`,
  network: "mainnet",
  chainId: 143,
  type: "feedback_given",
  agentId: "1",
  agentName: null,
  actor: "0xa",
  blockNumber: String(block),
  timestamp: "2026-09-28T00:00:00.000Z",
  txHash: "0x",
  detail: null,
});

function setup() {
  let progress = 100;
  const calls: Array<{ after?: string; upTo?: string }> = [];
  const events = [event(101), event(103), event(102)];
  const activity = {
    list: async (_network: string, opts: { after?: string; upTo?: string }) => {
      calls.push(opts);
      return events
        .filter((e) => Number(e.blockNumber) > Number(opts.after) && Number(e.blockNumber) <= Number(opts.upTo))
        .sort((a, b) => Number(b.blockNumber) - Number(a.blockNumber)); // newest first, like the repository
    },
  } as unknown as ActivityRepository;
  const sync = {
    progress: async (network: string): Promise<IndexerProgress | null> =>
      network === "mainnet"
        ? { startBlock: "0", progressBlock: String(progress), chainHeadBlock: String(progress + 2), eventsProcessed: "0", readyAt: null, usingHyperSync: true, progressBlockTime: null }
        : null,
  } as unknown as SyncRepository;
  const hub = new ActivityHub({ activity, sync }, { pollMs: 1_000, maxEventsPerTick: 50, maxSubscribers: 2 });
  return { hub, calls, advance: (to: number) => (progress = to) };
}

describe("ActivityHub", () => {
  it("does not replay history, then emits new blocks oldest first", async () => {
    const { hub, calls, advance } = setup();
    const got: HubMessage[] = [];
    hub.subscribe("mainnet", (m) => got.push(m));

    await hub.tick(); // first sighting: watermark = 100, status only
    expect(calls).toHaveLength(0);
    expect(got.map((m) => m.kind)).toEqual(["status"]);

    advance(103);
    await hub.tick();
    expect(calls).toEqual([{ limit: 50, after: "100", upTo: "103" }]);
    const blocks = got.filter((m) => m.kind === "activity").map((m) => (m.kind === "activity" ? m.event.blockNumber : ""));
    expect(blocks).toEqual(["101", "102", "103"]);

    await hub.tick(); // nothing new
    expect(calls).toHaveLength(1);
  });

  it("skips queries while nobody listens but keeps the watermark moving", async () => {
    const { hub, calls, advance } = setup();
    await hub.tick();
    advance(103);
    await hub.tick();
    expect(calls).toHaveLength(0);
    const got: HubMessage[] = [];
    hub.subscribe("mainnet", (m) => got.push(m));
    await hub.tick();
    expect(got.filter((m) => m.kind === "activity")).toHaveLength(0); // the unheard range is not replayed
  });

  it("enforces the subscriber limit and unsubscribes cleanly", () => {
    const { hub } = setup();
    const a = hub.subscribe("mainnet", () => {});
    const b = hub.subscribe("testnet", () => {});
    expect(hub.subscribe("mainnet", () => {})).toBeNull();
    a!();
    expect(hub.subscriberCount).toBe(1);
    expect(hub.subscribe("mainnet", () => {})).not.toBeNull();
    b!();
  });
});
