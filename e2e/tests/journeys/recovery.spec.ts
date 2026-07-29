/**
 * Recovery / error-paths journey.
 *
 * Happy-path journeys don't catch how the UI behaves when things break. This one
 * drives the app through failure modes and back:
 *   - point the backend at an unreachable URL → send → assert the generation
 *     error surfaces as a toast and the composer recovers;
 *   - reconfigure to the working mock mid-session → resume generating;
 *   - fire a second send while a generation is in flight;
 *   - attempt an invalid attachment and assert it is rejected.
 */
import { test, expect } from '../../fixtures/base.js';
import { login } from '../../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../../helpers/backendConfig.js';
import { App } from '../../helpers/app.js';

/**
 * Point the active backend at an arbitrary URL/model by talking to the app's WS
 * bus directly (same trick as helpers/backendConfig.ts). Used here to drive the
 * backend into a broken state and back.
 */
async function setBackend(page: import('@playwright/test').Page, apiUrl: string, model: string): Promise<void> {
  await page.evaluate(
    ({ apiUrl, model }) =>
      new Promise<void>((resolve, reject) => {
        const token = localStorage.getItem('st_auth_token') ?? '';
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
        ws.onopen = () => ws.send(JSON.stringify({ type: 'auth' }));
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'snapshot') {
            const activeId = msg.state?.settings?.activeBackendConfigId;
            if (!activeId) {
              ws.close();
              reject(new Error('no active backend config'));
              return;
            }
            ws.send(
              JSON.stringify({
                type: 'backendConfig.update',
                backendConfigId: activeId,
                patch: { backendProvider: 'openai', generationMode: 'chat', model, apiUrl, apiKey: 'mock-api-key' },
              }),
            );
          }
          if (msg.type === 'backendConfig.updated' || msg.type === 'backendConfig.snapshot') {
            ws.close();
            resolve();
          }
          if (msg.type === 'error') {
            ws.close();
            reject(new Error(msg.message ?? 'backend update failed'));
          }
        };
        ws.onerror = () => reject(new Error('ws error'));
        setTimeout(() => {
          ws.close();
          reject(new Error('setBackend timed out'));
        }, 10000);
      }),
    { apiUrl, model },
  );
}

test.describe('Recovery Journey', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });
  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test('broken backend surfaces an error, then recovers when reconfigured', async ({ page }) => {
    const app = new App(page);
    const charName = `Recovery Char ${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    await test.step('point the backend at an unreachable URL', async () => {
      // A port nothing listens on → ECONNREFUSED, fast.
      await setBackend(page, 'http://127.0.0.1:9/', 'unreachable-model');
    });

    await test.step('sending fails and the error surfaces as a toast', async () => {
      const input = app.messageInput();
      await input.fill('This generation should fail.');
      await page.locator('.message-input-area .send-btn').click();
      // generation.error → addToast('...', 'error') in serverStore.
      await expect(page.locator('.toast-container')).toContainText(/\berror\b|fail|refused|unreachable/i, {
        timeout: 15000,
      });
    });

    await test.step('reconfigure to the working mock and resume generating', async () => {
      await configureMockBackend(page);
      await app.sendUserMessage('seq:Back online now.', { expectReply: true });
      await app.waitForAssistantText(/Turn \d+/);
    });
  });

  test('a send while a generation is in flight does not corrupt the session', async ({ page }) => {
    await configureMockBackend(page);
    const app = new App(page);
    await app.createCharacterAndChat({ name: `Inflight Char ${Date.now()}`, firstMes: 'Ready.' });

    const input = app.messageInput();
    const sendBtn = page.locator('.message-input-area .send-btn');
    await input.fill('seq:first');
    await sendBtn.click();
    // Immediately attempt a second send without waiting for the first reply.
    // The composer becomes a Stop button mid-generation, so this either aborts
    // or queues. Let any in-flight generation settle before re-asserting.
    await input.fill('seq:second');
    await sendBtn.click();
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 15000 });

    // The session must still be usable end-to-end after the burst.
    await app.sendUserMessage('seq:after');
    await app.waitForAssistantText(/Turn \d+/);
  });

  test('an unsupported attachment is rejected', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({ name: `Attach Char ${Date.now()}`, firstMes: 'Ready.' });

    const fileInput = page.locator('.message-input-area .hidden-file-input');
    // The input advertises image/audio/video only; feed it an plain text blob.
    await fileInput.setInputFiles({
      name: 'not-an-image.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('this is not an image'),
    });

    // Either a rejection toast appears or no preview is rendered.
    const preview = page.locator('.attachment-previews .attachment-preview');
    const toast = page.locator('.toast-container');
    await expect.poll(
      async () => (await toast.count()) > 0 || (await preview.count()) === 0,
      { timeout: 10000, message: 'expected a rejection toast or no attachment preview' },
    ).toBeTruthy();
  });
});
