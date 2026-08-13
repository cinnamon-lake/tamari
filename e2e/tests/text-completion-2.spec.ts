import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, patchActiveBackendConfig, resetBackendConfig } from '../helpers/backendConfig.js';
import { getLastLlmRequest, resetLlmRequests, waitForNextLlmRequest } from '../helpers/llm.js';
import { setSetting } from '../helpers/settings.js';
import { App } from '../helpers/app.js';

/** The e2e webServer pins TAMARI_SECRET to this value (playwright.config.ts). */
const AUTH = { Authorization: 'Bearer e2e-test-secret' };

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

// A custom instruct template with distinctive markers, injected via the
// `instructTemplates` setting and selected by id on the backend config. The
// user/assistant prefixes end with a newline so the wrapped turn content sits
// on its own line — the mock's flat-prompt selector scan matches lines.
const MARKER_TEMPLATE_ID = 'e2e-tc2-markers';
const MARKER_TEMPLATE = {
  id: MARKER_TEMPLATE_ID,
  name: 'E2E TC2 Markers',
  bos: '<BOS>',
  eos: '<EOS>',
  separator: '\n',
  systemPrefix: '<SYS>',
  systemSuffix: '</SYS>',
  userPrefix: '<USR>\n',
  userSuffix: '\n</USR>',
  assistantPrefix: '<AST>\n',
  assistantSuffix: '\n</AST>',
  responsePrefix: '<RSP>',
};

// Adapter-side text formatting (backends/formatTextPrompt.ts) +
// TextCompletionBackendAdapter edge paths.
//
// Deliberately NOT covered here (uncoverable without mock-server changes):
// usage capture from the final stream chunk (adapter ~106-109) — the mock's
// /completions chunks never carry a `usage` field.
test.describe('Text Completion Mode — renderer and adapter edges', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await patchActiveBackendConfig(page, { generationMode: 'text' });
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    await setSetting(page, 'instructTemplates', []);
    await resetBackendConfig(page);
    await patchActiveBackendConfig(page, { instructTemplate: '' });
  });

  test('custom instruct template markers wrap the flat prompt (bos/eos/responsePrefix)', async ({ page }) => {
    const app = new App(page);
    await setSetting(page, 'instructTemplates', [MARKER_TEMPLATE]);
    await patchActiveBackendConfig(page, { instructTemplate: MARKER_TEMPLATE_ID });
    await app.createCharacterAndChat({ name: uniqueName('TC2 Markers'), firstMes: 'Marker greeting.' });

    await app.sendUserMessage('respond: marker reply', { expectReply: true });
    expect(await app.lastAssistantText()).toBe('marker reply');

    const captured = await getLastLlmRequest();
    const prompt = String((captured.body as Record<string, unknown>).prompt);

    // bos leads the prompt; responsePrefix + eos close it (no prefill yet).
    expect(prompt.startsWith('<BOS>')).toBe(true);
    expect(prompt.endsWith('<RSP>\n<EOS>')).toBe(true);
    // Role wraps land around the greeting and the user turn.
    expect(prompt).toContain('<AST>\nMarker greeting.\n</AST>');
    expect(prompt).toContain('<USR>\nrespond: marker reply\n</USR>');
  });

  test('continue in text mode sends the prior reply as raw prefill', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({ name: uniqueName('TC2 Prefill'), firstMes: 'Ready.' });

    // Default template ('none'): no bos/eos/responsePrefix, so the prompt ends
    // exactly with the extracted prefill.
    await app.sendUserMessage('seq: turn', { expectReply: true });
    const priorText = await app.lastAssistantText();
    expect(priorText).toMatch(/^Turn \d+$/);

    const before = (await getLastLlmRequest()).count;
    await app.clickMessageAction(app.lastBubble('assistant'), 'Continue');
    // The continue streams onto the SAME message — wait for the text to grow.
    await expect
      .poll(async () => (await app.lastAssistantText()).length, { timeout: 15000 })
      .toBeGreaterThan(priorText.length);
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 15000 });

    const captured = await waitForNextLlmRequest(before);
    const prompt = String((captured.body as Record<string, unknown>).prompt);
    // The prior assistant turn was popped out of the history and appended raw
    // at the very end as a prefill — not wrapped, not a new user turn.
    expect(prompt.endsWith(priorText)).toBe(true);
  });

  test('maps a length finish reason in text mode', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({ name: uniqueName('TC2 Length'), firstMes: 'Ready.' });

    await app.sendUserMessage('length:partial text', { expectReply: true });
    await app.waitForAssistantText('partial text');

    const bubble = app.lastBubble('assistant');
    await expect(bubble.locator('button[title="Continue"]')).toHaveCount(1);
  });

  test('lists models in text mode (TextCompletion listModels)', async ({ request }) => {
    const res = await request.get('/api/models', { headers: AUTH });
    expect(res.ok()).toBe(true);
    const data = (await res.json()) as { items: Array<{ id: string; name: string }> };
    expect(data.items.some((m) => m.id === 'mock-model')).toBe(true);
  });
});
