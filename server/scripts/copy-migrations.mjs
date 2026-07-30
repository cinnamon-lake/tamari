// Copies SQL migrations into dist/ after tsc — cross-platform replacement
// for `rm -rf dist/db/migrations && mkdir -p dist/db && cp -r src/db/migrations dist/db/`.
import { cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

rmSync(join(serverRoot, 'dist', 'db', 'migrations'), { recursive: true, force: true });
cpSync(join(serverRoot, 'src', 'db', 'migrations'), join(serverRoot, 'dist', 'db', 'migrations'), {
  recursive: true,
});
