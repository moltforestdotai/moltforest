import { createHash } from "node:crypto";
import { normalizeRegistration, type AgentService, type UriKind } from "@moltforest/registration";
import type { ProfileStatus } from "@moltforest/db";
import type { FetchOutcome } from "../net/fetchDocument.js";
import { fetchUrlsFor, isTransient, nextFetchDelayMs } from "./policy.js";

/** An agent whose remote registration file is due for (re)fetching. */
export interface EnrichTarget {
  chainId: number;
  agentId: string;
  uri: string;
  uriKind: string;
  previous: {
    uri: string;
    contentHash: string | null;
    failures: number;
    changeCount: number;
    firstFetchedAt: Date | null;
    lastOkAt: Date | null;
    lastChangedAt: Date | null;
  } | null;
}

export interface ProfileFields {
  name: string | null;
  description: string | null;
  image: string | null;
  services: AgentService[];
  serviceCount: number;
  x402Support: boolean | null;
  active: boolean | null;
  supportedTrust: string[];
}

export interface ProfileRow {
  chainId: number;
  agentId: string;
  uri: string;
  uriKind: string;
  fetchUrl: string | null;
  status: ProfileStatus;
  httpStatus: number | null;
  error: string | null;
  contentHash: string | null;
  /** null = keep the stored fields (transient failure on the same URI). */
  fields: ProfileFields | null;
  firstFetchedAt: Date | null;
  fetchedAt: Date;
  lastOkAt: Date | null;
  nextFetchAt: Date;
  failures: number;
  changeCount: number;
  lastChangedAt: Date | null;
}

export interface EnrichResult {
  row: ProfileRow;
  /** Present when a new, valid document was fetched: stored as a snapshot. */
  snapshot: { contentHash: string; document: unknown } | null;
}

export type Fetcher = (url: string) => Promise<FetchOutcome>;

const EMPTY_FIELDS: ProfileFields = {
  name: null,
  description: null,
  image: null,
  services: [],
  serviceCount: 0,
  x402Support: null,
  active: null,
  supportedTrust: [],
};

/** Fetches and interprets one agent's remote registration file. Never throws. */
export async function enrichAgent(
  target: EnrichTarget,
  fetcher: Fetcher,
  opts: { ipfsGateways: string[]; now?: () => Date; random?: () => number },
): Promise<EnrichResult> {
  const now = opts.now?.() ?? new Date();
  const prev = target.previous;
  const sameUri = prev !== null && prev.uri === target.uri;
  const base = {
    chainId: target.chainId,
    agentId: target.agentId,
    uri: target.uri,
    uriKind: target.uriKind,
    firstFetchedAt: prev?.firstFetchedAt ?? now,
    fetchedAt: now,
  };

  const fail = (status: ProfileStatus, outcome: FetchOutcome, fetchUrl: string | null, error: string): EnrichResult => {
    const transient = isTransient(outcome);
    const failures = (sameUri ? prev!.failures : 0) + 1;
    const keep = transient && sameUri;
    return {
      row: {
        ...base,
        fetchUrl,
        status,
        httpStatus: outcome.kind === "http_error" || outcome.kind === "too_large" ? outcome.httpStatus : null,
        error,
        contentHash: keep ? prev!.contentHash : null,
        fields: keep ? null : EMPTY_FIELDS,
        lastOkAt: keep ? prev!.lastOkAt : null,
        nextFetchAt: new Date(now.getTime() + nextFetchDelayMs({ ok: false, transient, failures }, opts.random)),
        failures,
        changeCount: prev?.changeCount ?? 0,
        lastChangedAt: prev?.lastChangedAt ?? null,
      },
      snapshot: null,
    };
  };

  const urls = fetchUrlsFor(target.uri, target.uriKind, opts.ipfsGateways);
  if (urls.length === 0) return fail("blocked", { kind: "blocked", reason: "empty URI" }, null, "empty URI");

  // Try each candidate URL (several only for ipfs gateways). A gateway's error (429, 403, …)
  // says nothing about the content, so ipfs moves on after any failure; other URIs stop at
  // the first definitive answer.
  const tryEveryUrl = target.uriKind === "ipfs";
  let outcome: FetchOutcome = { kind: "network_error", reason: "not attempted" };
  let fetchUrl = urls[0]!;
  for (const url of urls) {
    fetchUrl = url;
    outcome = await fetcher(url);
    if (outcome.kind === "ok" || (!tryEveryUrl && !isTransient(outcome))) break;
  }

  switch (outcome.kind) {
    case "blocked":
      return fail("blocked", outcome, fetchUrl, outcome.reason);
    case "too_large":
      return fail("too_large", outcome, fetchUrl, "registration file exceeds the size limit");
    case "network_error":
      return fail("unreachable", outcome, fetchUrl, outcome.reason);
    case "http_error":
      return fail(
        "unreachable",
        outcome,
        fetchUrl,
        // Seen live: some registries serve registration files behind an x402 paywall.
        outcome.httpStatus === 402 ? "HTTP 402 Payment Required (registration file behind an x402 paywall)" : `HTTP ${outcome.httpStatus}`,
      );
    case "ok":
      break;
  }

  let json: unknown;
  try {
    json = JSON.parse(outcome.body);
  } catch {
    return fail("invalid", outcome, outcome.finalUrl, "registration file is not valid JSON");
  }
  const parsed = normalizeRegistration(json, target.uriKind as UriKind);
  if (parsed.metadataStatus !== "ok") {
    return fail("invalid", outcome, outcome.finalUrl, parsed.metadataError ?? "invalid registration file");
  }

  const contentHash = createHash("sha256").update(outcome.body).digest("hex");
  const changed = prev?.contentHash != null && prev.contentHash !== contentHash;
  return {
    row: {
      ...base,
      fetchUrl: outcome.finalUrl,
      status: "ok",
      httpStatus: outcome.httpStatus,
      error: null,
      contentHash,
      fields: {
        name: parsed.name ?? null,
        description: parsed.description ?? null,
        image: parsed.image ?? null,
        services: parsed.services,
        serviceCount: parsed.services.length,
        x402Support: parsed.x402Support ?? null,
        active: parsed.active ?? null,
        supportedTrust: parsed.supportedTrust,
      },
      lastOkAt: now,
      nextFetchAt: new Date(now.getTime() + nextFetchDelayMs({ ok: true }, opts.random)),
      failures: 0,
      changeCount: (prev?.changeCount ?? 0) + (changed ? 1 : 0),
      lastChangedAt: changed ? now : (prev?.lastChangedAt ?? null),
    },
    snapshot: prev?.contentHash === contentHash ? null : { contentHash, document: json },
  };
}
