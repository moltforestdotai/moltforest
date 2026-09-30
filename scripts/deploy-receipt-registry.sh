#!/usr/bin/env bash
# Deploys contracts/ReceiptRegistry to Monad testnet (decision D05) with the
# deployer key from the local .env. The key is passed to the container as an
# environment variable and never printed or put on a command line.
#
#   scripts/deploy-receipt-registry.sh              # simulate (no gas spent)
#   scripts/deploy-receipt-registry.sh broadcast    # deploy for real
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
rpc="${MONAD_RPC_URL_TESTNET:-https://testnet-rpc.monad.xyz}"
args=(script script/DeployReceiptRegistry.s.sol --rpc-url "$rpc")
if [ "${1:-}" = "broadcast" ]; then
  args+=(--broadcast)
fi

DEPLOYER_PRIVATE_KEY="$key" docker compose run --rm -e DEPLOYER_PRIVATE_KEY foundry "${args[@]}"
