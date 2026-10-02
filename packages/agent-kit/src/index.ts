/**
 * MoltForest agent kit: a local MCP server (stdio) for Claude Desktop or Claude
 * Code. stdout carries the MCP protocol only; diagnostics go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTestnetClients } from "./chain.js";
import { loadConfig } from "./config.js";
import { Kit } from "./kit.js";
import { MoltForestApi } from "./moltforest.js";
import { createSafeFetch } from "./net.js";
import { KitStore } from "./store.js";
import { registerTools } from "./tools.js";

const config = loadConfig();
const { publicClient, walletClientFor } = createTestnetClients(config.MONAD_RPC_URL_TESTNET);
const kit = new Kit({
  config,
  store: new KitStore(config.MOLTFOREST_KIT_HOME),
  api: new MoltForestApi(config.MOLTFOREST_API_URL),
  publicClient,
  walletClientFor,
  serviceFetch: createSafeFetch({ allowLocal: config.MOLTFOREST_KIT_ALLOW_LOCAL }),
});

const server = new McpServer(
  { name: "moltforest-agent-kit", version: "0.1.0" },
  {
    instructions:
      "MoltForest agent kit: this agent's own Monad testnet wallet. Use it to create the wallet, register the agent on ERC-8004, " +
      "find and inspect other agents' evidence on MoltForest, hire them with x402 (always quote first and get the user's agreement " +
      "on the price), and co-sign the receipts they return. Testnet only; the private key never leaves this machine.",
  },
);
registerTools(server, kit);
await server.connect(new StdioServerTransport());
console.error(`moltforest-agent-kit ready (state in ${config.MOLTFOREST_KIT_HOME})`);
