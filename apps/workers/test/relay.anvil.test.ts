/**
 * End-to-end relay test against a local Anvil chain with the real
 * ReceiptRegistry, the real viem adapter and a real Postgres table. Opt-in:
 *
 *   docker compose run --rm foundry build
 *   docker run -d --rm --name mf-anvil -p 8545:8545 --entrypoint anvil ghcr.io/foundry-rs/foundry:v1.8.1 --host 0.0.0.0 --chain-id 10143
 *   ANVIL_RPC_URL=http://127.0.0.1:8545 pnpm --filter @moltforest/workers exec vitest run test/relay.anvil.test.ts
 *
 * The mock Identity Registry is placed at the real testnet registry address
 * (anvil_setCode), so the same code path as production resolves signers.
 */
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createTestClient, createWalletClient, http, publicActions, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORKS } from "@moltforest/chain";
import { createAgentSignatureVerifier, hashReceipt, newTaskId, receiptDomain, signReceipt, ZERO_BYTES32, type Receipt } from "@moltforest/receipts";
import { loadConfig } from "../src/config.js";
import { createAnchorChain } from "../src/anchor/chain.js";
import { createAnchorRepository } from "../src/anchor/repository.js";
import { runAnchorBatch, type AnchorOptions } from "../src/anchor/runner.js";

const RPC = process.env.ANVIL_RPC_URL;
const OUT = new URL("../../../contracts/out/", import.meta.url);
const artifact = (file: string, name: string) =>
  JSON.parse(readFileSync(new URL(`${file}/${name}.json`, OUT), "utf8")) as { bytecode: { object: Hex }; deployedBytecode: { object: Hex } };
// Anvil's well-known dev keys (public, never funded anywhere real).
const RELAYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const provider = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const client = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e82e959cc2a3b1b4ca7bbe0e2f");
const IDENTITY = NETWORKS.testnet.identityRegistry;
const identityAbi = parseAbi(["function setAgent(uint256 agentId, address owner, address wallet)"]);
const registryAbi = parseAbi(["constructor(address identityRegistry_)", "function levelOf(bytes32) view returns (uint8)"]);

const APP = `relay_e2e_${randomBytes(3).toString("hex")}`;
let skipReason: string | null = null;
let db: pg.Pool | undefined;
let registry: Address;
let chainClient: ReturnType<typeof makeClient>;

function makeClient(rpc: string) {
  return createTestClient({ mode: "anvil", transport: http(rpc), account: privateKeyToAccount(RELAYER_KEY) })
    .extend(publicActions)
    .extend((c) => ({ wallet: createWalletClient({ account: c.account!, transport: http(rpc) }) }));
}

beforeAll(async () => {
  if (!RPC) return void (skipReason = "set ANVIL_RPC_URL to run");
  if (!existsSync(new URL("ReceiptRegistry.sol/ReceiptRegistry.json", OUT))) return void (skipReason = "run `docker compose run --rm foundry build`");
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    return void (skipReason = (err as Error).message);
  }
  db = new pg.Pool({ connectionString: config.DATABASE_URL });
  await db.query(`CREATE SCHEMA "${APP}"`);
  await db.query(`CREATE TABLE "${APP}"."receipt" (LIKE app."receipt" INCLUDING ALL)`);

  chainClient = makeClient(RPC);
  await chainClient.setCode({ address: IDENTITY, bytecode: artifact("MockIdentityRegistry.sol", "MockIdentityRegistry").deployedBytecode.object });
  const setAgent = async (id: bigint, owner: Address, wallet: Address) => {
    const hash = await chainClient.wallet.writeContract({ address: IDENTITY, abi: identityAbi, functionName: "setAgent", args: [id, owner, wallet], chain: null });
    await chainClient.waitForTransactionReceipt({ hash });
  };
  await setAgent(7n, zeroAddress.replace(/0$/, "1") as Address, provider.address);
  await setAgent(0n, client.address, zeroAddress);
  const hash = await chainClient.wallet.deployContract({
    abi: registryAbi,
    bytecode: artifact("ReceiptRegistry.sol", "ReceiptRegistry").bytecode.object,
    args: [IDENTITY],
    chain: null,
  });
  registry = (await chainClient.waitForTransactionReceipt({ hash })).contractAddress!;
}, 60_000);

afterAll(async () => {
  if (!db) return;
  await db.query(`DROP SCHEMA "${APP}" CASCADE`);
  await db.end();
});

const opts: AnchorOptions = {
  chainId: 10143,
  batchSize: 20,
  maxPerAgentPerDay: 100,
  minBalanceWei: 1n,
  txTimeoutMs: 20_000,
  droppedAfterMs: 600_000,
  maxAttempts: 3,
};

async function insert(receipt: Receipt, providerSignature: Hex, clientSignature: Hex | null) {
  const digest = hashReceipt(receipt, receiptDomain(10143, registry));
  await db!.query(
    `INSERT INTO "${APP}".receipt (receipt_hash, chain_id, registry, task_id, client_agent_id, provider_agent_id, request_hash,
       result_hash, payment_ref, started_at, completed_at, proof_type, proof_ref, level, provider_signature, client_signature,
       provider_signer, client_signer)
     VALUES ($1, 10143, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      digest,
      registry.toLowerCase(),
      receipt.taskId,
      receipt.clientAgentId.toString(),
      receipt.providerAgentId.toString(),
      receipt.requestHash,
      receipt.resultHash,
      receipt.paymentRef,
      receipt.startedAt.toString(),
      receipt.completedAt.toString(),
      receipt.proofType,
      receipt.proofRef,
      clientSignature ? 2 : 1,
      providerSignature,
      clientSignature,
      provider.address.toLowerCase(),
      clientSignature ? client.address.toLowerCase() : null,
    ],
  );
  return digest;
}
const row = async (digest: Hex) => (await db!.query(`SELECT * FROM "${APP}".receipt WHERE receipt_hash = $1`, [digest])).rows[0];
const receipt = (): Receipt => ({
  taskId: newTaskId(),
  clientAgentId: 0n,
  providerAgentId: 7n,
  requestHash: `0x${"1".repeat(64)}`,
  resultHash: `0x${"2".repeat(64)}`,
  paymentRef: ZERO_BYTES32,
  startedAt: 1_790_000_000n,
  completedAt: 1_790_000_010n,
  proofType: 0,
  proofRef: ZERO_BYTES32,
});

describe("relay end to end (Anvil)", () => {
  const relay = () =>
    runAnchorBatch(
      {
        repo: createAnchorRepository(db!, APP),
        chain: createAnchorChain({ network: NETWORKS.testnet, rpcUrl: RPC!, registry, privateKey: RELAYER_KEY }),
      },
      opts,
    );
  const levelOf = (digest: Hex) => chainClient.readContract({ address: registry, abi: registryAbi, functionName: "levelOf", args: [digest] });

  it("anchors level 1 and level 2 receipts and records the transaction", async ({ skip }) => {
    if (skipReason) skip(skipReason);
    const domain = receiptDomain(10143, registry);
    const r1 = receipt();
    const d1 = await insert(r1, await signReceipt(provider, r1, domain), null);
    const r2 = receipt();
    const d2 = await insert(r2, await signReceipt(provider, r2, domain), await signReceipt(client, r2, domain));

    // The off-chain verifier resolves the same signers the contract uses.
    const verifier = createAgentSignatureVerifier(chainClient, IDENTITY);
    expect(await verifier.verify(7n, d1, await signReceipt(provider, r1, domain))).toEqual({ ok: true, signer: provider.address });

    expect(await relay()).toMatchObject({ selected: 2, anchored: 2 });
    expect(await levelOf(d1)).toBe(1);
    expect(await levelOf(d2)).toBe(2);
    const stored = await row(d2);
    expect(stored).toMatchObject({ anchor_status: "anchored", anchor_level: 2 });
    expect(stored.anchor_tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Number(stored.anchor_block)).toBeGreaterThan(0);
  }, 60_000);

  it("relays a later co-signature as a level raise", async ({ skip }) => {
    if (skipReason) skip(skipReason);
    const domain = receiptDomain(10143, registry);
    const r = receipt();
    const d = await insert(r, await signReceipt(provider, r, domain), null);
    await relay();
    expect(await levelOf(d)).toBe(1);

    await db!.query(`UPDATE "${APP}".receipt SET level = 2, client_signature = $2, anchor_status = 'queued' WHERE receipt_hash = $1`, [
      d,
      await signReceipt(client, r, domain),
    ]);
    expect(await relay()).toMatchObject({ anchored: 1 });
    expect(await levelOf(d)).toBe(2);
    expect(await row(d)).toMatchObject({ anchor_status: "anchored", anchor_level: 2 });
  }, 60_000);

  it("marks a receipt the contract rejects as failed, from the dry run", async ({ skip }) => {
    if (skipReason) skip(skipReason);
    const domain = receiptDomain(10143, registry);
    const r = receipt();
    const d = await insert(r, await signReceipt(client, r, domain), null); // signed by the wrong key
    expect(await relay()).toMatchObject({ failed: 1 });
    const stored = await row(d);
    expect(stored.anchor_status).toBe("failed");
    expect(stored.anchor_error).toContain("InvalidProviderSignature");
    expect(stored.anchor_tx).toBeNull();
  }, 60_000);

  it("records a receipt someone else anchored first without sending", async ({ skip }) => {
    if (skipReason) skip(skipReason);
    const domain = receiptDomain(10143, registry);
    const r = receipt();
    const sig = await signReceipt(provider, r, domain);
    const d = await insert(r, sig, null);
    const hash = await chainClient.wallet.writeContract({
      address: registry,
      abi: parseAbi([
        "struct Receipt { bytes32 taskId; uint256 clientAgentId; uint256 providerAgentId; bytes32 requestHash; bytes32 resultHash; bytes32 paymentRef; uint64 startedAt; uint64 completedAt; uint8 proofType; bytes32 proofRef; }",
        "function anchor(Receipt r, bytes providerSig, bytes clientSig)",
      ]),
      functionName: "anchor",
      args: [r, sig, "0x"],
      chain: null,
    });
    await chainClient.waitForTransactionReceipt({ hash });
    expect(await relay()).toMatchObject({ alreadyAnchored: 1 });
    expect(await row(d)).toMatchObject({ anchor_status: "anchored", anchor_level: 1, anchor_tx: null });
  }, 60_000);
});
