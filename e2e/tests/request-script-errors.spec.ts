/**
 * Request-script (Lua) error-path coverage for
 * server/src/backends/executeRequest.ts + RequestScript.ts + RequestLogger.ts.
 *
 * The hook: providerParams.requestScript flows top-level through
 * buildBackendSettings (factory reads settings['requestScript']) into the
 * adapter config, and executeRequest runs applyRequestScript before fetch.
 * The script gets a `request` table with url/method/headers/body (Lua via
 * wasmoon). Failures map to a GenerationResult error which GenerationService
 * broadcasts as generation.error → the client shows an error toast
 * (serverStore bus.on('generation.error') → addToast).
 *
 * Cases:
 *   1. Lua error("boom")        → 'Request script error: boom'
 *   2. loopback URL → mock 404  → 'HTTP 404: Not found' (also exercises
 *                                 RequestLogger.scrubText on a non-JSON error body)
 *   3. private IP               → SSRF block
 *   4. file: protocol           → protocol block
 *   5. unresolvable host        → DNS-failure block
 *   6. header mutation succeeds → generation works, header lands on the wire
 */
import { test, expect } from '../fixtures/base.js';
import type { Page } from '@playwright/test';
import { login } from '../helpers/auth.js';
import { configureMockBackend, patchActiveBackendConfig, resetBackendConfig } from '../helpers/backendConfig.js';
import { getLastLlmRequest, resetLlmRequests, waitForNextLlmRequest } from '../helpers/llm.js';
import { App } from '../helpers/app.js';

const MOCK_URL = process.env.MOCK_LLM_URL ?? 'http://127.0.0.1:9876';

/**
 * Install (or clear) the request script. providerParams REPLACES the whole
 * blob server-side, so `{ requestScript }` sets it and `{}` clears it.
 */
async function setRequestScript(page: Page, script: string | null): Promise<void> {
  await patchActiveBackendConfig(page, {
    providerParams: script === null ? {} : { requestScript: script },
  });
}

/** Send a message expected to fail, then assert the generation error toast. */
async function expectGenerationError(app: App, text: string, match: RegExp | string, timeout = 20000): Promise<void> {
  await app.sendUserMessage(text);
  await expect(app.page.locator('.toast-container')).toContainText(match, { timeout });
}

test.describe('Request script error paths', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    // Never leak a script (or a wiped blob) into the next spec.
    await setRequestScript(page, null);
    await resetBackendConfig(page);
  });

  test('lua error("boom") surfaces as a Request script error toast', async ({ page }) => {
    const app = new App(page);
    const charName = `RS Boom ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    await setRequestScript(page, 'error("boom")');
    await expectGenerationError(app, 'trigger a script failure', /Request script error:.*boom/);
  });

  test('script redirect to a loopback 404 surfaces the HTTP error', async ({ page }) => {
    const app = new App(page);
    const charName = `RS NotFound ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    // Loopback redirect is allowed because the configured backend itself is
    // loopback; the mock answers /nope with 404 text/plain 'Not found'.
    await setRequestScript(page, `request.url = ${JSON.stringify(`${MOCK_URL}/nope`)}`);
    await expectGenerationError(app, 'trigger a 404', /HTTP 404: Not found/);
  });

  test('script redirect to a private IP is SSRF-blocked', async ({ page }) => {
    const app = new App(page);
    const charName = `RS Private ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    await setRequestScript(page, 'request.url = "http://192.168.1.1/x"');
    await expectGenerationError(
      app,
      'trigger a private-ip redirect',
      'SSRF blocked: cannot request private address 192.168.1.1',
    );
  });

  test('script redirect to a file: URL is protocol-blocked', async ({ page }) => {
    const app = new App(page);
    const charName = `RS File ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    await setRequestScript(page, 'request.url = "file:///etc/passwd"');
    await expectGenerationError(app, 'trigger a protocol block', 'SSRF blocked: unsupported protocol file:');
  });

  test('script redirect to an unresolvable host is DNS-blocked', async ({ page }) => {
    test.setTimeout(90000); // DNS lookup can take seconds to fail.
    const app = new App(page);
    const charName = `RS Dns ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    // .invalid is reserved (RFC 2606) — resolution must fail.
    await setRequestScript(page, 'request.url = "http://nonexistent.invalid/x"');
    await expectGenerationError(
      app,
      'trigger a dns failure',
      'SSRF blocked: cannot resolve nonexistent.invalid',
      60000,
    );
  });

  test('script header mutation lands on the outgoing request', async ({ page }) => {
    const app = new App(page);
    const charName = `RS Header ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    await setRequestScript(page, 'request.headers["X-Test"] = "yes"');

    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('respond: script ok', { expectReply: true });
    await app.waitForAssistantText('script ok');
    await waitForNextLlmRequest(before);

    const res = await fetch(`${MOCK_URL}/last-request?route=${encodeURIComponent('/chat/completions')}`);
    const route = (await res.json()) as { headers: Record<string, string> } | null;
    expect(route).not.toBeNull();
    expect(route!.headers['x-test']).toBe('yes');
  });
});
