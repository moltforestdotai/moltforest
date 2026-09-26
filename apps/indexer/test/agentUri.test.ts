import { describe, expect, it } from "vitest";
import { classifyUri, decodeWalletMetadata, LIMITS, parseAgentUri } from "../src/lib/agentUri.js";

const toDataUri = (obj: unknown) =>
  `data:application/json;base64,${Buffer.from(JSON.stringify(obj)).toString("base64")}`;

describe("classifyUri", () => {
  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["data:application/json;base64,e30=", "data"],
    ["ipfs://bafy", "ipfs"],
    ["https://agent.example/reg.json", "https"],
    ["HTTP://agent.example/reg.json", "http"],
    ["ftp://nope", "other"],
  ])("%j -> %s", (uri, kind) => {
    expect(classifyUri(uri)).toBe(kind);
  });
});

describe("parseAgentUri", () => {
  it("decodes a base64 registration file", () => {
    const parsed = parseAgentUri(
      toDataUri({
        type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
        name: "  CodeReviewer  ",
        description: "Reviews code",
        image: "https://img.example/a.png",
        services: [{ name: "A2A", endpoint: "https://a.example/a2a", version: "0.3" }, { name: "no endpoint" }],
        x402Support: true,
        active: true,
        supportedTrust: ["reputation", 42, "tee-attestation"],
      }),
    );
    expect(parsed).toEqual({
      uriKind: "data",
      metadataStatus: "ok",
      metadataError: undefined,
      name: "CodeReviewer",
      description: "Reviews code",
      image: "https://img.example/a.png",
      services: [{ name: "A2A", endpoint: "https://a.example/a2a", version: "0.3" }],
      x402Support: true,
      active: true,
      supportedTrust: ["reputation", "tee-attestation"],
    });
  });

  it("decodes a percent-encoded (non-base64) data URI", () => {
    const uri = `data:application/json,${encodeURIComponent(JSON.stringify({ name: "Plain" }))}`;
    expect(parseAgentUri(uri)).toMatchObject({ metadataStatus: "ok", name: "Plain", services: [] });
  });

  it("accepts the legacy `endpoints` field and `x402support` casing", () => {
    const parsed = parseAgentUri(toDataUri({ endpoints: [{ name: "MCP", endpoint: "https://m.example" }], x402support: false }));
    expect(parsed.services).toEqual([{ name: "MCP", endpoint: "https://m.example" }]);
    expect(parsed.x402Support).toBe(false);
  });

  it("marks broken JSON as invalid with a reason", () => {
    const parsed = parseAgentUri("data:application/json;base64," + Buffer.from("{nope").toString("base64"));
    expect(parsed).toMatchObject({ metadataStatus: "invalid", metadataError: "registration file is not valid JSON" });
  });

  it("marks non-object JSON as invalid", () => {
    expect(parseAgentUri(toDataUri(["array"])).metadataStatus).toBe("invalid");
  });

  it("rejects oversized payloads", () => {
    const huge = toDataUri({ name: "x".repeat(LIMITS.dataUriBytes * 2) });
    expect(parseAgentUri(huge).metadataStatus).toBe("invalid");
  });

  it("caps field lengths and service counts", () => {
    const parsed = parseAgentUri(
      toDataUri({
        name: "n".repeat(500),
        services: Array.from({ length: 80 }, (_, i) => ({ name: `s${i}`, endpoint: `https://s${i}.example` })),
      }),
    );
    expect(parsed.name).toHaveLength(LIMITS.name);
    expect(parsed.services).toHaveLength(LIMITS.services);
  });

  it("leaves remote URIs pending and flags unknown schemes", () => {
    expect(parseAgentUri("ipfs://bafy").metadataStatus).toBe("pending");
    expect(parseAgentUri("https://a.example/r.json").metadataStatus).toBe("pending");
    expect(parseAgentUri("ftp://a").metadataStatus).toBe("unsupported");
    expect(parseAgentUri("").metadataStatus).toBe("empty");
  });
});

describe("decodeWalletMetadata", () => {
  const addr = "0x00000000000000000000000000000000000000aa";
  it("decodes packed and ABI-encoded addresses", () => {
    expect(decodeWalletMetadata("0x" + addr.slice(2).toUpperCase())).toBe(addr);
    expect(decodeWalletMetadata("0x" + "0".repeat(24) + addr.slice(2))).toBe(addr);
  });
  it("returns undefined for empty or malformed values", () => {
    expect(decodeWalletMetadata("0x")).toBeUndefined();
    expect(decodeWalletMetadata("0x1234")).toBeUndefined();
  });
});
