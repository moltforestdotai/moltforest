import { isNansenServiceLabel, nansenLinkKind } from "@moltforest/chain";
import type { NansenFacts, WalletLink } from "../reviews/assess.js";

/** One stored related wallet (app.nansen_relation). */
export interface NansenRelationRow {
  wallet: string;
  related: string;
  relation: string;
  label: string | null;
  txHash: string | null;
}

/** Pure: the links and the exchange, bridge and faucet addresses in stored Nansen rows (decision D47). */
export function nansenFactsFromRows(rows: NansenRelationRow[]): NansenFacts {
  const links: WalletLink[] = [];
  const services = new Map<string, string>();
  for (const row of rows) {
    if (row.label && isNansenServiceLabel(row.label)) services.set(row.related, row.label);
    const kind = nansenLinkKind(row.relation);
    if (kind && row.related !== row.wallet) links.push({ wallet: row.wallet, other: row.related, relation: row.relation, kind, tx: row.txHash });
  }
  return { links, services };
}
