/**
 * Smoke fixture — the standard wiring for isolated e2e/tests/*.spec.ts files.
 *
 * `smokeTest` is the base test extended with an `app` fixture that, per test:
 *   1. logs in (`login(page)`),
 *   2. points the active backend at the deterministic mock LLM started in
 *      global-setup (`configureMockBackend(page)`),
 *   3. hands the test an `App` (helpers/app.ts flow vocabulary) bound to the
 *      page, and
 *   4. after the test — and after any `afterEach` hooks — resets the active
 *      backend config (`resetBackendConfig(page)`) so other specs never see
 *      the mock URL.
 *
 * The wiring is shared with journeyTest via `appWiring` below — same login →
 * mock backend → App → reset core, different intent (journeys are long,
 * realistic flows; smokes are isolated single-feature checks).
 *
 * ── MIGRATING A SPEC (mechanical) ──────────────────────────────────────────
 *
 * 1. Replace the base import:
 *      `import { test, expect } from '../fixtures/base.js'`
 *    with:
 *      `import { smokeTest as test, expect } from '../fixtures/smoke.js'`
 *    Keep importing Page/Locator types from base.js when the file uses them.
 *
 * 2. Delete the hand-rolled wiring:
 *      `test.beforeEach(...)` blocks containing only `login(page)` and/or
 *      `configureMockBackend(page)`, and `resetBackendConfig(page)` lines in
 *      `test.afterEach(...)`. Drop the now-unused auth.js / backendConfig.js
 *      imports (and App import if step 3 removes its last use).
 *
 * 3. In every test add `app` to the destructured fixtures
 *    (`async ({ page, app }) => …`) and delete `const app = new App(page)`.
 *    The wiring only runs for tests that request `app` — a test that never
 *    calls App methods but still needs login + mock backend must destructure
 *    it as `{ app: _app }` (the `_` prefix satisfies no-unused-vars).
 *
 * 4. Extra beforeEach/afterEach steps stay as hooks minus the three lines
 *    from step 2. Fixture teardown runs AFTER afterEach hooks, so an
 *    afterEach that restores settings still runs before resetBackendConfig —
 *    the original ordering is preserved.
 *
 * 5. ORDERING PITFALL: fixtures are lazy — a beforeEach hook that only
 *    destructures `{ page }` runs BEFORE the `app` fixture's login +
 *    configureMockBackend. Extra steps that must run after the mock backend
 *    is configured (e.g. patchActiveBackendConfig switching the provider, as
 *    the backend-*.spec.ts files do) need the hook to request `app` too:
 *      `test.beforeEach(async ({ app: _app, page }) => { … })`.
 *    Order-independent extras (e.g. resetLlmRequests() — no page, no backend
 *    dependency) can stay in a plain `test.beforeEach(async () => …)`.
 *
 * 6. Leave `test.describe.configure({ mode: 'serial' })` and
 *    `test.setTimeout(...)` untouched — both are orthogonal to the wiring.
 *
 * Do NOT migrate with this fixture: journey specs (use journeyTest),
 * login-only specs that never generate (e.g. chat.spec.ts's first tests,
 * settings.spec.ts — keep their login-only beforeEach on the base test), and
 * specs that configure real-ish adapters against the mock LLM on purpose in
 * ways beyond a provider patch.
 */
import { test as base, expect } from './base.js';
import type { Page } from './base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { App } from '../helpers/app.js';

/**
 * Shared core of smokeTest and journeyTest: login → mock backend → App →
 * reset on teardown. Exported so journey.ts can build its fixture on the same
 * wiring instead of duplicating it.
 */
export async function appWiring({ page }: { page: Page }, use: (app: App) => Promise<void>): Promise<void> {
  await login(page);
  await configureMockBackend(page);
  const app = new App(page);
  await use(app);
  await resetBackendConfig(page);
}

export const smokeTest = base.extend<{ app: App }>({
  app: appWiring,
});

export { expect };
