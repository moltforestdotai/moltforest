import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { HttpError } from "./errors.js";

function keysEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Optional Bearer auth for CRE pending-epoch (and related) endpoints.
 * When SCORES_PENDING_API_KEY is unset, the route stays open (local/dev).
 * When set, require `Authorization: Bearer <key>`.
 */
export function requireScoresPendingKey(expectedKey: string | undefined): RequestHandler {
  return (req, _res, next) => {
    if (!expectedKey) {
      next();
      return;
    }
    const header = req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const provided = match?.[1]?.trim() ?? "";
    if (!keysEqual(provided, expectedKey)) {
      next(new HttpError(401, "unauthorized", "Missing or invalid Authorization Bearer token for scores pending API."));
      return;
    }
    next();
  };
}
