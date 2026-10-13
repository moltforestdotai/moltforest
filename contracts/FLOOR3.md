# Floor 3 — Verifiable scores

**Staging:** Monad testnet (`10143`) — live demo addresses below.  
**Mainnet:** Floor-3 + `ReceiptRegistry` live on Monad mainnet (`143`). Do **not** use the QNTX mainnet 8183 (`0xE8c4…0725`); we deploy our own kernel on both nets.

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

## Deployed (Monad mainnet)

Deployed 2026-10-13 via `DeployFloor3Mainnet` (`CRE_MODE=simulation`). Recorded in `packages/chain` + `cre/epoch-publisher/config.mainnet.json`. See **[MAINNET.md](./MAINNET.md)**.

| Contract | Address | Deploy block | Tx |
|---|---|---|---|
| `ScoreRegistry` | `0x764c5C04736ceB34D69409733bb2015F840e12a5` | `112997166` | `0x926e8f9e32664253a11023b4f94da66a694bc235ec170208b72cc0593409ce56` |
| `ERC8183` (our copy) | `0xC56C3C1aDB951f7747eF88310b036F612606d217` | `112997178` | `0x6a37871d893a847940be5d9e0e1ff02b05d05139895e1bcee786428d801e33a9` |
| `ScoreGateHook` | `0x7d86EdFEdbE012F7fcE72A95F51fEbEa2f215785` | `112997196` | `0xac09353c5a9223892e41a747dd075a1d18e17656d054cdcc0cc4ebe28930dced` |
| `CreScorePublisher` | `0x21487DdF77f01Ba10d147946D44dFD3fD55fd015` | `112997221` | `0x307b1a79b2787e81414f7a660c328001015cf590c67fbbafc0f777d14c82b4b1` |

Same 2-of-3 verifiers as testnet. `CreScorePublisher` → MockKeystoneForwarder `0x9eF646…784d`. Mainnet USDC `0x7547…a603` allowlisted. Gate thresholds match testnet.  
(Note: mainnet `ScoreGateHook` happens to share the same CREATE address as testnet `ScoreRegistry` — different chains.)

```bash
# Re-record if needed:
SCORE_REGISTRY=0x764c5C04736ceB34D69409733bb2015F840e12a5 \
  ERC8183=0xC56C3C1aDB951f7747eF88310b036F612606d217 \
  SCORE_GATE_HOOK=0x7d86EdFEdbE012F7fcE72A95F51fEbEa2f215785 \
  CRE_SCORE_PUBLISHER=0x21487DdF77f01Ba10d147946D44dFD3fD55fd015 \
  DEPLOY_BLOCK=112997166 pnpm record:floor3-mainnet
```

Runbook: `cre/PRODUCTION.md`. Public docs: `moltforest-web` `/docs#networks` + `/docs#scores`.

## What scoreBps / confidenceBps mean

| Field | Meaning |
|---|---|
| **bps** | Basis points: 1 bps = 0.01%. Scale is **0–10_000** (10_000 = 100%). |
| `scoreBps` | Quality-style signal from verified paid reviews + independent clusters + soft USDC volume bonus. **0** when there is no review signal. |
| `confidenceBps` | How much independent evidence backs the score. Low confidence = thin evidence, not “bad agent.” |

These leaves are for **market gates** (`ScoreGateHook`), not a hiring verdict. Hiring still uses `/trust` + `/evaluate` + caller policy (constraint C1).

### Off-chain algorithm (`moltforest-score-v1`)

Computed in `packages/scores` (deterministic integers). Pinned on-chain as `algoHash` so the formula can improve later without changing the leaf layout.

```text
volumeBonus = min(totalPaidVolume, 100_000_000) / 50_000   # ~100 USDC → +2000 bps max

scoreBps =
  0  if verifiedReviews == 0 AND countedReviewers == 0
  else clamp(2000 + verifiedReviews*1500 + countedReviewers*2000 + volumeBonus, 0, 10000)

confidenceBps = clamp(countedReviewers*2500 + verifiedReviews*1000, 0, 10000)
```

Default gate thresholds: score ≥ **5000** bps, confidence ≥ **2000** bps, ≥ **1** independent cluster.

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
10. ~~**Mainnet Floor-3 deploy**~~ — live (see table above + MAINNET.md)
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
