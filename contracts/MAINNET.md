# Monad mainnet Floor-3 (hackathon plug-in)

Chainlink accepts **CRE workflow simulation** for the hackathon. Contracts, verifiers, and
`cre workflow simulate --broadcast` still run on **Monad mainnet with real MON**.

## What goes on mainnet

| Piece | Role |
|---|---|
| `ScoreRegistry` | 2-of-3 verifier committee (real EOAs; keys on VPS for cosign) |
| `ERC8183` + `ScoreGateHook` | Hire/fund gate |
| `CreScorePublisher` | CRE courier → `publishEpoch` |
| MockKeystoneForwarder `0x9eF646…784d` | Default (`CRE_MODE=simulation`) for simulate `--broadcast` |
| Prod KeystoneForwarder `0x76c9cf…15E62` | Later DON only (`CRE_MODE=production` or `SetCreForwarder`) |

## One-shot deploy

```bash
# .env: DEPLOYER_PRIVATE_KEY (funded MON), VERIFIER_1/2/3
# Optional: CRE_MODE=simulation (default)

pnpm deploy:floor3-mainnet            # dry run
pnpm deploy:floor3-mainnet broadcast  # spends real MON
```

From forge logs, record:

```bash
SCORE_REGISTRY=0x… ERC8183=0x… SCORE_GATE_HOOK=0x… CRE_SCORE_PUBLISHER=0x… \
  DEPLOY_BLOCK=<block> \
  pnpm record:floor3-mainnet
```

That fills `packages/chain` `NETWORKS.mainnet` and `cre/epoch-publisher/config.mainnet.json`.

## Plug mainnet ops (anytime after record)

```bash
# VPS / workers .env
EPOCH_PIPELINE_ENABLED=true
EPOCH_PIPELINE_NETWORKS=mainnet          # or testnet,mainnet
# CRE target auto = mainnet-simulation when empty
CRE_ETH_PRIVATE_KEY=0x…                  # in cre/.env; funded with real MON
# VERIFIER_*_PRIVATE_KEY already required for 2-of-3 cosign

# Manual:
pnpm scores:prepare-epoch -- --from-db --all-agents --network mainnet
cd cre && cre workflow simulate epoch-publisher --target mainnet-simulation --broadcast -e .env
```

## Switch back to testnet

```bash
EPOCH_PIPELINE_NETWORKS=testnet
# CRE target auto = local-simulation
```

## Later: live DON

1. `CRE_MODE=production` + `SetCreForwarder` (or redeploy publisher)
2. `cre workflow deploy … --target mainnet-settings` (needs Chainlink deploy access)
