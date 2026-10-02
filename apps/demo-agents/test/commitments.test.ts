import { describe, expect, it } from "vitest";
import { concat, keccak256, stringToHex } from "viem";
import { canonicalJson, commit, newSalt } from "../src/commitments.js";

describe("canonicalJson", () => {
  it("sorts object keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
  });
});

describe("commit", () => {
  it("is keccak256(salt || canonical JSON)", () => {
    const salt = newSalt();
    expect(salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(commit(salt, { y: 2, x: 1 })).toBe(keccak256(concat([salt, stringToHex('{"x":1,"y":2}')])));
  });

  it("does not depend on key order, and changes with the salt", () => {
    const salt = newSalt();
    expect(commit(salt, { a: 1, b: 2 })).toBe(commit(salt, { b: 2, a: 1 }));
    expect(commit(newSalt(), { a: 1, b: 2 })).not.toBe(commit(salt, { a: 1, b: 2 }));
  });
});
