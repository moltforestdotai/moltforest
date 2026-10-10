# Floor 3 — Verifiable scores (Monad testnet)

**Network rule:** everything for this hackathon crypto layer deploys and demos on **Monad testnet (10143)** only. Do not use mainnet 8183 for the demo.

## Decisions locked

| Topic | Decision |
|---|---|
| Chain | Monad testnet `10143` |
| Official QNTX ERC-8183 | Mainnet only (`0xE8c4…0725`) — **not used** |
| Our ERC-8183 | Deploy a testnet copy of [qntx/market-contract](https://github.com/qntx/market-contract) (or minimal mock for unit tests) |
| Hook interface | **`IERC8183Hook`** (`beforeAction` / `afterAction`), not the outdated doc name `IACPHook` |
| Score publish | `ScoreRegistry` with **2-of-3** EIP-712 verifier signatures + Merkle proofs |
| Gate | `ScoreGateHook._preFund` checks score thresholds + cluster independence |

## Contracts added

| File | Role |
|---|---|
| `src/ScoreRegistry.sol` | Epoch roots + `verifyScore` |
| `src/ScoreGateHook.sol` | Bouncer on `fund()` |
| `src/erc8183/*` | Trimmed IERC8183 / hook base (ABI-compatible with QNTX) |

## Publish flow

```text
Workers / scoring engine (deterministic integers)
        → three verifier processes recompute roots and sign
        → anyone (publisher or later CRE) calls publishEpoch(2 sigs)
        → ScoreGateHook reads ScoreRegistry on fund()
```

## Deployed (Monad testnet)

| Contract | Address | Deploy block | Tx |
|---|---|---|---|
| `ScoreRegistry` | `0x7d86EdFEdbE012F7fcE72A95F51fEbEa2f215785` | `69566892` | `0x3b9943758042d0c69cb5ef02acb226361d66580ca56ad204c754111835d93751` |
| `ERC8183` (QNTX vendor) | `0xa3062BA91612782020EA0310De0e068D9bcEFF6a` | `69568083` | `0x70f7962d0819787d717c5a6fc52fb12465698c89c9f223a21a2545931ba0b7d9` |
| `ScoreGateHook` | `0xbd5f1114092A92EF24Aa3ebE00e3c462f572eBFB` | `69568091` | `0xf447861f60965b82562e99c4c8a348de31c34b4ec116a12e315ca97e1c025e16` |

Verifiers (sorted on-chain): `0x50A4…6552`, `0xA538…53e0`, `0xF10d…B04C`.

On-chain config verified:
- Hook whitelisted on ERC8183
- Testnet USDC `0x534b…43A3` allowlisted
- Gate thresholds: score ≥ 5000 bps, confidence ≥ 2000 bps, ≥ 1 independent cluster
- Hook points at ScoreRegistry + ERC8183 above

Also recorded in `packages/chain/src/networks.ts`.

## Off-chain scoring (`packages/scores`)

```bash
pnpm --filter @moltforest/scores test
pnpm scores:publish-epoch   # needs VERIFIER_*_PRIVATE_KEY (at least 2) in .env
```

Publishes a demo epoch (agents 7 / 42 / 100) to `testnet.scoreRegistry` with 2-of-3 EIP-712 cosignatures, then verifies a Merkle proof on-chain.

## Next steps (in order)

1. ~~`pnpm contracts:test` — ScoreRegistry + ScoreGateHook green~~
2. ~~Deploy `ScoreRegistry` to testnet~~
3. ~~Vendor/deploy ERC-8183 kernel on testnet; deploy `ScoreGateHook` pointing at it~~
4. ~~Off-chain epoch package + demo publish~~ — epoch **1** published  
   tx `0x732e970c8441cef4387d105c94a10988ba1db54619961e7c607cc98e473f99bf`  
   scoresRoot `0x78cd7d292127568819d67fcf2d7736df618a2cd65590f55c6cab80a257c7d6b8`  
   (`verifyScore` agent 7 = true)
5. Demo: createJob with ScoreGateHook → fund (pass / fail on score & collusion)
6. Wire scores from live `agent_review_summary` (DB) instead of demo agents
7. Optional: Chainlink CRE as epoch publisher (testnet CRE from CLI v1.30+)

## Leaf encoding (keep TS in sync)

```
leaf = keccak256(bytes.concat(keccak256(abi.encode(
  agentId, scoreBps, confidenceBps, paidReviews, independentClusters, totalPaidVolume
))))
```

EIP-712 domain: name `MoltForestScores`, version `1`, with `chainId` + `verifyingContract`.
Type: `Epoch(uint64 epochId,bytes32 inputsRoot,bytes32 scoresRoot,bytes32 algoHash)`.
