import base from './playwright.config.js';

/**
 * Docker variant of the E2E config: Playwright does NOT launch its own
 * webServer — the suite runs against the production Docker image (the same
 * artifact users deploy, alpine/musl and all), started separately, e.g.:
 *
 *   docker build -t tamari-e2e .
 *   docker run -d --rm --name tamari-e2e --network host \
 *     -e PORT=8766 -e HOST=127.0.0.1 -e TAMARI_SECRET=e2e-test-secret \
 *     -e LOG_LEVEL=debug -e DISABLE_CSRF=true tamari-e2e
 *   cd e2e && E2E_PORT=8766 E2E_SKIP_STALE_CHECK=1 \
 *     npx playwright test --config=playwright.docker.config.ts
 *
 * --network host is required: specs configure the app's backend as
 * http://localhost:<MOCK_LLM_PORT>, and the container must resolve that to
 * the host's mock LLM. The stale-dist guard is bypassed because the dist
 * under test lives inside the image, not in the repo checkout.
 */
export default {
  ...base,
  webServer: undefined,
};
