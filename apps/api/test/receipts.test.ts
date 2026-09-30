/**
 * Receipt endpoints against a real Postgres (table cloned from app.receipt)
 * with real EIP-712 signatures and a fake chain verifier. Skipped when the
 * database or the table is missing (run `pnpm db:up` and `pnpm db:migrate`).
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import {
  hashReceipt,
  parseReceipt,
  receiptDomain,
  recoverStrict,
  signReceipt,
  type AgentSignatureResult,
  type ReceiptJson,
} from "@moltforest/receipts";
import type { AgentReceiptsResponse, ReceiptSubmitResponse, ReceiptView } from "@moltforest/types";
import { loadConfig } from "../src/config.js";
import { createDb, type Db } from "../src/db.js";
import { createApp } from "../src/app.js";
import type { ChainChecker } from "../src/services/chainCheck.js";
import type { ReceiptNetworks } from "../src/services/receiptNetworks.js";

const SCHEMA = `rc_test_${randomBytes(4).toString("hex")}`;
const REGISTRY: Address = "0x5555555555555555555555555555555555555555";
const domain = receiptDomain(10143, REGISTRY);
const provider = privateKeyToAccount(generatePrivateKey());
const client = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const PROVIDER_ID = "1937";
const CLIENT_ID = "0";
const RPC_DOWN_ID = "666";

/** Agent id → signer; mirrors the contract's rule with strict ECDSA recovery. */
const signers: Record<string, Address> = { [PROVIDER_ID]: provider.address, [CLIENT_ID]: client.address, "42": stranger.address };
const networks: ReceiptNetworks = {
  testnet: {
    network: "testnet",
    chainId: 10143,
    registry: REGISTRY,
    verifier: {
      async verify(agentId: bigint, digest: Hex, signature: Hex): Promise<AgentSignatureResult> {
        if (agentId.toString() === RPC_DOWN_ID) throw new Error("rpc down");
        const signer = signers[agentId.toString()];
        if (!signer) return { ok: false, reason: "unknown_agent" };
        return (await recoverStrict(digest, signature)) === signer ? { ok: true, signer } : { ok: false, reason: "invalid_signature", signer };
      },
    },
  },
};
const fakeChain: ChainChecker = { highestAgentId: async () => ({ highestAgentId: null, checkedAt: null, error: null }) };

const now = () => Math.floor(Date.now() / 1000);
let seq = 0;
function receiptJson(over: Partial<ReceiptJson> = {}): ReceiptJson {
  seq += 1;
  return {
    taskId: `0x${seq.toString(16).padStart(64, "0")}`,
    clientAgentId: CLIENT_ID,
    providerAgentId: PROVIDER_ID,
    requestHash: `0x${"1".repeat(64)}`,
    resultHash: `0x${"2".repeat(64)}`,
    paymentRef: `0x${"0".repeat(64)}`,
    startedAt: now() - 60,
    completedAt: now() - 30,
    proofType: 0,
    proofRef: `0x${"0".repeat(64)}`,
    ...over,
  };
}
const sign = (account: typeof provider, json: ReceiptJson) => signReceipt(account, parseReceipt(json), domain);
const digestOf = (json: ReceiptJson) => hashReceipt(parseReceipt(json), domain);

let db: Db | undefined;
let app: Express;
let skipReason: string | null = null;

beforeAll(async () => {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    skipReason = (err as Error).message;
    return;
  }
  const pool = createDb(config.DATABASE_URL);
  try {
    const r = await pool.query(`SELECT to_regclass('app.receipt') AS t`);
    if (!r.rows[0]?.t) {
      skipReason = "needs `pnpm db:migrate`";
      await pool.end();
      return;
    }
  } catch (err) {
    skipReason = `database unreachable: ${(err as Error).message}`;
    await pool.end();
    return;
  }
  db = pool;
  await db.query(`CREATE SCHEMA "${SCHEMA}"`);
  await db.query(`CREATE TABLE "${SCHEMA}"."receipt" (LIKE app."receipt" INCLUDING ALL)`);
  app = createApp({
    config: { INDEXER_DB_SCHEMA: SCHEMA, APP_DB_SCHEMA: SCHEMA, CORS_ORIGINS: [], RATE_LIMIT_PER_MINUTE: 10_000 },
    db,
    chain: fakeChain,
    receipts: { networks, submitPerMinute: 10_000, maxFutureSeconds: 300 },
  });
});

afterAll(async () => {
  if (!db) return;
  await db.query(`DROP SCHEMA "${SCHEMA}" CASCADE`);
  await db.end();
});

const post = (body: unknown) => request(app).post("/v1/receipts").send(body as object);

describe("receipts API", () => {
  it("stores a provider-signed receipt at level 1 and queues it for anchoring", async ({ skip }) => {
    if (skipReason) skip(skipReason);
    const json = receiptJson();
    const res = await post({ network: "testnet", receipt: json, providerSignature: await sign(provider, json) });
    expect(res.status).toBe(202);
    const body = res.body as ReceiptSubmitResponse;
    expect(body).toMatchObject({
      receiptHash: digestOf(json),
      network: "testnet",
      chainId: 10143,
      registry: REGISTRY,
      receipt: json,
      level: 1,
      claimedProofType: "none",
      signers: { provider: provider.address.toLowerCase(), client: null },
      duplicate: false,
      anchor: { status: "queued", level: null, txHash: null, blockNumber: null, anchoredAt: null, error: null },
    });
    expect(body.signatures.client).toBeNull();
  });

  it("is idempotent for the same receipt", async ({ skip }) => {
    if (skipReason) skip(skipReason);
    const json = receiptJson();
    const payload = { network: "testnet", receipt: json, providerSignature: await sign(provider, json) };
    expect((await post(payload)).status).toBe(202);
    const again = await post(payload);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true, level: 1 });
  });

  it("raises a stored receipt to level 2 when the client co-signs later", async ({ skip }) => {
    if (skipReason) skip(skipReason);
    const json = receiptJson();
    const providerSignature = await sign(provider, json);
    await post({ network: "testnet", receipt: json, providerSignature });
    await db!.query(`UPDATE "${SCHEMA}".receipt SET anchor_status = 'anchored', anchor_level = 1 WHERE receipt_hash = $1`, [digestOf(json)]);

    const res = await post({ network: "testnet", receipt: json, providerSignature, clientSignature: await sign(client, json) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ duplicate: false, level: 2, signers: { client: client.address.toLowerCase() }, anchor: { status: "queued", level: 1 } });

    const again = await post({ network: "testnet", receipt: json, providerSignature, clientSignature: await sign(client, json) });
    expect(again.body).toMatchObject({ duplicate: true, level: 2 });
  });

  it("stores a co-signed receipt at level 2", async ({ skip }) => {
    if (skipReason) skip(skipReason);
    const json = receiptJson({ proofType: 1, proofRef: `0x${"9".repeat(64)}` });
    const res = await post({
      network: "testnet",
      receipt: json,
      providerSignature: await sign(provider, json),
      clientSignature: await sign(client, json),
    });
    expect(res.status).toBe(202);
    // A claimed ZK proof is recorded as a claim and does not change the level (constraint C4).
    expect(res.body).toMatchObject({ level: 2, claimedProofType: "zk" });
  });

  it.for([
    ["the provider's signature is by someone else", "provider"],
    ["the client's signature is by someone else", "client"],
  ] as const)("rejects when %s", async ([, who], { skip }) => {
    if (skipReason) skip(skipReason);
    const json = receiptJson();
    const good = await sign(provider, json);
    const bad = await sign(stranger, json);
    const res = await post({
      network: "testnet",
      receipt: json,
      providerSignature: who === "provider" ? bad : good,
      ...(who === "client" ? { clientSignature: bad } : {}),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("invalid_signature");
    expect((await request(app).get(`/v1/receipts/${digestOf(json)}`)).status).toBe(404);
  });

  it("rejects unknown agents, and reports RPC failures as retryable", async ({ skip }) => {
    if (skipReason) skip(skipReason);
    const unknown = receiptJson({ providerAgentId: "31337" });
    const r1 = await post({ network: "testnet", receipt: unknown, providerSignature: await sign(provider, unknown) });
    expect(r1.status).toBe(422);
    expect(r1.body.error.code).toBe("unknown_agent");

    const down = receiptJson({ providerAgentId: RPC_DOWN_ID });
    const r2 = await post({ network: "testnet", receipt: down, providerSignature: await sign(provider, down) });
    expect(r2.status).toBe(502);
    expect(r2.body.error.code).toBe("chain_unavailable");
  });

  it("rejects networks without a ReceiptRegistry, future receipts and malformed bodies", async ({ skip }) => {
    if (skipReason) skip(skipReason);
    const json = receiptJson();
    const sig = await sign(provider, json);
    const mainnet = await post({ network: "mainnet", receipt: json, providerSignature: sig });
    expect(mainnet.status).toBe(503);
    expect(mainnet.body.error.code).toBe("receipts_not_enabled");

    const future = receiptJson({ completedAt: now() + 3600 });
    const r = await post({ network: "testnet", receipt: future, providerSignature: await sign(provider, future) });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("invalid_receipt");

    expect((await post({ network: "testnet", receipt: { ...json, clientAgentId: PROVIDER_ID }, providerSignature: sig })).status).toBe(400);
    expect((await post({ network: "testnet", receipt: json, providerSignature: sig, extra: 1 })).status).toBe(400);
    const notJson = await request(app).post("/v1/receipts").set("content-type", "application/json").send("{nope");
    expect(notJson.status).toBe(400);
    expect(notJson.body.error.code).toBe("invalid_body");
    const huge = await post({ network: "testnet", receipt: json, providerSignature: `0x${"ab".repeat(30_000)}` });
    expect(huge.status).toBe(413);
  });

  it("returns one receipt by hash", async ({ skip }) => {
    if (skipReason) skip(skipReason);
    const json = receiptJson();
    await post({ network: "testnet", receipt: json, providerSignature: await sign(provider, json) });
    const res = await request(app).get(`/v1/receipts/${digestOf(json).toUpperCase().replace("0X", "0x")}`);
    expect(res.status).toBe(200);
    expect((res.body as ReceiptView).receipt).toEqual(json);
    expect((await request(app).get("/v1/receipts/0x1234")).status).toBe(400);
  });

  it("lists an agent's receipts by role, newest first, with a cursor", async ({ skip }) => {
    if (skipReason) skip(skipReason);
    const mine: string[] = [];
    for (let i = 0; i < 3; i++) {
      const json = receiptJson({ providerAgentId: "42", clientAgentId: CLIENT_ID });
      await post({ network: "testnet", receipt: json, providerSignature: await sign(stranger, json) });
      mine.unshift(digestOf(json));
    }
    const page1 = (await request(app).get("/v1/agents/testnet/42/receipts?role=provider&limit=2")).body as AgentReceiptsResponse;
    expect(page1.items.map((r) => r.receiptHash)).toEqual(mine.slice(0, 2));
    expect(page1.nextCursor).not.toBeNull();
    const page2 = (await request(app).get(`/v1/agents/testnet/42/receipts?role=provider&limit=2&cursor=${page1.nextCursor}`))
      .body as AgentReceiptsResponse;
    expect(page2.items.map((r) => r.receiptHash)).toEqual(mine.slice(2));
    expect(page2.nextCursor).toBeNull();

    const asClient = (await request(app).get("/v1/agents/testnet/42/receipts?role=client")).body as AgentReceiptsResponse;
    expect(asClient.items).toHaveLength(0);
    const any = (await request(app).get(`/v1/agents/testnet/${CLIENT_ID}/receipts`)).body as AgentReceiptsResponse;
    expect(any.items.length).toBeGreaterThanOrEqual(3);
    expect((await request(app).get("/v1/agents/mainnet/42/receipts")).body.items).toEqual([]);
    expect((await request(app).get("/v1/agents/testnet/42/receipts?cursor=bad")).status).toBe(400);
  });
});
