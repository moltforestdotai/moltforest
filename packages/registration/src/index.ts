/**
 * ERC-8004 registration-file parsing, shared by the indexer and the enrichment
 * worker.
 *
 * SOURCE OF TRUTH: packages/registration/src/index.ts. apps/indexer runs in
 * Docker outside the pnpm workspace, so it gets a byte-identical copy at
 * apps/indexer/src/lib/agentUri.ts. After editing, run `pnpm sync:registration`;
 * a test fails if the copy drifts.
 *
 * Classifies an agentURI and, for inline `data:` URIs or raw JSON written
 * straight into the URI, decodes and normalizes the registration file.
 * Everything here is pure and synchronous. Remote URIs (ipfs/https/http) are
 * `pending` until the enrichment worker fetches them.
 *
 * All input is untrusted: sizes are capped and unknown fields are dropped.
 */

export type UriKind = "empty" | "data" | "json" | "ipfs" | "https" | "http" | "other";
export type MetadataStatus = "ok" | "pending" | "invalid" | "empty" | "unsupported";

export interface AgentService {
  name: string;
  endpoint: string;
  version?: string;
}

export interface ParsedAgentUri {
  uriKind: UriKind;
  metadataStatus: MetadataStatus;
  metadataError: string | undefined;
  name: string | undefined;
  description: string | undefined;
  image: string | undefined;
  services: AgentService[];
  x402Support: boolean | undefined;
  active: boolean | undefined;
  supportedTrust: string[];
}

export const LIMITS = {
  dataUriBytes: 64 * 1024,
  name: 200,
  description: 2_000,
  url: 2_048,
  services: 50,
  serviceField: 200,
  supportedTrust: 20,
  trustLabel: 64,
} as const;

const EMPTY_FIELDS = {
  metadataError: undefined,
  name: undefined,
  description: undefined,
  image: undefined,
  services: [],
  x402Support: undefined,
  active: undefined,
  supportedTrust: [],
} satisfies Omit<ParsedAgentUri, "uriKind" | "metadataStatus">;

export function classifyUri(uri: string): UriKind {
  const u = uri.trim().toLowerCase();
  if (u === "") return "empty";
  if (u.startsWith("data:")) return "data";
  if (u.startsWith("{")) return "json"; // registration JSON written directly as the URI (seen on mainnet)
  if (u.startsWith("ipfs://")) return "ipfs";
  if (u.startsWith("https://")) return "https";
  if (u.startsWith("http://")) return "http";
  return "other";
}

export function parseAgentUri(uri: string): ParsedAgentUri {
  const uriKind = classifyUri(uri);
  switch (uriKind) {
    case "empty":
      return { uriKind, metadataStatus: "empty", ...EMPTY_FIELDS };
    case "ipfs":
    case "https":
    case "http":
      return { uriKind, metadataStatus: "pending", ...EMPTY_FIELDS };
    case "other":
      return { uriKind, metadataStatus: "unsupported", ...EMPTY_FIELDS };
    case "data":
      return parseDataUri(uri.trim());
    case "json":
      return parseJsonText(uri.trim(), "json");
  }
}

function invalid(error: string, uriKind: UriKind = "data"): ParsedAgentUri {
  return { uriKind, metadataStatus: "invalid", ...EMPTY_FIELDS, metadataError: error };
}

function parseDataUri(uri: string): ParsedAgentUri {
  if (uri.length > LIMITS.dataUriBytes * 2) return invalid("data URI too large");

  const comma = uri.indexOf(",");
  if (comma === -1) return invalid("malformed data URI");
  const header = uri.slice(5, comma).toLowerCase(); // after "data:"
  const payload = uri.slice(comma + 1);
  const isBase64 = header.split(";").includes("base64");

  let text: string;
  try {
    text = isBase64 ? Buffer.from(payload, "base64").toString("utf8") : decodeURIComponent(payload);
  } catch {
    return invalid("undecodable data URI");
  }
  return parseJsonText(text, "data");
}

function parseJsonText(text: string, uriKind: UriKind): ParsedAgentUri {
  if (Buffer.byteLength(text, "utf8") > LIMITS.dataUriBytes) return invalid("registration file too large", uriKind);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return invalid("registration file is not valid JSON", uriKind);
  }
  return normalizeRegistration(json, uriKind);
}

/** Normalizes a parsed registration JSON (also reused for remote files later). */
export function normalizeRegistration(json: unknown, uriKind: UriKind): ParsedAgentUri {
  if (!isRecord(json)) {
    return { uriKind, metadataStatus: "invalid", ...EMPTY_FIELDS, metadataError: "registration file is not a JSON object" };
  }

  // Current spec uses `services`; early drafts used `endpoints`.
  const rawServices = Array.isArray(json.services) ? json.services : Array.isArray(json.endpoints) ? json.endpoints : [];
  const services: AgentService[] = [];
  for (const s of rawServices.slice(0, LIMITS.services)) {
    if (!isRecord(s)) continue;
    const endpoint = str(s.endpoint, LIMITS.url);
    if (!endpoint) continue;
    const service: AgentService = { name: str(s.name, LIMITS.serviceField) ?? "", endpoint };
    const version = str(s.version, LIMITS.serviceField);
    if (version) service.version = version;
    services.push(service);
  }

  const rawTrust = Array.isArray(json.supportedTrust) ? json.supportedTrust : [];
  const supportedTrust = rawTrust
    .map((t) => str(t, LIMITS.trustLabel))
    .filter((t): t is string => t !== undefined)
    .slice(0, LIMITS.supportedTrust);

  return {
    uriKind,
    metadataStatus: "ok",
    metadataError: undefined,
    name: str(json.name, LIMITS.name),
    description: str(json.description, LIMITS.description),
    image: str(json.image, LIMITS.url),
    services,
    x402Support: bool(json.x402Support ?? json.x402support),
    active: bool(json.active),
    supportedTrust,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s === "" ? undefined : s.slice(0, max);
}

function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Decodes the `agentWallet` metadata value (raw bytes as hex) into an address.
 * Accepts 20-byte packed and 32-byte ABI-encoded values; empty means unset.
 */
export function decodeWalletMetadata(hex: string): string | undefined {
  const h = hex.toLowerCase().replace(/^0x/, "");
  if (h.length === 40) return `0x${h}`;
  if (h.length === 64 && /^0{24}/.test(h)) return `0x${h.slice(24)}`;
  return undefined;
}
