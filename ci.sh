#!/usr/bin/env bash

# tamari local CI — mirrors .github/workflows/ci.yml (Linux steps only).
# Runs the lint-and-test job, then the full e2e suite (smoke + journeys).
#
# Deliberately skipped vs. real CI:
#   - npm ci          — would wipe and reinstall node_modules on every run
#   - Windows matrix  — smoke-only there anyway; no local equivalent
#
# Usage: ./ci.sh

set -e

cd "$(dirname "$0")"

step() {
    echo ""
    echo -e "\033[0;36m==> $1\033[0m"
}

step "Audit dependencies"
npm audit --audit-level=moderate

step "Build packages/types (client/server import its dist/*.d.ts)"
npm run build --workspace=packages/types

step "Lint client"
npm run lint --workspace=client

step "Lint server"
npm run lint --workspace=server

step "Lint packages/types"
npm run lint --workspace=packages/types

step "Lint CSS (§16 hookable elements, §22 scoped atoms)"
npm run lint:css

step "Test client"
npm run test --workspace=client

step "Test server"
npm run test --workspace=server

step "Install Playwright browsers (no-op if already installed)"
npm run install:browsers --workspace=e2e

step "E2E full suite, incl. journeys (builds the app first)"
npm run test:e2e

step "CI passed"
