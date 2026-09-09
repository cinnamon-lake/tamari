import { smokeTest as test, expect } from '../fixtures/smoke.js';
import { setSetting } from '../helpers/settings.js';
import { setTransformerSteps, resetTransformerChain } from '../helpers/transformers.js';
import { getLastLlmRequest, waitForNextLlmRequest, wireContentText } from '../helpers/llm.js';
import { uniqueName } from '../helpers/names.js';

/** Last user-message text in a captured mock-LLM request body (content is a parts array on the wire). */
function lastUserContent(body: unknown): string {
  const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> })?.messages ?? [];
  const lastUser = messages
    .slice()
    .reverse()
    .find((m) => m.role === 'user');
  return wireContentText(lastUser?.content);
}

// Covers the GenerationService finalize post-processing paths (chat mode):
// trimSentences, autoFixGeneratedMarkdown (autoFixMarkdown), removeXML,
// singleLine — plus the `whitespace` request transformer, which replaced the
// removed global `whitespaceMode` setting's send-time/settle-time passes
// (both deleted; the transform is request-time only, stored messages stay
// verbatim).
//
// The text-level think-tag fallback parse is intentionally NOT here: it only
// runs when `prompt.reasoning` is set, which PromptBuilder only does in
// text-completion mode — see reasoning-textmode.spec.ts.
test.describe('Generation Post-Processing', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterEach(async ({ page }) => {
    // The server is shared per run — put every touched setting back to its
    // default even when a test fails halfway.
    await resetTransformerChain(page);
    await setSetting(page, 'trimSentences', false);
    await setSetting(page, 'autoFixGeneratedMarkdown', false);
    await setSetting(page, 'removeXML', false);
    await setSetting(page, 'singleLine', false);
  });

  test('whitespace transformer full collapses whitespace in the request only', async ({ page, app }) => {
    await app.createCharacterAndChat({ name: uniqueName('PP Whitespace'), firstMes: 'Ready.' });

    // Control: the fresh-install default (no chain linked) sends the user
    // turn verbatim — no global whitespace pass exists anymore.
    let before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('respond:line1\n\n\n\nline2  with   spaces', { expectReply: true });
    let captured = await waitForNextLlmRequest(before);
    expect(lastUserContent(captured.body)).toBe('respond:line1\n\n\n\nline2  with   spaces');

    await setTransformerSteps(page, [{ kind: 'builtin', id: 'whitespace', enabled: true, params: { mode: 'full' } }]);
    before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('respond:wide    gaps   here', { expectReply: true });
    captured = await waitForNextLlmRequest(before);
    // The chain collapsed the user turn in the outgoing request…
    expect(lastUserContent(captured.body)).toBe('respond:wide gaps here');
    // …but the reply is no longer mutated at stream settle (the mock echoes
    // the collapsed selector, so the reply is collapsed only transitively).
    expect(await app.lastAssistantText()).toBe('wide gaps here');
  });

  test('trimSentences cuts a dangling final fragment', async ({ page, app }) => {
    await app.createCharacterAndChat({ name: uniqueName('PP Trim'), firstMes: 'Ready.' });

    await setSetting(page, 'trimSentences', true);
    await app.sendUserMessage('respond:First sentence. Dangling frag', { expectReply: true });
    expect(await app.lastAssistantText()).toBe('First sentence.');
  });

  test('autoFixGeneratedMarkdown closes unbalanced bold markers', async ({ page, app }) => {
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

  test('removeXML strips XML tags from the reply', async ({ page, app }) => {
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

  test('singleLine trims the reply to its first line', async ({ page, app }) => {
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
