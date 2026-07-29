import { test, expect, type Page } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, patchActiveBackendConfig, resetBackendConfig } from '../helpers/backendConfig.js';
import { enableBuiltinToolset, deleteToolset } from '../helpers/tools.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

/** Mock LLM origin (host:port) as it appears in dry-run request URLs. */
const MOCK_ORIGIN = (process.env.MOCK_LLM_URL ?? 'http://127.0.0.1:9876').replace(/^https?:\/\//, '');

/**
 * Read the active backend config id from the app's WS snapshot, so scripted
 * `tool:` calls can address it as /backends/<id>.json — the workbench has no
 * backend collection listing, and the mock's tool sequences can't interpolate
 * prior tool results, so the id has to exist before the message is sent.
 */
async function activeBackendConfigId(page: Page): Promise<string> {
  return await page.evaluate(() => {
    return new Promise<string>((resolve, reject) => {
      const token = localStorage.getItem('st_auth_token') ?? '';
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'auth' }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'snapshot') {
            const activeId = msg.state?.settings?.activeBackendConfigId;
            ws.close();
            if (!activeId) {
              reject(new Error('No active backend config in snapshot'));
              return;
            }
            resolve(activeId as string);
          }
          if (msg.type === 'error') {
            ws.close();
            reject(new Error(msg.message ?? 'WS snapshot failed'));
          }
        } catch (err) {
          reject(err);
        }
      };

      ws.onerror = (err) => {
        reject(new Error(`WebSocket error: ${err.type}`));
      };

      setTimeout(() => {
        ws.close();
        reject(new Error('activeBackendConfigId timed out'));
      }, 10000);
    });
  });
}

test.describe('Backend Workbench Tools', () => {
  let toolsetId: string | undefined;

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
  });

  test.afterEach(async ({ page }) => {
    // Clear any requestScript the model "wrote" during the test, then reset.
    await patchActiveBackendConfig(page, { providerParams: {} });
    await resetBackendConfig(page);
    if (toolsetId) {
      await deleteToolset(page, toolsetId);
      toolsetId = undefined;
    }
  });

  test('reading /backends/<id>.json returns the active config with the api key redacted', async ({ page }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'workbench');

    await app.createCharacterAndChat({
      name: uniqueName('BW Host'),
      firstMes: 'Ready.',
    });

    const configId = await activeBackendConfigId(page);
    await app.sendUserMessage(`tool:read${JSON.stringify({ path: `/backends/${configId}.json` })}`, {
      expectReply: true,
    });

    const result = app.lastBubble('assistant').locator('.tool-result-block').last();
    await expect(result).toBeVisible({ timeout: 10000 });
    await expect(result).toContainText('"hasApiKey": true');
    await expect(result).toContainText('"model": "mock-model"');
    // The actual key must never reach the model's context.
    await expect(result).not.toContainText('mock-api-key');
  });

  test('write + test_backend dry: script mutates the real adapter request', async ({ page }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'workbench');

    await app.createCharacterAndChat({
      name: uniqueName('BW Host'),
      firstMes: 'Ready.',
    });

    // The mock walks the tool sequence: first the write persists a request
    // script, then test_backend dry-runs it against the exact request the
    // OpenAI adapter would send to the (loopback) mock backend.
    const configId = await activeBackendConfigId(page);
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: `/backends/${configId}.json`,
        content: JSON.stringify({ providerParams: { requestScript: 'request.body.temperature = 0.5' } }),
      })},run${JSON.stringify({ verb: 'test_backend', args: { mode: 'dry' } })}`,
      { expectReply: true, userText: 'write' },
    );

    const results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(2, { timeout: 15000 });

    // Update result: providerParams merge preserved the connection fields.
    await expect(results.first()).toContainText('"model": "mock-model"');
    await expect(results.first()).toContainText('requestScript');

    // Dry result: before/after pair, script mutation visible, loopback URL shown.
    const dry = results.last();
    await expect(dry).toContainText('"before"');
    await expect(dry).toContainText('"after"');
    await expect(dry).toContainText(MOCK_ORIGIN);
    await expect(dry).toContainText('0.5');
    // Auth headers / keys are scrubbed from both views.
    await expect(dry).not.toContainText('mock-api-key');
    await expect(dry).not.toContainText('authorization');
  });

  test('test_backend live fires a real request and reports ok', async ({ page }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'workbench');

    await app.createCharacterAndChat({
      name: uniqueName('BW Host'),
      firstMes: 'Ready.',
    });

    await app.sendUserMessage(`tool:run${JSON.stringify({ verb: 'test_backend', args: { mode: 'live' } })}`, {
      expectReply: true,
    });

    const result = app.lastBubble('assistant').locator('.tool-result-block').last();
    await expect(result).toBeVisible({ timeout: 15000 });
    await expect(result).toContainText('"ok":true');
    await expect(result).not.toContainText('mock-api-key');
  });
});
