# Monad mainnet Floor-3 (hackathon plug-in)

Chainlink accepts **CRE workflow simulation** for the hackathon. Contracts, verifiers, and
`cre workflow simulate --broadcast` still run on **Monad mainnet with real MON**.

## Live addresses (deployed 2026-10-13)

| Contract | Address | Deploy block |
|---|---|---|
| `ScoreRegistry` | `0x764c5C04736ceB34D69409733bb2015F840e12a5` | `112997166` |
| `ERC8183` (our copy) | `0xC56C3C1aDB951f7747eF88310b036F612606d217` | `112997178` |
| `ScoreGateHook` | `0x7d86EdFEdbE012F7fcE72A95F51fEbEa2f215785` | `112997196` |
| `CreScorePublisher` | `0x21487DdF77f01Ba10d147946D44dFD3fD55fd015` | `112997221` |

Also in `packages/chain` `NETWORKS.mainnet` and `cre/epoch-publisher/config.mainnet.json`.

## What goes on mainnet

| Piece | Role |
|---|---|
| `ScoreRegistry` | 2-of-3 verifier committee (real EOAs; keys on VPS for cosign) |
| `ERC8183` + `ScoreGateHook` | Hire/fund gate |
| `CreScorePublisher` | CRE courier → `publishEpoch` |
| MockKeystoneForwarder `0x9eF646…784d` | Default (`CRE_MODE=simulation`) for simulate `--broadcast` |
| Prod KeystoneForwarder `0x76c9cf…15E62` | Later DON only (`CRE_MODE=production` or `SetCreForwarder`) |

## One-shot deploy (already done)

Addresses above are live. Re-deploy only if you intentionally replace the stack:

```bash
# .env: DEPLOYER_PRIVATE_KEY (funded MON), VERIFIER_1/2/3
# Optional: CRE_MODE=simulation (default)

pnpm deploy:floor3-mainnet            # dry run
pnpm deploy:floor3-mainnet broadcast  # spends real MON
SCORE_REGISTRY=0x… ERC8183=0x… SCORE_GATE_HOOK=0x… CRE_SCORE_PUBLISHER=0x… \
  DEPLOY_BLOCK=<block> \
  pnpm record:floor3-mainnet
```

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
