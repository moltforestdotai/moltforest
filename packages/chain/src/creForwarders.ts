/**
 * Chainlink CRE Keystone Forwarder directory (Monad).
 * @see https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts
 *
 * Simulation MockForwarders are required for `cre workflow simulate --broadcast`.
 * Production Forwarders are for live DON deploys only.
 */
import type { NetworkName } from "./networks.js";

export type CreForwarderMode = "simulation" | "production";

export const CRE_FORWARDERS = {
  testnet: {
    simulation: "0xB9F79d863261869B234c481D1f9A7af84AeAd192" as const,
    production: "0xF8344CFd5c43616a4366C34E3EEE75af79a74482" as const,
  },
  mainnet: {
    simulation: "0x9eF6468C5f37b976E57d52054c693269479A784d" as const,
    production: "0x76c9cf548b4179F8901cda1f8623568b58215E62" as const,
  },
} as const satisfies Record<NetworkName, Record<CreForwarderMode, `0x${string}`>>;

export function creForwarder(network: NetworkName, mode: CreForwarderMode = "simulation"): `0x${string}` {
  return CRE_FORWARDERS[network][mode];
}

/** CRE CLI / workflow.yaml target for simulate --broadcast on that network. */
export function creSimulateTarget(network: NetworkName): string {
  return network === "mainnet" ? "mainnet-simulation" : "local-simulation";
}
