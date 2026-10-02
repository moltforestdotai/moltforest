/**
 * What the MCP tools do. Every method returns plain JSON-able data; KitError
 * messages are meant for the user.
 *
 * Safety rules:
 *  - Monad testnet only; nothing here can sign for another chain.
 *  - The private key stays in wallet.json and is never returned or logged.
 *  - Paying needs an explicit confirm with a maximum price, and stays under the
 *    per-payment and 24-hour caps.
 */
import { getAddress, parseUnits, type Account, type Chain, type LocalAccount, type PublicClient, type Transport, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { estimateRegistration, registerAgent, registrationEntry } from "@moltforest/chain";
import { parseReceipt, receiptDomain, receiptToJson, signReceipt } from "@moltforest/receipts";
import type { AgentSummary, NetworkName } from "@moltforest/types";
import type { KitConfig } from "./config.js";
import { balancesOf, formatMon, formatUsdc, IDENTITY_REGISTRY, RECEIPT_REGISTRY, TESTNET, TESTNET_CAIP2 } from "./chain.js";
import { checkJob, checksAllow, extractReceipt } from "./cosign.js";
import { payAndCall, requestQuote, settledTransaction, type ServiceRequest } from "./hire.js";
import type { MoltForestApi } from "./moltforest.js";
import { checkUrl, KitError } from "./net.js";
import { spentInLastDay, type JobRecord, type KitStore, type WalletFile } from "./store.js";

export interface KitDeps {
  config: KitConfig;
  store: KitStore;
  api: MoltForestApi;
  publicClient: PublicClient;
  walletClientFor: (account: LocalAccount) => WalletClient<Transport, Chain, Account>;
  /** fetch for provider URLs (see net.ts). */
  serviceFetch: typeof fetch;
  now?: () => number;
}

const truncate = (s: string | null, n: number) => (s && s.length > n ? `${s.slice(0, n)}…` : s);

const parseUsdc = (value: string, field: string) => {
  if (!/^\d+(\.\d{1,6})?$/.test(value.trim())) throw new KitError(`${field} must be a USDC amount such as "0.01".`);
  return parseUnits(value.trim(), 6);
};

export class Kit {
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: KitDeps) {}

  private get now() {
    return this.deps.now?.() ?? Date.now();
  }

  private profileUrl(network: NetworkName, agentId: string | bigint) {
    return `${this.deps.config.MOLTFOREST_WEB_URL}/agents/${network}/${agentId}`;
  }

  /** Runs payments one at a time, so two hires cannot both fit under the daily cap. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private async wallet(): Promise<WalletFile> {
    const wallet = await this.deps.store.readWallet();
    if (!wallet) throw new KitError("There is no wallet yet. Create one with wallet_create.");
    return wallet;
  }

  private async account(): Promise<LocalAccount> {
    return privateKeyToAccount((await this.wallet()).privateKey);
  }

  private async myAgentId(): Promise<bigint> {
    const wallet = await this.wallet();
    if (wallet.agentId === undefined) throw new KitError("This wallet has no agent yet. Register one with register_agent.");
    return BigInt(wallet.agentId);
  }

  private async caps() {
    const { config, store } = this.deps;
    const spent = spentInLastDay(await store.readLedger(), this.now);
    const perDay = config.MOLTFOREST_KIT_MAX_PER_DAY_USDC;
    return {
      perPayment: config.MOLTFOREST_KIT_MAX_PER_PAYMENT_USDC,
      perDay,
      spent,
      remaining: perDay > spent ? perDay - spent : 0n,
    };
  }

  private async capsView() {
    const c = await this.caps();
    return {
      perPaymentUsdc: formatUsdc(c.perPayment),
      per24hUsdc: formatUsdc(c.perDay),
      spentLast24hUsdc: formatUsdc(c.spent),
      remainingUsdc: formatUsdc(c.remaining),
    };
  }

  async createWallet() {
    const existing = await this.deps.store.readWallet();
    const funding = [
      "Test MON pays gas for registering the agent (about 0.15 MON): use the Monad testnet faucet listed at docs.monad.xyz.",
      "Test USDC pays for hiring agents: https://faucet.circle.com, choose Monad Testnet (20 USDC per address every 2 hours). x402 payments need no MON.",
    ];
    if (existing) {
      return {
        created: false,
        message: "A wallet already exists. The kit never replaces it.",
        address: existing.address,
        network: `Monad testnet (${TESTNET_CAIP2})`,
        keyFile: this.deps.store.walletPath,
        funding,
      };
    }
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    await this.deps.store.writeWallet({
      version: 1,
      network: "testnet",
      address: account.address,
      privateKey,
      createdAt: new Date(this.now).toISOString(),
    });
    return {
      created: true,
      address: account.address,
      network: `Monad testnet (${TESTNET_CAIP2})`,
      keyFile: this.deps.store.walletPath,
      note: "Testnet only. The private key is stored in keyFile on this machine and is never sent anywhere or shown.",
      funding,
    };
  }

  async status() {
    const wallet = await this.wallet();
    const { monWei, usdcAtomic } = await balancesOf(this.deps.publicClient, wallet.address);
    return {
      address: wallet.address,
      network: `Monad testnet (${TESTNET_CAIP2})`,
      balances: { MON: formatMon(monWei), USDC: formatUsdc(usdcAtomic) },
      agent: wallet.agentId === undefined ? null : { agentId: wallet.agentId, profile: this.profileUrl("testnet", wallet.agentId) },
      spendCaps: await this.capsView(),
      keyFile: this.deps.store.walletPath,
    };
  }

  async registerAgent(args: { name: string; description: string; endpoint?: string; image?: string; confirm: boolean }) {
    const wallet = await this.wallet();
    if (wallet.agentId !== undefined) {
      throw new KitError(`This wallet already registered agent ${wallet.agentId} (${this.profileUrl("testnet", wallet.agentId)}).`);
    }
    for (const [field, url] of [["endpoint", args.endpoint], ["image", args.image]] as const) {
      if (url !== undefined && !/^https:\/\/[^\s]+$/.test(url)) throw new KitError(`${field} must be an https:// URL.`);
    }
    const fileFor = (agentId?: bigint) => ({
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: args.name,
      description: args.description,
      ...(args.image ? { image: args.image } : {}),
      services: args.endpoint ? [{ name: "web", endpoint: args.endpoint }] : [],
      active: true,
      registrations: agentId === undefined ? [] : [registrationEntry(TESTNET.chainId, IDENTITY_REGISTRY, agentId)],
      supportedTrust: [],
    });

    const { publicClient } = this.deps;
    const [{ totalCostWei }, balance] = await Promise.all([
      estimateRegistration(publicClient, wallet.address, IDENTITY_REGISTRY, fileFor(0n)),
      publicClient.getBalance({ address: wallet.address }),
    ]);
    if (!args.confirm) {
      return {
        preview: fileFor(),
        estimatedCostMON: formatMon(totalCostWei),
        balanceMON: formatMon(balance),
        enoughMON: balance >= totalCostWei,
        next: "Show this to the user. To register, call register_agent again with the same fields and confirm: true.",
      };
    }
    if (balance < totalCostWei) {
      throw new KitError(`Registering costs about ${formatMon(totalCostWei)} MON for gas; the wallet holds ${formatMon(balance)} MON.`);
    }
    const account = await this.account();
    const result = await registerAgent({ publicClient, walletClient: this.deps.walletClientFor(account), registry: IDENTITY_REGISTRY, fileFor });
    await this.deps.store.writeWallet({ ...wallet, agentId: result.agentId.toString() });
    return {
      agentId: result.agentId.toString(),
      registerTx: result.registerTx,
      setAgentUriTx: result.setUriTx,
      profile: this.profileUrl("testnet", result.agentId),
      note: "MoltForest shows the agent once its indexer has seen the transaction, usually within a minute.",
    };
  }

  private summarize(a: AgentSummary) {
    return {
      network: a.network,
      agentId: a.agentId,
      name: a.name,
      description: truncate(a.description, 240),
      services: a.services.map((s) => ({ name: s.name, endpoint: s.endpoint })),
      x402Support: a.x402Support,
      active: a.active,
      evidence: {
        reviews: { feedback: a.reputation.feedbackCount, reviewers: a.reputation.uniqueReviewerCount },
        uptime: { endpoints: a.liveness.endpoints, up: a.liveness.up, paywalled402: a.liveness.paymentRequired, uptime7d: a.liveness.uptime7d },
        receipts: { total: a.receipts.total, coSigned: a.receipts.coSigned, anchored: a.receipts.anchored },
        payments: {
          receivedFromOthers: a.payments.receivedFromOthers,
          receivedUsdc: a.payments.receivedAmount,
          sent: a.payments.sent,
          self: a.payments.selfPayments,
        },
      },
      profile: this.profileUrl(a.network, a.agentId),
    };
  }

  async findAgents(args: { query?: string; network: NetworkName; payments?: "any" | "received" | "sent"; includeIncomplete: boolean; limit: number }) {
    const res = await this.deps.api.findAgents({ ...args, q: args.query });
    return {
      network: res.network,
      matching: res.total,
      hiddenWithoutUsableProfile: res.hiddenIncomplete,
      agents: res.items.map((a) => this.summarize(a)),
      note: "MoltForest returns evidence, not a verdict: compare it against the user's own requirements.",
    };
  }

  async inspectAgent(args: { network: NetworkName; agentId: string }) {
    const [detail, receipts, payments] = await Promise.all([
      this.deps.api.agent(args.network, args.agentId),
      this.deps.api.receipts(args.network, args.agentId, 5).catch(() => null),
      this.deps.api.payments(args.network, args.agentId, 5).catch(() => null),
    ]);
    return {
      ...this.summarize(detail),
      owner: detail.owner,
      agentWallet: detail.agentWallet,
      registeredAt: detail.registeredAt,
      endpoints: detail.endpoints.map((e) => ({
        url: e.url,
        status: e.status,
        httpStatus: e.httpStatus,
        paywalled402: e.paymentRequired,
        uptime7d: e.uptime7d,
        lastCheckedAt: e.lastCheckedAt,
      })),
      recentReceipts: receipts?.items.map((r) => ({
        receiptHash: r.receiptHash,
        level: r.level,
        providerAgentId: r.receipt.providerAgentId,
        clientAgentId: r.receipt.clientAgentId,
        paymentRef: r.receipt.paymentRef,
        anchored: r.anchor.status === "anchored",
      })),
      recentPayments: payments?.items.map((p) => ({
        direction: p.direction,
        amountUsdc: p.amount,
        payerAgentIds: p.payerAgentIds,
        payeeAgentIds: p.payeeAgentIds,
        transaction: p.txHash,
        at: p.blockTime,
      })),
      note: "Evidence, not a verdict. Read a service's free info page with read_service before hiring it.",
    };
  }

  async readService(args: { url: string }) {
    checkUrl(args.url, this.deps.config.MOLTFOREST_KIT_ALLOW_LOCAL);
    const quote = await requestQuote(this.deps.serviceFetch, { url: args.url, method: "GET" });
    return quote.kind === "no_payment" ? { status: quote.status, body: quote.body } : { status: 402, paymentRequired: quote };
  }

  async hire(args: { url: string; method: "GET" | "POST"; body?: unknown; confirm: boolean; maxPriceUsdc?: string }) {
    checkUrl(args.url, this.deps.config.MOLTFOREST_KIT_ALLOW_LOCAL);
    const request: ServiceRequest = { url: args.url, method: args.method, body: args.body };
    const quote = await requestQuote(this.deps.serviceFetch, request);
    if (quote.kind === "no_payment") {
      return { paid: false, note: "The service did not ask for payment.", status: quote.status, response: quote.body };
    }
    if (!quote.payable) {
      return {
        paid: false,
        note: "The service asks for a payment this kit cannot make: it pays only the x402 'exact' scheme with USDC on Monad testnet.",
        options: quote.options,
      };
    }
    const price = BigInt(quote.payable.amount);
    const caps = await this.caps();
    if (!args.confirm) {
      return {
        paid: false,
        quote: {
          priceUsdc: formatUsdc(price),
          payTo: quote.payable.payTo,
          network: TESTNET_CAIP2,
          resource: quote.resource?.url ?? args.url,
          description: quote.description,
        },
        spendCaps: await this.capsView(),
        withinCaps: price <= caps.perPayment && price <= caps.remaining,
        next: "Nothing was paid. Show the price to the user; if they agree, call hire_agent again with the same request, confirm: true and maxPriceUsdc set to that price.",
      };
    }

    if (args.maxPriceUsdc === undefined) throw new KitError("maxPriceUsdc is required with confirm: true (the price the user agreed to).");
    const max = parseUsdc(args.maxPriceUsdc, "maxPriceUsdc");
    if (price > max) throw new KitError(`The service now asks ${formatUsdc(price)} USDC, above the agreed ${formatUsdc(max)} USDC. Nothing was paid.`);
    if (price > caps.perPayment) {
      throw new KitError(`${formatUsdc(price)} USDC is above the per-payment cap of ${formatUsdc(caps.perPayment)} USDC. Nothing was paid.`);
    }

    return this.exclusive(async () => {
      const { spent, perDay } = await this.caps();
      if (spent + price > perDay) {
        throw new KitError(
          `Paying ${formatUsdc(price)} USDC would exceed the 24-hour cap of ${formatUsdc(perDay)} USDC (${formatUsdc(spent)} spent). Nothing was paid.`,
        );
      }
      const account = await this.account();
      const { usdcAtomic } = await balancesOf(this.deps.publicClient, account.address);
      if (usdcAtomic < price) {
        throw new KitError(`The wallet holds ${formatUsdc(usdcAtomic)} test USDC; this costs ${formatUsdc(price)}. Get test USDC at https://faucet.circle.com (Monad Testnet).`);
      }

      const call = await payAndCall(account, this.deps.serviceFetch, request, price);
      const tx = settledTransaction(call);
      const at = new Date(this.now).toISOString();
      if (tx && call.paid) {
        await this.deps.store.updateLedger((l) => {
          l.payments.push({ at, url: args.url, amount: call.paid!.amount, payTo: getAddress(call.paid!.payTo), transaction: tx });
        });
      }

      const found = tx ? extractReceipt(call.body) : null;
      if (found && tx) {
        const job: JobRecord = {
          at,
          url: args.url,
          request: args.body ?? null,
          response: call.body,
          paymentTx: tx,
          receiptHash: found.receiptHash,
          receipt: found.receipt,
          providerSignature: found.providerSignature,
          registry: RECEIPT_REGISTRY,
          chainId: TESTNET.chainId,
        };
        await this.deps.store.updateLedger((l) => {
          l.jobs.push(job);
        });
      }

      return {
        paid: tx !== null,
        status: call.status,
        payment: tx
          ? { transaction: tx, amountUsdc: formatUsdc(BigInt(call.paid!.amount)), payTo: call.paid!.payTo, network: TESTNET_CAIP2 }
          : null,
        ...(tx === null && call.paid ? { note: "A payment was signed but not settled, so nothing was charged." } : {}),
        response: call.body,
        receipt: found
          ? {
              receiptHash: found.receiptHash,
              level: 1,
              providerAgentId: found.receipt.providerAgentId,
              clientAgentId: found.receipt.clientAgentId,
              next: "Call cosign_receipt with this receiptHash to check it and co-sign it (level 2).",
            }
          : null,
      };
    });
  }

  async cosign(args: { receiptHash: string; acceptUnverified: boolean }) {
    const hash = args.receiptHash.toLowerCase();
    const ledger = await this.deps.store.readLedger();
    const job = ledger.jobs.find((j) => j.receiptHash.toLowerCase() === hash);
    if (!job) throw new KitError(`No receipt ${args.receiptHash} from a job this wallet paid for. See my_activity.`);
    if (job.coSigned?.submitted) return { receiptHash: job.receiptHash, alreadyCoSigned: true, level: job.coSigned.level ?? 2 };

    const myAgentId = await this.myAgentId();
    const checks = await checkJob(job, { myAgentId, publicClient: this.deps.publicClient, now: this.deps.now });
    if (!checksAllow(checks, args.acceptUnverified)) {
      return { receiptHash: job.receiptHash, coSigned: false, checks, note: "Not co-signed: a check failed." };
    }

    const account = await this.account();
    const domain = receiptDomain(TESTNET.chainId, RECEIPT_REGISTRY);
    const parsed = parseReceipt(job.receipt);
    const clientSignature = await signReceipt(account, parsed, domain);
    const submitted = await this.deps.api
      .submitReceipt({ network: "testnet", receipt: receiptToJson(parsed), providerSignature: job.providerSignature, clientSignature })
      .then((r) => ({ ok: true as const, level: r.level, anchor: r.anchor.status }))
      .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));

    await this.deps.store.updateLedger((l) => {
      const j = l.jobs.find((x) => x.receiptHash.toLowerCase() === hash);
      if (j) j.coSigned = { at: new Date(this.now).toISOString(), clientSignature, submitted: submitted.ok, ...(submitted.ok ? { level: submitted.level } : {}) };
    });
    return {
      receiptHash: job.receiptHash,
      coSigned: true,
      checks,
      submitted,
      ...(submitted.ok ? { profile: this.profileUrl("testnet", myAgentId) } : { note: "Signed, but MoltForest did not accept it yet; call cosign_receipt again to resubmit." }),
    };
  }

  async activity() {
    const wallet = await this.wallet();
    const ledger = await this.deps.store.readLedger();
    const agentId = wallet.agentId;
    const [receipts, payments] = agentId
      ? await Promise.all([
          this.deps.api.receipts("testnet", agentId, 20).catch(() => null),
          this.deps.api.payments("testnet", agentId, 20).catch(() => null),
        ])
      : [null, null];
    return {
      address: wallet.address,
      agent: agentId ? { agentId, profile: this.profileUrl("testnet", agentId) } : null,
      spendCaps: await this.capsView(),
      local: {
        payments: ledger.payments.slice(-20).map((p) => ({ ...p, amountUsdc: formatUsdc(BigInt(p.amount)) })),
        jobs: ledger.jobs.slice(-20).map((j) => ({
          at: j.at,
          url: j.url,
          receiptHash: j.receiptHash,
          providerAgentId: j.receipt.providerAgentId,
          paymentTx: j.paymentTx,
          coSigned: j.coSigned?.submitted ?? false,
        })),
      },
      onMoltForest: agentId
        ? {
            receipts: receipts?.items.map((r) => ({
              receiptHash: r.receiptHash,
              level: r.level,
              providerAgentId: r.receipt.providerAgentId,
              anchor: r.anchor.status,
            })) ?? "unavailable",
            payments:
              payments?.items.map((p) => ({
                direction: p.direction,
                amountUsdc: p.amount,
                payerAgentIds: p.payerAgentIds,
                payeeAgentIds: p.payeeAgentIds,
                transaction: p.txHash,
                at: p.blockTime,
              })) ?? "unavailable",
            note: "Payments appear after MoltForest's payment indexer runs (every few minutes).",
          }
        : null,
    };
  }
}
