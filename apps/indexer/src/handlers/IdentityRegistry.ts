import { indexer, type Agent } from "envio";
import { decodeWalletMetadata, parseAgentUri, type ParsedAgentUri } from "../lib/agentUri.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";


function uriFields(uri: string, parsed: ParsedAgentUri) {
  return {
    agentUri: uri,
    uriKind: parsed.uriKind,
    metadataStatus: parsed.metadataStatus,
    metadataError: parsed.metadataError,
    name: parsed.name,
    description: parsed.description,
    image: parsed.image,
    services: parsed.services,
    serviceCount: parsed.services.length,
    x402Support: parsed.x402Support,
    active: parsed.active,
    supportedTrust: parsed.supportedTrust,
  };
}

indexer.onEvent({ contract: "IdentityRegistry", event: "Registered" }, async ({ event, context }) => {
  const id = event.params.agentId.toString();
  const at = new Date(event.block.timestamp * 1000);
  const block = BigInt(event.block.number);
  const existing = await context.Agent.get(id);

  const agent: Agent = {
    id,
    agentId: event.params.agentId,
    owner: event.params.owner,
    agentWallet: existing?.agentWallet,
    ...uriFields(event.params.agentURI, parseAgentUri(event.params.agentURI)),
    registeredBlock: block,
    registeredAt: at,
    registeredTx: event.transaction.hash,
    updatedBlock: block,
    updatedAt: at,
    uriChangeCount: 0,
    feedbackCount: existing?.feedbackCount ?? 0,
    revokedFeedbackCount: existing?.revokedFeedbackCount ?? 0,
    uniqueReviewerCount: existing?.uniqueReviewerCount ?? 0,
    lastFeedbackAt: existing?.lastFeedbackAt,
  };
  context.Agent.set(agent);
});

indexer.onEvent({ contract: "IdentityRegistry", event: "URIUpdated" }, async ({ event, context }) => {
  const id = event.params.agentId.toString();
  const at = new Date(event.block.timestamp * 1000);
  const parsed = parseAgentUri(event.params.newURI);

  context.AgentUriChange.set({
    id: `${event.block.number}_${event.logIndex}`,
    agent_id: id,
    uri: event.params.newURI,
    uriKind: parsed.uriKind,
    updatedBy: event.params.updatedBy,
    blockNumber: BigInt(event.block.number),
    timestamp: at,
    txHash: event.transaction.hash,
  });

  const agent = await context.Agent.get(id);
  if (!agent) {
    context.log.warn(`URIUpdated for unknown agent ${id} on chain ${event.chainId}`);
    return;
  }
  context.Agent.set({
    ...agent,
    ...uriFields(event.params.newURI, parsed),
    uriChangeCount: agent.uriChangeCount + 1,
    updatedBlock: BigInt(event.block.number),
    updatedAt: at,
  });
});

indexer.onEvent({ contract: "IdentityRegistry", event: "MetadataSet" }, async ({ event, context }) => {
  const id = event.params.agentId.toString();
  const key = event.params.metadataKey;
  const at = new Date(event.block.timestamp * 1000);

  context.AgentMetadataEntry.set({
    id: `${id}_${key}`,
    agent_id: id,
    key,
    value: event.params.metadataValue,
    blockNumber: BigInt(event.block.number),
    updatedAt: at,
  });

  if (key !== "agentWallet") return;
  const agent = await context.Agent.get(id);
  if (!agent) return;
  context.Agent.set({
    ...agent,
    agentWallet: decodeWalletMetadata(event.params.metadataValue),
    updatedBlock: BigInt(event.block.number),
    updatedAt: at,
  });
});

// Mints are handled by Registered (emitted in the same transaction).
indexer.onEvent({ contract: "IdentityRegistry", event: "Transfer" }, async ({ event, context }) => {
  if (event.params.from === ZERO_ADDRESS) return;
  const agent = await context.Agent.get(event.params.tokenId.toString());
  if (!agent) return;
  context.Agent.set({
    ...agent,
    owner: event.params.to,
    updatedBlock: BigInt(event.block.number),
    updatedAt: new Date(event.block.timestamp * 1000),
  });
});
