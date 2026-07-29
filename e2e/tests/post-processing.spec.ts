import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { App } from '../helpers/app.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { setSetting } from '../helpers/settings.js';
import { getLastLlmRequest, waitForNextLlmRequest } from '../helpers/llm.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

/** Last user-message string content in a captured mock-LLM request body. */
function lastUserContent(body: unknown): string {
  const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> })?.messages ?? [];
  const lastUser = messages.slice().reverse().find((m) => m.role === 'user');
  const content = lastUser?.content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

// Covers the GenerationService finalize post-processing paths (chat mode):
// applyInputWhitespace / applyOutputWhitespace, trimSentences,
// autoFixGeneratedMarkdown (autoFixMarkdown), removeXML, singleLine.
//
// The text-level think-tag fallback parse is intentionally NOT here: it only
// runs when `prompt.reasoning` is set, which PromptBuilder only does in
// text-completion mode — see reasoning-textmode.spec.ts.
test.describe('Generation Post-Processing', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
  });

  test.afterEach(async ({ page }) => {
    // The server is shared per run — put every touched setting back to its
    // default even when a test fails halfway.
    await setSetting(page, 'whitespaceMode', 'none');
    await setSetting(page, 'trimSentences', false);
    await setSetting(page, 'autoFixGeneratedMarkdown', false);
    await setSetting(page, 'removeXML', false);
    await setSetting(page, 'singleLine', false);
    await resetBackendConfig(page);
  });

  test('whitespaceMode full collapses whitespace in the request and the reply', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({ name: uniqueName('PP Whitespace'), firstMes: 'Ready.' });

    await setSetting(page, 'whitespaceMode', 'full');
    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('respond:line1\n\n\n\nline2  with   spaces', { expectReply: true });
    const captured = await waitForNextLlmRequest(before);
    // applyInputWhitespace collapsed the user turn before it reached the LLM.
    expect(lastUserContent(captured.body)).toBe('respond:line1\n\nline2 with spaces');
    // The reply (echoed from the collapsed selector) renders collapsed too.
    const content = app.lastBubble('assistant').locator('.message-content');
    await expect(content).toContainText('line1');
    await expect(content).toContainText('line2 with spaces');
    expect(await app.lastAssistantText()).not.toMatch(/ {2}/);
  });

  test('trimSentences cuts a dangling final fragment', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({ name: uniqueName('PP Trim'), firstMes: 'Ready.' });

    await setSetting(page, 'trimSentences', true);
    await app.sendUserMessage('respond:First sentence. Dangling frag', { expectReply: true });
    expect(await app.lastAssistantText()).toBe('First sentence.');
  });

  test('autoFixGeneratedMarkdown closes unbalanced bold markers', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({ name: uniqueName('PP Markdown'), firstMes: 'Ready.' });

    await setSetting(page, 'autoFixGeneratedMarkdown', true);
    // autoFixMarkdown appends one '*' when the count is odd, so '**bold*'
    // becomes '**bold**' and renders as a real bold element. ('**bold' alone
    // has an even count and is left untouched by design.)
    // The user's own bubble markdown-renders '**bold*' (visible as '*bold'),
    // hence the userText override.
    await app.sendUserMessage('respond:**bold*', { expectReply: true, userText: 'respond:*bold' });
    await expect(app.lastBubble('assistant').locator('.message-content strong')).toContainText('bold');
  });

  test('removeXML strips XML tags from the reply', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({ name: uniqueName('PP Xml'), firstMes: 'Ready.' });

    await setSetting(page, 'removeXML', true);
    // The user's own bubble also renders without the tags (DOMPurify strips
    // them at display time), hence the userText override.
    await app.sendUserMessage('respond:keep this <xml>drop this</xml>', {
      expectReply: true,
      userText: 'respond:keep this drop this',
    });
    expect(await app.lastAssistantText()).toBe('keep this drop this');
  });

  test('singleLine trims the reply to its first line', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({ name: uniqueName('PP SingleLine'), firstMes: 'Ready.' });

    await setSetting(page, 'singleLine', true);
    // The user's own bubble renders the newline without a separator, so
    // assert the typed message by prefix.
    await app.sendUserMessage('respond:first line\nsecond line', {
      expectReply: true,
      userText: 'respond:first line',
    });
    expect(await app.lastAssistantText()).toBe('first line');
  });
});
