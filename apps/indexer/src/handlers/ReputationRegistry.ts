import { indexer } from "envio";



export const feedbackId = (agentId: bigint, client: string, index: bigint) =>
  `${agentId}_${client.toLowerCase()}_${index}`;

indexer.onEvent({ contract: "ReputationRegistry", event: "NewFeedback" }, async ({ event, context }) => {
  const p = event.params;
  const agentId = p.agentId.toString();
  const client = p.clientAddress;
  const at = new Date(event.block.timestamp * 1000);

  context.Feedback.set({
    id: feedbackId(p.agentId, client, p.feedbackIndex),
    agent_id: agentId,
    client,
    feedbackIndex: p.feedbackIndex,
    value: p.value,
    valueDecimals: Number(p.valueDecimals),
    tag1: p.tag1,
    tag2: p.tag2,
    endpoint: p.endpoint,
    feedbackUri: p.feedbackURI,
    feedbackHash: p.feedbackHash,
    revoked: false,
    responseCount: 0,
    blockNumber: BigInt(event.block.number),
    timestamp: at,
    txHash: event.transaction.hash,
  });

  const reviewerId = `${agentId}_${client}`;
  const reviewer = await context.AgentReviewer.get(reviewerId);
  context.AgentReviewer.set(
    reviewer
      ? { ...reviewer, feedbackCount: reviewer.feedbackCount + 1, lastFeedbackAt: at }
      : { id: reviewerId, agent_id: agentId, client, feedbackCount: 1, firstFeedbackAt: at, lastFeedbackAt: at },
  );

  const agent = await context.Agent.get(agentId);
  if (!agent) {
    context.log.warn(`NewFeedback for unknown agent ${agentId} on chain ${event.chainId}`);
    return;
  }
  context.Agent.set({
    ...agent,
    feedbackCount: agent.feedbackCount + 1,
    uniqueReviewerCount: agent.uniqueReviewerCount + (reviewer ? 0 : 1),
    lastFeedbackAt: at,
  });
});

indexer.onEvent({ contract: "ReputationRegistry", event: "FeedbackRevoked" }, async ({ event, context }) => {
  const p = event.params;
  const feedback = await context.Feedback.get(feedbackId(p.agentId, p.clientAddress, p.feedbackIndex));
  if (!feedback || feedback.revoked) return;
  context.Feedback.set({ ...feedback, revoked: true });

  const agent = await context.Agent.get(p.agentId.toString());
  if (!agent) return;
  context.Agent.set({
    ...agent,
    feedbackCount: Math.max(0, agent.feedbackCount - 1),
    revokedFeedbackCount: agent.revokedFeedbackCount + 1,
  });
});

indexer.onEvent({ contract: "ReputationRegistry", event: "ResponseAppended" }, async ({ event, context }) => {
  const p = event.params;
  const fbId = feedbackId(p.agentId, p.clientAddress, p.feedbackIndex);

  context.FeedbackResponse.set({
    id: `${event.block.number}_${event.logIndex}`,
    feedback_id: fbId,
    agent_id: p.agentId.toString(),
    responder: p.responder,
    responseUri: p.responseURI,
    responseHash: p.responseHash,
    blockNumber: BigInt(event.block.number),
    timestamp: new Date(event.block.timestamp * 1000),
    txHash: event.transaction.hash,
  });

  const feedback = await context.Feedback.get(fbId);
  if (feedback) context.Feedback.set({ ...feedback, responseCount: feedback.responseCount + 1 });
});
