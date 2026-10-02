/**
 * Salted commitments for a receipt's `requestHash` and `resultHash`, shared by
 * providers (which compute them) and clients (which check them before co-signing).
 *
 *   hash = keccak256(salt ‖ utf8(canonical JSON))
 *
 * The salt is 32 random bytes per job, returned only to the paying client, so
 * the client can recompute both hashes while the receipt (public, on-chain)
 * reveals nothing. Without a salt, an email's hash could be found by hashing
 * guesses.
 */
import { concat, keccak256, stringToHex, toHex, type Hex } from "viem";

export const COMMITMENT_SCHEME = "keccak256(salt || utf8(canonical JSON with sorted keys))";

export function newSalt(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** JSON with object keys sorted at every level, so both sides serialize identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export function commit(salt: Hex, value: unknown): Hex {
  return keccak256(concat([salt, stringToHex(canonicalJson(value))]));
}
