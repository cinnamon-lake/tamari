# tamari E2E Tests

This directory contains two kinds of end-to-end tests:

1. **Browser E2E tests** (`tests/*.spec.ts`) — Full-stack tests using [Playwright](https://playwright.dev/) that run a real browser against a real server.
2. **Server E2E tests** (`tests/server/*.test.ts`) — Bus-level integration tests that exercise the full server stack (WebSocket, dispatcher, repositories) without a browser. These run via Vitest in the server workspace.

## Browser E2E Tests (Playwright)

### Quick Start

```bash
# Install Playwright browsers (one-time)
npm run install:browsers --workspace=e2e

# Build first — the webServer runs the *built* server (server/dist/main.js)
npm run build

# Run browser e2e tests (headless; smoke + journeys)
npm run test:e2e

# Run only the fast smoke specs, or only the long serial journeys
npm run test:e2e:smoke
npm run test:e2e:journeys

# Run with UI mode for debugging
npm run test:e2e:ui
```

### Running against the Docker image

The suite can target the production Docker image instead of the repo build —
the exact artifact users deploy (alpine/musl, so this is also the sharp/native-
module verification). Playwright and the mock LLM stay on the host; the app
runs in a container with host networking so `localhost:<MOCK_LLM_PORT>`
resolves identically inside and outside:

```bash
docker build -t tamari-e2e .
docker run -d --rm --name tamari-e2e --network host \
  -e PORT=8766 -e HOST=127.0.0.1 -e TAMARI_SECRET=e2e-test-secret \
  -e LOG_LEVEL=debug -e DISABLE_CSRF=true tamari-e2e
cd e2e && E2E_PORT=8766 E2E_SKIP_STALE_CHECK=1 \
  npx playwright test --config=playwright.docker.config.ts
docker stop tamari-e2e
```

`playwright.docker.config.ts` is the stock config minus `webServer`;
`E2E_SKIP_STALE_CHECK=1` because the dist under test lives inside the image,
not in the checkout.


### Architecture

- **`fixtures/server.ts`** — Starts/stops a real server with an isolated SQLite database.
- **`fixtures/mockBackend.ts`** — Mocks LLM API responses so tests don't need API keys.
- **`fixtures/mockLlmServer.ts`** — Deterministic mock OpenAI-compatible LLM (started in `global-setup.ts`). Endpoints: `GET /models`, `POST /chat/completions`, `POST /completions` (text mode), plus test-inspection endpoints `GET /last-request` and `POST /__reset-requests`. Response selectors: `respond:`/`seq:` user-message prefixes, `[WI]`/`[AN]` injectable-token echo, tool-call and reasoning modes, and OpenAI `stop` param handling.
- **`helpers/auth.ts`** — Reusable auth flows (login, assert logged in).
- **`tests/*.spec.ts`** — Fast, isolated per-feature specs (the `chromium-smoke` project).
- **`tests/journeys/*.spec.ts`** — Long, serial, realistic user journeys (the `chromium-journeys` project, 240s per-test timeout).

### How it works

1. `playwright.config.ts` starts the **built** server before tests (`node server/dist/main.js`) — it does not build it, so run `npm run build` first.
2. Each test run uses `DATA_DIR=./server/.test-data` (wiped and recreated on every run) so your real data is untouched.
3. The auth secret is fixed to `e2e-test-secret` for predictability.
4. Tests run against Chromium by default (configurable in `playwright.config.ts`).

### Adding test IDs

Use `data-testid` attributes for stable selectors:

```tsx
<button data-testid="char-save-btn">Save</button>
```

Then target them in tests:

```ts
await page.locator('[data-testid="char-save-btn"]').click();
```

## Server E2E Tests (Vitest)

These tests live in `tests/server/` but run via the **server workspace's** Vitest config because they deeply import server internals (repositories, services, bus, dispatcher).

```bash
# Run all server tests (unit + e2e)
npm run test --workspace=server
```

### Architecture

- **`tests/server/e2e-*.test.ts`** — Bus-level integration tests using `TestHarness`.
- **Server-side `TestHarness`** — Spins up a real EventBus, real repositories (in-memory SQLite), and a real dispatcher. Located at `server/src/testing/TestHarness.ts`.

## CI

Both kinds of E2E tests run in GitHub Actions. See `.github/workflows/ci.yml`:

- Server E2E tests run as part of the `lint-and-test` job (via `npm run test --workspace=server`).
- Browser E2E tests run in the dedicated `e2e` job: `npm run test:e2e:smoke` on every PR/push, plus the full suite (`npm run test:e2e`, smoke + journeys) on push to main.
