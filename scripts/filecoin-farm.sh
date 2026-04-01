#!/usr/bin/env bash
# Farm tUSDFC from ChainSafe Calibration faucet using 23 wallets.
# Uses claim_token_all endpoint to get both USDFC + FIL per wallet in one call.
# Fires claims sequentially (60s global cooldown), then sweeps USDFC to main.
#
# Rate limits: 60s global cooldown, 2 claims/day/wallet.
# Yield: ~230 USDFC/day (23 wallets x 2 claims x 5 USDFC).
#
# Cron (hourly at :30):
#   30 * * * * /home/bawler/maw/scripts/filecoin-farm.sh >> /home/bawler/maw/data/faucet-farm.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

FAUCET_ALL="https://forest-explorer.chainsafe.dev/api/claim_token_all"

FARM_ADDRS=(
  "0x7eBAb60fE8ddb6bb37950dC8F31127DAAD58590C"
  "0x89de1c20C0D31a2e390375D4aD00F9e122c309e3"
  "0x552BB1BD734f7e2b8C5cDc7457aD149a8697B4aD"
  "0x1f545D7f8701645BB678dC7cE9C3DdbEF9f6202f"
  "0x68C6B5a1773ff6C2D896403D88f8A8375C10dB89"
  "0x46Ef08C7cc8fa98763071e34648947f9578385f8"
  "0x0E52513Fc75d45aD5edF929522112097A38FA332"
  "0xE79F4B98d404C52b88b58e05b5D1F50a004Ac850"
  "0x7D1A8c9E15E58Aa5206fCcB03E29B1A8B4Dbc3Ea"
  "0xbb9538CEacB659bE8ED07E09AebE43d8EB9C32a5"
  "0x48e2c67436B2ac024d4f3c32151B630F44dce54e"
  "0xdcB17a7e0955bE6B661F5C3ce7c68A3Daf2c45c4"
  "0xDdB7C04CbdD1efC624C4C24c23c869aCf31bFe82"
  "0x36bA0908d5D0cB4EE58376E10d8e103c6a72E681"
  "0x6770A058Db27F940A8D4C4Bf4b1D382dC2FD3047"
  "0x720047D1aCE6bA7A92998147EA73C1968b8Fdd92"
  "0x027ECcFAE8D21100E2d0Cb5775c5FA0210FF132B"
  "0x12C8d742858B4715C48D39E0aBe89b9259fD6C77"
  "0x55956e772F625D669E1F24f80d1670F9Af55119f"
  "0x20a143f9a5F272653f1265a51ec6Ef42d5CC5f77"
  "0x739C42F9b864Bf41a3Ee6045f9a7D8294A182cf6"
  "0x1ea1064A446aB3a4076a728d805367eAd18e3fFB"
  "0x8d846e73c9063A441AcCCa681Ef820A43E10e7b4"
)

ts() { date -u "+%Y-%m-%dT%H:%M:%SZ"; }

# claim_token_all returns JSON array: [{faucet_info, tx_hash?, error?}, ...]
# Gives both USDFC + FIL in one call, ensuring a wallet always gets gas with its USDFC.
claim_all() {
  local addr="$1"
  local label="$2"
  local url="${FAUCET_ALL}?address=${addr}"
  local response http_code body

  response=$(curl -s -w "\n%{http_code}" --max-time 60 "$url" 2>&1) || true
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')

  if [ "$http_code" = "200" ]; then
    # Check if any tx_hash present (not all rate-limited)
    if echo "$body" | grep -q "tx_hash"; then
      echo "$(ts) [OK] ${label}: ${body}"
    fi
    # Silent if all rate-limited
  else
    echo "$(ts) [FAIL] ${label}: http=${http_code}"
  fi
}

echo "$(ts) === Farm cycle start (${#FARM_ADDRS[@]} wallets) ==="

# Phase 1: Claim for each wallet sequentially with 65s delay.
# claim_token_all gives USDFC+FIL together, so gas is always paired.
claimed=0
for i in "${!FARM_ADDRS[@]}"; do
  addr="${FARM_ADDRS[$i]}"
  label="farm-$((i+1))"
  claim_all "$addr" "$label"
  claimed=$((claimed + 1))
  # 65s cooldown between claims (global rate limit).
  # Stop after ~50 min to avoid overlapping with next hourly cron run.
  if [ "$claimed" -ge 45 ]; then
    echo "$(ts) Hit 45 claims, stopping to avoid cron overlap"
    break
  fi
  if [ "$i" -lt "$(( ${#FARM_ADDRS[@]} - 1 ))" ]; then
    sleep 65
  fi
done

# Phase 2: Wait for last faucet txns to confirm
echo "$(ts) Waiting 45s for confirmations..."
sleep 45

# Phase 3: Sweep all USDFC to main wallet (concurrent with limit of 5)
echo "$(ts) Transferring USDFC to main wallet..."
node "${PROJECT_DIR}/packages/agent/scripts/farm-transfer.mjs" 2>&1

echo "$(ts) === Farm cycle end ==="
