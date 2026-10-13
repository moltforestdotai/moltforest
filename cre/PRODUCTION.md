# CRE production runbook — Floor-3 epoch publisher

CRE is the **standard publisher** of score epochs. Verifiers still cosign content;
CRE delivers `publishEpoch` through `CreScorePublisher`.

## Environments

| Env | Chain | Forwarder | Consumer | Pending API |
|---|---|---|---|---|
| Local simulate | testnet 10143 | MockKeystoneForwarder `0xB9F79d…Ad192` | `0xEDAffF…A3c5` | `http://127.0.0.1:4000/...` (optional auth) |
| Staging broadcast | testnet | Same mock (CLI simulate `--broadcast`) | same | staging API + `SCORES_PENDING_API_KEY` |
| Testnet prod DON | testnet | KeystoneForwarder `0xF8344C…4482` | same after `setForwarderAddress` | public HTTPS + Bearer |
| **Mainnet simulate (hackathon)** | mainnet 143 | MockKeystoneForwarder `0x9eF646…784d` | after `DeployFloor3Mainnet` (`CRE_MODE=simulation`) | `?network=mainnet` + Bearer |
| **Mainnet DON** | mainnet 143 | KeystoneForwarder `0x76c9cf…15E62` | same after `SetCreForwarder` / redeploy | same |

Full mainnet plug-in: [contracts/MAINNET.md](../contracts/MAINNET.md).

## Staging E2E (required before calling CRE “integrated”)

```bash
# API + DB
pnpm db:migrate
pnpm dev:api

# Cosign next epoch (do not publish with publish-epoch)
EPOCH_ID=2 pnpm scores:prepare-epoch -- --demo

# Optional: lock pending endpoint
# SCORES_PENDING_API_KEY=…at-least-16-chars… in .env
# and pendingEpochApiKey in cre/epoch-publisher/config.simulation.json

# CRE CLI ≥ 1.30 + Bun ≥ 1.2.21
# Binary: ~/.cre/bin/cre (export PATH="$HOME/.cre/bin:$PATH")
# Auth (required even for local simulate):
#   cre login   OR   export CRE_API_KEY=…  (https://app.chain.link Account Settings)

cd cre/epoch-publisher && bun install && cd ..
# cre/.env → CRE_ETH_PRIVATE_KEY=0x… (funded Monad testnet for --broadcast)

cre workflow simulate epoch-publisher --target local-simulation
cre workflow simulate epoch-publisher --target local-simulation --broadcast
```

Success criteria:
- Dry-run completes without error (may skip if epoch already published).
- `--broadcast` yields a Monad tx; `ScoreRegistry.getEpoch(2)` returns roots.
- `GET /v1/agents/testnet/7/score?epochId=2` returns a Merkle proof.

## Testnet production cutover

1. Set `SCORES_PENDING_API_KEY` on the API; put the same value in CRE secrets / config for the workflow.
2. Point `pendingEpochUrl` at the public API (HTTPS).
3. Switch Forwarder (owner only):

```bash
cd contracts
CRE_SCORE_PUBLISHER=0xEDAffF4855de733de33aF792b7DD4ddf1670A3c5 \
  CRE_FORWARDER=0xF8344CFd5c43616a4366C34E3EEE75af79a74482 \
  forge script script/SetCreForwarder.s.sol:SetCreForwarder \
  --rpc-url https://testnet-rpc.monad.xyz --broadcast
```

4. `cre workflow deploy epoch-publisher --target staging-settings` (once CRE deploy access is granted).
5. Automate prepare + CRE on the VPS via workers (`EPOCH_PIPELINE_ENABLED=true`):
   cosigns all indexed agents (`EPOCH_PIPELINE_ALL_AGENTS`), stages pending, runs
   `cre workflow simulate … --broadcast` (hackathon), falls back to `publishEpoch` if CRE fails.
   Requires `VERIFIER_*_PRIVATE_KEY`, CRE CLI + auth, and `cre/.env` (`CRE_ETH_PRIVATE_KEY`) on the box.
6. Keep manual `publish-epoch` as **break-glass** only (document who may run it).

## Mainnet cutover (hackathon = simulate + real MON)

1. Deploy (`CRE_MODE=simulation` default → MockForwarder `0x9eF646…784d`):

```bash
pnpm deploy:floor3-mainnet broadcast
# then plug addresses:
SCORE_REGISTRY=… ERC8183=… SCORE_GATE_HOOK=… CRE_SCORE_PUBLISHER=… DEPLOY_BLOCK=… \
  pnpm record:floor3-mainnet
```

2. Fund `CRE_ETH_PRIVATE_KEY` (and deployer) with **real MON**.
3. Prepare: `pnpm scores:prepare-epoch -- --from-db --all-agents --network mainnet`
4. CRE simulate: `cre workflow simulate epoch-publisher --target mainnet-simulation --broadcast`
5. Or VPS: `EPOCH_PIPELINE_NETWORKS=mainnet` (CRE target auto = `mainnet-simulation`).
6. Break-glass: `pnpm scores:publish-epoch -- --from-db --all-agents --network mainnet`.

### Later: live DON

`CRE_MODE=production` + `SetCreForwarder`, then
`cre workflow deploy epoch-publisher --target mainnet-settings` (needs deploy access).
Prod Forwarder: `0x76c9cf548b4179F8901cda1f8623568b58215E62`.

## Idempotency

The workflow calls `ScoreRegistry.getEpoch(epochId)` before `writeReport`. If the epoch is already published, it skips (safe re-runs).

## Incident playbook

| Symptom | Action |
|---|---|
| CRE cannot fetch pending | Check API health, Bearer key, DNS/TLS, `?network=` |
| `writeReport` reverts `EpochAlreadyPublished` | Expected if double-fire; workflow should skip first |
| Wrong Forwarder | `setForwarderAddress` back to mock or prod |
| Bad signatures | Re-run `prepare-epoch` with correct `VERIFIER_*_PRIVATE_KEY` + matching `chainId` |
| Emergency publish without CRE | `pnpm scores:publish-epoch -- --network …` (break-glass; log the incident) |

## Ownership

- `CreScorePublisher` Ownable → deploy key today; move to multisig before/at mainnet.
- Verifier keys → separate from deployer; never in CRE secrets (only pending API key).
