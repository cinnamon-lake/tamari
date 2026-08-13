// Syncs SQL migrations into dist/ after tsc — cross-platform replacement for
// `cp src/db/migrations/*.sql dist/db/migrations/`. Only *.sql files are
// touched: code migrations (NNN_name.ts) are compiled by tsc into the same
// dist directory as .js and must be left alone.
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(serverRoot, 'src', 'db', 'migrations');
const distDir = join(serverRoot, 'dist', 'db', 'migrations');

mkdirSync(distDir, { recursive: true });

// Remove stale .sql files from dist, then copy the current set over.
for (const file of readdirSync(distDir)) {
  if (file.endsWith('.sql')) rmSync(join(distDir, file));
}
for (const file of readdirSync(srcDir)) {
  if (file.endsWith('.sql')) cpSync(join(srcDir, file), join(distDir, file));
}
