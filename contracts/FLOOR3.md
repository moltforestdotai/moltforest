# Floor 3 — Verifiable scores

**Staging:** Monad testnet (`10143`) — live demo addresses below.  
**Cutover:** Monad mainnet (`143`) via `DeployFloor3Mainnet.s.sol` before Metropolis ends. Do **not** use the QNTX mainnet 8183 (`0xE8c4…0725`); we deploy our own kernel on both nets.

## Decisions locked

| Topic | Decision |
|---|---|
| Staging chain | Monad testnet `10143` |
| Production chain | Monad mainnet `143` |
| Official QNTX ERC-8183 | Mainnet only (`0xE8c4…0725`) — **not used** |
| Our ERC-8183 | Deploy our copy of [qntx/market-contract](https://github.com/qntx/market-contract) (or minimal mock for unit tests) |
| Hook interface | **`IERC8183Hook`** (`beforeAction` / `afterAction`), not the outdated doc name `IACPHook` |
| Score publish | `ScoreRegistry` with **2-of-3** EIP-712 verifier signatures + Merkle proofs |
| Gate | `ScoreGateHook._preFund` checks score thresholds + cluster independence |
| CRE courier | `CreScorePublisher` + CRE workflow; Forwarder cutover per network |

## Contracts added

| File | Role |
|---|---|
| `src/ScoreRegistry.sol` | Epoch roots + `verifyScore` |
| `src/ScoreGateHook.sol` | Bouncer on `fund()` |
| `src/CreScorePublisher.sol` | CRE `writeReport` → `publishEpoch` |
| `src/erc8183/*` | Trimmed IERC8183 / hook base (ABI-compatible with QNTX) |

## Publish flow

```text
Workers / scoring engine (deterministic integers)
        → three verifier processes recompute roots and sign
        → prepare-epoch stages pending (API) for CRE
        → CRE (or break-glass publish-epoch) calls publishEpoch(2 sigs)
        → ScoreGateHook reads ScoreRegistry on fund()
```

## Deployed (Monad testnet)

| Contract | Address | Deploy block | Tx |
|---|---|---|---|
| `ScoreRegistry` | `0x7d86EdFEdbE012F7fcE72A95F51fEbEa2f215785` | `69566892` | `0x3b9943758042d0c69cb5ef02acb226361d66580ca56ad204c754111835d93751` |
| `ERC8183` (QNTX vendor) | `0xa3062BA91612782020EA0310De0e068D9bcEFF6a` | `69568083` | `0x70f7962d0819787d717c5a6fc52fb12465698c89c9f223a21a2545931ba0b7d9` |
| `ScoreGateHook` | `0xbd5f1114092A92EF24Aa3ebE00e3c462f572eBFB` | `69568091` | `0xf447861f60965b82562e99c4c8a348de31c34b4ec116a12e315ca97e1c025e16` |
| `CreScorePublisher` | `0xEDAffF4855de733de33aF792b7DD4ddf1670A3c5` | `69722712` | `0x29472c41e3884805ba77a05ff469c068e1e65d6e69755fb7e82963c8999a7c38` |

Verifiers (sorted on-chain): `0x50A4…6552`, `0xA538…53e0`, `0xF10d…B04C`.

`CreScorePublisher` is wired to the Monad testnet **simulation** MockKeystoneForwarder `0xB9F79d…Ad192` (for `cre workflow simulate --broadcast`). Production KeystoneForwarder is `0xF8344C…4482` — update via `setForwarderAddress` before a live CRE deploy.

On-chain config verified:
- Hook whitelisted on ERC8183
- Testnet USDC `0x534b…43A3` allowlisted
- Gate thresholds: score ≥ 5000 bps, confidence ≥ 2000 bps, ≥ 1 independent cluster
- Hook points at ScoreRegistry + ERC8183 above

Also recorded in `packages/chain/src/networks.ts`.

## Mainnet deploy (plug-in ready)

See **[MAINNET.md](./MAINNET.md)** — hackathon path uses CRE **simulate** on mainnet with real MON.

```bash
pnpm deploy:floor3-mainnet broadcast          # CRE_MODE=simulation → MockForwarder 0x9eF646…784d
# SCORE_REGISTRY=… ERC8183=… SCORE_GATE_HOOK=… CRE_SCORE_PUBLISHER=… DEPLOY_BLOCK=…
pnpm record:floor3-mainnet
```

Defaults: mainnet USDC `0x7547…a603`, CRE **simulation** MockForwarder (override with `CRE_MODE=production`).  
Runbook: `cre/PRODUCTION.md`.

## Off-chain scoring (`packages/scores`)

```bash
pnpm --filter @moltforest/scores test
pnpm scores:publish-epoch -- --demo                 # testnet (default)
pnpm scores:publish-epoch -- --demo --network mainnet
```

Publishes with 2-of-3 EIP-712 cosignatures, then verifies a Merkle proof on-chain.

## Score + proof API

After `pnpm db:migrate`, publish (or seed) an epoch so leaves live in `app.score_epoch` / `app.score_epoch_agent`:

```bash
# Already published on-chain — seed Postgres only (demo leaves):
PUBLISH_TX=0x732e970c8441cef4387d105c94a10988ba1db54619961e7c607cc98e473f99bf \
  pnpm scores:publish-epoch -- --db-only --demo

# Live Floor-2 assessments → new epoch (needs reviews worker data):
EPOCH_ID=2 pnpm scores:publish-epoch -- --from-db

# Demo agents (default if no --from-db / --scores):
pnpm scores:publish-epoch -- --demo
```

```bash
curl -s localhost:4000/v1/agents/testnet/7/score | jq .
# optional: ?epochId=1
```

Response includes `score`, `proof` (hex Merkle path), roots, and `scoreRegistry` for `verifyScore` / gate consumers. This is an on-chain gate surface, not a hiring verdict (C1).

### Live score inputs (`--from-db`)

| Field | Source |
|---|---|
| `verifiedReviews` | `app.agent_review_summary.verified_reviews` |
| `countedReviewers` | `app.agent_review_summary.counted_reviewers` (independent clusters) |
| `totalPaidVolume` | sum of `review_assessment.link.amount` for counted linked reviews |

By default only agents with `verified_reviews > 0` or `counted_reviewers > 0` are included. Pass `--include-zero` for every assessed agent; `SCORE_LIMIT` caps leaf count.

## Chainlink CRE epoch publisher

CRE is the **neutral clock + courier** — not the scoring brain. Verifiers still cosign off-chain; CRE delivers the report to `CreScorePublisher`, which calls `ScoreRegistry.publishEpoch`.

```bash
# 1) Cosign + stage (does not publish on-chain)
EPOCH_ID=2 pnpm scores:prepare-epoch -- --demo
curl -s 'localhost:4000/v1/scores/pending-epoch?network=testnet' | jq .

# Mainnet (after deploy):
# EPOCH_ID=1 pnpm scores:prepare-epoch -- --demo --network mainnet

# 2) Simulate CRE workflow (needs CRE CLI ≥ 1.30 + Bun)
#    See cre/README.md
cd cre/epoch-publisher && bun install && cd ..
cre workflow simulate epoch-publisher --target local-simulation
cre workflow simulate epoch-publisher --target local-simulation --broadcast
```

Workflow code: `cre/epoch-publisher/main.ts`. Report ABI matches `CreScorePublisher._processReport`.

Production path (auth, idempotent skip, Forwarder cutover, mainnet): see `cre/PRODUCTION.md`.

## Next steps (in order)

1. ~~`pnpm contracts:test` — ScoreRegistry + ScoreGateHook green~~
2. ~~Deploy `ScoreRegistry` to testnet~~
3. ~~Vendor/deploy ERC-8183 kernel on testnet; deploy `ScoreGateHook` pointing at it~~
4. ~~Off-chain epoch package + demo publish~~ — epoch **1** published  
   tx `0x732e970c8441cef4387d105c94a10988ba1db54619961e7c607cc98e473f99bf`  
   scoresRoot `0x78cd7d292127568819d67fcf2d7736df618a2cd65590f55c6cab80a257c7d6b8`  
   (`verifyScore` agent 7 = true)
5. ~~Demo: createJob + fund gate~~ (`pnpm scores:demo-gate`)
6. ~~API endpoint to serve score + Merkle proof~~ — `GET /v1/agents/:network/:agentId/score`
7. ~~Wire scores from live `agent_review_summary`~~ — `pnpm scores:publish-epoch -- --from-db`
8. ~~Chainlink CRE as epoch publisher~~ — `CreScorePublisher` + hardened `cre/epoch-publisher`
9. ~~Staging CRE simulate / `--broadcast`~~ — proven locally; VPS via `EPOCH_PIPELINE_*` workers
10. **Mainnet Floor-3 deploy** — `pnpm deploy:floor3-mainnet broadcast` + `pnpm record:floor3-mainnet` (see MAINNET.md)
11. CRE live DON *(optional)* — Chainlink deploy access + `CRE_MODE=production`

### VPS unattended (hackathon)

```bash
# On the server .env:
EPOCH_PIPELINE_ENABLED=true
EPOCH_PIPELINE_NETWORKS=testnet
EPOCH_PIPELINE_ALL_AGENTS=true
EPOCH_PIPELINE_CRE_BROADCAST=true
EPOCH_PIPELINE_FALLBACK_PUBLISH=true
# + VERIFIER_1/2/3_PRIVATE_KEY, CRE_API_KEY or cre login, cre/.env CRE_ETH_PRIVATE_KEY

# Manual one-shot (all ERC-8004 agents since indexer start_block 0):
pnpm scores:prepare-epoch -- --from-db --all-agents
```

Reviews: the reviews worker assesses every on-chain `Feedback` row. Agents with no ERC-8004
reviews still appear in the Merkle tree with score 0 when `allAgents` is on — we do **not**
fabricate Reputation Registry reviews.

## Leaf encoding (keep TS in sync)

```
leaf = keccak256(bytes.concat(keccak256(abi.encode(
  agentId, scoreBps, confidenceBps, paidReviews, independentClusters, totalPaidVolume
))))
```

EIP-712 domain: name `MoltForestScores`, version `1`, with `chainId` + `verifyingContract`.
Type: `Epoch(uint64 epochId,bytes32 inputsRoot,bytes32 scoresRoot,bytes32 algoHash)`.
