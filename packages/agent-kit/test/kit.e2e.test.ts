/**
 * The kit hires the real email-verifier demo agent (apps/demo-agents) over HTTP:
 * quote → confirmed x402 payment → receipt → checks → co-signature. The x402
 * facilitator, the chain reads and the MoltForest API are fakes; the provider,
 * the kit, the x402 client and every signature are real.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseUnits, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { parseReceipt, receiptDomain, recoverReceiptSigner } from "@moltforest/receipts";
// The provider under test is the demo app itself (test-only cross-import).
import { createApp } from "../../../apps/demo-agents/src/app.js";
import { checkEmail } from "../../../apps/demo-agents/src/emailVerifier/checks.js";
import { createPaywallServer, TESTNET_CAIP2 } from "../../../apps/demo-agents/src/paywall.js";
import { ReceiptIssuer, type AgentDirectory } from "../../../apps/demo-agents/src/receipts.js";
import { RECEIPT_REGISTRY, TESTNET } from "../src/chain.js";
import { loadConfig } from "../src/config.js";
import { Kit } from "../src/kit.js";
import { MoltForestApi, type ReceiptSubmission } from "../src/moltforest.js";
import { createSafeFetch, KitError } from "../src/net.js";
import { KitStore } from "../src/store.js";

const provider = privateKeyToAccount(generatePrivateKey());
const PROVIDER_ID = 4242n;
const MY_AGENT_ID = "1720";
const SETTLE_TX: Hex = `0x${"cd".repeat(32)}`;
const EMAIL = "jane.doe@example.com";

class FakeFacilitator implements FacilitatorClient {
  settled = 0;
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: TESTNET_CAIP2 }], extensions: [], signers: {} };
  }
  async verify(payload: PaymentPayload) {
    return { isValid: true, payer: (payload.payload as { authorization: { from: string } }).authorization.from };
  }
  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    this.settled++;
    return { success: true, transaction: SETTLE_TX, network: req.network, payer: (payload.payload as { authorization: { from: string } }).authorization.from };
  }
}

let kitAddress: Address;
const facilitator = new FakeFacilitator();
const directory: AgentDirectory = {
  addressesOf: async (id) => (id === BigInt(MY_AGENT_ID) ? { owner: kitAddress, wallet: null } : null),
  receiptSignerOf: async () => provider.address,
};
const providerSubmissions: unknown[] = [];
const apiSubmissions: ReceiptSubmission[] = [];

/** The few chain reads the kit makes. */
const fakeChain = {
  getBalance: async () => parseUnits("1", 18),
  readContract: async ({ functionName }: { functionName: string }) => {
    if (functionName === "balanceOf") return parseUnits("5", 6);
    if (functionName === "signerOf") return provider.address;
    throw new Error(`unexpected read ${functionName}`);
  },
  getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
    if (hash !== SETTLE_TX) throw new Error("not found");
    return { status: "success" };
  },
  estimateContractGas: async () => 300_000n,
  getGasPrice: async () => 100_000_000_000n,
} as unknown as PublicClient;

const fakeApiFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/v1/receipts") && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as ReceiptSubmission;
    apiSubmissions.push(body);
    return Response.json({ level: body.clientSignature ? 2 : 1, anchor: { status: "queued" } });
  }
  return Response.json({ error: { message: "not found" } }, { status: 404 });
}) as typeof fetch;

let server: Server;
let verifyUrl: string;
let home: string;

function newKit(env: Record<string, string> = {}) {
  const config = loadConfig({ MOLTFOREST_KIT_HOME: home, MOLTFOREST_KIT_ALLOW_LOCAL: "true", ...env });
  return new Kit({
    config,
    store: new KitStore(home),
    api: new MoltForestApi("http://api.test", fakeApiFetch),
    publicClient: fakeChain,
    walletClientFor: () => {
      throw new Error("no transactions in this test");
    },
    serviceFetch: createSafeFetch({ allowLocal: true }),
  });
}

beforeAll(async () => {
  const paywall = createPaywallServer(facilitator, [
    {
      pattern: "POST /demo/email-verifier/verify",
      resource: "http://agents.test/demo/email-verifier/verify",
      payTo: provider.address,
      amount: 10_000n,
      description: "test",
      serviceName: "test",
    },
  ]);
  await paywall.initialize();
  const issuer = new ReceiptIssuer(PROVIDER_ID, provider, async (body) => {
    providerSubmissions.push(body);
    return { ok: true, status: 202 };
  });
  const app = createApp({
    rateLimitPerMinute: 1_000,
    emailVerifier: {
      paywall,
      paymentsReady: () => true,
      check: (email) =>
        checkEmail(email, { resolveMx: async () => [{ exchange: "mx.example.com", priority: 10 }], resolve4: async () => [], resolve6: async () => [] }),
      receipts: () => issuer,
      directory,
      payTo: provider.address,
      priceAtomic: 10_000n,
      publicUrl: "http://agents.test",
      apiUrl: "http://api.test",
      webUrl: "http://web.test",
      facilitatorUrl: "http://facilitator.test",
    },
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  verifyUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/demo/email-verifier/verify`;
});

afterAll(() => {
  server?.close();
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "agent-kit-"));
  providerSubmissions.length = 0;
  apiSubmissions.length = 0;
});

/** A kit with a wallet registered as agent 1720. */
async function registeredKit(env: Record<string, string> = {}) {
  const kit = newKit(env);
  const created = await kit.createWallet();
  kitAddress = created.address;
  const store = new KitStore(home);
  await store.writeWallet({ ...(await store.readWallet())!, agentId: MY_AGENT_ID });
  return kit;
}

const hireArgs = { url: "", method: "POST" as const, body: { email: EMAIL, clientAgentId: MY_AGENT_ID } };

describe("wallet", () => {
  it("creates a wallet once, and never returns the private key", async () => {
    const kit = newKit();
    const first = await kit.createWallet();
    expect(first.created).toBe(true);
    const second = await kit.createWallet();
    expect(second).toMatchObject({ created: false, address: first.address });

    const stored = JSON.parse(await readFile(join(home, "wallet.json"), "utf8")) as { privateKey: string; address: string };
    expect(privateKeyToAccount(stored.privateKey as Hex).address).toBe(first.address);
    for (const result of [first, second, await kit.status()]) expect(JSON.stringify(result)).not.toContain(stored.privateKey.slice(2));
  });

  it("reports balances and spend caps", async () => {
    const kit = await registeredKit();
    expect(await kit.status()).toMatchObject({
      balances: { MON: "1", USDC: "5" },
      agent: { agentId: MY_AGENT_ID },
      spendCaps: { perPaymentUsdc: "0.1", per24hUsdc: "1", spentLast24hUsdc: "0", remainingUsdc: "1" },
    });
  });
});

describe("hire_agent", () => {
  it("quotes without paying", async () => {
    const kit = await registeredKit();
    const settled = facilitator.settled;
    const quote = await kit.hire({ ...hireArgs, url: verifyUrl, confirm: false });
    expect(quote).toMatchObject({ paid: false, quote: { priceUsdc: "0.01", payTo: provider.address, network: "eip155:10143" }, withinCaps: true });
    expect(facilitator.settled).toBe(settled);
  });

  it("refuses to pay without an agreed price, above it, or above the per-payment cap", async () => {
    const kit = await registeredKit();
    await expect(kit.hire({ ...hireArgs, url: verifyUrl, confirm: true })).rejects.toThrow(/maxPriceUsdc is required/);
    await expect(kit.hire({ ...hireArgs, url: verifyUrl, confirm: true, maxPriceUsdc: "0.005" })).rejects.toThrow(/above the agreed/);
    const capped = await registeredKit({ MOLTFOREST_KIT_MAX_PER_PAYMENT_USDC: "0.005" });
    await expect(capped.hire({ ...hireArgs, url: verifyUrl, confirm: true, maxPriceUsdc: "0.01" })).rejects.toThrow(/per-payment cap/);
  });

  it("pays, gets the result and a receipt, then checks and co-signs it", async () => {
    const kit = await registeredKit();
    const hired = await kit.hire({ ...hireArgs, url: verifyUrl, confirm: true, maxPriceUsdc: "0.01" });
    expect(hired).toMatchObject({
      paid: true,
      status: 200,
      payment: { transaction: SETTLE_TX, amountUsdc: "0.01", payTo: provider.address },
      response: { result: { status: "pass" } },
      receipt: { level: 1, providerAgentId: "4242", clientAgentId: MY_AGENT_ID },
    });
    expect(providerSubmissions).toHaveLength(1);
    expect((await kit.status()).spendCaps.spentLast24hUsdc).toBe("0.01");

    const receiptHash = (hired as { receipt: { receiptHash: Hex } }).receipt.receiptHash;
    const cosigned = await kit.cosign({ receiptHash, acceptUnverified: false });
    expect(cosigned).toMatchObject({ coSigned: true, submitted: { ok: true, level: 2 } });
    expect((cosigned as { checks: { ok: boolean }[] }).checks.every((c) => c.ok)).toBe(true);

    expect(apiSubmissions).toHaveLength(1);
    const sub = apiSubmissions[0]!;
    const signer = await recoverReceiptSigner(parseReceipt(sub.receipt), receiptDomain(TESTNET.chainId, RECEIPT_REGISTRY), sub.clientSignature!);
    expect(signer).toBe(kitAddress);

    expect(await kit.cosign({ receiptHash, acceptUnverified: false })).toMatchObject({ alreadyCoSigned: true });

    // review_agent previews an ERC-8004 review that attaches the payment and the receipt.
    const preview = (await kit.reviewAgent({ receiptHash, rating: 90, confirm: false })) as { preview: Record<string, unknown>; enoughMON: boolean };
    expect(preview.preview).toMatchObject({
      agentId: 4242,
      value: 90,
      tag1: "starred",
      endpoint: verifyUrl,
      proofOfPayment: { fromAddress: kitAddress, toAddress: provider.address, chainId: "10143", txHash: SETTLE_TX },
      executionReceipt: { receiptHash },
    });
    expect(preview.enoughMON).toBe(true);
    await expect(kit.reviewAgent({ receiptHash: `0x${"ee".repeat(32)}`, rating: 50, confirm: false })).rejects.toThrow(/No job/);
    const activity = await kit.activity();
    expect(activity.local.jobs).toEqual([expect.objectContaining({ receiptHash, coSigned: true })]);
  });

  it("does not co-sign a receipt whose result does not match what was received", async () => {
    const kit = await registeredKit();
    const hired = (await kit.hire({ ...hireArgs, url: verifyUrl, confirm: true, maxPriceUsdc: "0.01" })) as { receipt: { receiptHash: Hex } };
    const store = new KitStore(home);
    await store.updateLedger((l) => {
      (l.jobs[0]!.response as { result: { status: string } }).result.status = "fail";
    });
    const res = await kit.cosign({ receiptHash: hired.receipt.receiptHash, acceptUnverified: false });
    expect(res).toMatchObject({ coSigned: false });
    expect((res as { checks: { check: string; ok: boolean }[] }).checks.find((c) => c.check === "result hash")?.ok).toBe(false);
    expect(apiSubmissions).toHaveLength(0);
  });

  it("stops at the 24-hour cap", async () => {
    const kit = await registeredKit({ MOLTFOREST_KIT_MAX_PER_PAYMENT_USDC: "0.01", MOLTFOREST_KIT_MAX_PER_DAY_USDC: "0.015" });
    await kit.hire({ ...hireArgs, url: verifyUrl, confirm: true, maxPriceUsdc: "0.01" });
    const settled = facilitator.settled;
    await expect(kit.hire({ ...hireArgs, url: verifyUrl, confirm: true, maxPriceUsdc: "0.01" })).rejects.toThrow(/24-hour cap/);
    expect(facilitator.settled).toBe(settled);
  });

  it("refuses non-https URLs unless local testing is on", async () => {
    const kit = newKit({ MOLTFOREST_KIT_ALLOW_LOCAL: "false" });
    await kit.createWallet();
    await expect(kit.hire({ ...hireArgs, url: verifyUrl, confirm: false })).rejects.toThrow(KitError);
  });
});
