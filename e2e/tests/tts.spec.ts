import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { resetLlmRequests } from '../helpers/llm.js';
import { enableBuiltinToolset, deleteToolset } from '../helpers/tools.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';
import { App } from '../helpers/app.js';

const MOCK_URL = process.env.MOCK_LLM_URL ?? 'http://127.0.0.1:9876';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

test.describe('TTS (speak tool)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test('speak tool generates audio via the configured provider and renders it inline', async ({ page }) => {
    const app = new App(page);
    const toolsetId = await enableBuiltinToolset(page, 'speak', {
      provider: 'kokoro',
      baseUrl: MOCK_URL,
      apiKey: 'mock-api-key',
    });
    try {
      await app.createCharacterAndChat({ name: uniqueName('TTS Char'), firstMes: 'Ready.' });

      // The mock "model" emits a speak tool call with these args; the server
      // runs the Kokoro adapter against the mock /audio/speech endpoint.
      await app.sendUserMessage('tool:speak {"text":"hello out there"}', { expectReply: true });

      const bubble = app.lastBubble('assistant');
      await expect(bubble.locator('.tool-call-block').first()).toBeVisible({ timeout: 10000 });
      await expect(bubble.locator('.tool-result-block').first()).toBeVisible({ timeout: 10000 });
      // The generated WAV is saved as an attachment and rendered inline.
      await expect(page.locator('audio, .message-inline-audio').first()).toBeVisible({ timeout: 10000 });
      await expectNoAxeViolations(page);
    } finally {
      await deleteToolset(page, toolsetId);
    }
  });
});
