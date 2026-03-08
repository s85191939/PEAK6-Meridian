.PHONY: install build test dev frontend demo deploy clean

# Ensure Solana / Anchor / Cargo are on PATH
export PATH := $(HOME)/.local/share/solana/install/active_release/bin:$(HOME)/.cargo/bin:$(PATH)

# Anchor / Solana env defaults (devnet)
export ANCHOR_PROVIDER_URL ?= https://api.devnet.solana.com
export ANCHOR_WALLET       ?= $(HOME)/.config/solana/id.json

PROGRAM_ID := 2zchyfx482vagebbGJ2ePq8AuuafwS1Hc6YoSkgAfTe1

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

# Full lifecycle demo on local validator (starts validator, deploys, runs, shuts down)
demo:
	@# Kill any leftover validator from a previous run
	@pkill -f solana-test-validator 2>/dev/null || true
	@sleep 1
	@echo "🚀 Starting local validator + deploying program..."
	@solana-test-validator --reset --quiet \
		--bpf-program $(PROGRAM_ID) target/deploy/meridian.so \
		> /dev/null 2>&1 & echo $$! > .validator-pid
	@echo "   Waiting for validator to be ready..."
	@for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do \
		sleep 1; \
		curl -s http://localhost:8899 -X POST -H "Content-Type: application/json" \
			-d '{"jsonrpc":"2.0","id":1,"method":"getVersion"}' 2>/dev/null | grep -q solana-core && break; \
		if [ $$i -eq 15 ]; then echo "❌ Validator failed to start"; kill $$(cat .validator-pid) 2>/dev/null; rm -f .validator-pid; exit 1; fi; \
	done
	@echo "   ✅ Validator ready"
	@ANCHOR_PROVIDER_URL=http://localhost:8899 ANCHOR_WALLET=$(HOME)/.config/solana/id.json \
		npx ts-node scripts/demo-lifecycle.ts; \
		STATUS=$$?; kill $$(cat .validator-pid) 2>/dev/null; rm -f .validator-pid; exit $$STATUS

# Full lifecycle demo on devnet (requires funded wallet — use https://faucet.solana.com)
demo-devnet:
	ANCHOR_PROVIDER_URL=https://api.devnet.solana.com npx ts-node scripts/demo-lifecycle.ts

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
