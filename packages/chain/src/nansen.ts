/**
 * How MoltForest reads Nansen's related wallets (decision D47). Shared by the
 * reviews worker, which links wallets with them, and the API, which draws them.
 */

/**
 * - funding: "First Funder", the same fact as MoltForest's own funding scan.
 *   A funder of many unrelated wallets (a hub, or an exchange) links nothing.
 * - control: the key that signs for a wallet, or a multisig it signs for:
 *   one controller, so these link even across many agents.
 * Deployment relations are not used: a factory or a bundler deploys
 * thousands of unrelated accounts.
 */
export type NansenLinkKind = "funding" | "control";

const LINK_KINDS = new Map<string, NansenLinkKind>([
  ["first funder", "funding"],
  ["signer", "control"],
  ["previous signer", "control"],
  ["multisig signer of", "control"],
  ["previous multisig signer of", "control"],
]);

/** The kind of a Nansen relation MoltForest uses, or null for one it ignores. */
export function nansenLinkKind(relation: string): NansenLinkKind | null {
  return LINK_KINDS.get(relation.trim().toLowerCase()) ?? null;
}

const SERVICE_WORDS = /\b(exchange|cex|hot ?wallet|deposit|withdrawals?|bridge|faucet|custody|custodian|payment processor|on-?ramp)\b/i;
const SERVICE_NAMES =
  /\b(binance|coinbase|okx|okex|bybit|kraken|kucoin|bitget|gate\.io|mexc|htx|huobi|crypto\.com|bitfinex|bitstamp|gemini|upbit|bithumb|bitvavo|bitpanda|poloniex|bitmart|lbank|whitebit|wormhole|layerzero|stargate|across protocol|orbiter|debridge|axelar)\b/i;

/**
 * True when a Nansen label names an exchange, bridge or faucet: an address
 * that sends funds to strangers, so funding from it says nothing about who
 * controls the funded wallet. Matched on words and well-known names, to be
 * refined once real Monad labels have been seen.
 */
export function isNansenServiceLabel(label: string | null | undefined): boolean {
  return !!label && (SERVICE_WORDS.test(label) || SERVICE_NAMES.test(label));
}
