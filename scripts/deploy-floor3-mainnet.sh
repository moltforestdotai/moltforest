#!/usr/bin/env bash
# Deploy Floor-3 to Monad mainnet (ScoreRegistry + ERC8183 + ScoreGateHook + CreScorePublisher).
#
#   scripts/deploy-floor3-mainnet.sh              # simulate (no gas)
#   scripts/deploy-floor3-mainnet.sh broadcast    # deploy with real MON
#
# Requires in .env:
#   DEPLOYER_PRIVATE_KEY   (funded with real MON)
#   VERIFIER_1, VERIFIER_2, VERIFIER_3
#
# Optional:
#   CRE_MODE=simulation|production   (default simulation — MockForwarder for CRE simulate)
#   CRE_FORWARDER=0x…                (override)
#   TREASURY=0x…
#
# After broadcast, copy addresses from forge logs into:
#   SCORE_REGISTRY=… ERC8183=… SCORE_GATE_HOOK=… CRE_SCORE_PUBLISHER=… DEPLOY_BLOCK=…
#   pnpm record:floor3-mainnet
set -euo pipefail
cd "$(dirname "$0")/.."

load_env() {
  local key="$1"
  grep -E "^${key}=" .env 2>/dev/null | head -n1 | cut -d= -f2- | tr -d "\r\"' " || true
}

key="$(load_env DEPLOYER_PRIVATE_KEY)"
if [ -z "$key" ]; then
  echo "DEPLOYER_PRIVATE_KEY is not set in .env" >&2
  exit 1
fi
case "$key" in 0x*) ;; *) key="0x$key" ;; esac

for v in VERIFIER_1 VERIFIER_2 VERIFIER_3; do
  val="$(load_env "$v")"
  if [ -z "$val" ]; then
    echo "$v is not set in .env" >&2
    exit 1
  fi
  export "$v=$val"
done

export CRE_MODE="${CRE_MODE:-$(load_env CRE_MODE)}"
export CRE_MODE="${CRE_MODE:-simulation}"
if [ -n "$(load_env CRE_FORWARDER)" ]; then export CRE_FORWARDER="$(load_env CRE_FORWARDER)"; fi
if [ -n "$(load_env TREASURY)" ]; then export TREASURY="$(load_env TREASURY)"; fi

rpc="${MONAD_RPC_URL_MAINNET:-https://rpc.monad.xyz}"
args=(script script/DeployFloor3Mainnet.s.sol:DeployFloor3Mainnet --rpc-url "$rpc" -vvvv)
if [ "${1:-}" = "broadcast" ]; then
  args+=(--broadcast)
fi

echo "CRE_MODE=$CRE_MODE  rpc=$rpc  broadcast=${1:-simulate}"
DEPLOYER_PRIVATE_KEY="$key" \
  docker compose run --rm \
    -e DEPLOYER_PRIVATE_KEY -e VERIFIER_1 -e VERIFIER_2 -e VERIFIER_3 \
    -e CRE_MODE -e CRE_FORWARDER -e TREASURY \
    -e MIN_SCORE_BPS -e MIN_CONFIDENCE_BPS -e MIN_INDEPENDENT_CLUSTERS \
    foundry "${args[@]}"
