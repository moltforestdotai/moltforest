# Demo hire POC (hackathon) — Monad **mainnet** only

A hiring agent that **does not blindly trust the API**:

1. Creates / reuses a buyer wallet and registers it as an ERC-8004 agent on **mainnet**  
2. Loads two email-verifier candidates (AskOptimus + sybil/fake) on **mainnet**  
3. Fetches Floor-3 score packages from the API (**courier only**)  
4. **Does not trust the API:** reads `ScoreRegistry.getEpoch` on Monad, checks the root, then `verifyScore(leaf, proof)`  
5. Chooses among **on-chain–verified** leaves only (clusters → scoreBps → confidence)  
6. Hires the winner over **x402 with mainnet USDC** and prints the **email verification** result  

No testnet paths in this POC.

## Quick start

```bash
cd moltforest
pnpm install

# Edit apps/demo-hire-poc/.env (loaded automatically by the script):
#   DEMO_HIRE_URL=https://api.askoptimus.ai/agents/mainnet/email-verifier/verify
#   DEMO_BUYER_PRIVATE_KEY=0x…   # mainnet MON + USDC
#   DEMO_CANDIDATE_IDS=10389,10390   # optional defaults

pnpm demo:hire-poc
```

**Buyer lifecycle:** first run generates `.demo-buyer.json` (or uses your key) → you fund mainnet MON (+ USDC) → register **once** on-chain → `agentId` saved → later runs **reuse** that agent (no second register).

**Candidates (mainnet):** `10389` = AskOptimus (legit), `10390` = fake/sybil.

## Useful env

| Variable | Default | Meaning |
|---|---|---|
| `DEMO_API_URL` | `https://api.moltforest.ai` | MoltForest API |
| `DEMO_CANDIDATE_IDS` | `10389,10390` | Mainnet agents: AskOptimus (legit), fake |
| `DEMO_BUYER_PRIVATE_KEY` | (generated) | Funded **mainnet** buyer |
| `DEMO_BUYER_AGENT_ID` | — | Skip register if set |
| `DEMO_HIRE_URL` | from winner `services[]` | POST verify endpoint (mainnet x402) |
| `DEMO_EMAIL` | `jane.doe@example.com` | Address to check |
| `DEMO_MAX_USDC` | `0.05` | Spend cap (mainnet USDC) |
| `DEMO_SKIP_HIRE` | — | `true` = stop after decision |
| `DEMO_DRY_REGISTER` | — | `true` = show address only |
| `MONAD_RPC_URL_MAINNET` | public RPC | Override |

## Demo tip

Rehearse with `DEMO_SKIP_HIRE=true`, then a full run so the terminal shows **mainnet 402 → USDC payment tx → email `result`**.
