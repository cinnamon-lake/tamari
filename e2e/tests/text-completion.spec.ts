import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, patchActiveBackendConfig, resetBackendConfig } from '../helpers/backendConfig.js';
import { getLastLlmRequest, resetLlmRequests } from '../helpers/llm.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

test.describe('Text Completion Mode', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test('text mode sends a flat instruct prompt to /completions and renders the reply', async ({ page }) => {
    const app = new App(page);
    await patchActiveBackendConfig(page, { generationMode: 'text' });
    await app.createCharacterAndChat({ name: uniqueName('TC Char'), firstMes: 'Ready.' });

    await app.sendUserMessage('respond: flat prompt works', { expectReply: true });
    expect(await app.lastAssistantText()).toBe('flat prompt works');

    // The captured request is a single flat prompt string — not a messages array.
    const captured = await getLastLlmRequest();
    const body = captured.body as Record<string, unknown>;
    expect(typeof body.prompt).toBe('string');
    expect(body.messages).toBeUndefined();
    expect(body.prompt as string).toContain('respond: flat prompt works');
  });
});
