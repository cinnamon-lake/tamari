import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { startMockLlmServer } from './fixtures/mockLlmServer.js';

/**
 * Stale-build guard.
 *
 * E2E runs the BUILT app: webServer launches `node server/dist/main.js` and
 * the server serves client/dist — with no build step in between. A stale dist
 * silently tests old code (and worse, a stale build can PASS, hiding real
 * regressions). CI builds before running e2e, so this only guards local runs.
 *
 * Compares the oldest key build artifact against the newest non-test source
 * file and fails fast with an actionable message. Bypass with
 * E2E_SKIP_STALE_CHECK=1 for intentional runs against an older build.
 */
function assertDistIsFresh(repoRoot: string): void {
  if (process.env.E2E_SKIP_STALE_CHECK) return;

  const artifacts = ['server/dist/main.js', 'client/dist/index.html'];
  let oldestArtifact = Infinity;
  let oldestArtifactPath = '';
  for (const artifact of artifacts) {
    const full = join(repoRoot, artifact);
    if (!existsSync(full)) {
      throw new Error(
        `[e2e] ${artifact} does not exist. E2E tests run the BUILT app — run \`npm run build\` first.`,
      );
    }
    const mtime = statSync(full).mtimeMs;
    if (mtime < oldestArtifact) {
      oldestArtifact = mtime;
      oldestArtifactPath = artifact;
    }
  }

  let newestSource = 0;
  let newestSourcePath = '';
  const scan = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') scan(full);
        continue;
      }
      // Test-only changes don't affect the build output.
      if (!/\.(ts|tsx|js|jsx|css|html|sql)$/.test(entry.name) || /\.(test|spec)\.[tj]sx?$/.test(entry.name)) {
        continue;
      }
      const mtime = statSync(full).mtimeMs;
      if (mtime > newestSource) {
        newestSource = mtime;
        newestSourcePath = full;
      }
    }
  };
  for (const srcDir of ['server/src', 'client/src', 'client/public', 'packages/types/src']) {
    const full = join(repoRoot, srcDir);
    if (existsSync(full)) scan(full);
  }
  const clientHtml = join(repoRoot, 'client/index.html');
  if (existsSync(clientHtml)) {
    const mtime = statSync(clientHtml).mtimeMs;
    if (mtime > newestSource) {
      newestSource = mtime;
      newestSourcePath = clientHtml;
    }
  }

  if (newestSource > oldestArtifact) {
    throw new Error(
      `[e2e] Refusing to run against a stale build.\n` +
        `  oldest build artifact: ${oldestArtifactPath} (${new Date(oldestArtifact).toISOString()})\n` +
        `  newest source file:    ${relative(repoRoot, newestSourcePath)} (${new Date(newestSource).toISOString()})\n` +
        `E2E runs the BUILT app (server/dist + client/dist) with no build step — run \`npm run build\` first.\n` +
        `Set E2E_SKIP_STALE_CHECK=1 to bypass this check.`,
    );
  }
}

/**
 * Playwright global setup.
 *
 * Starts a deterministic mock OpenAI-compatible LLM server so browser E2E
 * tests can exercise real generation flows without API keys or GPUs.
 * The server URL is exposed to tests via process.env.MOCK_LLM_URL.
 */
export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  assertDistIsFresh(join(config.rootDir, '..'));

  const server = await startMockLlmServer({ port: Number(process.env.MOCK_LLM_PORT ?? 9876) });
  process.env.MOCK_LLM_URL = server.url;

  return async () => {
    await server.stop();
  };
}
