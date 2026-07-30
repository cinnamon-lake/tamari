// Wipes and recreates the e2e test data directory before the webServer starts
// — cross-platform replacement for `rm -rf <dir> && mkdir -p <dir>` (which is
// POSIX-only; the Playwright webServer command runs under cmd on Windows).
// Usage: node e2e/scripts/reset-test-data.mjs <dir>
import { mkdirSync, rmSync } from 'node:fs';

const dir = process.argv[2];
if (!dir) {
  console.error('reset-test-data: missing directory argument');
  process.exit(1);
}

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
