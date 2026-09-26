import { describe, expect, it } from "vitest";
import { createTestIndexer } from "envio";

const OWNER = "0x00000000000000000000000000000000000000a1";
const BUYER = "0x00000000000000000000000000000000000000b2";
const CLIENT_1 = "0x00000000000000000000000000000000000000c1";
const CLIENT_2 = "0x00000000000000000000000000000000000000c2";
const WALLET = "0x00000000000000000000000000000000000000d4";
const ZERO = "0x0000000000000000000000000000000000000000";
const TS = 1_790_000_000;
const TX = "0x" + "ab".repeat(32);

const registration = (name: string) =>
  `data:application/json;base64,${Buffer.from(
    JSON.stringify({ name, services: [{ name: "A2A", endpoint: "https://a.example" }], x402Support: true }),
  ).toString("base64")}`;

const at = (number: number) => ({ block: { number, timestamp: TS + number }, transaction: { hash: TX } });

describe("IdentityRegistry handlers", () => {
  it("creates an agent from Registered with an inline registration file", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        143: {
          simulate: [
            { contract: "IdentityRegistry", event: "Transfer", params: { from: ZERO, to: OWNER, tokenId: 7n }, ...at(100) },
            { contract: "IdentityRegistry", event: "Registered", params: { agentId: 7n, agentURI: registration("Alpha"), owner: OWNER }, ...at(100) },
          ],
        },
      },
    });

    const agent = await indexer.Agent.getOrThrow("7");
    expect(agent).toMatchObject({
      agentId: 7n,
      owner: OWNER,
      uriKind: "data",
      metadataStatus: "ok",
      name: "Alpha",
      serviceCount: 1,
      x402Support: true,
      registeredBlock: 100n,
      registeredTx: TX,
      uriChangeCount: 0,
      feedbackCount: 0,
    });
    expect(agent.registeredAt).toEqual(new Date((TS + 100) * 1000));
  });

  it("tracks URI updates, wallet metadata and transfers", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        143: {
          simulate: [
            { contract: "IdentityRegistry", event: "Registered", params: { agentId: 1n, agentURI: "", owner: OWNER }, ...at(10) },
            { contract: "IdentityRegistry", event: "URIUpdated", params: { agentId: 1n, newURI: "https://a.example/reg.json", updatedBy: OWNER }, ...at(11) },
            { contract: "IdentityRegistry", event: "MetadataSet", params: { agentId: 1n, indexedMetadataKey: "0x", metadataKey: "agentWallet", metadataValue: WALLET }, ...at(12) },
            { contract: "IdentityRegistry", event: "Transfer", params: { from: OWNER, to: BUYER, tokenId: 1n }, ...at(13) },
          ],
        },
      },
    });

    const agent = await indexer.Agent.getOrThrow("1");
    expect(agent).toMatchObject({
      owner: BUYER,
      agentWallet: WALLET,
      agentUri: "https://a.example/reg.json",
      uriKind: "https",
      metadataStatus: "pending",
      uriChangeCount: 1,
      updatedBlock: 13n,
    });
    expect(await indexer.AgentUriChange.getAll()).toHaveLength(1);
    expect(await indexer.AgentMetadataEntry.getOrThrow("1_agentWallet")).toMatchObject({ key: "agentWallet", value: WALLET });
  });

  it("keeps mainnet and testnet agents with the same id apart", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        143: { simulate: [{ contract: "IdentityRegistry", event: "Registered", params: { agentId: 5n, agentURI: registration("Main"), owner: OWNER }, ...at(1) }] },
        10143: { simulate: [{ contract: "IdentityRegistry", event: "Registered", params: { agentId: 5n, agentURI: registration("Test"), owner: OWNER }, ...at(1) }] },
      },
    });

    const mainnet = await indexer.Agent.getWhere({ chainId: { _eq: 143 } });
    const testnet = await indexer.Agent.getWhere({ chainId: { _eq: 10143 } });
    expect(mainnet.map((a) => a.name)).toEqual(["Main"]);
    expect(testnet.map((a) => a.name)).toEqual(["Test"]);
  });
});

describe("ReputationRegistry handlers", () => {
  const feedback = (client: `0x${string}`, feedbackIndex: bigint, block: number) => ({
    contract: "ReputationRegistry" as const,
    event: "NewFeedback" as const,
    params: {
      agentId: 3n,
      clientAddress: client,
      feedbackIndex,
      value: 95n,
      valueDecimals: 0n,
      indexedTag1: "0x",
      tag1: "quality",
      tag2: "",
      endpoint: "https://a.example",
      feedbackURI: "",
      feedbackHash: "0x" + "00".repeat(32),
    },
    ...at(block),
  });

  it("counts feedback, unique reviewers, revocations and responses", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        143: {
          simulate: [
            { contract: "IdentityRegistry", event: "Registered", params: { agentId: 3n, agentURI: registration("Gamma"), owner: OWNER }, ...at(20) },
            feedback(CLIENT_1, 1n, 21),
            feedback(CLIENT_1, 2n, 22),
            feedback(CLIENT_2, 1n, 23),
            { contract: "ReputationRegistry", event: "FeedbackRevoked", params: { agentId: 3n, clientAddress: CLIENT_1, feedbackIndex: 2n }, ...at(24) },
            // Revoking twice must not double-count.
            { contract: "ReputationRegistry", event: "FeedbackRevoked", params: { agentId: 3n, clientAddress: CLIENT_1, feedbackIndex: 2n }, ...at(25) },
            {
              contract: "ReputationRegistry",
              event: "ResponseAppended",
              params: { agentId: 3n, clientAddress: CLIENT_2, feedbackIndex: 1n, responder: OWNER, responseURI: "ipfs://r", responseHash: "0x" + "11".repeat(32) },
              ...at(26),
            },
          ],
        },
      },
    });

    const agent = await indexer.Agent.getOrThrow("3");
    expect(agent).toMatchObject({ feedbackCount: 2, revokedFeedbackCount: 1, uniqueReviewerCount: 2 });
    expect(agent.lastFeedbackAt).toEqual(new Date((TS + 23) * 1000));

    expect(await indexer.Feedback.getOrThrow(`3_${CLIENT_1}_2`)).toMatchObject({ revoked: true });
    expect(await indexer.Feedback.getOrThrow(`3_${CLIENT_2}_1`)).toMatchObject({ responseCount: 1, value: 95n, valueDecimals: 0 });
    expect(await indexer.AgentReviewer.getOrThrow(`3_${CLIENT_1}`)).toMatchObject({ feedbackCount: 2 });
  });
});
