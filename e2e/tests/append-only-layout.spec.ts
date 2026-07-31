import { test, expect, type Page } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { getLastLlmRequest, waitForNextLlmRequest, resetLlmRequests } from '../helpers/llm.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

/**
 * WS fast-path: lorebook (keyword + constant entries), character linked to it,
 * chat, and an in-chat author's note — one socket, ack-waited per step.
 */
async function setupChat(page: Page, charName: string): Promise<{ chatId: string }> {
  return await page.evaluate((cn) => {
    return new Promise<{ chatId: string }>((resolve, reject) => {
      const token = localStorage.getItem('st_auth_token') ?? '';
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
      const entryBase = {
        comment: '',
        order: 0,
        probability: 100,
        selective: false,
        secondaryKeys: [],
        addMemo: false,
        disable: false,
        regex: false,
        recursive: false,
        depth: 0,
        role: 'system',
        retrievalMode: 'keyword',
      };
      let bookId = '';
      let characterId = '';
      let chatId = '';

      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth' }));
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'snapshot') {
            ws.send(JSON.stringify({
              type: 'worldinfo.create',
              data: {
                name: 'AO Book',
                entries: [
                  { ...entryBase, keys: ['kwtoken'], content: 'KEYWORD-WI-ENTRY', position: 'before_char', constant: false },
                  { ...entryBase, keys: [], content: 'CONSTANT-WI-ENTRY', position: 'before_char', constant: true },
                ],
              },
            }));
          }
          if (msg.type === 'worldinfo.created') {
            bookId = msg.book.id;
            ws.send(JSON.stringify({
              type: 'character.create',
              data: { name: cn, description: 'Append-only test character', firstMes: 'Greetings.', worldInfoId: bookId },
            }));
          }
          if (msg.type === 'character.created' && msg.character?.name === cn) {
            characterId = msg.character.id;
            ws.send(JSON.stringify({ type: 'chat.create', data: { characterId, name: 'AO Chat' } }));
          }
          if (msg.type === 'chat.created') {
            chatId = msg.chat.id;
            ws.send(JSON.stringify({ type: 'chat.materialize', chatId }));
            ws.send(JSON.stringify({
              type: 'chat.update',
              chatId,
              patch: {
                metadata: {
                  authorsNote: { content: 'APPEND-ONLY-NOTE', position: 'in_chat', depth: 1, role: 'system', interval: 1 },
                },
              },
            }));
          }
          if (msg.type === 'chat.updated') {
            ws.close();
            resolve({ chatId });
          }
          if (msg.type === 'error') {
            ws.close();
            reject(new Error(msg.message ?? 'WS setup failed'));
          }
        } catch (err) {
          reject(err);
        }
      };
      ws.onerror = () => reject(new Error('WebSocket error'));
      setTimeout(() => {
        ws.close();
        reject(new Error('setupChat timed out'));
      }, 10000);
    });
  }, charName);
}

test.describe('Append-only prompt layout', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    // Mode off for the rest of the suite (the server is shared).
    await page.evaluate(() => {
      const token = localStorage.getItem('st_auth_token') ?? '';
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'auth' }));
        ws.send(JSON.stringify({ type: 'settings.set', key: 'appendOnlyPromptLayout', value: false }));
        ws.close();
      };
    });
    await resetBackendConfig(page);
  });

  test('toggle persists across reload; note hoists to the top block, keyword WI vanishes', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('AppendOnly Char');
    const { chatId } = await setupChat(page, charName);

    // Toggle the mode on through the settings UI and ack the save.
    const modal = await app.openSettings();
    await modal.locator('label.checkbox-row:has-text("Append-only prompt layout") input').click();
    await app.waitForSettingSaved('appendOnlyPromptLayout', true);
    await app.closeSettings();

    // Persistence across reload: the checkbox is still on.
    await page.reload();
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 10000 });
    const modal2 = await app.openSettings();
    await expect(modal2.locator('label.checkbox-row:has-text("Append-only prompt layout") input')).toBeChecked();
    await app.closeSettings();

    // Select the prepared chat (startChat would create a NEW one, losing the
    // author's-note metadata) and generate with the keyword in the message.
    await app.selectChatById(chatId);
    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('respond: kwtoken hello', { expectReply: true });
    const cap = await waitForNextLlmRequest(before);

    const messages = (cap.body as { messages: Array<{ role: string; content: unknown }> }).messages;
    const json = JSON.stringify(messages);

    // The keyword-triggered (non-constant) entry renders NOWHERE.
    expect(json).not.toContain('KEYWORD-WI-ENTRY');
    // The constant entry still renders (static head position).
    expect(json).toContain('CONSTANT-WI-ENTRY');

    // The author's note is hoisted into the pinned block ABOVE message 1
    // (a system message before the first user/greeting message), never at depth.
    const firstUserIdx = messages.findIndex((m) => m.role === 'user');
    const noteIdx = messages.findIndex((m) => typeof m.content === 'string' && m.content.includes('APPEND-ONLY-NOTE'));
    expect(noteIdx).toBeGreaterThanOrEqual(0);
    expect(noteIdx).toBeLessThan(firstUserIdx);
  });

  /**
   * Falsifiability control: with the mode OFF, the author's note floats at
   * depth 1, so turn 1's request is NOT a prefix of turn 2's. If this control
   * ever starts passing, the property test below isn't measuring anything.
   */
  test('control: default layout is not append-only (note floats)', async ({ page }) => {
    const app = new App(page);
    const { chatId } = await setupChat(page, uniqueName('AppendOnly Control Char'));
    await app.selectChatById(chatId);

    let before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('respond:CONTROL-REPLY-ONE', { expectReply: true });
    const cap1 = await waitForNextLlmRequest(before);
    const r1 = (cap1.body as { messages: unknown[] }).messages;

    before = cap1.count;
    await app.sendUserMessage('respond:CONTROL-REPLY-TWO', { expectReply: true });
    const cap2 = await waitForNextLlmRequest(before);
    const r2 = (cap2.body as { messages: unknown[] }).messages;

    expect(r2.length).toBeGreaterThan(r1.length);
    expect(JSON.stringify(r2.slice(0, r1.length))).not.toBe(JSON.stringify(r1));
  });

  /**
   * THE property, over the wire: with the mode on, turn 1's serialized request
   * is a byte-prefix of turn 2's, and the message appended between them is the
   * assistant reply — verbatim raw provider bytes (no post-processing, no
   * macro resolution). This is what snapshot caches need for hits.
   */
  test('rendered requests are byte-prefixes across turns', async ({ page }) => {
    const app = new App(page);
    const { chatId } = await setupChat(page, uniqueName('AppendOnly Prefix Char'));

    const modal = await app.openSettings();
    await modal.locator('label.checkbox-row:has-text("Append-only prompt layout") input').click();
    await app.waitForSettingSaved('appendOnlyPromptLayout', true);
    await app.closeSettings();

    await app.selectChatById(chatId);

    // Turn 1.
    let before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('respond:RAW-REPLY-BYTES-ONE', { expectReply: true });
    const cap1 = await waitForNextLlmRequest(before);
    const r1 = (cap1.body as { messages: unknown[] }).messages;

    // Turn 2.
    before = cap1.count;
    await app.sendUserMessage('respond:RAW-REPLY-BYTES-TWO', { expectReply: true });
    const cap2 = await waitForNextLlmRequest(before);
    const r2 = (cap2.body as { messages: unknown[] }).messages;

    // Byte-prefix: every message the provider saw in turn 1 is re-sent
    // verbatim, in order, at the same positions in turn 2.
    expect(r2.length).toBeGreaterThan(r1.length);
    expect(JSON.stringify(r2.slice(0, r1.length))).toBe(JSON.stringify(r1));

    // The appended history between the turns is the turn-1 assistant reply,
    // byte-exact as the mock streamed it (persisted = raw provider stream).
    const appended = r2[r1.length] as { role: string; content: unknown };
    expect(appended.role).toBe('assistant');
    expect(appended.content).toBe('RAW-REPLY-BYTES-ONE');
  });
});
