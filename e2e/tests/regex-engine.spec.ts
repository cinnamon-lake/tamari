import { smokeTest as test, expect } from '../fixtures/smoke.js';
import { getLastLlmRequest, resetLlmRequests, waitForNextLlmRequest } from '../helpers/llm.js';
import { setSetting } from '../helpers/settings.js';
import { uniqueName } from '../helpers/names.js';

function promptText(captured: { body: unknown }): string {
  const body = captured.body as Record<string, unknown>;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.map((m: Record<string, unknown>) => String(m.content ?? '')).join('\n');
}

test.describe('Regex Engine', () => {
  test.beforeEach(async () => {
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    // Rules persist on the shared e2e server — clear them or later specs see them.
    await setSetting(page, 'regexRules', []);
  });

  test('display rule rewrites the rendered reply but not the stored text', async ({ page, app }) => {
    await setSetting(page, 'regexRules', [
      {
        id: 'r-cat-dog',
        name: 'cat to dog',
        findRegex: '/cat/',
        replaceString: 'dog',
        disabled: false,
        userInput: false,
        aiOutput: true,
        prompt: false,
        display: true,
      },
    ]);
    await app.createCharacterAndChat({ name: uniqueName('Regex Char'), firstMes: 'Ready.' });

    await app.sendUserMessage('respond: I have a cat', { expectReply: true });
    expect(await app.lastAssistantText()).toBe('I have a dog');

    // Storage is untouched: the next prompt still carries the original text.
    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('again', { expectReply: true });
    const all = promptText(await waitForNextLlmRequest(before));
    expect(all).toContain('I have a cat');
  });

  test('prompt-placement rule rewrites the outgoing prompt', async ({ page, app }) => {
    await setSetting(page, 'regexRules', [
      {
        id: 'r-alpha-beta',
        name: 'alpha to beta',
        findRegex: '/alpha/',
        replaceString: 'beta',
        disabled: false,
        userInput: false,
        aiOutput: false,
        prompt: true,
        display: false,
      },
    ]);
    await app.createCharacterAndChat({ name: uniqueName('Regex Char'), firstMes: 'Ready.' });

    await app.sendUserMessage('alpha', { expectReply: true });
    const all = promptText(await getLastLlmRequest());
    expect(all).toContain('beta');
    expect(all).not.toContain('alpha');
  });
});
