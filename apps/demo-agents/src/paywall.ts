/**
 * x402 paywall for the demo agents (x402 v2, "exact" scheme, USDC on Monad testnet).
 *
 * Routes call the x402 core server directly instead of using the stock Express
 * middleware: that middleware settles only after the handler has written its
 * response, but a receipt needs the settlement transaction (`paymentRef`).
 * Here a paid request goes: verify payment → do the job → settle → sign the
 * receipt → respond.
 */
import type { Request, Response } from "express";
import type { Address } from "viem";
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
  type HTTPAdapter,
  type HTTPRequestContext,
  type HTTPResponseInstructions,
  type RouteConfig,
} from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { NETWORKS } from "@moltforest/chain";

const TESTNET = NETWORKS.testnet;
export const TESTNET_CAIP2 = `eip155:${TESTNET.chainId}` as const;

/** EIP-712 domain of testnet USDC (`name()` and `version()` verified on-chain), needed to sign EIP-3009 authorizations. */
export const TESTNET_USDC_EIP712 = { name: "USDC", version: "2" } as const;

export function createFacilitator(url: string): FacilitatorClient {
  return new HTTPFacilitatorClient({ url, timeoutMs: 30_000 });
}

export interface PaidRoute {
  /** e.g. "POST /demo/email-verifier/verify": the full path, as the router sees it. */
  pattern: string;
  /** Absolute public URL of the resource. */
  resource: string;
  payTo: Address;
  /** Price in USDC atomic units (6 decimals). */
  amount: bigint;
  description: string;
  serviceName: string;
}

export function routeConfig(route: PaidRoute): RouteConfig {
  return {
    accepts: {
      scheme: "exact",
      network: TESTNET_CAIP2,
      payTo: route.payTo,
      price: { asset: TESTNET.usdc, amount: route.amount.toString(), extra: { ...TESTNET_USDC_EIP712 } },
      maxTimeoutSeconds: 120,
    },
    resource: route.resource,
    description: route.description,
    mimeType: "application/json",
    serviceName: route.serviceName,
    unpaidResponseBody: () => ({
      contentType: "application/json",
      body: {
        error: {
          code: "payment_required",
          message:
            "This endpoint is paid with x402. Read the PAYMENT-REQUIRED header (base64 JSON), sign an EIP-3009 " +
            "authorization for the amount in test USDC on Monad testnet, and retry with the PAYMENT-SIGNATURE header.",
        },
      },
    }),
  };
}

export function createPaywallServer(facilitator: FacilitatorClient, routes: PaidRoute[]): x402HTTPResourceServer {
  const server = new x402ResourceServer(facilitator).register(TESTNET_CAIP2, new ExactEvmScheme());
  return new x402HTTPResourceServer(server, Object.fromEntries(routes.map((r) => [r.pattern, routeConfig(r)])));
}

class ExpressAdapter implements HTTPAdapter {
  constructor(private readonly req: Request) {}
  getHeader(name: string) {
    return this.req.header(name) ?? undefined;
  }
  getMethod() {
    return this.req.method;
  }
  getPath() {
    return this.req.baseUrl + this.req.path;
  }
  getUrl() {
    return `${this.req.protocol}://${this.req.get("host") ?? "localhost"}${this.req.originalUrl}`;
  }
  getAcceptHeader() {
    return this.req.header("accept") ?? "";
  }
  getUserAgent() {
    return this.req.header("user-agent") ?? "";
  }
  getBody() {
    return this.req.body as unknown;
  }
}

export function requestContext(req: Request): HTTPRequestContext {
  const adapter = new ExpressAdapter(req);
  const path = adapter.getPath();
  return {
    adapter,
    path,
    decodedPath: path,
    method: req.method,
    paymentHeader: adapter.getHeader("payment-signature") ?? adapter.getHeader("x-payment"),
  };
}

export function sendInstructions(res: Response, response: HTTPResponseInstructions): void {
  res.status(response.status);
  for (const [key, value] of Object.entries(response.headers)) res.setHeader(key, value);
  // Browsers get JSON too: the demo agents are for agents, so there is no HTML paywall.
  res.json(response.body ?? {});
}

/** The address that signed an "exact" EIP-3009 payment, before it is settled. */
export function payerOf(payload: PaymentPayload): Address | null {
  const auth = (payload.payload as { authorization?: { from?: unknown } }).authorization;
  return typeof auth?.from === "string" && /^0x[0-9a-fA-F]{40}$/.test(auth.from) ? (auth.from as Address) : null;
}

export type { PaymentPayload, PaymentRequirements };
