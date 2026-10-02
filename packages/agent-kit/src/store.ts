/**
 * Local state of the agent kit, kept on the user's machine only (constraint C6):
 *
 *   wallet.json   the testnet key, its address, and the agent id once registered
 *   ledger.json   payments made and jobs (with their receipts) received
 *
 * Nothing here is ever sent anywhere; the private key never leaves wallet.json.
 * Writes go to a temporary file first, then replace the old file.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import type { ReceiptJson } from "@moltforest/receipts";

export interface WalletFile {
  version: 1;
  network: "testnet";
  address: Address;
  privateKey: Hex;
  createdAt: string;
  /** ERC-8004 agent id on Monad testnet, once registered. */
  agentId?: string;
}

export interface PaymentRecord {
  at: string;
  url: string;
  /** USDC atomic units. */
  amount: string;
  payTo: Address;
  transaction: Hex;
}

/** A provider's receipt for a job this agent paid for. */
export interface JobRecord {
  at: string;
  url: string;
  /** The JSON body this agent sent. */
  request: unknown;
  /** The provider's response body. */
  response: unknown;
  paymentTx: Hex;
  receiptHash: Hex;
  receipt: ReceiptJson;
  providerSignature: Hex;
  registry: Address;
  chainId: number;
  coSigned?: { at: string; clientSignature: Hex; submitted: boolean; level?: number };
}

export interface LedgerFile {
  version: 1;
  payments: PaymentRecord[];
  jobs: JobRecord[];
}

const emptyLedger = (): LedgerFile => ({ version: 1, payments: [], jobs: [] });

export class KitStore {
  constructor(readonly home: string) {}

  get walletPath() {
    return join(this.home, "wallet.json");
  }

  get ledgerPath() {
    return join(this.home, "ledger.json");
  }

  async readWallet(): Promise<WalletFile | null> {
    return this.readJson<WalletFile>(this.walletPath);
  }

  async writeWallet(wallet: WalletFile): Promise<void> {
    await this.writeJson(this.walletPath, wallet);
  }

  async readLedger(): Promise<LedgerFile> {
    return (await this.readJson<LedgerFile>(this.ledgerPath)) ?? emptyLedger();
  }

  async updateLedger(change: (ledger: LedgerFile) => void): Promise<LedgerFile> {
    const ledger = await this.readLedger();
    change(ledger);
    await this.writeJson(this.ledgerPath, ledger);
    return ledger;
  }

  private async readJson<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (err) {
      if ((err as { code?: unknown }).code === "ENOENT") return null;
      throw err;
    }
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
  }
}

/** USDC paid in the 24 hours before `now`, in atomic units. */
export function spentInLastDay(ledger: LedgerFile, now = Date.now()): bigint {
  const since = now - 24 * 60 * 60 * 1000;
  return ledger.payments.filter((p) => Date.parse(p.at) > since).reduce((sum, p) => sum + BigInt(p.amount), 0n);
}
