import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { enableBuiltinToolset, deleteToolset } from '../helpers/tools.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';
import { getLastLlmRequest, resetLlmRequests } from '../helpers/llm.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

test.describe('Choices Widget', () => {
  let toolsetId: string | undefined;

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
    if (toolsetId) {
      await deleteToolset(page, toolsetId);
      toolsetId = undefined;
    }
  });

  test('renders present_choices as clickable buttons and clicking one replies', async ({ page }) => {
    const app = new App(page);
    await resetLlmRequests();
    toolsetId = await enableBuiltinToolset(page, 'lua_choices');

    await app.createCharacterAndChat({
      name: uniqueName('Choices Character'),
      firstMes: 'You stand before a heavy oak door.',
    });

    // The mock LLM walks the `tool:` sequence: round 1 calls present_choices.
    // present_choices declares `endsTurn`, so the turn stops after the tool
    // result — no follow-up generation round streams an answer. The tool-call
    // round streams no visible text, so we can't use expectReply (it waits for
    // non-empty .message-content); wait on the widget instead.
    await app.sendUserMessage(
      'tool:present_choices{"options":["Open the door","Sneak around"],"prompt":"What do you do?"}',
    );

    // The tool result part carries extra.renderType = "choices": the server
    // renders a placeholder slot inline in the parts flow and the client
    // hydrates the interactive widget into it.
    const assistantBubble = app.lastBubble('assistant');
    const widget = assistantBubble.locator('.message-content .choices-result');
    await expect(widget).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 30000 });
    await expect(widget.locator('.choices-prompt')).toHaveText('What do you do?');
    const buttons = widget.locator('.choice-btn');
    await expect(buttons).toHaveCount(2);
    await expect(buttons.nth(0)).toHaveText('Open the door');
    await expect(buttons.nth(1)).toHaveText('Sneak around');
    // No generic server-rendered block for the renderType part, and the raw
    // tool-call block (JSON args) is suppressed — the widget represents the call.
    await expect(assistantBubble.locator('.tool-result-block')).toHaveCount(0);
    await expect(assistantBubble.locator('.tool-call-block')).toHaveCount(0);

    // endsTurn: the tool-call round was the only completion request — the turn
    // ended after present_choices instead of generating a follow-up reply.
    expect((await getLastLlmRequest()).count).toBe(1);

    await expectNoAxeViolations(page);

    // Clicking a choice sends it as the user's reply and triggers generation.
    await buttons.nth(1).click();
    await expect(app.lastBubble('user')).toContainText('Sneak around', { timeout: 5000 });
    await app.waitForNextAssistantReply();

    // The reply after the click is the second completion request.
    expect((await getLastLlmRequest()).count).toBe(2);

    // Once a reply follows, the stale choices disable (branch-leaf rule).
    // `assistantBubble` is a live `.last()` locator that now points at the new
    // reply, so re-locate the bubble that actually contains the widget.
    const staleWidget = page.locator('.message-bubble.assistant', { has: page.locator('.choices-result') });
    await expect(staleWidget.locator('.choice-btn').first()).toBeDisabled();
  });
});
