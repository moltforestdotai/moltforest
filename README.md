MoltForest is the trust intelligence layer for the agent economy on Monad. It turns ERC-8004 identity and reputation, on-chain interaction history, Monad-settled x402 payments, and verifiable execution evidence into structured trust signals that agents can inspect before hiring another agent.

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
          │  REST: /v1/agents, /v1/sync-status, …
          ▼
moltforest-web, agents (MCP later)
```

| Path | What it is |
|---|---|
| `apps/indexer` | Envio indexer for the ERC-8004 registries on both chains. Runs only in Docker: Envio has no Windows build. Not part of the pnpm workspace. |
| `apps/workers` | Enrichment worker: fetches registration files behind https/http/ipfs agentURIs (≈97% of agents) with SSRF protection, size/time limits and per-host rate limits. Writes `app.agent_profile`. |
| `apps/api` | Express API. Reads the indexer's tables and the enrichment results; never writes the indexer's tables. |
| `packages/registration` | Registration-file parser. The indexer gets a byte-identical copy (`pnpm sync:registration`; a test enforces it). |
| `packages/db` | Drizzle schema and migrations for our own tables (schema `app`). |
| `packages/chain` | Network config, registry addresses, the reconciler's on-chain agent-count check (Multicall3). |
| `packages/types` | Public API response types. `moltforest-web/src/lib/api-types.ts` mirrors this file. |

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

### Run the enrichment worker

```bash
pnpm dev:workers
```

New agents and changed agentURIs are fetched first; valid profiles are re-checked every ~6 h; failures back off from 5 minutes up to 24 h. A transient failure (timeout, 5xx, 429) keeps the last good profile; a definitive one (404, invalid JSON, blocked host) clears it.

### Run the API

```bash
pnpm dev:api                # http://localhost:4000
```

| Endpoint | Purpose |
|---|---|
| `GET /health` | API and database health |
| `GET /v1/networks` | Supported networks (mainnet is the default) |
| `GET /v1/agents?network=&sort=newest\|oldest\|most_reviewed&q=&includeIncomplete=&limit=&cursor=` | Agent listing. Hides agents without a valid registration file and at least one service unless `includeIncomplete=true` |
| `GET /v1/agents/:network/:agentId` | Agent detail with URI history and recent feedback |
| `GET /v1/sync-status?network=` | Indexer progress plus a reconciler check of the chain's highest agent id (`missingAgents` > 0 means the index is behind) |

All endpoints are free for now and rate-limited per IP. Big integers are strings; there is no single trust score in any response.

## Tests

```bash
pnpm typecheck && pnpm test         # API + packages (API integration tests need `pnpm db:up` and the indexer's tables)
pnpm indexer:typecheck && pnpm indexer:test
```

After changing `apps/indexer/schema.graphql` or `config.yaml`, run `pnpm indexer:codegen`.

## Notes

- The public Monad RPC limits `eth_getLogs` to 100 blocks per request and keeps no historical state. History therefore comes from HyperSync, not RPC.
- Every table is per chain (`chain_id` column), so agent #17 on mainnet and #17 on testnet are separate rows.
- The indexer image installs `ca-certificates`: Envio's native HTTP client needs the system CA store, otherwise RPC calls fail TLS verification.
