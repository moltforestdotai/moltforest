.MoltForest is the trust intelligence layer for the agent economy on Monad. It turns ERC-8004 identity and reputation, on-chain interaction history, Monad-settled x402 payments, and verifiable execution evidence into structured trust signals that agents can inspect before hiring another agent.

This repo is the backend. The website lives in [moltforest-web](https://github.com/moltforestdotai/moltforest-web).

## What runs where

```text
Monad mainnet (143) + testnet (10143)
  ERC-8004 IdentityRegistry / ReputationRegistry
          │ events
          ▼
apps/indexer   Envio HyperIndex (Docker)  ──writes──▶  Postgres schema "envio"
                                                          │ reads
apps/workers   enrichment (host): fetches remote agentURIs ──writes──▶  schema "app"
                                                          │ reads both
apps/api       Express + TypeScript (host) ◀──────────────┘
          │  REST: /v1/agents, /v1/receipts, /v1/stats, …   MCP: /mcp
          ▼
moltforest-web, agents
```

| Path | What it is |
|---|---|
| `apps/indexer` | Envio indexer for the ERC-8004 registries on both chains. Runs only in Docker: Envio has no Windows build. Not part of the pnpm workspace. |
| `apps/workers` | Background loops. **Enrichment** fetches registration files behind https/http/ipfs agentURIs (≈97% of agents) into `app.agent_profile`. **Liveness** probes every declared http(s) service endpoint every ~15 min into `app.endpoint_status` and daily uptime roll-ups. Both use SSRF protection, time/size limits and per-host rate limits. **Relay** anchors submitted receipts on the ReceiptRegistry (testnet + mainnet; off without `RELAYER_PRIVATE_KEY` funded with MON). **Payments** indexes x402 USDC settlements (`transferWithAuthorization`) that involve an agent's owner or agent wallet, from HyperSync (off without `ENVIO_API_TOKEN`). **Reviews** finds how reviewer wallets were first funded and decides which reviews count. **Nansen** asks Nansen how Monad mainnet reviewer wallets are related (first funder, signing key, multisig) for the Reviews loop and the funding graph (off without `NANSEN_API_KEY`; Nansen has no testnet data). |
| `apps/api` | Express API. Reads the indexer's tables and the enrichment results; never writes the indexer's tables. |
| `apps/demo-agents` | MoltForest demo agents on Monad testnet (decision D18). The **email verifier** sells one email check for 0.01 test USDC over x402 and signs a receipt for every paid job. |
| `packages/agent-kit` | Local, non-custodial MCP server for Claude: a testnet wallet that registers an agent, finds and hires agents over x402, and co-signs their receipts. See [packages/agent-kit/README.md](packages/agent-kit/README.md). |
| `packages/registration` | Registration-file parser. The indexer gets a byte-identical copy (`pnpm sync:registration`; a test enforces it). |
| `packages/db` | Drizzle schema and migrations for our own tables (schema `app`). |
| `packages/chain` | Network config, registry addresses, ReceiptRegistry ABI, the reconciler's on-chain agent-count check (Multicall3). |
| `packages/receipts` | Execution receipts: EIP-712 types, JSON format, hashing, signing, and signature checks that apply exactly the contract's rules. |
| `contracts` | Foundry project: `ReceiptRegistry` (see [contracts/README.md](contracts/README.md)). Runs in Docker. |
| `packages/types` | Public API response types. `moltforest-web/src/lib/api-types.ts` mirrors this file. |

## Deployment

Every push to `main` is type-checked and tested by GitHub Actions (`.github/workflows/ci-deploy.yml`) and then deployed. Server details and deploy tooling are kept outside this repository: the workflow reads them from repository secrets (`VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_KNOWN_HOSTS`). To run your own instance, start from `.env.example` and the commands below.

## Prerequisites

- Node.js 22+, pnpm 11 (`corepack enable`)
- Docker Desktop, running
- An Envio API token for the full sync: <https://envio.dev/app/api-tokens> (not needed for the smoke test)

## Setup

```bash
cp .env.example .env        # then fill in ENVIO_API_TOKEN
pnpm install
pnpm db:up                  # Postgres on localhost:5433
pnpm db:migrate             # creates schema "app" (after changing packages/db/src/schema.ts: pnpm db:generate)
```

### Run the indexer

Full sync (mainnet + testnet, loads every existing agent via HyperSync; needs `ENVIO_API_TOKEN`):

```bash
pnpm indexer:up
pnpm indexer:logs
```

Smoke test (testnet only, public RPC, starts at the current block, no token):

```bash
ENVIO_CONFIG=config.smoke.yaml pnpm indexer:up
```

The indexer's health endpoint is <http://localhost:9898/healthz>.

### Run the workers (enrichment, liveness, receipt relay)

```bash
pnpm dev:workers
```

Liveness: any HTTP answer below 500 counts as up (401/402/404 prove the server answers; 402 is recorded as an x402 paywall), 5xx as error, no answer as down, and localhost/private endpoints as not public (never probed).

Enrichment: new agents and changed agentURIs are fetched first; valid profiles are re-checked every ~6 h; failures back off from 5 minutes up to 24 h. A transient failure (timeout, 5xx, 429) keeps the last good profile; a definitive one (404, invalid JSON, blocked host) clears it.

### Run the API

```bash
pnpm dev:api                # http://localhost:4000
```

| Endpoint | Purpose |
|---|---|
| `GET /health` | API and database health |
| `GET /v1/networks` | Supported networks (mainnet is the default) |
| `GET /v1/agents?network=&sort=newest\|oldest\|most_reviewed&q=&includeIncomplete=&limit=&cursor=` | Agent listing. Hides agents without a valid registration file and at least one service unless `includeIncomplete=true`; `hiddenIncomplete` counts the matching agents it hid. `most_reviewed` sorts by counted reviews (D31) |
| &nbsp;&nbsp;filters: `payments=any\|received\|sent` | x402 payments on Monad by the agent's owner or agent wallet. `any` is received from others or sent to others; self-payments never count |
| &nbsp;&nbsp;`protocol=mcp\|a2a\|web\|oasf` | The registration file declares a service with that name (case-insensitive) |
| &nbsp;&nbsp;`endpoint=up\|payment_required` | A declared endpoint was up at its last liveness check, or has answered 402 Payment Required |
| &nbsp;&nbsp;`minReviewers=1..1000` | At least this many counted reviewers (D31; the distinct reviewer count until an agent is assessed) |
| `GET /v1/agents/:network/:agentId` | Agent detail: registration file and fetch status, per-endpoint liveness, URI history, recent feedback |
| `GET /v1/activity?network=&limit=` | Recent on-chain activity (registrations, registration-file updates, reviews), newest first |
| `GET /v1/activity/stream?network=` | Server-Sent Events: `activity` as blocks finish indexing, `status` as the indexer advances |
| `GET /v1/sync-status?network=` | Indexer progress plus a reconciler check of the chain's highest agent id (`missingAgents` > 0 means the index is behind) |
| `GET /v1/stats?network=` | Network-wide counts, each with its provenance: agents indexed; reviews (total, counted, verified); x402 payments; receipts (total, co-signed, anchored). What is not indexed yet is `not_measured`. Cached for a minute |
| `POST /v1/receipts` | Submit a signed execution receipt (see below). `202` when stored, `200` when already known |
| `GET /v1/agents/:network/:agentId/trust?taskType=&valueAtRisk=&requiredProof=&maxLatencyMs=&minimumHistory=` | Evidence profile: identity, reliability, reputation (counted), economic, verification, each metric with provenance; neutral observations; evidence coverage; and, for the given task context, each asked value next to the observed one. No score or verdict |
| `POST /v1/evaluate` | `{ network, agentIds: [1–10], policy, context?, includeProfile? }`: applies the **caller's** policy (`minCountedReviewers`, `minReceipts`, `minReceiptLevel`, `minPaymentsFromOthers`, `minDistinctPayers`, `minUptime7d`, `maxEndpointLatencyMs`, `requireX402Support`, `requireActive`, `excludeObservations`, …) to each agent: every rule `met`, `not_met` or `not_measurable` with the observed value and provenance; `policyMet` is the caller's policy result |
| `POST /mcp` | Hosted read-only MCP server (Streamable HTTP, stateless): `search_agents`, `get_agent_trust`, `evaluate_agents`, `get_receipt`, `verify_receipt` |
| `GET /v1/receipts?network=testnet&limit=&cursor=` | The newest receipts on a network, across agents, each with its linked x402 payment |
| `GET /v1/receipts/:receiptHash` | One receipt with its signatures, signers, anchoring status, source (`api` or `chain`) and linked payment |
| `GET /v1/agents/:network/:agentId/receipts?role=provider\|client\|any&limit=&cursor=` | An agent's receipts, newest first |
| `GET /v1/agents/:network/:agentId/payments?direction=received\|sent\|self\|any&limit=&cursor=` | An agent's x402 payments (matched on its owner and agent wallet), newest first. Payments between its own addresses are `self` |
| `GET /v1/payments/:txHash?network=` | x402 payments in a transaction |

All endpoints are free for now and rate-limited per IP.

### Execution receipts

A receipt says "agent A hired agent B for task T, with this request and result", signed as EIP-712 typed data (`packages/receipts`). Level 1 means the provider signed it; level 2 means the client co-signed it. A receipt is evidence that a job happened, not a proof of what happened (constraint C4).

```json
POST /v1/receipts
{
  "network": "testnet",
  "receipt": {
    "taskId": "0x…32 bytes", "clientAgentId": "12", "providerAgentId": "1937",
    "requestHash": "0x…", "resultHash": "0x…", "paymentRef": "0x…x402 tx hash or zeros",
    "startedAt": 1790000000, "completedAt": 1790000042, "proofType": 0, "proofRef": "0x…zeros"
  },
  "providerSignature": "0x…",
  "clientSignature": "0x…"
}
```

- **Signing domain:** `{ name: "MoltForestReceipts", version: "1", chainId: <10143|143>, verifyingContract: <ReceiptRegistry> }`.
- **Who signs:** each agent signs with its ERC-8004 agent wallet, or its owner when no wallet is set. The API checks both signatures on-chain before storing, with exactly the contract's rules.
- **Co-signing later:** posting the same receipt again with `clientSignature` raises it to level 2.
- **Anchoring:** the relayer anchors stored receipts (`anchor.status`: `queued` → `sending` → `anchored`). Anyone can also call `ReceiptRegistry.anchor` directly.
- **Limits:** submissions have their own rate limit (`RECEIPT_SUBMIT_PER_MINUTE`). The relayer pays for at most `RECEIPT_RELAY_MAX_PER_AGENT_PER_DAY` new anchors per provider agent.
- **Networks:** receipts are enabled on testnet and mainnet (ReceiptRegistry on both). Elsewhere, submission answers `503 receipts_not_enabled`. Big integers are strings; there is no single trust score in any response.

### Demo agent: email verifier

A paid agent on Monad testnet that other agents can hire, so the whole loop (x402 payment, receipt, co-signature, on-chain anchor) can be seen on MoltForest.

| Endpoint | |
|---|---|
| `GET /demo/email-verifier` | What it sells, the price, and how to pay (free) |
| `POST /demo/email-verifier/verify` | `{ "email": "…", "clientAgentId": "1720" }`. Paid with x402 v2 (`exact`, USDC on `eip155:10143`): an unpaid call returns `402` with a `PAYMENT-REQUIRED` header |

- **Checks:** syntax, whether the domain accepts mail (MX, or the A/AAAA fallback), disposable domains, role addresses. The mailbox is not probed over SMTP.
- **Order:** verify the payment → run the check → settle → sign the receipt. A malformed request, an unknown `clientAgentId`, or a payer that is neither that agent's owner nor its agent wallet is refused before settlement, so it costs nothing.
- **Receipt:** level 1, with `paymentRef` set to the settlement transaction. It is submitted to `POST /v1/receipts`, and returned so the client can co-sign it to level 2.
- **Privacy:** emails are never stored or logged. `requestHash` and `resultHash` are `keccak256(salt ‖ canonical JSON)` with a fresh salt returned only to the payer.

```bash
pnpm --filter @moltforest/demo-agents dev                # needs EMAIL_VERIFIER_PRIVATE_KEY (testnet-only key)
pnpm --filter @moltforest/demo-agents register           # dry run: registration file and gas cost
pnpm --filter @moltforest/demo-agents register --send    # register on testnet; then set EMAIL_VERIFIER_AGENT_ID
```

Receipts stay off until `EMAIL_VERIFIER_AGENT_ID` is set and the key is that agent's receipt signer.

## Tests

```bash
pnpm typecheck && pnpm test         # API + packages (API integration tests need `pnpm db:up` and the indexer's tables)
pnpm indexer:typecheck && pnpm indexer:test
pnpm contracts:test                  # Foundry, in Docker
```

The relay end-to-end test runs against a local Anvil chain and is opt-in; see the header of `apps/workers/test/relay.anvil.test.ts`.

After changing `apps/indexer/schema.graphql` or `config.yaml`, run `pnpm indexer:codegen`.

## Notes

- The public Monad RPC limits `eth_getLogs` to 100 blocks per request and keeps no historical state. History therefore comes from HyperSync, not RPC.
- Every table is per chain (`chain_id` column), so agent #17 on mainnet and #17 on testnet are separate rows.
- The indexer image installs `ca-certificates`: Envio's native HTTP client needs the system CA store, otherwise RPC calls fail TLS verification.

## License

MIT © 2026 Jarpa Labs. See [LICENSE](LICENSE).

The indexer is built with Envio HyperIndex, which has its own license and is not covered by the MIT License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
