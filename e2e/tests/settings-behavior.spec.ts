import { test, expect, type Locator } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { App } from '../helpers/app.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { setSetting } from '../helpers/settings.js';
import { getLastLlmRequest, waitForNextLlmRequest } from '../helpers/llm.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

/** Idempotently set a checkbox row inside the open settings modal. */
async function setCheckbox(modal: Locator, label: string, desired: boolean): Promise<void> {
  const checkbox = modal.locator(`label.checkbox-row:has-text("${label}") input[type="checkbox"]`);
  if ((await checkbox.isChecked()) !== desired) {
    await checkbox.click();
    await expect(checkbox).toBeChecked({ checked: desired });
  }
}

/** Last user-message string content in a captured mock-LLM request body. */
function lastUserContent(body: unknown): string {
  const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> })?.messages ?? [];
  const lastUser = messages.slice().reverse().find((m) => m.role === 'user');
  const content = lastUser?.content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

test.describe('Settings — Behavior', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test('send on Enter and confirm before deleting messages', async ({ page }) => {
    test.setTimeout(90000);
    const app = new App(page);
    const name = uniqueName('BehaviorSend');
    await app.createCharacterAndChat({ name, firstMes: `Hello from ${name}.` });

    const modal = await app.openSettings();
    const sendOnEnter = modal.locator('label.field-label:has-text("Send on Enter") select');

    // Disabled: Enter inserts a newline instead of sending.
    await sendOnEnter.selectOption('disabled');
    await app.closeSettings();
    const bubblesBefore = await page.locator('.message-bubble').count();
    await app.messageInput().fill('unsent enter probe');
    await app.messageInput().press('Enter');
    await expect(app.messageInput()).toHaveValue(/unsent enter probe/);
    await expect(page.locator('.message-bubble')).toHaveCount(bubblesBefore);

    // Enabled: Enter sends the message (and triggers a reply).
    const modal2 = await app.openSettings();
    await modal2.locator('label.field-label:has-text("Send on Enter") select').selectOption('enabled');
    await app.closeSettings();
    await app.messageInput().fill('respond:sent via enter');
    const assistantBefore = await page.locator('.message-bubble.assistant').count();
    await app.messageInput().press('Enter');
    await expect(app.messageInput()).toHaveValue('');
    await expect(app.lastBubble('user')).toContainText('respond:sent via enter');
    await expect
      .poll(async () => page.locator('.message-bubble.assistant').count(), { timeout: 30000 })
      .toBeGreaterThan(assistantBefore);
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 30000 });

    const modal3 = await app.openSettings();
    await modal3.locator('label.field-label:has-text("Send on Enter") select').selectOption('auto');
    await app.closeSettings();

    // confirmMessageDelete: delete requires the confirmation popup.
    await app.ensureSetting('Confirm before deleting messages', true);
    const userBubble = app.lastBubble('user');
    const countBeforeDelete = await page.locator('.message-bubble').count();
    await app.clickMessageAction(userBubble, 'Delete');
    const popup = page.locator('.popup-modal');
    await expect(popup).toBeVisible();
    await expect(popup).toContainText('Delete this message?');
    await popup.locator('button.primary').click();
    await expect(popup).not.toBeVisible();
    await expect(page.locator('.message-bubble')).toHaveCount(countBeforeDelete - 1);
    await app.ensureSetting('Confirm before deleting messages', false);
  });

  test('soft fork and restore input text on chat switch', async ({ page }) => {
    test.setTimeout(120000);
    const app = new App(page);
    const name = uniqueName('BehaviorFork');
    await app.createCharacterAndChat({ name, firstMes: `Hello from ${name}.` });
    await app.sendUserMessage('seq:forkbase', { expectReply: true });

    // useSoftFork: the Fork action creates a soft-fork chat that keeps the history link.
    await app.ensureSetting('Use soft fork (keep history link) instead of hard fork', true);
    const sourceChatId = await app.activeChatId();
    await app.forkAt(app.lastBubble('assistant'));
    const forkItem = page.locator('.chat-item', { hasText: 'Fork of' }).first();
    await expect(forkItem).toBeVisible();
    await app.ensureSetting('Use soft fork (keep history link) instead of hard fork', false);

    // restoreUserInput: unsent text survives switching chats and back.
    await app.ensureSetting('Restore input text when switching chats', true);
    await app.selectChatById(sourceChatId!);
    await app.messageInput().fill('unsent draft probe');
    await forkItem.click();
    await expect(page.locator('.chat-view')).toBeVisible();
    await app.selectChatById(sourceChatId!);
    await expect(app.messageInput()).toHaveValue('unsent draft probe');
    await app.messageInput().fill('');
    await app.ensureSetting('Restore input text when switching chats', false);
  });

  test('auto load last chat and character list grid view', async ({ page }) => {
    test.setTimeout(90000);
    const app = new App(page);
    const name = uniqueName('BehaviorLoad');
    await app.createCharacterAndChat({ name, firstMes: `Hello from ${name}.` });

    // autoLoadLastChat: after a reload the last chat is auto-selected.
    await app.ensureSetting('Load last chat on startup', true);
    await app.waitForSettingSaved('autoLoadLastChat', true);
    await page.reload();
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 10000 });
    await expect(page.locator('.chat-view')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.chat-item.active')).toBeVisible();
    await expect(page.locator('.message-bubble').first()).toBeVisible();
    await app.ensureSetting('Load last chat on startup', false);

    // charListGrid: the character list gets a grid class.
    await app.ensureSetting('Grid view for character list', true);
    await expect(page.locator('.character-list')).toHaveClass(/grid/);
    await app.ensureSetting('Grid view for character list', false);
    await expect(page.locator('.character-list')).not.toHaveClass(/grid/);
  });

  test('post-processing: whitespace, trim sentences, markdown fix, XML, single line', async ({ page }) => {
    test.setTimeout(180000);
    const app = new App(page);
    const name = uniqueName('BehaviorPost');
    await app.createCharacterAndChat({ name, firstMes: `Hello from ${name}.` });

    // whitespaceMode 'full': user input is collapsed before it reaches the LLM.
    await setSetting(page, 'whitespaceMode', 'full');
    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('respond:wide    gaps   here', { expectReply: true });
    const captured = await waitForNextLlmRequest(before);
    expect(lastUserContent(captured.body)).toBe('respond:wide gaps here');
    // The reply is rendered collapsed as well.
    expect(await app.lastAssistantText()).toBe('wide gaps here');
    await setSetting(page, 'whitespaceMode', 'none');

    // trimSentences: dangling final fragment is cut.
    await app.ensureSetting('Trim to end of last complete sentence', true);
    await app.sendUserMessage('respond:First sentence. Dangling frag', { expectReply: true });
    expect(await app.lastAssistantText()).toBe('First sentence.');
    await app.ensureSetting('Trim to end of last complete sentence', false);

    // autoFixGeneratedMarkdown: an unclosed backtick gets closed, rendering <code>.
    await app.ensureSetting('Auto-fix generated markdown', true);
    await app.sendUserMessage('respond:use `tickmark now', { expectReply: true });
    await expect(app.lastBubble('assistant').locator('.message-content code')).toContainText('tickmark now');
    await app.ensureSetting('Auto-fix generated markdown', false);

    // removeXML: XML tags are stripped from the reply. (The user's own bubble
    // also renders without the tags — DOMPurify strips them at display time.)
    await app.ensureSetting('Remove XML tags from output', true);
    await app.sendUserMessage('respond:keep <xml>drop</xml> end', { expectReply: true, userText: 'respond:keep drop end' });
    const xmlText = (await app.lastAssistantText()).replace(/\s+/g, ' ').trim();
    expect(xmlText).toBe('keep drop end');
    await app.ensureSetting('Remove XML tags from output', false);

    // singleLine: the reply is trimmed to its first line. (The user's own
    // bubble renders the newline without a separator, so assert by prefix.)
    await app.ensureSetting('Single-line mode (trim to first newline)', true);
    await app.sendUserMessage('respond:first line\nsecond line', { expectReply: true, userText: 'respond:first line' });
    expect(await app.lastAssistantText()).toBe('first line');
    await app.ensureSetting('Single-line mode (trim to first newline)', false);
  });

  test('message sound and smooth streaming with fade-in', async ({ page }) => {
    test.setTimeout(90000);
    const app = new App(page);
    const name = uniqueName('BehaviorStream');
    await app.createCharacterAndChat({ name, firstMes: `Hello from ${name}.` });

    // Sound toggles: generation completes without crashing (no audio in headless).
    await app.ensureSetting('Play sound when generation completes', true);
    await app.ensureSetting('Only play sound when unfocused', true);
    await app.sendUserMessage('seq:soundprobe', { expectReply: true });
    await expect(app.lastBubble('assistant')).toBeVisible();

    // smoothStreaming + streamFadeIn: the streaming bubble renders with the fade-in class.
    await app.ensureSetting('Smooth streaming (typewriter effect)', true);
    await app.ensureSetting('Fade in streamed text', true);

    // The mock LLM streams its whole reply instantly, so the `.streaming`
    // window is milliseconds — too fast to observe reliably. Slow the
    // generation.* WS events down with a serial delay queue so the streaming
    // phase (and thus the fade-in class) becomes observable deterministically.
    // The route only applies to new connections, so reload to re-connect.
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((msg) => {
        void server.send(msg);
      });
      let chain: Promise<void> = Promise.resolve();
      server.onMessage((msg) => {
        if (typeof msg === 'string' && msg.includes('"generation.')) {
          chain = chain.then(
            () =>
              new Promise<void>((resolve) => {
                setTimeout(() => {
                  void ws.send(msg);
                  resolve();
                }, 50);
              }),
          );
        } else {
          void ws.send(msg);
        }
      });
    });
    await page.reload();
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('.chat-item').first().click();
    await expect(page.locator('.chat-view')).toBeVisible();

    const longProbe =
      'respond:stream fade probe with quite a few extra words here so the streamed reply keeps the bubble in its streaming phase for a while';
    await app.messageInput().fill(longProbe);
    await page.locator('.message-input-area .send-btn').click();
    await expect(page.locator('.message-bubble.streaming .message-content.stream-fade-in')).toBeVisible({
      timeout: 20000,
    });
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 60000 });
    await app.waitForAssistantText('stream fade probe', 30000);

    // Reset everything flipped above.
    await app.ensureSetting('Play sound when generation completes', false);
    await app.ensureSetting('Only play sound when unfocused', true);
    await app.ensureSetting('Smooth streaming (typewriter effect)', false);
    await app.ensureSetting('Fade in streamed text', true);
  });

  test('whitespace handling radios persist across reload', async ({ page }) => {
    test.setTimeout(90000);
    const app = new App(page);

    const modal = await app.openSettings();
    await modal.locator('label.radio-row:has-text("Full whitespace manipulation") input').click();
    await app.waitForSettingSaved('whitespaceMode', 'full');
    await app.closeSettings();

    await page.reload();
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 10000 });
    const modal2 = await app.openSettings();
    await expect(modal2.locator('input[name="whitespaceMode"][value="full"]')).toBeChecked();

    await modal2.locator('label.radio-row:has-text("Essential whitespace manipulation") input').click();
    await app.waitForSettingSaved('whitespaceMode', 'essential');
    await app.closeSettings();

    await page.reload();
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 10000 });
    const modal3 = await app.openSettings();
    await expect(modal3.locator('input[name="whitespaceMode"][value="essential"]')).toBeChecked();

    // Reset to the default.
    await modal3.locator('label.radio-row:has-text("No whitespace manipulation") input').click();
    await expect(modal3.locator('input[name="whitespaceMode"][value="none"]')).toBeChecked();
    await app.closeSettings();
  });
});
