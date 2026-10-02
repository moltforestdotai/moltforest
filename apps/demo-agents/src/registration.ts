/**
 * ERC-8004 registration file of the email-verifier demo agent, stored on-chain
 * as a data: URI (decision D17) and labelled as a MoltForest demo agent (D18).
 */
import { parseAbi } from "viem";
import { NETWORKS } from "@moltforest/chain";
import { EMAIL_VERIFIER_NAME, EMAIL_VERIFIER_PATH } from "./emailVerifier/router.js";

export const identityRegistryWriteAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

export interface RegistrationOptions {
  publicUrl: string;
  webUrl: string;
  /** Known after the first registration; listed in `registrations`. */
  agentId?: bigint;
}

export function emailVerifierRegistration(opts: RegistrationOptions) {
  const testnet = NETWORKS.testnet;
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: EMAIL_VERIFIER_NAME,
    description:
      "MoltForest demo agent on Monad testnet. Checks an email address (syntax, mail domain, disposable domain, role address) " +
      "for 0.01 test USDC per check, paid with x402, and signs a MoltForest execution receipt for every paid job. " +
      "Emails are not stored; receipts carry salted hashes only.",
    image: `${opts.webUrl}/logo.svg`,
    services: [{ name: "web", endpoint: `${opts.publicUrl}${EMAIL_VERIFIER_PATH}` }],
    x402Support: true,
    active: true,
    registrations:
      opts.agentId === undefined
        ? []
        : [{ agentId: Number(opts.agentId), agentRegistry: `eip155:${testnet.chainId}:${testnet.identityRegistry}` }],
    supportedTrust: ["reputation"],
  };
}

export function toDataUri(registration: unknown): string {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(registration), "utf8").toString("base64")}`;
}
