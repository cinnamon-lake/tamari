import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { App } from '../helpers/app.js';
import { getLastLlmRequest, resetLlmRequests } from '../helpers/llm.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

/** Flatten the captured request's messages into one string (mock returns OpenAI-shaped bodies). */
function promptText(req: Awaited<ReturnType<typeof getLastLlmRequest>>): string {
  const body = req.body as { messages?: Array<{ content?: unknown }> };
  return (body.messages ?? [])
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

test.describe('chatHistory marker position', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  // The jailbreak slot is ordered after the Chat History marker in the default
  // prompt list — before the renderer fix it silently rendered BEFORE the
  // history. This spec proves the position in a real request body.
  test('post-history instructions render after the chat history', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({
      name: uniqueName('JB Char'),
      firstMes: 'FIRST_MES_TOKEN',
      postHistoryInstructions: 'JB_ORDER_TOKEN',
    });

    await app.sendUserMessage('USER_TURN_TOKEN', { expectReply: true });

    const text = promptText(await getLastLlmRequest());
    const jbIdx = text.indexOf('JB_ORDER_TOKEN');
    expect(jbIdx).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('FIRST_MES_TOKEN')).toBeGreaterThanOrEqual(0);
    expect(jbIdx).toBeGreaterThan(text.indexOf('FIRST_MES_TOKEN'));
    expect(jbIdx).toBeGreaterThan(text.indexOf('USER_TURN_TOKEN'));
  });
});
