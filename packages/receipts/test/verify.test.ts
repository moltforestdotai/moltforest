import { describe, expect, it } from "vitest";
import {
  ContractFunctionRevertedError,
  HttpRequestError,
  concatHex,
  hexToBigInt,
  numberToHex,
  padHex,
  slice,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashReceipt, parseReceipt, receiptDomain, signReceipt } from "../src/index.js";
import { createAgentSignatureVerifier, recoverStrict, type SignatureReader } from "../src/verify.js";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const h = (c: string) => `0x${c.repeat(64)}`;
const receipt = parseReceipt({
  taskId: h("a"),
  clientAgentId: "3",
  providerAgentId: "5",
  requestHash: h("b"),
  resultHash: h("c"),
  paymentRef: h("0"),
  startedAt: 1_790_000_000,
  completedAt: 1_790_000_009,
  proofType: 0,
  proofRef: h("0"),
});
const domain = receiptDomain(10143, "0x3333333333333333333333333333333333333333");
const digest = hashReceipt(receipt, domain);
const account = privateKeyToAccount(generatePrivateKey());
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const SMART_ACCOUNT: Address = "0x4444444444444444444444444444444444444444";

const revert = () => new ContractFunctionRevertedError({ abi: [], functionName: "ownerOf", message: "reverted" });

interface Agent {
  owner?: Address;
  wallet?: Address;
}
function fakeClient(agents: Record<string, Agent>, opts: { code?: Record<string, Hex>; call?: () => Promise<{ data?: Hex }>; readError?: Error } = {}) {
  const client = {
    async readContract({ functionName, args }: { functionName: string; args: readonly [bigint] }) {
      if (opts.readError) throw opts.readError;
      const agent = agents[args[0].toString()];
      if (functionName === "getAgentWallet") return agent?.wallet ?? zeroAddress;
      if (!agent?.owner) throw revert();
      return agent.owner;
    },
    async getCode({ address }: { address: Address }) {
      return opts.code?.[address.toLowerCase()];
    },
    async call() {
      if (!opts.call) throw new Error("unexpected call");
      return opts.call();
    },
  };
  return client as unknown as SignatureReader;
}

describe("recoverStrict", () => {
  it("recovers a normal signature", async () => {
    const sig = await signReceipt(account, receipt, domain);
    expect(await recoverStrict(digest, sig)).toBe(account.address);
  });

  it("rejects the malleable high-s twin that plain ecrecover accepts", async () => {
    const sig = await signReceipt(account, receipt, domain);
    const s = hexToBigInt(slice(sig, 32, 64));
    const v = Number(hexToBigInt(slice(sig, 64, 65)));
    const twin = concatHex([slice(sig, 0, 32), numberToHex(N - s, { size: 32 }), numberToHex(v === 27 ? 28 : 27, { size: 1 })]);
    expect(await recoverStrict(digest, twin)).toBeNull();
  });

  it("rejects 64-byte compact signatures and v of 0/1", async () => {
    const sig = await signReceipt(account, receipt, domain);
    expect(await recoverStrict(digest, slice(sig, 0, 64))).toBeNull();
    const v = Number(hexToBigInt(slice(sig, 64, 65)));
    expect(await recoverStrict(digest, concatHex([slice(sig, 0, 64), numberToHex(v - 27, { size: 1 })]))).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await recoverStrict(digest, `0x${"00".repeat(65)}`)).toBeNull();
  });
});

describe("createAgentSignatureVerifier", () => {
  it("accepts the agent wallet's signature", async () => {
    const verifier = createAgentSignatureVerifier(fakeClient({ 5: { owner: privateKeyToAccount(generatePrivateKey()).address, wallet: account.address } }), REGISTRY);
    const sig = await signReceipt(account, receipt, domain);
    expect(await verifier.verify(5n, digest, sig)).toEqual({ ok: true, signer: account.address });
  });

  it("falls back to the owner when no wallet is set", async () => {
    const verifier = createAgentSignatureVerifier(fakeClient({ 5: { owner: account.address } }), REGISTRY);
    const sig = await signReceipt(account, receipt, domain);
    expect(await verifier.verify(5n, digest, sig)).toEqual({ ok: true, signer: account.address });
  });

  it("rejects the owner's signature when a different wallet is set", async () => {
    const wallet = privateKeyToAccount(generatePrivateKey()).address;
    const verifier = createAgentSignatureVerifier(fakeClient({ 5: { owner: account.address, wallet } }), REGISTRY);
    const sig = await signReceipt(account, receipt, domain);
    expect(await verifier.verify(5n, digest, sig)).toEqual({ ok: false, reason: "invalid_signature", signer: wallet });
  });

  it("reports unknown agents", async () => {
    const verifier = createAgentSignatureVerifier(fakeClient({}), REGISTRY);
    expect(await verifier.verify(99n, digest, "0x00")).toEqual({ ok: false, reason: "unknown_agent" });
  });

  it("asks a smart-account wallet via ERC-1271", async () => {
    const code = { [SMART_ACCOUNT.toLowerCase()]: "0x6080" as Hex };
    const agents = { 5: { owner: account.address, wallet: SMART_ACCOUNT } };
    const magic = padHex("0x1626ba7e", { dir: "right", size: 32 });

    const yes = createAgentSignatureVerifier(fakeClient(agents, { code, call: async () => ({ data: magic }) }), REGISTRY);
    expect(await yes.verify(5n, digest, "0x1234")).toEqual({ ok: true, signer: SMART_ACCOUNT });

    const no = createAgentSignatureVerifier(fakeClient(agents, { code, call: async () => ({ data: padHex("0xffffffff", { dir: "right", size: 32 }) }) }), REGISTRY);
    expect((await no.verify(5n, digest, "0x1234")).ok).toBe(false);

    const empty = createAgentSignatureVerifier(fakeClient(agents, { code, call: async () => ({ data: undefined }) }), REGISTRY);
    expect((await empty.verify(5n, digest, "0x1234")).ok).toBe(false);

    const reverts = createAgentSignatureVerifier(fakeClient(agents, { code, call: async () => Promise.reject(revert()) }), REGISTRY);
    expect((await reverts.verify(5n, digest, "0x1234")).ok).toBe(false);
  });

  it("throws on RPC failures instead of reporting a bad signature", async () => {
    const down = new HttpRequestError({ url: "https://rpc.example" });
    const verifier = createAgentSignatureVerifier(fakeClient({}, { readError: down }), REGISTRY);
    await expect(verifier.verify(5n, digest, "0x00")).rejects.toBe(down);

    const code = { [SMART_ACCOUNT.toLowerCase()]: "0x6080" as Hex };
    const flaky = createAgentSignatureVerifier(
      fakeClient({ 5: { owner: account.address, wallet: SMART_ACCOUNT } }, { code, call: async () => Promise.reject(down) }),
      REGISTRY,
    );
    await expect(flaky.verify(5n, digest, "0x1234")).rejects.toBe(down);
  });
});
