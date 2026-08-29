import { smokeTest as test, expect } from '../fixtures/smoke.js';
import { getLastLlmRequest, resetLlmRequests, waitForNextLlmRequest } from '../helpers/llm.js';
import { uniqueName } from '../helpers/names.js';

function promptText(captured: { body: unknown }): string {
  const body = captured.body as Record<string, unknown>;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.map((m: Record<string, unknown>) => String(m.content ?? '')).join('\n');
}

test.describe('Macro Resolution', () => {
  test.beforeEach(async () => {
    await resetLlmRequests();
  });

  test('{{char}} and {{user}} resolve to real names in the prompt', async ({ app }) => {
    const charName = uniqueName('Macro Char');
    await app.createCharacterAndChat({
      name: charName,
      description: 'You are {{char}} speaking with {{user}}.',
      firstMes: 'Ready.',
    });

    await app.sendUserMessage('hello', { expectReply: true });
    const all = promptText(await getLastLlmRequest());
    expect(all).toContain(`You are ${charName} speaking with`);
    expect(all).not.toContain('{{char}}');
    expect(all).not.toContain('{{user}}');
  });

  test('{{setvar}} in one turn feeds {{getvar}} in the next', async ({ app }) => {
    await app.createCharacterAndChat({
      name: uniqueName('Var Char'),
      description: 'The user feels {{getvar::mood}}.',
      firstMes: 'Ready.',
    });

    // Turn 1 plants the variable (setvar resolves to empty text — the bubble
    // renders just 'hello', so the assertion uses the resolved form).
    await app.sendUserMessage('{{setvar::mood::ecstatic}} hello', { expectReply: true, userText: 'hello' });

    // Turn 2's prompt is built from the accumulated message variables.
    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('how do I seem?', { expectReply: true });
    const all = promptText(await waitForNextLlmRequest(before));
    expect(all).toContain('The user feels ecstatic.');
    expect(all).not.toContain('{{getvar');
  });

  test('{{roll:2d6}} resolves to a number, not the macro text', async ({ app }) => {
    await app.createCharacterAndChat({
      name: uniqueName('Dice Char'),
      description: 'Roll: {{roll::2d6}}',
      firstMes: 'Ready.',
    });

    await app.sendUserMessage('hello', { expectReply: true });
    const all = promptText(await getLastLlmRequest());
    expect(all).not.toContain('{{roll');
    const match = /Roll: (\d+)/.exec(all);
    expect(match).not.toBeNull();
    const value = Number(match![1]);
    expect(value).toBeGreaterThanOrEqual(2);
    expect(value).toBeLessThanOrEqual(12);
  });
});
