import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { resetLlmRequests } from '../helpers/llm.js';
import { setSetting } from '../helpers/settings.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

test.describe('Stop Strings', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    // Persisted on the shared e2e server — clear or later specs inherit them.
    await setSetting(page, 'customStoppingStrings', []);
    await resetBackendConfig(page);
  });

  test('custom stopping strings cut the reply at the stop string', async ({ page }) => {
    const app = new App(page);
    await setSetting(page, 'customStoppingStrings', ['STOP']);
    await app.createCharacterAndChat({ name: uniqueName('Stop Char'), firstMes: 'Ready.' });

    // The mock honors the OpenAI `stop` param like a real backend: the reply
    // streams in full but is cut at the first stop-string occurrence.
    await app.sendUserMessage('respond: hello STOP world', { expectReply: true });
    expect((await app.lastAssistantText()).trim()).toBe('hello');
  });
});
