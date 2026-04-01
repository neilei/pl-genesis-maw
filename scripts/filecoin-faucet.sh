#!/usr/bin/env bash
# Claim tUSDFC and tFIL from ChainSafe Calibration faucet for the Maw Filecoin wallet.
# Per-wallet cap: 2 claims per 24h per token (5 USDFC/claim = 10 USDFC/day, 1 FIL/claim = 2 FIL/day).
# 60s cooldown between claims of the same token.
#
# Usage: ./scripts/filecoin-faucet.sh [--usdfc-only | --fil-only | --both]
#   Default: --both
#
# Cron example (hourly):
#   0 * * * * /home/bawler/maw/scripts/filecoin-faucet.sh >> /home/bawler/maw/data/faucet.log 2>&1

set -euo pipefail

WALLET="0x4F12c98c004Ff28aA1e3C230946A89430F5889F0"
FAUCET_BASE="https://forest-explorer.chainsafe.dev/api/claim_token"
MODE="${1:---both}"

ts() { date -u "+%Y-%m-%dT%H:%M:%SZ"; }

claim() {
  local token="$1"
  local url="${FAUCET_BASE}?faucet_info=${token}&address=${WALLET}"
  local response
  local http_code

  response=$(curl -s -w "\n%{http_code}" --max-time 30 "$url" 2>&1) || true
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')

  if [ "$http_code" = "200" ]; then
    echo "$(ts) [OK] ${token}: tx=${body}"
  elif echo "$body" | grep -q "Rate limited"; then
    echo "$(ts) [SKIP] ${token}: rate limited"
  else
    echo "$(ts) [FAIL] ${token}: http=${http_code} body=${body}"
  fi
}

case "$MODE" in
  --usdfc-only) claim "CalibnetUSDFC" ;;
  --fil-only)   claim "CalibnetFIL" ;;
  --both)
    claim "CalibnetUSDFC"
    sleep 2
    claim "CalibnetFIL"
    ;;
  *)
    echo "Usage: $0 [--usdfc-only | --fil-only | --both]"
    exit 1
    ;;
esac
