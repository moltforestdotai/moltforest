#!/usr/bin/env bash
# Deploys contracts/ScoreRegistry to Monad testnet with three verifier EOAs.
#
#   scripts/deploy-score-registry.sh              # simulate (no gas spent)
#   scripts/deploy-score-registry.sh broadcast    # deploy for real
#
# Requires in .env:
#   DEPLOYER_PRIVATE_KEY
#   VERIFIER_1, VERIFIER_2, VERIFIER_3  (distinct addresses)
#
# Afterwards: put the address and deploy block in packages/chain/src/networks.ts
# (scoreRegistry on testnet).
set -euo pipefail
cd "$(dirname "$0")/.."

key="$(grep -E '^DEPLOYER_PRIVATE_KEY=' .env 2>/dev/null | head -n1 | cut -d= -f2- | tr -d "\r\"' " || true)"
if [ -z "$key" ]; then
  echo "DEPLOYER_PRIVATE_KEY is not set in .env" >&2
  exit 1
fi
case "$key" in 0x*) ;; *) key="0x$key" ;; esac

for v in VERIFIER_1 VERIFIER_2 VERIFIER_3; do
  val="$(grep -E "^${v}=" .env 2>/dev/null | head -n1 | cut -d= -f2- | tr -d "\r\"' " || true)"
  if [ -z "$val" ]; then
    echo "$v is not set in .env" >&2
    exit 1
  fi
  export "$v=$val"
done

rpc="${MONAD_RPC_URL_TESTNET:-https://testnet-rpc.monad.xyz}"
args=(script script/DeployScoreRegistry.s.sol --rpc-url "$rpc")
if [ "${1:-}" = "broadcast" ]; then
  args+=(--broadcast)
fi

DEPLOYER_PRIVATE_KEY="$key" VERIFIER_1="$VERIFIER_1" VERIFIER_2="$VERIFIER_2" VERIFIER_3="$VERIFIER_3" \
  docker compose run --rm \
    -e DEPLOYER_PRIVATE_KEY -e VERIFIER_1 -e VERIFIER_2 -e VERIFIER_3 \
    foundry "${args[@]}"
