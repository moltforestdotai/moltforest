import { describe, expect, it } from "vitest";
import { createNansenClient, NansenError, parseRelatedWallets } from "../src/nansen/client.js";

const FUNDER = `0x${"ab".repeat(20)}`;
const SIGNER = `0x${"cd".repeat(20)}`;
const TX = `0x${"12".repeat(32)}`;

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("parseRelatedWallets", () => {
  it("keeps EVM rows with a relation, lowercased, with label, tx and time", () => {
    const rows = parseRelatedWallets({
      data: [
        { address: FUNDER.toUpperCase().replace("0X", "0x"), address_label: " Binance 14 ", relation: "First Funder", transaction_hash: TX.toUpperCase().replace("0X", "0x"), block_timestamp: "2026-09-01T10:00:00Z", order: 1, chain: "monad" },
        { address: SIGNER, address_label: null, relation: "Signer", transaction_hash: "not-a-hash", block_timestamp: "garbage" },
      ],
    });
    expect(rows).toEqual([
      { address: FUNDER, relation: "First Funder", label: "Binance 14", txHash: TX, blockTime: "2026-09-01T10:00:00.000Z" },
      { address: SIGNER, relation: "Signer", label: null, txHash: null, blockTime: null },
    ]);
  });

  it("skips non-EVM addresses, rows without a relation, malformed rows and repeats", () => {
    const rows = parseRelatedWallets({
      data: [
        { address: "So11111111111111111111111111111111111111112", relation: "First Funder" },
        { address: FUNDER, relation: "  " },
        { relation: "Signer" },
        "nonsense",
        { address: SIGNER, relation: "Signer" },
        { address: SIGNER, relation: "signer" },
      ],
    });
    expect(rows.map((r) => [r.address, r.relation])).toEqual([[SIGNER, "Signer"]]);
  });

  it("rejects a body without a data array", () => {
    expect(() => parseRelatedWallets({ error: "nope" })).toThrow(NansenError);
  });
});

describe("createNansenClient", () => {
  it("posts the wallet and chain with the API key header and reads the credit cost", async () => {
    const { fn, calls } = fakeFetch(200, { data: [{ address: FUNDER, relation: "First Funder" }] }, { "x-nansen-credits-cost": "1" });
    const client = createNansenClient({ apiKey: "secret", baseUrl: "https://nansen.example/", fetch: fn });
    const result = await client.relatedWallets(SIGNER, "monad");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://nansen.example/api/v1/profiler/address/related-wallets");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).apikey).toBe("secret");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ wallet_address: SIGNER, chain: "monad", pagination: { page: 1, per_page: 100 } });
    expect(result).toEqual({ relations: [{ address: FUNDER, relation: "First Funder", label: null, txHash: null, blockTime: null }], creditsCost: 1 });
  });

  it.each([
    [401, "auth", true],
    [403, "auth", true],
    [402, "credits", true],
    [429, "rate_limit", true],
    [503, "server", true],
    [400, "bad_request", false],
    [422, "bad_request", false],
  ] as const)("maps HTTP %i to %s", async (status, kind, transient) => {
    const { fn } = fakeFetch(status, { message: "no" });
    const err = await createNansenClient({ apiKey: "k", fetch: fn })
      .relatedWallets(SIGNER, "monad")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NansenError);
    expect(err).toMatchObject({ kind, status, transient });
  });

  it("reports a network failure and a non-JSON answer as transient", async () => {
    const failing = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    await expect(createNansenClient({ apiKey: "k", fetch: failing }).relatedWallets(SIGNER, "monad")).rejects.toMatchObject({ kind: "network", transient: true });

    const { fn } = fakeFetch(200, "<html>oops</html>");
    await expect(createNansenClient({ apiKey: "k", fetch: fn }).relatedWallets(SIGNER, "monad")).rejects.toMatchObject({ kind: "bad_response", transient: true });
  });

  it("never puts the API key in an error message", async () => {
    const { fn } = fakeFetch(401, { message: "invalid key" });
    const err = (await createNansenClient({ apiKey: "super-secret-key", fetch: fn })
      .relatedWallets(SIGNER, "monad")
      .catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("super-secret-key");
  });
});
