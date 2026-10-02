/**
 * The paid flow end to end over HTTP: a real x402 client (signing EIP-3009
 * authorizations with a local key) against the app, with a fake facilitator that
 * checks the authorization's signature, amount and payee, and fakes settlement.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Writable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import { getAddress, verifyTypedData, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { NETWORKS } from "@moltforest/chain";
import { commit, hashReceipt, parseReceipt, recoverReceiptSigner } from "@moltforest/receipts";
import { createApp } from "../src/app.js";
import { checkEmail, type MailResolver } from "../src/emailVerifier/checks.js";
import { EMAIL_VERIFIER_SERVICE } from "../src/emailVerifier/router.js";
import { createPaywallServer, TESTNET_CAIP2, TESTNET_USDC_EIP712 } from "../src/paywall.js";
import { ReceiptIssuer, type AgentAddresses, type AgentDirectory, type ReceiptSubmitBody } from "../src/receipts.js";

const provider = privateKeyToAccount(generatePrivateKey());
const payer = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const PROVIDER_ID = 4242n;
const PRICE = 10_000n; // 0.01 USDC
const SETTLE_TX: Hex = `0x${"ab".repeat(32)}`;
const EMAIL = "jane.doe@example.com";

class FakeFacilitator implements FacilitatorClient {
  verified = 0;
  settled = 0;
  failNextSettle = false;

  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: TESTNET_CAIP2 }], extensions: [], signers: {} };
  }

  async verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    this.verified++;
    const { authorization, signature } = payload.payload as {
      authorization: { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex };
      signature: Hex;
    };
    const valid =
      req.amount === PRICE.toString() &&
      getAddress(authorization.to) === getAddress(req.payTo) &&
      authorization.value === req.amount &&
      (await verifyTypedData({
        address: authorization.from,
        domain: { ...TESTNET_USDC_EIP712, chainId: NETWORKS.testnet.chainId, verifyingContract: getAddress(NETWORKS.testnet.usdc) },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: {
          from: authorization.from,
          to: authorization.to,
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
          nonce: authorization.nonce,
        },
        signature,
      }));
    return valid ? { isValid: true, payer: authorization.from } : { isValid: false, invalidReason: "invalid_exact_evm_payload_signature" };
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    this.settled++;
    const from = (payload.payload as { authorization: { from: string } }).authorization.from;
    if (this.failNextSettle) {
      this.failNextSettle = false;
      return { success: false, errorReason: "insufficient_funds", transaction: "", network: req.network, payer: from };
    }
    return { success: true, transaction: SETTLE_TX, network: req.network, payer: from };
  }
}

const agents = new Map<bigint, AgentAddresses>([
  [1720n, { owner: payer.address, wallet: null }],
  [1721n, { owner: stranger.address, wallet: null }],
]);
const directory: AgentDirectory = {
  addressesOf: async (id) => agents.get(id) ?? null,
  receiptSignerOf: async () => provider.address,
};
const resolver: MailResolver = {
  resolveMx: async () => [{ exchange: "mx.example.com", priority: 10 }],
  resolve4: async () => [],
  resolve6: async () => [],
};

const facilitator = new FakeFacilitator();
const submitted: ReceiptSubmitBody[] = [];
const issuer = new ReceiptIssuer(PROVIDER_ID, provider, async (body) => {
  submitted.push(body);
  return { ok: true, status: 202 };
});
const logLines: string[] = [];
let ready = true;
let server: Server;
let base: string;

const paidFetch = wrapFetchWithPayment(fetch, new x402Client().register(TESTNET_CAIP2, new ExactEvmScheme(payer)));
// Response bodies are asserted field by field.
const json = (res: Response): Promise<any> => res.json();
const post = (f: typeof fetch, body: unknown) =>
  f(`${base}/demo/email-verifier/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  const paywall = createPaywallServer(facilitator, [
    {
      pattern: "POST /demo/email-verifier/verify",
      resource: "http://agents.test/demo/email-verifier/verify",
      payTo: provider.address,
      amount: PRICE,
      description: "test",
      serviceName: "test",
    },
  ]);
  await paywall.initialize();
  const logger = pino(
    { level: "info" },
    new Writable({
      write(chunk, _enc, cb) {
        logLines.push(String(chunk));
        cb();
      },
    }),
  );
  const app = createApp({
    logger,
    rateLimitPerMinute: 1_000,
    emailVerifier: {
      paywall,
      paymentsReady: () => ready,
      check: (email) => checkEmail(email, resolver),
      receipts: () => issuer,
      directory,
      payTo: provider.address,
      priceAtomic: PRICE,
      publicUrl: "http://agents.test",
      apiUrl: "http://api.test",
      webUrl: "http://web.test",
      facilitatorUrl: "http://facilitator.test",
    },
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  ready = true;
  submitted.length = 0;
});

describe("GET /demo/email-verifier", () => {
  it("describes the service, its price and its agent", async () => {
    const res = await fetch(`${base}/demo/email-verifier`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.agent).toEqual({ network: "testnet", agentId: "4242", profile: "http://web.test/agents/testnet/4242" });
    expect(body.service.price).toMatchObject({ amount: "0.01", currency: "USDC", network: "eip155:10143", payTo: provider.address });
  });
});

describe("POST /demo/email-verifier/verify", () => {
  it("rejects a malformed request before asking for payment", async () => {
    const before = facilitator.verified;
    const res = await post(fetch, { mail: EMAIL });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("invalid_request");
    expect(facilitator.verified).toBe(before);
  });

  it("answers an unpaid call with 402 and x402 v2 payment instructions", async () => {
    const res = await post(fetch, { email: EMAIL });
    expect(res.status).toBe(402);
    const header = res.headers.get("payment-required");
    expect(header).toBeTruthy();
    const required = JSON.parse(Buffer.from(header!, "base64").toString("utf8"));
    expect(required.x402Version).toBe(2);
    expect(required.resource.url).toBe("http://agents.test/demo/email-verifier/verify");
    expect(required.accepts).toEqual([
      expect.objectContaining({
        scheme: "exact",
        network: "eip155:10143",
        asset: NETWORKS.testnet.usdc,
        amount: "10000",
        payTo: provider.address,
        extra: expect.objectContaining({ name: "USDC", version: "2" }),
      }),
    ]);
    expect((await json(res)).error.code).toBe("payment_required");
  });

  it("does the job, settles, and returns a signed level-1 receipt that commits to request and result", async () => {
    const settledBefore = facilitator.settled;
    const res = await post(paidFetch, { email: EMAIL, clientAgentId: "1720" });
    expect(res.status).toBe(200);
    expect(facilitator.settled).toBe(settledBefore + 1);
    expect(decodePaymentResponseHeader(res.headers.get("payment-response")!)).toMatchObject({ success: true, transaction: SETTLE_TX });

    const body = await json(res);
    expect(body.result.status).toBe("pass");
    expect(body.payment).toEqual({
      network: "eip155:10143",
      transaction: SETTLE_TX,
      payer: payer.address,
      amount: "10000",
      asset: NETWORKS.testnet.usdc,
    });

    const { salt, requestHash, resultHash } = body.commitment;
    expect(requestHash).toBe(commit(salt, { service: EMAIL_VERIFIER_SERVICE, email: EMAIL }));
    expect(resultHash).toBe(commit(salt, body.result));

    const { receipt } = body;
    expect(receipt).toMatchObject({ network: "testnet", level: 1, chainId: 10143, submitted: { ok: true, status: 202 } });
    expect(receipt.receipt).toMatchObject({
      clientAgentId: "1720",
      providerAgentId: "4242",
      paymentRef: SETTLE_TX,
      requestHash,
      resultHash,
      proofType: 0,
    });
    const parsed = parseReceipt(receipt.receipt);
    expect(receipt.receiptHash).toBe(hashReceipt(parsed, issuer.domain));
    expect(await recoverReceiptSigner(parsed, issuer.domain, receipt.providerSignature)).toBe(provider.address);
    expect(submitted).toEqual([{ network: "testnet", receipt: receipt.receipt, providerSignature: receipt.providerSignature }]);
    expect(JSON.stringify(receipt)).not.toContain(EMAIL);
  });

  it("serves a paid call without clientAgentId, with no receipt", async () => {
    const res = await post(paidFetch, { email: EMAIL });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.receipt).toBeNull();
    expect(body.receiptNote).toMatch(/clientAgentId/);
    expect(submitted).toEqual([]);
  });

  it.for([
    ["1721", "payer_not_client_agent"],
    ["999", "unknown_agent"],
    ["4242", "self_receipt"],
  ] as const)("refuses clientAgentId %s (%s) without settling", async ([clientAgentId, code]) => {
    const settledBefore = facilitator.settled;
    const res = await post(paidFetch, { email: EMAIL, clientAgentId });
    expect(res.status).toBe(422);
    expect((await json(res)).error.code).toBe(code);
    expect(facilitator.settled).toBe(settledBefore);
  });

  it("returns 402 and no result or receipt when settlement fails", async () => {
    facilitator.failNextSettle = true;
    const res = await post(paidFetch, { email: EMAIL, clientAgentId: "1720" });
    expect(res.status).toBe(402);
    const body = await json(res);
    expect(body.result).toBeUndefined();
    expect(submitted).toEqual([]);
  });

  it("answers 503 while the facilitator is not synced", async () => {
    ready = false;
    const res = await post(fetch, { email: EMAIL });
    expect(res.status).toBe(503);
  });

  it("never writes an email address to the logs", () => {
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join("\n")).not.toContain("jane.doe");
  });
});
