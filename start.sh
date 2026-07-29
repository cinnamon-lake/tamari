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
node server/dist/main.js "$@"
