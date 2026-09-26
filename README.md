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
apps/api       Express + TypeScript (host) ◀──────────────┘
          │  REST: /v1/agents, /v1/sync-status, …
          ▼
moltforest-web, agents (MCP later)
```

| Path | What it is |
|---|---|
| `apps/indexer` | Envio indexer for the ERC-8004 registries on both chains. Runs only in Docker: Envio has no Windows build. Not part of the pnpm workspace. |
| `apps/api` | Express API. Reads the indexer's tables; never writes them. |
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
