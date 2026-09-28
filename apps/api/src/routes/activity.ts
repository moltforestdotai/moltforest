import { Router } from "express";
import { z } from "zod";
import { DEFAULT_NETWORK, NETWORK_NAMES, NETWORKS } from "@moltforest/chain";
import type { ActivityListResponse } from "@moltforest/types";
import type { ActivityRepository } from "../repositories/activity.js";
import { isMissingRelation } from "../repositories/sync.js";
import type { ActivityHub, HubMessage } from "../services/activityHub.js";
import { HttpError } from "../lib/errors.js";

const RecentQuery = z.object({
  network: z.enum(NETWORK_NAMES).default(DEFAULT_NETWORK),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const StreamQuery = z.object({ network: z.enum(NETWORK_NAMES).default(DEFAULT_NETWORK) });

const HEARTBEAT_MS = 20_000;

export function activityRouter(repo: ActivityRepository, hub: ActivityHub | undefined): Router {
  const router = Router();

  /** Most recent on-chain events (registrations, profile updates, reviews), newest first. */
  router.get("/", async (req, res) => {
    const { network, limit } = RecentQuery.parse(req.query);
    try {
      const body: ActivityListResponse = { network, chainId: NETWORKS[network].chainId, items: await repo.list(network, { limit }) };
      res.json(body);
    } catch (err) {
      throw isMissingRelation(err) ? new HttpError(503, "index_not_ready", "Database tables are missing.") : err;
    }
  });

  /**
   * Server-Sent Events: `activity` (ActivityEvent) as blocks finish indexing and
   * `status` (ActivityStreamStatus) when the indexer advances. Comment pings
   * keep proxies from closing idle connections.
   */
  router.get("/stream", (req, res) => {
    const { network } = StreamQuery.parse(req.query);
    if (!hub) throw new HttpError(503, "stream_unavailable", "Live activity is not enabled on this server.");

    const send = (message: HubMessage) => {
      const data = message.kind === "activity" ? message.event : message.status;
      res.write(`event: ${message.kind}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const unsubscribe = hub.subscribe(network, send);
    if (!unsubscribe) throw new HttpError(503, "too_many_streams", "Too many live connections; try again later.");

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 5000\n\n");
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return router;
}
