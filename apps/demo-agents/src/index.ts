import { pino } from "pino";
import { createPublicClient, http, isAddressEqual, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { checkEmail, createResolver } from "./emailVerifier/checks.js";
import { EMAIL_VERIFIER_NAME, EMAIL_VERIFIER_PATH } from "./emailVerifier/router.js";
import { createFacilitator, createPaywallServer } from "./paywall.js";
import { createAgentDirectory, createReceiptSubmitter, ReceiptIssuer } from "./receipts.js";

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });
const account = privateKeyToAccount(config.EMAIL_VERIFIER_PRIVATE_KEY);
const client = createPublicClient({ chain: monadTestnet, transport: http(config.MONAD_RPC_URL_TESTNET) }) as PublicClient;
const directory = createAgentDirectory(client);

const paywall = createPaywallServer(createFacilitator(config.X402_FACILITATOR_URL), [
  {
    pattern: `POST ${EMAIL_VERIFIER_PATH}/verify`,
    resource: `${config.DEMO_AGENTS_PUBLIC_URL}${EMAIL_VERIFIER_PATH}/verify`,
    payTo: account.address,
    amount: config.EMAIL_VERIFIER_PRICE_USDC,
    description: "Checks one email address: syntax, mail domain, disposable domain, role address.",
    serviceName: EMAIL_VERIFIER_NAME,
  },
]);

// The paywall needs the facilitator's supported kinds before it can price a route.
let paymentsReady = false;
async function syncFacilitator(attempt = 1): Promise<void> {
  try {
    await paywall.initialize();
    paymentsReady = true;
    logger.info({ facilitator: config.X402_FACILITATOR_URL }, "x402 paywall ready");
  } catch (err) {
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5));
    logger.warn({ err, retryInMs: delay }, "x402 facilitator sync failed");
    setTimeout(() => void syncFacilitator(attempt + 1), delay).unref();
  }
}
void syncFacilitator();

// Receipts need a registered agent whose receipt signer is this key; otherwise MoltForest would reject them.
let issuer: ReceiptIssuer | null = null;
async function enableReceipts(attempt = 1): Promise<void> {
  const agentId = config.EMAIL_VERIFIER_AGENT_ID;
  if (agentId === undefined) {
    logger.warn("EMAIL_VERIFIER_AGENT_ID is not set: receipts are off until the agent is registered (pnpm register)");
    return;
  }
  try {
    const signer = await directory.receiptSignerOf(agentId);
    if (!isAddressEqual(signer, account.address)) {
      logger.error({ agentId: agentId.toString(), signer, key: account.address }, "this key does not sign for the agent: receipts are off");
      return;
    }
    issuer = new ReceiptIssuer(agentId, account, createReceiptSubmitter(config.MOLTFOREST_API_URL));
    logger.info({ agentId: agentId.toString(), signer }, "receipts on");
  } catch (err) {
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5));
    logger.warn({ err, retryInMs: delay }, "could not read the agent's receipt signer");
    setTimeout(() => void enableReceipts(attempt + 1), delay).unref();
  }
}
void enableReceipts();

const resolver = createResolver(config.EMAIL_VERIFIER_DNS_TIMEOUT_MS);
const app = createApp({
  logger,
  rateLimitPerMinute: config.DEMO_AGENTS_RATE_LIMIT_PER_MINUTE,
  emailVerifier: {
    paywall,
    paymentsReady: () => paymentsReady,
    check: (email) => checkEmail(email, resolver),
    receipts: () => issuer,
    directory,
    payTo: account.address,
    priceAtomic: config.EMAIL_VERIFIER_PRICE_USDC,
    publicUrl: config.DEMO_AGENTS_PUBLIC_URL,
    apiUrl: config.MOLTFOREST_API_URL,
    webUrl: config.MOLTFOREST_WEB_URL,
    facilitatorUrl: config.X402_FACILITATOR_URL,
  },
});

const server = app.listen(config.DEMO_AGENTS_PORT, config.DEMO_AGENTS_HOST, () => {
  logger.info({ payTo: account.address }, `MoltForest demo agents listening on http://${config.DEMO_AGENTS_HOST}:${config.DEMO_AGENTS_PORT}`);
});

function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
