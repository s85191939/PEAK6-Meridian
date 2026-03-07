#!/bin/bash
# deploy.sh — Deploy Meridian to Solana devnet
#
# Prerequisites:
#   - Solana CLI configured: solana config set --url devnet
#   - Wallet funded: solana airdrop 5 (may need to retry if rate-limited)
#   - Contract built: anchor build --no-idl
#
# Usage:
#   bash scripts/deploy.sh

set -e

echo "=== Meridian Devnet Deployment ==="
echo ""

# Check balance
BALANCE=$(solana balance | awk '{print $1}')
echo "Wallet balance: $BALANCE SOL"

if (( $(echo "$BALANCE < 3" | bc -l) )); then
    echo "Insufficient balance. Requesting airdrop..."
    solana airdrop 5 --url devnet || {
        echo "Airdrop failed (rate limited). Try again later or fund via https://faucet.solana.com"
        echo "Wallet address: $(solana address)"
        exit 1
    }
fi

# Deploy
echo ""
echo "Deploying program..."
solana program deploy \
    target/deploy/meridian.so \
    --program-id target/deploy/meridian-keypair.json \
    --url devnet \
    -v

echo ""
echo "=== Deployment Complete ==="
echo "Program ID: $(solana address -k target/deploy/meridian-keypair.json)"
echo "Explorer: https://explorer.solana.com/address/$(solana address -k target/deploy/meridian-keypair.json)?cluster=devnet"
