/**
 * Shared application flow helpers for browser E2E journeys.
 *
 * The isolated specs each re-implement the same ~30-line setup (create a
 * character, start a chat, send a message, poke a hover-gated action button).
 * This module gives journeys a single vocabulary for those flows so a long,
 * realistic test reads like a user script instead of a wall of duplicated
 * locator plumbing.
 *
 * Selectors here are verified against the SolidJS components — see
 * ChatView.tsx (message actions, swipes), ChatHeader.tsx (menu), Sidebar.tsx
 * (character/chat lists), MessageInput.tsx (send/attach), and
 * character/CharacterEditor.tsx (fields, save, delete).
 */
import { expect, type Locator, type Page } from '@playwright/test';

export interface CreateCharacterOptions {
  name: string;
  description?: string;
  firstMes?: string;
  /**
   * Label of an existing lorebook to link (it must already exist in World
   * Info). The fast create path cannot link an existing book, so passing this
   * makes createCharacter fall back to the (slower) editor flow.
   */
  lorebookBookLabel?: string;
}

export class App {
  constructor(readonly page: Page) {}

  // ── low-level affordances ───────────────────────────────────────────────

  /**
   * Legacy helper: character/chat/message action buttons used to be
   * opacity:0 until hover, so this injects one style tag (idempotent) that
   * keeps them visible for automation. The app no longer hover-gates these
   * actions (message and chat-row actions are always visible), so the
   * override is a harmless no-op kept to avoid churning every journey.
   */
  async revealHoverButtons(): Promise<void> {
    await this.page.evaluate(() => {
      if (document.body.dataset.stHoverHack) return;
      const style = document.createElement('style');
      style.id = 'st-hover-hack';
      style.textContent = [
        '.character-list .character-actions { opacity: 1 !important; }',
        '.chat-actions { opacity: 1 !important; }',
        '.message-actions { opacity: 1 !important; transform: none !important; }',
      ].join('\n');
      document.head.appendChild(style);
      document.body.dataset.stHoverHack = '1';
    });
  }

  /** Click a per-message action button by its title (Edit/Hide/Unhide/Delete/Fork/Regenerate/Continue). */
  async clickMessageAction(message: Locator, title: string): Promise<void> {
    await this.revealHoverButtons();
    // evaluate().click() is used elsewhere in the suite because programmatic
    // clicks on hover-revealed buttons are more reliable than Playwright's.
    await message.locator(`button[title="${title}"]`).evaluate((el: HTMLButtonElement) => el.click());
  }

  // ── characters & chats ──────────────────────────────────────────────────

  /**
   * Create a character with one WS `character.create` message — the same wire
   * call the editor makes, without the open → fill → debounced-save → close
   * choreography. Fields are stored raw (unlike the REST import endpoint,
   * which normalizes Risu macros) and the client receives the same
   * created/snapshot/listed broadcasts, so tests observe the same end state.
   * Returns the new character id ('' on the fallback path).
   *
   * Falls back to the editor flow when lorebookBookLabel is set (the create
   * schema cannot link an existing book by label).
   */
  async createCharacter(opts: CreateCharacterOptions): Promise<string> {
    if (opts.lorebookBookLabel !== undefined) {
      await this.createCharacterViaEditor(opts);
      return '';
    }
    const id = await this.page.evaluate(
      (card) => {
        return new Promise<string>((resolve, reject) => {
          const token = localStorage.getItem('st_auth_token') ?? '';
          const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
          const timer = setTimeout(() => {
            ws.close();
            reject(new Error('createCharacter timed out'));
          }, 10000);
          ws.onopen = () => ws.send(JSON.stringify({ type: 'auth' }));
          ws.onmessage = (event) => {
            const msg = JSON.parse(event.data as string);
            if (msg.type === 'snapshot') {
              ws.send(JSON.stringify({ type: 'character.create', data: card }));
            } else if (msg.type === 'character.created' && msg.character?.name === card.name) {
              clearTimeout(timer);
              ws.close();
              resolve(msg.character.id as string);
            } else if (msg.type === 'error') {
              clearTimeout(timer);
              ws.close();
              reject(new Error((msg.message as string) ?? 'character.create failed'));
            }
          };
          ws.onerror = () => {
            clearTimeout(timer);
            ws.close();
            reject(new Error('createCharacter websocket error'));
          };
        });
      },
      { name: opts.name, description: opts.description ?? '', firstMes: opts.firstMes ?? '' },
    );
    // Filter by name before asserting: a leftover search from a prior startChat
    // (and pagination across a long suite run) can otherwise hide the new row.
    await this.page.locator('input[placeholder="Search characters..."]').fill(opts.name);
    await expect(this.page.locator('.character-list li', { hasText: opts.name })).toBeVisible();
    return id;
  }

  /** Create a character via the editor, wait for auto-save, close the editor. */
  async createCharacterViaEditor(opts: CreateCharacterOptions): Promise<void> {
    await this.page.locator('[title="Create character"]').click();
    const editor = this.page.locator('.character-editor-modal');
    await expect(editor).toBeVisible();
    await editor.locator('.text-input').first().fill(opts.name);
    if (opts.description !== undefined) {
      await editor.locator('.textarea-input').nth(0).fill(opts.description);
    }
    if (opts.firstMes !== undefined) {
      await editor.locator('.textarea-input').nth(3).fill(opts.firstMes);
    }
    if (opts.lorebookBookLabel) {
      await editor.locator('.lorebook-selector select').selectOption({ label: opts.lorebookBookLabel });
    }
    await expect(editor.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
    await editor.locator('[title="Close"]').click();
    await expect(editor).not.toBeVisible();
    // Filter by name before asserting: a leftover search from a prior startChat
    // (and pagination across a long suite run) can otherwise hide the new row.
    await this.page.locator('input[placeholder="Search characters..."]').fill(opts.name);
    await expect(this.page.locator('.character-list li', { hasText: opts.name })).toBeVisible();
  }

  /**
   * Create a lorebook with one keyword entry. The entry's content is wrapped in
   * a `[WI] TOKEN` sentinel so the mock LLM can echo it back, proving injection.
   * Returns the book's option label for linking in the character editor.
   */
  async createLorebook(name: string, key: string, token: string): Promise<string> {
    const btn = this.page.locator('button.settings-btn:has-text("World Info")');
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    const editor = this.page.locator('.worldinfo-modal');
    await expect(editor).toBeVisible();

    await editor.locator('button:has-text("New Lorebook")').click();
    await editor.locator('.worldinfo-item').filter({ hasText: 'New Lorebook' }).first().click();
    await expect(editor.locator('.book-editor')).toBeVisible();
    await editor.locator('.book-name-input').fill(name);
    await editor.locator('.book-name-input').blur();

    await editor.locator('button:has-text("Add Entry")').click();
    await editor.locator('.entry-row').first().click();
    await expect(editor.locator('.entry-editor')).toBeVisible();
    await editor.locator('.entry-editor label:has-text("Keys") input').fill(key);
    await editor.locator('.entry-editor label:has-text("Keys") input').blur();
    await editor
      .locator('.entry-editor label:has-text("Content") textarea')
      .fill(`[WI] ${token}`);
    await editor.locator('.entry-editor label:has-text("Content") textarea').blur();

    await this.page.locator('.modal-overlay:has(.worldinfo-modal)').click({ position: { x: 0, y: 0 } });
    await expect(editor).not.toBeVisible();
    // The editor renders the option label as "<name> (<entries> entries)".
    return `${name} (1 entries)`;
  }

  characterRow(name: string): Locator {
    return this.page.locator('.character-list li').filter({
      has: this.page.locator('.character-name', { hasText: name }),
    });
  }

  /** Filter the character list to `name`, open a new chat, and select it. */
  async startChat(characterName: string): Promise<void> {
    await this.revealHoverButtons();
    await this.page.locator('input[placeholder="Search characters..."]').fill(characterName);
    const row = this.characterRow(characterName);
    await row.waitFor({ state: 'visible' });
    await row.locator('[title="New chat"]').click({ force: true });

    // The client auto-selects new chats, but explicit selection is more reliable.
    const chatItem = this.page.locator('.chat-item').filter({ hasText: new RegExp(characterName) }).first();
    await expect(chatItem).toBeVisible({ timeout: 10000 });
    await chatItem.click();

    await expect(this.page.locator('.chat-view')).toBeVisible();
    await expect(this.page.locator('.message-bubble')).toHaveCount(1, { timeout: 5000 });
  }

  async createCharacterAndChat(opts: CreateCharacterOptions): Promise<void> {
    await this.createCharacter(opts);
    await this.startChat(opts.name);
  }

  // ── messaging ───────────────────────────────────────────────────────────

  messageInput(): Locator {
    return this.page.locator('.message-textarea');
  }

  lastBubble(role: 'user' | 'assistant'): Locator {
    return this.page.locator(`.message-bubble.${role}`).last();
  }

  /** Visible text of the last assistant message's content node. */
  async lastAssistantText(): Promise<string> {
    return (await this.lastBubble('assistant').locator('.message-content').innerText()).trim();
  }

  /**
   * Wait for the last assistant message's rendered content to contain `match`.
   * Necessary because a bubble's element exists before its streamed text lands.
   */
  async waitForAssistantText(match: RegExp | string, timeout = 10000): Promise<void> {
    await expect(this.lastBubble('assistant').locator('.message-content')).toContainText(match, { timeout });
  }

  async waitForBubbleCount(count: number, timeout = 10000): Promise<void> {
    await expect(this.page.locator('.message-bubble')).toHaveCount(count, { timeout });
  }

  /**
   * Wait for one new assistant bubble to appear (assistant count + 1) AND for its
   * streaming to settle, then return it. Waiting for streaming to finish matters:
   * the bubble exists before its text lands, and the generation lock isn't
   * released until streaming completes — so sending the next turn too early can
   * cause that generation to be dropped. Note the server broadcasts the empty
   * target bubble BEFORE prompt building, so the count bump alone is not proof
   * the reply happened — gate on real text first, then on streaming settle.
   */
  async waitForNextAssistantReply(timeout = 20000): Promise<Locator> {
    const before = await this.page.locator('.message-bubble.assistant').count();
    await expect(this.page.locator('.message-bubble.assistant')).toHaveCount(before + 1, { timeout });
    await expect(this.lastBubble('assistant').locator('.message-content')).not.toBeEmpty({ timeout });
    await expect(this.page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout });
    return this.lastBubble('assistant');
  }

  /**
   * Type a user message and send it. Asserts the input clears and the user
   * bubble renders (by text, not count — with the mock backend the assistant
   * reply can land in the same tick as the user message). When `expectReply` is
   * set, also waits for the assistant reply so the next turn appends cleanly.
   * `userText` overrides the bubble assertion for messages that render
   * differently than typed (e.g. `{{setvar}}` resolves to empty text).
   */
  async sendUserMessage(text: string, { expectReply = false, userText }: { expectReply?: boolean; userText?: string } = {}): Promise<Locator> {
    const input = this.messageInput();
    await input.fill(text);
    // Capture the assistant-bubble count BEFORE the click. The click dispatches
    // action.send + action.generate; action.generate appends and broadcasts the
    // streaming target bubble early (well before prompt building), so a count
    // captured AFTER the click can already include that bubble — making
    // `count > beforeAssistant` unsatisfiable for the very reply we are waiting
    // on, and producing a false 60s timeout.
    const beforeAssistant = expectReply
      ? await this.page.locator('.message-bubble.assistant').count()
      : 0;
    await this.page.locator('.message-input-area .send-btn').click();
    await expect(input).toHaveValue('');
    const userBubble = this.lastBubble('user');
    await expect(userBubble).toContainText(userText ?? text, { timeout: 5000 });
    if (expectReply) {
      // Wait for at least one NEW assistant reply and for its stream to settle.
      // Don't assert an exact total count: under load a slow prior turn can land
      // late and push the count past +1, which would falsely fail an exact check.
      await expect
        .poll(async () => await this.page.locator('.message-bubble.assistant').count(), {
          timeout: 60000,
          message: 'assistant reply appeared',
        })
        .toBeGreaterThan(beforeAssistant);
      // The server broadcasts the empty target assistant bubble BEFORE prompt
      // building (executeGeneration step 3), and `.streaming` is also 0 in that
      // pre-generation gap — so bubble-count + streaming-count alone can pass
      // before the generation has even started. Wait for actual streamed text
      // first (it persists once landed), then for the streaming phase to end.
      await expect(this.lastBubble('assistant').locator('.message-content')).not.toBeEmpty({
        timeout: 60000,
      });
      await expect(this.page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 30000 });
    }
    return userBubble;
  }

  // ── per-message actions ─────────────────────────────────────────────────

  async editMessage(message: Locator, newText: string): Promise<void> {
    await this.clickMessageAction(message, 'Edit');
    const textarea = this.page.locator('.message-bubble.editing .edit-textarea');
    await textarea.fill(newText);
    await this.page.locator('.message-bubble.editing button:has-text("Save")').click();
    await expect(message.locator('.message-content')).toContainText(newText, { timeout: 5000 });
  }

  async regenerate(message: Locator): Promise<void> {
    await this.clickMessageAction(message, 'Regenerate');
  }

  async hideMessage(message: Locator): Promise<void> {
    await this.clickMessageAction(message, 'Hide');
  }

  async unhideMessage(message: Locator): Promise<void> {
    await this.clickMessageAction(message, 'Unhide');
  }

  /** Fork at a message and wait for the new "Fork of ..." chat to appear. */
  async forkAt(message: Locator): Promise<void> {
    await this.clickMessageAction(message, 'Fork at this message');
    await expect(this.page.locator('.chat-list')).toContainText('Fork of', { timeout: 5000 });
  }

  // ── swipes ──────────────────────────────────────────────────────────────

  /** The swipe arrow lives inside the last assistant message's swipe-actions slot. */
  private swipeButton(direction: 'left' | 'right'): Locator {
    return this.lastBubble('assistant').locator(
      `button.action-btn.swipe-btn[title="Swipe ${direction}"]`,
    );
  }

  async swipe(direction: 'left' | 'right'): Promise<void> {
    await this.swipeButton(direction).evaluate((el: HTMLButtonElement) => el.click());
  }

  /** Current "index/total" shown by the swipe counter, e.g. "2/2". */
  async swipeCounterText(): Promise<string> {
    return (await this.page.locator('.swipe-counter').innerText()).trim();
  }

  // ── chat list / header ──────────────────────────────────────────────────

  /** The DOM id (== server chat id) of the currently active chat item. */
  async activeChatId(): Promise<string | null> {
    return this.page.locator('.chat-item.active').first().getAttribute('id');
  }

  async selectChatById(id: string): Promise<void> {
    const item = this.page.locator(`.chat-item[id="${id}"]`);
    await expect(item).toBeVisible({ timeout: 5000 });
    await item.click();
    await expect(this.page.locator('.chat-view')).toBeVisible();
  }

  async renameActiveChat(newName: string): Promise<void> {
    await this.revealHoverButtons();
    await this.page.locator('.chat-item.active [title="Rename"]').evaluate((el: HTMLButtonElement) => el.click());
    const input = this.page.locator('.chat-rename-input');
    await input.fill(newName);
    await input.press('Enter');
    await expect(this.page.locator('.chat-list')).toContainText(newName);
  }

  async deleteActiveChatViaHeader(): Promise<void> {
    await this.page.locator('.chat-header button[title="Menu"]').click();
    await this.page.locator('.dropdown-item:has-text("Delete chat")').click();
    const popup = this.page.locator('.popup-modal');
    await expect(popup).toBeVisible();
    await popup.locator('button.primary, button:has-text("Delete")').click();
    await expect(popup).not.toBeVisible();
  }

  // ── settings ────────────────────────────────────────────────────────────

  async openSettings(): Promise<Locator> {
    await this.page.locator('button.settings-btn:has-text("Settings")').click();
    const modal = this.page.locator('.settings-modal');
    await expect(modal).toBeVisible();
    return modal;
  }

  async closeSettings(): Promise<void> {
    const modal = this.page.locator('.settings-modal');
    await this.page.locator('.modal-overlay:has(.settings-modal)').click({ position: { x: 0, y: 0 } });
    await expect(modal).not.toBeVisible();
  }

  /** Open settings, flip the named checkbox, close settings. */
  async toggleSetting(labelText: string): Promise<void> {
    const settings = await this.openSettings();
    const checkbox = settings.locator(
      `label.checkbox-row:has-text("${labelText}") input[type="checkbox"]`,
    );
    const before = await checkbox.isChecked();
    await checkbox.click();
    await expect(checkbox).toBeChecked({ checked: !before });
    await this.closeSettings();
  }

  /**
   * Idempotently set a checkbox setting to `desired`. The e2e server is shared
   * across the whole suite, so settings persist between tests — `toggleSetting`
   * is unsafe for journeys that need a *known* state. Only clicks when needed.
   */
  async ensureSetting(labelText: string, desired: boolean): Promise<void> {
    const settings = await this.openSettings();
    const checkbox = settings.locator(
      `label.checkbox-row:has-text("${labelText}") input[type="checkbox"]`,
    );
    if ((await checkbox.isChecked()) !== desired) {
      await checkbox.click();
      await expect(checkbox).toBeChecked({ checked: desired });
    }
    await this.closeSettings();
  }
}
