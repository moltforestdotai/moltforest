# CRE — Floor-3 epoch publisher

Chainlink Runtime Environment publishes cosigned score epochs through
`CreScorePublisher` → `ScoreRegistry.publishEpoch`. CRE is the **neutral clock +
courier**; verifiers still sign off-chain.

**Production runbook:** [PRODUCTION.md](./PRODUCTION.md) (auth, idempotency, Forwarder cutover, mainnet).

## Prerequisites

1. [CRE CLI](https://docs.chain.link/cre/getting-started/cli-installation) (`cre` ≥ 1.30 for Monad simulation)  
   Binary lives at `~/.cre/bin/cre` — add to `PATH`, or use the install script.
2. **Auth:** `cre login` (browser) or `CRE_API_KEY` from [app.chain.link](https://app.chain.link) Account Settings — required even for local simulate
3. Bun ≥ 1.2.21 (`curl -fsSL https://bun.sh/install | bash`)
4. Funded key in `cre/.env` as `CRE_ETH_PRIVATE_KEY=0x…` (testnet for staging `--broadcast`; mainnet MON for mainnet)
5. API + Postgres (`pnpm db:migrate`, `pnpm dev:api`)
6. Optional: `SCORES_PENDING_API_KEY` in API `.env` + matching `pendingEpochApiKey` in workflow config

## Deployed (testnet simulation)

| Contract | Address |
|---|---|
| `CreScorePublisher` | `0xEDAffF4855de733de33aF792b7DD4ddf1670A3c5` |
| MockKeystoneForwarder | `0xB9F79d863261869B234c481D1f9A7af84AeAd192` |
| `ScoreRegistry` | `0x7d86EdFEdbE012F7fcE72A95F51fEbEa2f215785` |

Deploy tx: `0x29472c41e3884805ba77a05ff469c068e1e65d6e69755fb7e82963c8999a7c38` (block `69722712`).

Configs already point at this publisher. For a **production** CRE deploy on testnet later, call
`setForwarderAddress(0xF8344CFd5c43616a4366C34E3EEE75af79a74482)` (or redeploy).

Mainnet: `DeployFloor3Mainnet.s.sol` (prod Forwarder `0x76c9cf…15E62`), then fill `config.mainnet.json`.

```bash
cd contracts
SCORE_REGISTRY=0x7d86EdFEdbE012F7fcE72A95F51fEbEa2f215785 \
  forge script script/DeployCreScorePublisher.s.sol:DeployCreScorePublisher \
  --rpc-url https://testnet-rpc.monad.xyz --broadcast -vvvv
```

## Prepare an epoch (verifiers)

```bash
# Demo leaves
EPOCH_ID=2 pnpm scores:prepare-epoch -- --demo \
  --out cre/epoch-publisher/pending-epoch.json

# Every ERC-8004 agent on testnet (zeros if no reviews) — preferred for hackathon POC:
pnpm scores:prepare-epoch -- --from-db --all-agents

# Mainnet after deploy:
# pnpm scores:prepare-epoch -- --demo --network mainnet
```

Serves at `GET /v1/scores/pending-epoch?network=testnet` (or `mainnet`).

**VPS:** set `EPOCH_PIPELINE_ENABLED=true` on workers (see `.env.example`) so prepare +
`cre workflow simulate --broadcast` run unattended. Keep MockKeystoneForwarder until DON deploy.

## Simulate

```bash
export PATH="$HOME/.cre/bin:$PATH"
cd cre/epoch-publisher && bun install
cd ..
cre workflow simulate epoch-publisher --target local-simulation
# real Monad tx:
cre workflow simulate epoch-publisher --target local-simulation --broadcast
```

Dry-run does not need gas; `--broadcast` does.

## Report ABI

Must match `CreScorePublisher._processReport`:

```text
(uint64 epochId, bytes32 inputsRoot, bytes32 scoresRoot, bytes32 algoHash, bytes sig0, bytes sig1)
```
