/**
 * ERC-8004 feedback files: the off-chain JSON a review's feedbackURI points to.
 * Anyone writes them, so they are untrusted input (constraint C7): fetched with
 * the same SSRF guard and size limit as registration files, checked against the
 * review's feedbackHash, and only three facts are kept:
 *
 *   proofOfPayment   { fromAddress, toAddress, chainId, txHash }   (ERC-8004, for x402)
 *   executionReceipt { receiptHash }                               (MoltForest receipts)
 *   endpoint         the service the review is about: the payment's purpose
 */
import { keccak256, stringToBytes } from "viem";
import { fetchDocument, type FetchOptions } from "../net/fetchDocument.js";
import { fetchUrlsFor, isTransient } from "../enrich/policy.js";

export type FileStatus = "ok" | "invalid" | "hash_mismatch" | "unreachable" | "too_large" | "blocked" | "unsupported";

export interface FeedbackFacts {
  proofTx: string | null;
  proofChainId: string | null;
  proofFrom: string | null;
  proofTo: string | null;
  receiptHash: string | null;
  endpoint: string | null;
}

export interface FileResult extends Partial<FeedbackFacts> {
  status: FileStatus;
  /** Transient failures are retried later. */
  transient?: boolean;
  error?: string;
}

const ZERO_HASH = `0x${"0".repeat(64)}`;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** proofOfPayment addresses may be CAIP-10 ("eip155:1:0x…") or plain. */
const toAddress = (v: unknown) => {
  if (typeof v !== "string") return null;
  const last = v.trim().split(":").at(-1) ?? "";
  return ADDRESS.test(last) ? last.toLowerCase() : null;
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Pure: the facts MoltForest uses from a feedback file's JSON. */
export function parseFeedbackFile(content: string): FeedbackFacts | null {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(json)) return null;
  const pop = isRecord(json.proofOfPayment) ? json.proofOfPayment : null;
  const proofTx = pop && typeof pop.txHash === "string" && HEX32.test(pop.txHash.trim()) ? pop.txHash.trim().toLowerCase() : null;
  const receipt = isRecord(json.executionReceipt) ? json.executionReceipt : null;
  const receiptHash = receipt && typeof receipt.receiptHash === "string" && HEX32.test(receipt.receiptHash.trim()) ? receipt.receiptHash.trim().toLowerCase() : null;
  const endpoint = typeof json.endpoint === "string" && json.endpoint.trim() ? json.endpoint.trim().slice(0, 2048) : null;
  return {
    proofTx,
    proofChainId: pop && (typeof pop.chainId === "string" || typeof pop.chainId === "number") ? String(pop.chainId).trim().slice(0, 64) : null,
    proofFrom: pop ? toAddress(pop.fromAddress) : null,
    proofTo: pop ? toAddress(pop.toAddress) : null,
    receiptHash,
    endpoint,
  };
}

/** True when `chainId` (e.g. "10143" or "eip155:10143") names `expected`. */
export function sameChain(chainId: string | null, expected: number): boolean {
  if (!chainId) return true; // not stated: the review's own chain
  return chainId.split(":").at(-1) === String(expected);
}

/** Decodes `data:[mediatype][;base64],payload`. */
export function decodeDataUri(uri: string): string | null {
  const comma = uri.indexOf(",");
  if (!uri.toLowerCase().startsWith("data:") || comma < 0) return null;
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  try {
    return /;base64$/i.test(meta) ? Buffer.from(payload, "base64").toString("utf8") : decodeURIComponent(payload);
  } catch {
    return null;
  }
}

/** Raw JSON written straight into the URI, as some registration files do. */
const isInlineJson = (uri: string) => uri.trim().startsWith("{");

export async function readFeedbackFile(
  uri: string,
  feedbackHash: string,
  opts: { fetch: Omit<FetchOptions, "maxRedirects"> & { maxRedirects?: number }; ipfsGateways: string[] },
): Promise<FileResult> {
  const trimmed = uri.trim();
  const lower = trimmed.toLowerCase();
  let content: string | null = null;

  if (lower.startsWith("data:")) {
    content = decodeDataUri(trimmed);
    if (content === null) return { status: "invalid", error: "undecodable data: URI" };
  } else if (isInlineJson(trimmed)) {
    content = trimmed;
  } else if (lower.startsWith("ipfs://") || lower.startsWith("https://") || lower.startsWith("http://")) {
    const kind = lower.startsWith("ipfs://") ? "ipfs" : "https";
    let last: FileResult = { status: "unreachable", transient: true, error: "no gateway answered" };
    for (const url of fetchUrlsFor(trimmed, kind, opts.ipfsGateways)) {
      const out = await fetchDocument(url, { maxRedirects: 3, ...opts.fetch });
      if (out.kind === "ok") {
        content = out.body;
        break;
      }
      if (out.kind === "too_large") return { status: "too_large", error: "larger than the size limit" };
      if (out.kind === "blocked") return { status: "blocked", error: out.reason };
      last = {
        status: "unreachable",
        transient: isTransient(out),
        error: out.kind === "http_error" ? `HTTP ${out.httpStatus}` : out.reason,
      };
    }
    if (content === null) return last;
  } else {
    return { status: "unsupported", error: "unsupported URI scheme" };
  }

  // feedbackHash is optional (zero); when given it must match (content-addressed IPFS may omit it).
  if (feedbackHash && feedbackHash !== ZERO_HASH && keccak256(stringToBytes(content)).toLowerCase() !== feedbackHash.toLowerCase()) {
    return { status: "hash_mismatch", error: "content does not match feedbackHash" };
  }
  const facts = parseFeedbackFile(content);
  return facts ? { status: "ok", ...facts } : { status: "invalid", error: "not a JSON object" };
}
