import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { App } from '../helpers/app.js';
import { configureMockBackend, patchActiveBackendConfig, resetBackendConfig } from '../helpers/backendConfig.js';
import { setSetting } from '../helpers/settings.js';
import { getLastLlmRequest, waitForNextLlmRequest } from '../helpers/llm.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

// Covers ReasoningEngine (extractReasoning / reconstructWithReasoning) and the
// text-level think-tag parse — all of which only run in text-completion mode:
// the text adapters carry their instruct template's reasoning delimiters
// (`adapter.outputReasoning`), so the fallback parse at the message target (no
// native reasoning streamed -> parse text) cannot fire in chat mode.
//
// Template: 'deepseek-v4-pro-thinking' (built-in, see
// server/src/backends/InstructTemplate.ts) — reasoning pattern
// `(.*?<\/think>\s*)?(.*)`, prefix `<think>`, suffix `</think>`, separator ''.
//
// Selector note: the mock's /completions endpoint finds respond:/seq: by
// scanning prompt LINES (newest first) for the prefix at line start. The
// DeepSeek template glues `<｜User｜>` directly onto the turn and
// `<｜Assistant｜><think>` (responsePrefix) directly after it (separator ''),
// so every probe message puts `respond:` on its own line (leading sentence)
// and terminates that line with a trailing sentence — otherwise the reply
// text would absorb the glued-on response prefix.
test.describe('Reasoning — Text Completion Mode', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await patchActiveBackendConfig(page, {
      generationMode: 'text',
      instructTemplate: 'deepseek-v4-pro-thinking',
    });
  });

  test.afterEach(async ({ page }) => {
    await setSetting(page, 'reasoningAddToPrompts', false);
    await resetBackendConfig(page);
    await patchActiveBackendConfig(page, { instructTemplate: '' });
  });

  test('extracts a reasoning block from a text-mode reply via the instruct template', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({ name: uniqueName('RT Extract'), firstMes: 'Ready.' });

    // userText: the user's own bubble renders without the tags (DOMPurify
    // strips them at display time).
    await app.sendUserMessage(
      'What is the answer?\nrespond:<think>I pondered deeply</think>The answer is 42.\nEnd of turn.',
      { expectReply: true, userText: 'respond:I pondered deeplyThe answer is 42.' },
    );

    const bubble = app.lastBubble('assistant');
    // Reasoning was split out of the raw text into a details block; the
    // remaining markdown paragraph is exactly the visible content.
    const reasoningBlock = bubble.locator('.reasoning-block');
    await expect(reasoningBlock).toBeVisible({ timeout: 10000 });
    await expect(reasoningBlock).toContainText('I pondered deeply');
    await expect(bubble.locator('.message-content p')).toHaveText('The answer is 42.');
  });

  test('re-injects prior reasoning into the flat prompt when reasoningAddToPrompts is on', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({ name: uniqueName('RT Reconstruct'), firstMes: 'Ready.' });

    await app.sendUserMessage(
      'First question.\nrespond:<think>I pondered deeply</think>The answer is 42.\nEnd of turn.',
      { expectReply: true, userText: 'respond:I pondered deeplyThe answer is 42.' },
    );
    await expect(app.lastBubble('assistant').locator('.reasoning-block')).toContainText(
      'I pondered deeply',
      { timeout: 10000 },
    );

    // Control: with the setting off, the prior assistant turn in the flat
    // prompt carries only the visible content — no reconstructed think block.
    let before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('Control question.\nrespond:Control reply.\nEnd of control.', {
      expectReply: true,
      userText: 'respond:Control reply.',
    });
    let captured = await waitForNextLlmRequest(before);
    let prompt = String((captured.body as Record<string, unknown>).prompt);
    expect(prompt).toContain('<｜Assistant｜>The answer is 42.');
    expect(prompt).not.toContain('<｜Assistant｜><think>I pondered deeply</think>The answer is 42.');

    await setSetting(page, 'reasoningAddToPrompts', true);

    before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('Second question.\nrespond:The sequel is 43.\nEnd of second.', {
      expectReply: true,
      userText: 'respond:The sequel is 43.',
    });
    captured = await waitForNextLlmRequest(before);
    prompt = String((captured.body as Record<string, unknown>).prompt);
    // reconstructWithReasoning: prefix + reasoning + suffix + separator +
    // content, wrapped as an assistant turn by the instruct template.
    expect(prompt).toContain('<｜Assistant｜><think>I pondered deeply</think>The answer is 42.');

    await setSetting(page, 'reasoningAddToPrompts', false);
  });
});
