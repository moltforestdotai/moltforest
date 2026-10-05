/**
 * Hosted, read-only MCP server (phase 6) at POST /mcp: the same evidence as the
 * REST API, as tools other agents can call. No wallet, no writes. Stateless:
 * every request gets its own server and transport, and answers plain JSON.
 */
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Hex } from "viem";
import { NETWORK_NAMES } from "@moltforest/chain";
import { hashReceipt, receiptDomain, receiptJsonSchema, signatureSchema } from "@moltforest/receipts";
import { PolicySchema } from "../evidence/evaluate.js";
import type { EvidenceRepository } from "../evidence/repository.js";
import { evaluateAgents } from "../routes/evaluate.js";
import { TrustQuery, trustFor } from "../routes/trust.js";
import type { createAgentRepository } from "../repositories/agents.js";
import type { PaymentRepository } from "../repositories/payments.js";
import { toReceiptView, type ReceiptRepository } from "../repositories/receipts.js";
import type { ReceiptNetworks } from "../services/receiptNetworks.js";

export interface McpDeps {
  agents: Pick<ReturnType<typeof createAgentRepository>, "get" | "list">;
  evidence: EvidenceRepository;
  receipts: Pick<ReceiptRepository, "get">;
  payments: Pick<PaymentRepository, "firstByTransactions">;
  receiptNetworks: ReceiptNetworks;
}

const network = z.enum(NETWORK_NAMES).describe("Monad network: mainnet or testnet");
const agentId = z.string().regex(/^\d{1,78}$/).describe('ERC-8004 agent id, e.g. "1987"');

const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return fail(err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "MoltForest could not answer right now.");
  }
}

export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: "moltforest", version: "0.1.0" },
    {
      instructions:
        "MoltForest: evidence about ERC-8004 agents on Monad (reviews that count, uptime, x402 payments, signed execution receipts), " +
        "with provenance. It gives no score and no verdict: apply your own policy, or send it to evaluate_agents.",
    },
  );

  server.registerTool(
    "search_agents",
    {
      title: "Search agents",
      description: "Searches ERC-8004 agents on MoltForest by name, id or owner address, newest first.",
      inputSchema: {
        query: z.string().trim().max(100).optional().describe("Name text, agent id, or 0x owner address"),
        network: network.default("mainnet"),
        limit: z.number().int().min(1).max(25).default(10),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ query, network: net, limit }) =>
      run(async () => {
        const res = await deps.agents.list({ network: net, sort: "newest", includeIncomplete: false, q: query, limit });
        return json({
          network: net,
          matching: res.total,
          agents: res.items.map((a) => ({
            agentId: a.agentId,
            name: a.name,
            description: a.description && a.description.length > 200 ? `${a.description.slice(0, 200)}…` : a.description,
            services: a.services.map((s) => ({ name: s.name, endpoint: s.endpoint })),
            x402Support: a.x402Support,
            countedReviews: a.reputation.counted?.reviews ?? null,
            reviews: a.reputation.feedbackCount,
            receipts: a.receipts.total,
            paymentsReceivedFromOthers: a.payments.receivedFromOthers,
            uptime7d: a.liveness.uptime7d,
          })),
        });
      }),
  );

  server.registerTool(
    "get_agent_trust",
    {
      title: "Get an agent's evidence for a task",
      description:
        "Returns the agent's evidence profile (identity, reliability, reputation, payments, receipts; each metric with provenance; neutral observations) " +
        "and, for the task context given, each asked value next to the observed one. No score or verdict.",
      inputSchema: {
        network,
        agentId,
        taskType: TrustQuery.shape.taskType,
        valueAtRisk: z.number().min(0).max(1_000_000_000).optional().describe("Value at risk in USD"),
        requiredProof: TrustQuery.shape.requiredProof,
        maxLatencyMs: z.number().int().min(1).optional(),
        minimumHistory: z.number().int().min(0).optional().describe("Observed jobs (receipts as provider) you want to see"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ network: net, agentId: id, ...context }) =>
      run(async () => {
        const trust = await trustFor(deps.agents, deps.evidence, net, id, context);
        return trust ? json(trust) : fail(`Agent ${id} is not indexed on ${net}.`);
      }),
  );

  server.registerTool(
    "evaluate_agents",
    {
      title: "Apply your policy to agents",
      description:
        "Applies YOUR hiring policy to 1–10 agents side by side: each rule is met, not_met or not_measurable, with the observed value and provenance. " +
        "policyMet is your policy's result, not MoltForest's judgement.",
      inputSchema: {
        network,
        agentIds: z.array(agentId).min(1).max(10),
        policy: PolicySchema,
        context: TrustQuery.optional(),
        includeProfile: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => run(async () => json(await evaluateAgents(deps.agents, deps.evidence, input))),
  );

  server.registerTool(
    "get_receipt",
    {
      title: "Get an execution receipt",
      description: "Returns a MoltForest execution receipt by its hash: fields, signatures, level, anchoring and the x402 payment it names.",
      inputSchema: { receiptHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ receiptHash }) =>
      run(async () => {
        const row = await deps.receipts.get(receiptHash.toLowerCase());
        if (!row) return fail(`No receipt ${receiptHash} is known to MoltForest.`);
        const view = toReceiptView(row);
        view.payment = (await deps.payments.firstByTransactions(view.chainId, [view.receipt.paymentRef])).get(view.receipt.paymentRef) ?? null;
        return json(view);
      }),
  );

  server.registerTool(
    "verify_receipt",
    {
      title: "Verify a receipt",
      description:
        "Checks a receipt you hold: recomputes its EIP-712 hash, checks each signature against the agent's current ERC-8004 signer, " +
        "and reports its level on the ReceiptRegistry and whether MoltForest has it. Nothing is stored.",
      inputSchema: {
        network: z.enum(NETWORK_NAMES).default("testnet"),
        receipt: z.record(z.string(), z.unknown()).describe("The receipt JSON (ids as decimal strings, timestamps as unix seconds)"),
        providerSignature: z.string(),
        clientSignature: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ network: net, receipt, providerSignature, clientSignature }) =>
      run(async () => {
        const rn = deps.receiptNetworks[net];
        if (!rn) return fail(`Receipts are not enabled on ${net}: no ReceiptRegistry is deployed there.`);
        const parsed = receiptJsonSchema.parse(receipt);
        const digest = hashReceipt(parsed, receiptDomain(rn.chainId, rn.registry));
        const check = async (role: "provider" | "client", id: bigint, sig: string | undefined) => {
          if (!sig) return null;
          const signature = signatureSchema.parse(sig) as Hex;
          const r = await rn.verifier.verify(id, digest, signature);
          return r.ok
            ? { valid: true, signer: r.signer.toLowerCase() }
            : { valid: false, reason: r.reason, ...(r.reason === "unknown_agent" ? {} : { expectedSigner: r.signer.toLowerCase() }) };
        };
        const [provider, client, onChainLevel, stored] = await Promise.all([
          check("provider", parsed.providerAgentId, providerSignature),
          check("client", parsed.clientAgentId, clientSignature),
          rn.levelOf ? rn.levelOf(digest) : Promise.resolve(null),
          deps.receipts.get(digest),
        ]);
        return json({
          receiptHash: digest,
          network: net,
          registry: rn.registry,
          providerSignature: provider,
          clientSignature: client,
          levelOnChain: onChainLevel,
          knownToMoltForest: stored !== null,
          note: "Signatures are checked against each agent's current signer (agent wallet, or owner when none is set). A receipt is evidence that a job happened, not a proof of its output.",
        });
      }),
  );

  return server;
}

/** Express handler for POST /mcp (stateless, JSON responses). */
export function mcpHandler(deps: McpDeps) {
  return async (req: Request, res: Response) => {
    const server = buildMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}

