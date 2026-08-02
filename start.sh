#!/usr/bin/env bash

# tamari startup script
# Builds client + server from source, then starts the server.

set -e

cd "$(dirname "$0")"

if ! command -v npm &> /dev/null; then
    echo -e "\033[0;31mnpm could not be found in PATH. Please install Node.js from https://nodejs.org/\033[0m"
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo -e "\033[0;31mnode could not be found in PATH. Please install Node.js from https://nodejs.org/\033[0m"
    exit 1
fi

echo "Installing Node Modules..."
npm install --no-save --no-audit --no-fund --loglevel=error --no-progress

echo "Building tamari..."
npm run build

echo "Starting server..."
# WORKAROUND (V8/wasm crash): wasmoon injects each JS callback into Lua via a
# tiny per-callback WebAssembly module (emscripten addFunction), so card-script
# turns create+destroy dozens of wasm modules. Node 24's V8 crashes tearing
# these down while tiering up wasm→JS wrappers (FreeDeadCode/ThreadIsolation
# segfaults + fatals — see cores from 2026-08-01/02). --no-wasm-tier-up keeps
# wrappers on Liftoff and closes that path at negligible cost for this app.
# Remove once the V8 bug is fixed upstream.
node --no-wasm-tier-up server/dist/main.js "$@"
