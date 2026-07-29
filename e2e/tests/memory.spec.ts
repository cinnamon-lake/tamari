import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { getLastLlmRequest, resetLlmRequests } from '../helpers/llm.js';
import { getActiveBackendConfigId, setSetting } from '../helpers/settings.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

test.describe('Rolling Memory', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    // Memory is a persisted setting on the shared e2e server — disable it or
    // later specs start summarizing unexpectedly.
    await setSetting(page, 'memory', { enabled: false });
    await resetBackendConfig(page);
  });

  test('a rolling summary is injected into the prompt after enough turns', async ({ page }) => {
    const app = new App(page);
    const backendConfigId = await getActiveBackendConfigId(page);
    await setSetting(page, 'memory', { enabled: true, updateInterval: 2, depth: 1, backendConfigId });
    await app.createCharacterAndChat({ name: uniqueName('Mem Char'), firstMes: 'Ready.' });

    await app.sendUserMessage('seq: first', { expectReply: true });
    await app.sendUserMessage('seq: second', { expectReply: true });

    // The empty generation target counts toward `depth`, so the first summary
    // can trigger as early as turn 2. Send a third turn and poll the mock
    // capture until a request carries the injected memory summary.
    await app.sendUserMessage('seq: third', { expectReply: true });
    await expect
      .poll(
        async () => {
          const cap = await getLastLlmRequest();
          const body = cap.body as Record<string, unknown>;
          const messages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
          // The mock's default text is what the summarization call returned —
          // a system-role memory summary carrying it proves the full round trip.
          return messages.some(
            (m) => m.role === 'system' && String(m.content ?? '').includes('deterministic mock response'),
          );
        },
        { timeout: 15000, message: 'memory summary injected into prompt' },
      )
      .toBe(true);
  });
});
