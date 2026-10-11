/**
 * Nansen's related-wallets endpoint (decision D47): for one wallet, the
 * addresses Nansen links to it (first funder, signer, multisig, deployer…),
 * each with the transaction behind the link and Nansen's label for it.
 * One lookup costs 1 credit. The API key is sent as the `apikey` header and
 * is never logged.
 */
import { z } from "zod";

export type NansenErrorKind = "auth" | "credits" | "rate_limit" | "bad_request" | "server" | "network" | "bad_response";

export class NansenError extends Error {
  constructor(
    message: string,
    readonly kind: NansenErrorKind,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "NansenError";
  }

  /** Worth asking about the same wallet again later. */
  get transient(): boolean {
    return this.kind !== "bad_request";
  }
}

export interface NansenRelatedWallet {
  /** Lowercase address. */
  address: string;
  /** Nansen's words, e.g. "First Funder" or "Signer". */
  relation: string;
  /** Nansen's label for `address`, e.g. an exchange's name. */
  label: string | null;
  txHash: string | null;
  /** ISO time of the transaction behind the relation. */
  blockTime: string | null;
}

export interface RelatedWalletsResult {
  relations: NansenRelatedWallet[];
  /** Credits the call cost, from the X-Nansen-Credits-Cost header when present. */
  creditsCost: number | null;
}

const Row = z.object({
  address: z.string(),
  address_label: z.string().nullish(),
  relation: z.string(),
  transaction_hash: z.string().nullish(),
  block_timestamp: z.string().nullish(),
});
const Body = z.object({ data: z.array(z.unknown()) });

const ADDRESS = /^0x[0-9a-f]{40}$/;
const TX = /^0x[0-9a-f]{64}$/;

/** Pure: the usable rows of a related-wallets response. Rows that are not an EVM address with a relation are skipped. */
export function parseRelatedWallets(body: unknown): NansenRelatedWallet[] {
  const parsed = Body.safeParse(body);
  if (!parsed.success) throw new NansenError("unexpected related-wallets response", "bad_response");
  const out: NansenRelatedWallet[] = [];
  const seen = new Set<string>();
  for (const item of parsed.data.data) {
    const row = Row.safeParse(item);
    if (!row.success) continue;
    const address = row.data.address.trim().toLowerCase();
    const relation = row.data.relation.trim().slice(0, 64);
    if (!ADDRESS.test(address) || !relation) continue;
    const key = `${address}|${relation.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tx = row.data.transaction_hash?.trim().toLowerCase() ?? "";
    const time = row.data.block_timestamp ? new Date(row.data.block_timestamp) : null;
    out.push({
      address,
      relation,
      label: row.data.address_label?.trim().slice(0, 200) || null,
      txHash: TX.test(tx) ? tx : null,
      blockTime: time && !Number.isNaN(time.getTime()) ? time.toISOString() : null,
    });
  }
  return out;
}

function errorKind(status: number): NansenErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "credits";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "bad_request";
}

export interface NansenClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Related wallets asked for per lookup (Nansen allows up to 1,000). */
  perPage?: number;
  fetch?: typeof fetch;
}

export function createNansenClient(opts: NansenClientOptions) {
  const base = (opts.baseUrl ?? "https://api.nansen.ai").replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;

  return {
    async relatedWallets(address: string, chain: string): Promise<RelatedWalletsResult> {
      let res: Response;
      try {
        res = await doFetch(`${base}/api/v1/profiler/address/related-wallets`, {
          method: "POST",
          headers: { apikey: opts.apiKey, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ wallet_address: address, chain, pagination: { page: 1, per_page: opts.perPage ?? 100 } }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        });
      } catch (err) {
        throw new NansenError(`request failed: ${(err as Error).message}`, "network");
      }
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
        throw new NansenError(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`, errorKind(res.status), res.status);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new NansenError("response is not JSON", "bad_response", res.status);
      }
      const cost = res.headers.get("x-nansen-credits-cost");
      return { relations: parseRelatedWallets(body), creditsCost: cost !== null && Number.isFinite(Number(cost)) ? Number(cost) : null };
    },
  };
}

export type NansenClient = ReturnType<typeof createNansenClient>;
