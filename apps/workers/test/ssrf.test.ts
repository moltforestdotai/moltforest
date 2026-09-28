import { describe, expect, it } from "vitest";
import { assertPublicHost, BlockedHostError, isPublicAddress } from "../src/net/ssrf.js";

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata endpoint
    "100.64.0.1", // carrier-grade NAT
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:10.0.0.1",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(["8.8.8.8", "104.16.132.229", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
});

describe("assertPublicHost", () => {
  it("rejects private IP literals, including bracketed IPv6", () => {
    expect(() => assertPublicHost("127.0.0.1")).toThrow(BlockedHostError);
    expect(() => assertPublicHost("[::1]")).toThrow(BlockedHostError);
  });

  it("lets hostnames through (they are checked at connect time)", () => {
    expect(() => assertPublicHost("example.com")).not.toThrow();
    expect(() => assertPublicHost("8.8.8.8")).not.toThrow();
  });
});
