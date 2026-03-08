.PHONY: install build test dev frontend demo deploy clean

# One-command setup: install deps, build program, run tests, start frontend
all: install build test frontend

# Install all dependencies (Anchor + frontend)
install:
	npm install
	cd app && npm install

# Build the Solana program (skip IDL gen due to Rust 1.94 incompatibility with anchor-syn)
build:
	anchor build --no-idl

# Run all 23 integration tests on local validator
test:
	anchor test --skip-build

# Start the Next.js frontend (http://localhost:3000)
frontend:
	cd app && npm run dev

# Full lifecycle demo on local validator: create -> mint -> trade -> settle -> redeem
demo:
	npx ts-node scripts/demo-lifecycle.ts

# Deploy program to Solana devnet
deploy:
	solana config set --url devnet
	solana program deploy target/deploy/meridian.so --program-id target/deploy/meridian-keypair.json --url devnet

# Create markets on devnet
create-markets:
	npx ts-node scripts/create-markets.ts

# Settle markets on devnet
settle-markets:
	npx ts-node scripts/settle-markets.ts

# Build frontend for production
build-frontend:
	cd app && npm run build

# Clean build artifacts
clean:
	anchor clean
	rm -rf app/.next app/out
