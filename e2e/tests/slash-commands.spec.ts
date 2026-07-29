/**
 * Slash-command coverage for client/src/lib/commands.ts (+ slashCommands.ts).
 *
 * Commands are typed into `.message-textarea` and dispatched with the send
 * button — MessageInput.send() runs parseCommand + executeSlashCommand.
 * Behaviors asserted here are taken from the implementations:
 *   - client-side commands: /name, /bg, /theme, /persona, /char, /lock,
 *     /unlock, /wi, /inject, /flushinject, /listvar (commands.ts)
 *   - WS-routed commands: /send, /sys, /cut, /gen, /genraw, /ask, /sysgen
 *     (buildClientMessage in slashCommands.ts)
 *
 * Skipped on purpose:
 *   - /regen — pure alias of /regenerate (same buildClientMessage branch).
 *   - /regenerate, /continue, /swipe — generation/swipe mechanics already
 *     covered by the message-actions / swipe specs; here they add no new
 *     commands.ts paths (single return statements).
 *   - /impersonate — drafts into the textarea via generation.impersonationDraft;
 *     covered by quick-reply/impersonate UI paths elsewhere.
 *   - /reset — wipes chat history; destructive and orthogonal to commands.ts
 *     branching (single passthrough).
 */
import { test, expect, type Page } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { App } from '../helpers/app.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { setSetting } from '../helpers/settings.js';
import { getLastLlmRequest, waitForNextLlmRequest, resetLlmRequests } from '../helpers/llm.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()} ${Math.floor(Math.random() * 100000)}`;
}

/** Type a slash command into the composer and dispatch it with the send button. */
async function runCommand(page: Page, command: string): Promise<void> {
  const input = page.locator('.message-textarea');
  await input.fill(command);
  await page.locator('.message-input-area .send-btn').click();
  // executeSlashCommand's clearInput() empties the composer for handled commands.
  await expect(input).toHaveValue('');
}

function lastSystemBubble(page: Page) {
  return page.locator('.message-bubble.system').last();
}

/**
 * Read one setting over a throwaway WS connection (settings.get → settings.loaded).
 * Used to gate on `/name` (settings.set userName) having landed server-side
 * before the next message send resolves {{user}} — the settings.set write is
 * async and otherwise races the following action.send.
 */
async function readSetting(page: Page, key: string): Promise<unknown> {
  return page.evaluate((key) => {
    return new Promise((resolve, reject) => {
      const token = localStorage.getItem('st_auth_token') ?? '';
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'auth' }));
        ws.send(JSON.stringify({ type: 'settings.get', keys: [key] }));
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string);
        if (msg.type === 'settings.loaded') {
          ws.close();
          resolve(msg.settings?.[key]);
        }
      };
      ws.onerror = () => reject(new Error('readSetting WS error'));
      setTimeout(() => {
        ws.close();
        reject(new Error('readSetting timed out'));
      }, 10000);
    });
  }, key);
}

test.describe('Slash commands', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test('message ops: /sys, /send, /cut', async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    const app = new App(page);
    const charName = uniqueName('SlashOps Char');
    await app.createCharacterAndChat({ name: charName, description: 'ops char', firstMes: 'Greetings from ops.' });

    // /sys appends a system message (action.system → role 'system' bubble).
    await runCommand(page, '/sys hello world');
    await expect(lastSystemBubble(page)).toContainText('hello world', { timeout: 5000 });
    await app.waitForBubbleCount(2); // greeting + system

    // /send appends a user message and triggers a generation.
    await runCommand(page, '/send respond: send reply here');
    await expect(app.lastBubble('user')).toContainText('respond: send reply here', { timeout: 5000 });
    await app.waitForAssistantText('send reply here');
    await app.waitForBubbleCount(4);

    // /cut 1 removes the last message (the assistant reply).
    await runCommand(page, '/cut 1');
    await app.waitForBubbleCount(3);
    await expect(app.lastBubble('user')).toContainText('respond: send reply here');
  });

  test('identity and lock: /name, /lock, /unlock', async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    const app = new App(page);
    const charName = uniqueName('SlashName Char');
    await app.createCharacterAndChat({ name: charName, description: 'name char', firstMes: 'Greetings from name.' });

    // /name sends settings.set userName. Note: userName is not rendered anywhere
    // in the client UI, and {{user}} resolves to the *persona* name first
    // (chats auto-assign the default persona on creation), so the honest
    // observable is the persisted setting itself.
    const newName = uniqueName('Renamed User');
    await runCommand(page, `/name ${newName}`);
    await expect.poll(() => readSetting(page, 'userName'), { timeout: 5000 }).toBe(newName);

    // /lock disables the composer (inputLocked → disabled + locked placeholder).
    await runCommand(page, '/lock');
    const input = app.messageInput();
    await expect(input).toBeDisabled();
    await expect(input).toHaveAttribute('placeholder', 'Input is locked. Type /unlock to enable.');

    // The composer is disabled, so /unlock can't be typed normally — lift the
    // DOM lock on both the textarea and the send button (disabled controls
    // swallow clicks), then send /unlock like a user would.
    await input.evaluate((el: HTMLTextAreaElement) => {
      el.disabled = false;
    });
    await page.locator('.message-input-area .send-btn').evaluate((el: HTMLButtonElement) => {
      el.disabled = false;
    });
    await input.fill('/unlock');
    await page.locator('.message-input-area .send-btn').click();
    await expect(input).toBeEnabled();
    await expect(input).toHaveAttribute('placeholder', 'Type a message...');
  });

  test('/persona assigns a persona to the chat and errors on unknown names', async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    const app = new App(page);
    const personaName = uniqueName('Slash Persona');

    // Create a persona via the Personas manager UI.
    await page.locator('button.settings-btn:has-text("Personas")').click();
    const manager = page.locator('.persona-modal');
    await expect(manager).toBeVisible();
    await manager.locator('button:has-text("New Persona")').click();
    await expect(manager.locator('.persona-editor')).toBeVisible();
    await manager.locator('.persona-editor .text-input').first().fill(personaName);
    await expect(manager.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
    await page.locator('.modal-overlay:has(.persona-modal)').click({ position: { x: 0, y: 0 } });
    await expect(manager).not.toBeVisible();

    const charName = uniqueName('SlashPersona Char');
    await app.createCharacterAndChat({ name: charName, description: 'persona char', firstMes: 'Greetings from persona.' });

    // Unknown persona → error toast, chat unchanged.
    const bogus = uniqueName('NoSuchPerson');
    await runCommand(page, `/persona ${bogus}`);
    await expect(page.locator('.toast-container')).toContainText(`Persona "${bogus}" not found`);

    // Known persona → chat.update personaId; new user bubbles show the persona name.
    await runCommand(page, `/persona ${personaName}`);
    await app.sendUserMessage('persona check', { expectReply: true });
    await expect(app.lastBubble('user').locator('.message-role')).toHaveText(personaName);
  });

  test('/char switches to another character and errors on unknown names', async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    const app = new App(page);
    const first = uniqueName('SlashChar First');
    const second = uniqueName('SlashChar Second');
    await app.createCharacterAndChat({ name: first, description: 'first', firstMes: 'Greetings from first.' });
    await app.createCharacter({ name: second, description: 'second' });

    await expect(page.locator('main').getByRole('heading', { name: first })).toBeVisible();

    // /char <second> — no chat exists for it yet, so a chat is created and selected.
    // (The sidebar chat list stays scoped to the first character, so the active
    // chat is observed via the chat header in the main panel.)
    await runCommand(page, `/char ${second}`);
    await expect(page.locator('main').getByRole('heading', { name: second })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.chat-view')).toBeVisible();

    // Unknown character → error toast, active chat unchanged.
    const bogus = uniqueName('NoSuchChar');
    await runCommand(page, `/char ${bogus}`);
    await expect(page.locator('.toast-container')).toContainText(`Character "${bogus}" not found`);
    await expect(page.locator('main').getByRole('heading', { name: second })).toBeVisible();
  });

  test('generation: /gen, /genraw, /sysgen', async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
    const app = new App(page);
    const charName = uniqueName('SlashGen Char');
    const descMarker = `DESC_MARKER_${Date.now()}`;
    await app.createCharacterAndChat({ name: charName, description: descMarker, firstMes: 'Greetings from gen.' });

    // /gen — quiet generation with chat context, result appended as system message.
    let before = (await getLastLlmRequest()).count;
    await runCommand(page, '/gen respond: quiet gen');
    await waitForNextLlmRequest(before);
    await expect(lastSystemBubble(page)).toContainText('quiet gen', { timeout: 10000 });

    // /genraw — minimal prompt: exactly one user message, no character fields.
    before = (await getLastLlmRequest()).count;
    await runCommand(page, '/genraw respond: raw out');
    const rawCap = await waitForNextLlmRequest(before);
    await expect(lastSystemBubble(page)).toContainText('raw out', { timeout: 10000 });
    const rawBody = rawCap.body as { messages?: Array<{ role: string; content: string }> };
    expect(Array.isArray(rawBody.messages)).toBe(true);
    expect(rawBody.messages).toHaveLength(1);
    expect(rawBody.messages![0]).toEqual({ role: 'user', content: 'respond: raw out' });
    expect(JSON.stringify(rawCap.body)).not.toContain(descMarker);

    // /sysgen — same path as /gen, result appended as a system message.
    before = (await getLastLlmRequest()).count;
    await runCommand(page, '/sysgen respond: sys out');
    await waitForNextLlmRequest(before);
    await expect(lastSystemBubble(page)).toContainText('sys out', { timeout: 10000 });
  });

  test('/ask generates as a specific character in a group chat', async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    const app = new App(page);
    // /ask's first argument is a single token (args[0]), so the character name
    // must not contain spaces.
    const charName = `SlashAskMember${Date.now()}`;
    const groupName = uniqueName('SlashAsk Group');
    await app.createCharacter({ name: charName, description: 'ask member' });

    // Create a group chat and add the character as a member.
    await page.locator('[title="New group chat"]').click();
    const popup = page.locator('.popup-modal');
    await expect(popup).toBeVisible();
    await popup.locator('.popup-input').fill(groupName);
    await popup.locator('.popup-actions button.primary').click();
    await expect(popup).not.toBeVisible();
    await expect(page.locator('.group-chat-toolbar')).toBeVisible();

    await page.locator('.group-chat-toolbar button:has-text("Manage Members")').click();
    const panel = page.locator('.group-panel');
    await expect(panel).toBeVisible();
    await panel.locator('button:has-text("Add Member")').click();
    await panel.locator('.add-member-dropdown select').selectOption({ label: charName });
    await expect(panel.locator('.group-members-list')).toContainText(charName);
    await panel.locator('[aria-label="Close"]').click();
    await expect(panel).not.toBeVisible();

    // /ask <char> <content> appends the user message and generates as that character.
    await runCommand(page, `/ask ${charName} respond: asked`);
    await expect(app.lastBubble('user')).toContainText('respond: asked', { timeout: 5000 });
    await app.waitForAssistantText('asked');
    await expect(app.lastBubble('assistant').locator('.message-role')).toHaveText(charName);
  });

  test('inject: /inject, /flushinject, /listvar', async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
    const app = new App(page);
    const charName = uniqueName('SlashInject Char');
    await app.createCharacterAndChat({ name: charName, description: 'inject char', firstMes: 'Greetings from inject.' });

    // /listvar with nothing set → info toast.
    await runCommand(page, '/listvar');
    await expect(page.locator('.toast-container')).toContainText('No variables set');

    // /inject queues a one-shot prompt injection (client-side, consumed by the
    // next action.generate from a normal send).
    const token = `UNIQUE_TOKEN_${Date.now()}`;
    await runCommand(page, `/inject ${token}`);
    await expect(page.locator('.toast-container')).toContainText(`Injected (pending for next generation): ${token}`);

    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('respond: after inject', { expectReply: true });
    const cap = await waitForNextLlmRequest(before);
    expect(JSON.stringify(cap.body)).toContain(token);

    // /flushinject clears queued injections and reports the count.
    await runCommand(page, `/inject SECOND_TOKEN_${Date.now()}`);
    await runCommand(page, '/flushinject');
    await expect(page.locator('.toast-container')).toContainText('Cleared 1 pending injection(s)');
    await runCommand(page, '/flushinject');
    await expect(page.locator('.toast-container')).toContainText('No pending injections');

    // /listvar lists global vars as {{$name}} = value.
    const varName = `e2evar${Date.now()}`;
    await setSetting(page, 'globalVars', { [varName]: 'e2evalue' });
    await runCommand(page, '/listvar');
    await expect(page.locator('.toast-container')).toContainText(`{{$${varName}}} = e2evalue`);
    await setSetting(page, 'globalVars', {});
  });

  test('/wi family against a linked lorebook', async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    const app = new App(page);
    const bookName = uniqueName('SlashWI Book');
    const charName = uniqueName('SlashWI Char');
    const dragonToken = `DRAGONTOK_${Date.now()}`;
    const bookLabel = await app.createLorebook(bookName, 'ember', `EMBERTOK_${Date.now()}`);
    await app.createCharacterAndChat({ name: charName, description: 'wi char', firstMes: 'Greetings from wi.', lorebookBookLabel: bookLabel });

    // /wi add <keys> <content...> — creates an entry in the linked book.
    await runCommand(page, `/wi add dragon [WI] ${dragonToken}`);

    // /wi get <key> — system message with [keys] + content.
    await runCommand(page, '/wi get dragon');
    await expect(lastSystemBubble(page)).toContainText(`[WI] ${dragonToken}`, { timeout: 5000 });
    await expect(lastSystemBubble(page)).toContainText('[dragon]');

    // /wi list — numbered entry list as a system message (the numbers render as
    // a markdown ordered list, so assert on the keys/content instead).
    await runCommand(page, '/wi list');
    await expect(lastSystemBubble(page)).toContainText('[dragon]', { timeout: 5000 });
    await expect(lastSystemBubble(page)).toContainText('[ember]');

    // /wi get with an unknown key → error toast.
    await runCommand(page, '/wi get nosuchkey');
    await expect(page.locator('.toast-container')).toContainText('No entry with key "nosuchkey"');

    // Unknown subcommand → usage error toast.
    await runCommand(page, '/wi frobnicate');
    await expect(page.locator('.toast-container')).toContainText('Unknown /wi subcommand. Use: list, get, add, del');

    // /wi del <key> — entry removed; the next /wi list no longer shows it.
    await runCommand(page, '/wi del dragon');
    await runCommand(page, '/wi get dragon');
    await expect(page.locator('.toast-container')).toContainText('No entry with key "dragon"');
    await runCommand(page, '/wi list');
    await expect(lastSystemBubble(page)).not.toContainText('dragon');
    await expect(lastSystemBubble(page)).toContainText('[ember]');
  });

  test('/theme and /bg apply settings; /wi without a linked book errors', async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    const app = new App(page);
    const charName = uniqueName('SlashTheme Char');
    await app.createCharacterAndChat({ name: charName, description: 'theme char', firstMes: 'Greetings from theme.' });

    // No lorebook linked to this chat → /wi bails with an error toast.
    await runCommand(page, '/wi list');
    await expect(page.locator('.toast-container')).toContainText('No lorebook linked to this chat');

    // /theme light → themeCustomCss = light preset → ThemeInjector mounts
    // style#user-theme-css with the preset CSS.
    await runCommand(page, '/theme light');
    const themeStyle = page.locator('style#user-theme-css');
    await expect(themeStyle).toBeAttached();
    // <style> bodies are not part of innerText — read textContent directly.
    expect(await themeStyle.textContent()).toContain('--color-bg-primary:   #fafafa;');

    // /theme dark maps to an empty preset → the style tag is removed again.
    await runCommand(page, '/theme dark');
    await expect(page.locator('style#user-theme-css')).toHaveCount(0);

    // /bg <url> → BackgroundInjector sets the app-shell background image.
    await runCommand(page, '/bg https://example.com/e2e-bg.png');
    await expect(page.locator('.app-shell')).toHaveCSS('background-image', /e2e-bg\.png/);

    // /bg with no args clears it again.
    await runCommand(page, '/bg');
    await expect(page.locator('.app-shell')).toHaveCSS('background-image', 'none');
  });
});
