#!/usr/bin/env bash
# Deploys contracts/ReceiptRegistry with the deployer key from the local .env.
# The key is passed to the container as an env var and never printed or put on a command line.
#
#   scripts/deploy-receipt-registry.sh                     # simulate on testnet
#   scripts/deploy-receipt-registry.sh broadcast           # deploy on testnet
#   NETWORK=mainnet scripts/deploy-receipt-registry.sh     # simulate on mainnet
#   NETWORK=mainnet scripts/deploy-receipt-registry.sh broadcast
#
# Afterwards: put the address and deploy block in packages/chain/src/networks.ts.
set -euo pipefail
cd "$(dirname "$0")/.."

key="$(grep -E '^DEPLOYER_PRIVATE_KEY=' .env 2>/dev/null | head -n1 | cut -d= -f2- | tr -d "\r\"' " || true)"
if [ -z "$key" ]; then
  echo "DEPLOYER_PRIVATE_KEY is not set in .env" >&2
  exit 1
fi
case "$key" in 0x*) ;; *) key="0x$key" ;; esac
if ! printf '%s' "$key" | grep -Eq '^0x[0-9a-fA-F]{64}$'; then
  echo "DEPLOYER_PRIVATE_KEY in .env is not a 32-byte hex key" >&2
  exit 1
fi

network="${NETWORK:-testnet}"
case "$network" in
  testnet)
    rpc="${MONAD_RPC_URL_TESTNET:-https://testnet-rpc.monad.xyz}"
    identity_default="0x8004A818BFB912233c491871b3d84c89A494BD9e"
    ;;
  mainnet)
    rpc="${MONAD_RPC_URL_MAINNET:-https://rpc.monad.xyz}"
    identity_default="0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"
    ;;
  *)
    echo "NETWORK must be testnet or mainnet (got: $network)" >&2
    exit 1
    ;;
esac

identity="$(grep -E '^IDENTITY_REGISTRY=' .env 2>/dev/null | head -n1 | cut -d= -f2- | tr -d "\r\"' " || true)"
identity="${IDENTITY_REGISTRY:-${identity:-$identity_default}}"

args=(script script/DeployReceiptRegistry.s.sol --rpc-url "$rpc" -vvvv)
if [ "${1:-}" = "broadcast" ]; then
  args+=(--broadcast)
fi

echo "network=$network  rpc=$rpc  identity=$identity  broadcast=${1:-simulate}"
DEPLOYER_PRIVATE_KEY="$key" IDENTITY_REGISTRY="$identity" \
  docker compose run --rm \
    -e DEPLOYER_PRIVATE_KEY -e IDENTITY_REGISTRY \
    foundry "${args[@]}"
