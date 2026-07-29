import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';

/**
 * Playwright configuration for tamari E2E tests.
 *
 * The server is started automatically via the `webServer` directive.
 * The webServer command wipes and recreates the test data directory before
 * starting so old characters/chats do not accumulate in the sidebar.
 *
 * NOTE: webServer runs the BUILT app (server/dist + client/dist) with no
 * build step — global-setup.ts refuses to start when dist is older than the
 * sources (run `npm run build`; bypass with E2E_SKIP_STALE_CHECK=1).
 *
 * Tests are split into two projects so they can be selected independently:
 *   - `chromium-smoke`:    the fast, isolated per-feature specs (tests/*.spec.ts)
 *   - `chromium-journeys`: the long, serial, realistic user journeys
 *                          (tests/journeys/*.spec.ts)
 * `npm run test:e2e` runs both. CI runs smoke on every PR and journeys on push
 * (merge to main). See the `test:smoke` / `test:journeys` scripts.
 *
 * Coverage mode (E2E_COVERAGE=1, see root `test:e2e:coverage` script):
 *   - specs collect client-side V8 coverage via the auto fixture in
 *     fixtures/base.ts,
 *   - the server runs with NODE_V8_COVERAGE and is shut down with SIGINT so
 *     Node flushes its V8 coverage to .coverage/node,
 *   - monocart-reporter merges both into a source-mapped report at
 *     e2e/coverage/index.html. Requires a build with sourcemaps
 *     (E2E_COVERAGE=1 npm run build).
 *
 * This config assumes it lives at `<repo-root>/e2e/playwright.config.ts`.
 */
const chromeLaunch = {
  ...devices['Desktop Chrome'],
  launchOptions: {
    executablePath: '/run/current-system/sw/bin/chromium-browser',
  },
};

const coverageEnabled = !!process.env.E2E_COVERAGE;

// Ports/data-dir are parameterizable so several Playwright instances can run
// side by side (e.g. parallel spec-authoring agents): E2E_PORT picks the app
// port (and an isolated data dir), MOCK_LLM_PORT the mock LLM port (read by
// global-setup.ts). Defaults preserve the historical single-run behavior.
const e2ePort = Number(process.env.E2E_PORT ?? 8765);
const dataDir = process.env.E2E_PORT ? `server/.test-data-${e2ePort}` : 'server/.test-data';

const reporter: NonNullable<Parameters<typeof defineConfig>[0]['reporter']> = [
  ['list'],
  ['html', { open: 'never' }],
];
if (coverageEnabled) {
  reporter.push([
    'monocart-reporter',
    {
      name: 'tamari E2E Coverage',
      outputFile: 'coverage/index.html',
      coverage: {
        name: 'E2E Coverage',
        // Repo root, so client/src/... and server/src/... resolve to real files.
        baseDir: join(__dirname, '..'),
        // The client bundle is served from http://localhost:8765/, so its
        // sourcemap sources unpack as bare src/... — rewrite them (and the
        // bundle label) to their real repo paths.
        sourcePath: (filePath: string) =>
          filePath
            .replace(/^localhost-8765\/assets\//, 'client/dist/assets/')
            .replace(/^src\//, 'client/src/'),
        // Raw Node V8 coverage written by the webServer (NODE_V8_COVERAGE).
        // Browser coverage arrives via addCoverageReport() in fixtures/base.ts.
        dataDir: join(__dirname, '.coverage/node'),
        reports: ['v8', 'v8-json', 'console-summary'],
        // Only original TS sources of the app itself — drops node_modules,
        // the mock LLM, Playwright internals, and the compiled @tamari/types.
        // Client sources unpack as bare src/... (they pass through here
        // before the sourcePath rewrite above).
        sourceFilter: (sourcePath: string) => /^(src|client\/src|server\/src)\//.test(sourcePath),
        // sourceFilter only runs on sourcemap-unpacked sources; entries
        // without maps (server node_modules, internals) must be cut here.
        entryFilter: (entry: { url?: string }) => {
          const url = entry.url || '';
          // The client bundle served by the app.
          if (url.startsWith('http://localhost:8765/')) return true;
          // Compiled server sources (have .js.map next to them).
          if (url.includes('/server/dist/')) return true;
          return false;
        },
      },
    },
  ]);
}

export default defineConfig({
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter,
  globalSetup: require.resolve('./global-setup'),
  use: {
    baseURL: `http://localhost:${e2ePort}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium-smoke',
      testDir: './tests',
      testIgnore: ['**/server/**', '**/journeys/**'],
      use: chromeLaunch,
    },
    {
      name: 'chromium-journeys',
      testDir: './tests/journeys',
      // Journeys are long, serial, multi-step sessions by design — give them
      // headroom past the 30s default per-test timeout (and for generation
      // stalls that can run tens of seconds under sustained load).
      timeout: 240000,
      use: chromeLaunch,
    },
  ],

  webServer: {
    command: `rm -rf ${dataDir} && mkdir -p ${dataDir} && node server/dist/main.js`,
    cwd: '..',
    url: `http://localhost:${e2ePort}`,
    reuseExistingServer: false,
    env: {
      PORT: String(e2ePort),
      HOST: '127.0.0.1',
      DATA_DIR: `./${dataDir}`,
      TAMARI_SECRET: 'e2e-test-secret',
      LOG_LEVEL: 'debug',
      DISABLE_CSRF: 'true',
      // Node only flushes V8 coverage on graceful exit — paired with the
      // SIGINT gracefulShutdown below. Path is relative to webServer cwd
      // (the repo root).
      ...(coverageEnabled ? { NODE_V8_COVERAGE: 'e2e/.coverage/node' } : {}),
    },
    // SIGTERM does not flush NODE_V8_COVERAGE; SIGINT does.
    ...(coverageEnabled ? { gracefulShutdown: { signal: 'SIGINT' as const, timeout: 10000 } } : {}),
  },
});
