import { test, expect, type Page } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, patchActiveBackendConfig, resetBackendConfig } from '../helpers/backendConfig.js';
import { getLastLlmRequest, resetLlmRequests } from '../helpers/llm.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

const MES_EXAMPLE = '<START>\n{{user}}: Example question\n{{char}}: Example answer EXTOK1';

/**
 * Patch a character over the WS bus (same mechanism greeting-swipes uses for
 * alternate greetings): the editor's Message Example textarea is one more
 * fragile index in the modal, and the server-side field is what the prompt
 * pipeline actually reads.
 */
async function patchCharacter(page: Page, name: string, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    ({ name, patch }) =>
      new Promise<void>((resolve, reject) => {
        const token = localStorage.getItem('st_auth_token') ?? '';
        const ws = new WebSocket(`ws://${window.location.host}/ws?token=${encodeURIComponent(token)}`);
        ws.onopen = () => ws.send(JSON.stringify({ type: 'auth' }));
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.type === 'snapshot') {
            const char = (msg.state?.characters ?? []).find((c: { name: string }) => c.name === name);
            if (!char) { ws.close(); reject(new Error('character not found')); return; }
            ws.send(JSON.stringify({ type: 'character.update', characterId: char.id, patch }));
          }
          if (msg.type === 'character.updated') { ws.close(); resolve(); }
          if (msg.type === 'error') { ws.close(); reject(new Error(msg.message)); }
        };
        setTimeout(() => { ws.close(); reject(new Error('patchCharacter timeout')); }, 10000);
      }),
    { name, patch },
  );
}

test.describe('Example Dialogue (mesExample)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test('chat mode: <START> blocks become user/assistant messages before the real history', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('Example Char');
    await app.createCharacter({ name: charName, description: 'An example-driven bot.', firstMes: 'Ready.' });
    await patchCharacter(page, charName, { mesExample: MES_EXAMPLE });
    await app.startChat(charName);

    await app.sendUserMessage('hello', { expectReply: true });
    const captured = await getLastLlmRequest();
    const body = captured.body as Record<string, unknown>;
    const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];

    // The parsed example block shows up as real conversation turns.
    const exUserIdx = messages.findIndex((m) => m.role === 'user' && m.content === 'Example question');
    const exCharIdx = messages.findIndex((m) => m.role === 'assistant' && String(m.content ?? '').includes('EXTOK1'));
    expect(exUserIdx).toBeGreaterThanOrEqual(0);
    expect(exCharIdx).toBeGreaterThan(exUserIdx);

    // …and they precede the actual chat history (greeting + our message).
    const realUserIdx = messages.findIndex((m) => m.role === 'user' && String(m.content ?? '').includes('hello'));
    expect(realUserIdx).toBeGreaterThan(exCharIdx);
  });

  test('text mode: example dialogue lands in the flat prompt string', async ({ page }) => {
    const app = new App(page);
    await patchActiveBackendConfig(page, { generationMode: 'text' });
    const charName = uniqueName('Example Text Char');
    await app.createCharacter({ name: charName, description: 'An example-driven bot.', firstMes: 'Ready.' });
    await patchCharacter(page, charName, { mesExample: MES_EXAMPLE });
    await app.startChat(charName);

    await app.sendUserMessage('hello', { expectReply: true });
    const captured = await getLastLlmRequest();
    const body = captured.body as Record<string, unknown>;
    expect(typeof body.prompt).toBe('string');
    const prompt = body.prompt as string;
    expect(prompt).toContain('Example question');
    expect(prompt).toContain('EXTOK1');
    // The example precedes the real user turn in the flat prompt too.
    expect(prompt.indexOf('Example question')).toBeLessThan(prompt.indexOf('hello'));
  });
});
