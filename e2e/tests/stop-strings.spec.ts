import { smokeTest as test, expect } from '../fixtures/smoke.js';
import { resetLlmRequests } from '../helpers/llm.js';
import { setSetting } from '../helpers/settings.js';
import { uniqueName } from '../helpers/names.js';

test.describe('Stop Strings', () => {
  test.beforeEach(async () => {
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    // Persisted on the shared e2e server — clear or later specs inherit them.
    await setSetting(page, 'customStoppingStrings', []);
  });

  test('custom stopping strings cut the reply at the stop string', async ({ page, app }) => {
    await setSetting(page, 'customStoppingStrings', ['STOP']);
    await app.createCharacterAndChat({ name: uniqueName('Stop Char'), firstMes: 'Ready.' });

    // The mock honors the OpenAI `stop` param like a real backend: the reply
    // streams in full but is cut at the first stop-string occurrence.
    await app.sendUserMessage('respond: hello STOP world', { expectReply: true });
    expect((await app.lastAssistantText()).trim()).toBe('hello');
  });
});
