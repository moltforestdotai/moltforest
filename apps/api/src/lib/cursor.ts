import type { AgentSort } from "@moltforest/types";
import { HttpError } from "./errors.js";

/**
 * Keyset-pagination cursor. Opaque to clients (base64url JSON).
 * - newest / oldest:  { agentId }
 * - most_reviewed:    { agentId, reviewCount } (counted reviews, D31)
 */
export interface AgentCursor {
  sort: AgentSort;
  agentId: string;
  reviewCount?: number;
}

export function encodeCursor(cursor: AgentCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(raw: string, expectedSort: AgentSort): AgentCursor {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_cursor", "cursor is malformed");
  }
  const c = value as Partial<AgentCursor>;
  if (
    typeof c !== "object" ||
    c === null ||
    c.sort !== expectedSort ||
    typeof c.agentId !== "string" ||
    !/^\d{1,78}$/.test(c.agentId) ||
    (expectedSort === "most_reviewed" && (!Number.isInteger(c.reviewCount) || (c.reviewCount as number) < 0))
  ) {
    throw new HttpError(400, "invalid_cursor", "cursor does not match this query");
  }
  return c as AgentCursor;
}
