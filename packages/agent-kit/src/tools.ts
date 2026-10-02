/** MCP tool definitions over the Kit. Results are JSON text; KitErrors become tool errors. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Kit } from "./kit.js";
import { KitError } from "./net.js";

const agentId = z.string().regex(/^(0|[1-9][0-9]{0,77})$/, "a decimal agent id").describe("ERC-8004 agent id, e.g. \"1720\"");
const network = z.enum(["testnet", "mainnet"]).default("testnet").describe("Monad network to search (hiring works on testnet only)");

const json = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2) }],
});

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await fn());
  } catch (err) {
    const message = err instanceof KitError ? err.message : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

export function registerTools(server: McpServer, kit: Kit): void {
  server.registerTool(
    "wallet_create",
    {
      title: "Create agent wallet",
      description:
        "Creates this agent's Monad testnet wallet. The private key is generated and stored on this machine only and is never shown. " +
        "Does nothing if a wallet already exists. Returns the address and how to get test MON and test USDC.",
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => run(() => kit.createWallet()),
  );

  server.registerTool(
    "wallet_status",
    {
      title: "Wallet status",
      description: "Shows the wallet address, its test MON and USDC balances, this agent's id and MoltForest profile, and the spend caps.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => run(() => kit.status()),
  );

  server.registerTool(
    "register_agent",
    {
      title: "Register this agent",
      description:
        "Registers this wallet as an ERC-8004 agent on Monad testnet (two transactions, paid in test MON). " +
        "Call first with confirm=false to preview the registration file and gas cost and show it to the user; " +
        "call again with confirm=true only after the user agrees.",
      inputSchema: {
        name: z.string().trim().min(1).max(100).describe("Agent name"),
        description: z.string().trim().min(1).max(1000).describe("What the agent does"),
        endpoint: z.string().max(2048).optional().describe("Optional https:// URL where the agent can be reached"),
        image: z.string().max(2048).optional().describe("Optional https:// image URL"),
        confirm: z.boolean().default(false).describe("false = preview only; true = send the transactions"),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => run(() => kit.registerAgent(args)),
  );

  server.registerTool(
    "find_agents",
    {
      title: "Find agents on MoltForest",
      description:
        "Searches MoltForest for ERC-8004 agents by name or description and returns their evidence (reviews, uptime, receipts, payments). " +
        "MoltForest gives evidence, never a single score or verdict.",
      inputSchema: {
        query: z.string().trim().max(100).optional().describe("Search text, e.g. \"email verifier\""),
        network,
        payments: z.enum(["any", "received", "sent"]).optional().describe("Only agents with x402 payments"),
        includeIncomplete: z.boolean().default(false).describe("Include agents without a usable profile"),
        limit: z.number().int().min(1).max(25).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => run(() => kit.findAgents(args)),
  );

  server.registerTool(
    "inspect_agent",
    {
      title: "Inspect an agent",
      description: "Shows one agent's evidence from MoltForest: services, endpoint uptime, recent receipts and x402 payments.",
      inputSchema: { agentId, network },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => run(() => kit.inspectAgent(args)),
  );

  server.registerTool(
    "read_service",
    {
      title: "Read a service's info page",
      description:
        "GETs a service URL (https only) without paying, e.g. an agent's info page listing what it sells, its price and request format. " +
        "If the URL is paywalled, returns its x402 price instead.",
      inputSchema: { url: z.string().max(2048).describe("https:// URL") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => run(() => kit.readService(args)),
  );

  server.registerTool(
    "hire_agent",
    {
      title: "Hire an agent (x402)",
      description:
        "Calls a paid agent service and pays it with test USDC over x402 on Monad testnet. " +
        "ALWAYS call first with confirm=false: that returns the price and pays nothing. Show the price to the user, and only if they agree " +
        "call again with the same url/method/body, confirm=true and maxPriceUsdc set to the agreed price. " +
        "Payments are capped per payment and per 24 hours. If the service asks for the hiring agent's id (for example a clientAgentId field), " +
        "put this wallet's agent id (see wallet_status) in the body so the provider issues a receipt.",
      inputSchema: {
        url: z.string().max(2048).describe("https:// service URL"),
        method: z.enum(["POST", "GET"]).default("POST"),
        body: z.record(z.string(), z.unknown()).optional().describe("JSON body for POST"),
        confirm: z.boolean().default(false).describe("false = quote only; true = pay and call"),
        maxPriceUsdc: z.string().max(20).optional().describe("Required with confirm=true: the price the user agreed to, e.g. \"0.01\""),
      },
      annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => run(() => kit.hire(args)),
  );

  server.registerTool(
    "cosign_receipt",
    {
      title: "Check and co-sign a receipt",
      description:
        "Checks a provider's receipt for a job this wallet paid for (client id, payment on-chain, provider signature, request/result hashes) " +
        "and, if every check passes, co-signs it (level 2) and submits it to MoltForest, which anchors it on-chain.",
      inputSchema: {
        receiptHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe("receiptHash from hire_agent or my_activity"),
        acceptUnverified: z
          .boolean()
          .default(false)
          .describe("Co-sign even if the request/result hashes cannot be recomputed (only with the user's consent)"),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => run(() => kit.cosign(args)),
  );

  server.registerTool(
    "my_activity",
    {
      title: "My payments and receipts",
      description: "Lists this agent's payments and receipts: the local ledger, and what MoltForest has recorded for its agent id.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => run(() => kit.activity()),
  );
}
