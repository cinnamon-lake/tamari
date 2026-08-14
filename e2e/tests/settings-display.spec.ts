import { test, expect, type Locator, type Page } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { App } from '../helpers/app.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

// Minimal 1x1 transparent PNG (same fixture as attachments.spec.ts).
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function pngFile() {
  return { name: 'display-test.png', mimeType: 'image/png', buffer: Buffer.from(PNG_BASE64, 'base64') };
}

/** Idempotently set a checkbox row inside the open settings modal. */
async function setCheckbox(modal: Locator, label: string, desired: boolean): Promise<void> {
  const checkbox = modal.locator(`label.checkbox-row:has-text("${label}") input[type="checkbox"]`);
  if ((await checkbox.isChecked()) !== desired) {
    await checkbox.click();
    await expect(checkbox).toBeChecked({ checked: desired });
  }
}

/** A `label.field-label` select inside the open settings modal. */
function settingSelect(modal: Locator, label: string): Locator {
  return modal.locator(`label.field-label:has-text("${label}") select`);
}

/** Read an inline CSS custom property from documentElement (set by DesignTokenInjector). */
async function rootCssVar(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => document.documentElement.style.getPropertyValue(n).trim(), name);
}

test.describe('Settings — Display', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test('chat style, avatar style, shadows, compact input, reduced motion', async ({ page }) => {
    test.setTimeout(90000);
    const app = new App(page);
    const name = uniqueName('DisplayStyle');
    await app.createCharacterAndChat({ name, firstMes: `Hello from ${name}.` });

    const modal = await app.openSettings();

    // chatStyle: DesignTokenInjector swaps a `chat-style-*` class on .messages.
    await settingSelect(modal, 'Chat Style').selectOption('bubbles');
    await expect(page.locator('.messages')).toHaveClass(/chat-style-bubbles/);
    await settingSelect(modal, 'Chat Style').selectOption('document');
    await expect(page.locator('.messages')).toHaveClass(/chat-style-document/);
    await settingSelect(modal, 'Chat Style').selectOption('default');
    await expect(page.locator('.messages')).toHaveClass(/chat-style-default/);

    // avatarStyle: mapped to the --avatar-border-radius CSS var on :root.
    await settingSelect(modal, 'Avatar Style').selectOption('rectangular');
    await expect.poll(() => rootCssVar(page, '--avatar-border-radius')).toBe('0');
    await settingSelect(modal, 'Avatar Style').selectOption('round');
    await expect.poll(() => rootCssVar(page, '--avatar-border-radius')).toBe('50%');

    // shadowWidth: 0 flattens the UI (the old "No shadows" checkbox was merged
    // into the slider); 1 restores the default intensity.
    const shadowSlider = modal.locator('label.field-label:has-text("Shadow Width") input[type="range"]');
    await shadowSlider.fill('0');
    await expect.poll(() => rootCssVar(page, '--shadow-opacity')).toBe('0');
    await shadowSlider.fill('1');
    await expect.poll(() => rootCssVar(page, '--shadow-opacity')).toBe('1');

    // compactInputArea: toggles a class on the app shell.
    await setCheckbox(modal, 'Compact input area', true);
    await expect(page.locator('.app-shell')).toHaveClass(/compact-input/);
    await setCheckbox(modal, 'Compact input area', false);
    await expect(page.locator('.app-shell')).not.toHaveClass(/compact-input/);

    // reducedMotion: toggles a class on documentElement.
    await setCheckbox(modal, 'Reduced motion (disable animations)', true);
    await expect(page.locator('html')).toHaveClass(/reduced-motion/);
    await setCheckbox(modal, 'Reduced motion (disable animations)', false);
    await expect(page.locator('html')).not.toHaveClass(/reduced-motion/);

    await app.closeSettings();
  });

  test('avatars, names, message ids, swipe numbers on all messages', async ({ page }) => {
    test.setTimeout(120000);
    const app = new App(page);
    const name = uniqueName('DisplayChrome');
    await app.createCharacterAndChat({ name, firstMes: `Hello from ${name}.` });

    // Build a non-last assistant message with two swipes: reply, regenerate,
    // then another turn so the swiped message is no longer last.
    await app.sendUserMessage('seq:first', { expectReply: true });
    await app.regenerate(app.lastBubble('assistant'));
    await expect(page.locator('.swipe-counter')).toHaveText('2/2', { timeout: 30000 });
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 30000 });
    await app.sendUserMessage('seq:second', { expectReply: true });

    // Assistant bubbles: [greeting, swiped reply (non-last), latest reply].
    const swipedBubble = page.locator('.message-bubble.assistant').nth(1);
    await expect(swipedBubble.locator('.swipe-counter')).toHaveCount(0);

    const modal = await app.openSettings();

    // Test characters/personas have no avatar images, so the observable effect
    // is the `hide-avatar` class on the bubbles (the <img> only exists with a src).
    await setCheckbox(modal, 'Hide chat avatars', true);
    await expect(page.locator('.message-bubble.hide-avatar').first()).toBeVisible();
    await setCheckbox(modal, 'Hide chat avatars', false);
    await expect(page.locator('.message-bubble.hide-avatar')).toHaveCount(0);

    await setCheckbox(modal, 'Hide chat names', true);
    await expect(page.locator('.message-role')).toHaveCount(0);
    await setCheckbox(modal, 'Hide chat names', false);
    await expect(page.locator('.message-role').first()).toBeVisible();

    await setCheckbox(modal, 'Show message IDs', true);
    await expect(page.locator('.message-id').first()).toBeVisible();
    await expect(page.locator('.message-id').first()).toContainText('#');
    await setCheckbox(modal, 'Show message IDs', false);
    await expect(page.locator('.message-id')).toHaveCount(0);

    // The last message always shows its swipe counter (two swipes exist).
    // Note: a *non-last* swipe counter is not reachable in a 1:1 chat — the
    // server replaces the swipe set with the current head's children on every
    // generation snapshot (server/src/lib/swipeInfo.ts), so a non-last message
    // never carries swipe data. Assert the reachable behavior instead: the
    // toggle round-trips to the server and leaks no chrome onto old messages.
    await setCheckbox(modal, 'Show swipe numbers on all messages', true);
    await app.closeSettings();
    const modal2 = await app.openSettings();
    await expect(
      modal2.locator('label.checkbox-row:has-text("Show swipe numbers on all messages") input[type="checkbox"]'),
    ).toBeChecked();
    await expect(swipedBubble.locator('.swipe-counter')).toHaveCount(0);
    await setCheckbox(modal2, 'Show swipe numbers on all messages', false);

    await app.closeSettings();
  });

  test('encodeTags, hotswap bar, model timestamps, toast position', async ({ page }) => {
    test.setTimeout(90000);
    const app = new App(page);
    const name = uniqueName('DisplayMisc');
    await app.createCharacterAndChat({ name, firstMes: `Hello from ${name}.` });
    await app.sendUserMessage('respond:a plain reply', { expectReply: true });

    const modal = await app.openSettings();

    // encodeTags: bubbles render raw escaped text in <pre.encoded-tags> instead of HTML.
    await setCheckbox(modal, 'Show raw message text (encode tags)', true);
    await expect(page.locator('.encoded-tags').first()).toBeVisible();
    await expect(page.locator('.message-content')).toHaveCount(0);
    await setCheckbox(modal, 'Show raw message text (encode tags)', false);
    await expect(page.locator('.message-content').first()).toBeVisible();

    // showHotswapBar (default on): the bar lists characters that have chats.
    await expect(page.locator('.hotswap-bar')).toBeVisible();
    await setCheckbox(modal, 'Show recently-used character bar', false);
    await expect(page.locator('.hotswap-bar')).toHaveCount(0);
    await setCheckbox(modal, 'Show recently-used character bar', true);
    await expect(page.locator('.hotswap-bar')).toBeVisible();

    // timestampModelIcon: mock replies carry extra.model = 'mock-model'.
    await setCheckbox(modal, 'Show model name in message timestamps', true);
    await expect(app.lastBubble('assistant').locator('.message-model')).toContainText('mock-model');
    await setCheckbox(modal, 'Show model name in message timestamps', false);
    await expect(page.locator('.message-model')).toHaveCount(0);

    // toastPosition: the container class follows the setting; an unknown
    // /persona name raises an error toast.
    await settingSelect(modal, 'Toast position').selectOption('bottom-left');
    await expect(page.locator('.toast-container')).toHaveClass(/toast-position-bottom-left/);

    await app.closeSettings();

    await app.messageInput().fill('/persona definitively-not-a-persona');
    await page.locator('.message-input-area .send-btn').click();
    await expect(page.locator('.toast-container.toast-position-bottom-left .toast')).toBeVisible();

    const modal2 = await app.openSettings();
    await settingSelect(modal2, 'Toast position').selectOption('top-right');
    await expect(page.locator('.toast-container')).toHaveClass(/toast-position-top-right/);
    await app.closeSettings();
  });

  test('click to edit, auto-focus input, never resize avatars', async ({ page }) => {
    test.setTimeout(120000);
    const app = new App(page);
    const name = uniqueName('DisplayInteract');
    await app.createCharacterAndChat({ name, firstMes: `Hello from ${name}.` });
    await app.sendUserMessage('respond:interaction probe', { expectReply: true });

    // clickToEdit: clicking a bubble's content opens inline edit mode.
    await app.ensureSetting('Click message to edit', true);
    await app.lastBubble('user').locator('.message-content').click();
    await expect(page.locator('.message-bubble.editing .edit-textarea')).toBeVisible();
    await page.locator('.message-bubble.editing button:has-text("Cancel")').click();
    await expect(page.locator('.message-bubble.editing')).toHaveCount(0);
    await app.ensureSetting('Click message to edit', false);
    await app.lastBubble('user').locator('.message-content').click();
    await expect(page.locator('.message-bubble.editing')).toHaveCount(0);

    // autoSelectInput: switching chats focuses the message textarea.
    await app.startChat(name); // second chat for the same character
    await app.ensureSetting('Auto-focus input when switching chats', true);
    await page.locator('.chat-item:not(.active)').first().click();
    await expect(page.locator('.chat-item.active')).toBeVisible();
    await expect(app.messageInput()).toBeFocused();
    await app.ensureSetting('Auto-focus input when switching chats', false);

    // neverResizeAvatars: avatar upload skips the crop dialog when enabled.
    await app.revealHoverButtons();
    const row = app.characterRow(name);
    await row.locator('[title="Edit character"]').click({ force: true });
    const editor = page.locator('.character-editor-modal');
    await expect(editor).toBeVisible();

    // Default (off): the crop modal opens.
    await editor.locator('.hidden-file-input').setInputFiles(pngFile());
    await expect(page.locator('.crop-modal')).toBeVisible();
    await page.locator('.crop-modal-cancel-btn').click();
    await expect(page.locator('.crop-modal')).not.toBeVisible();
    await editor.locator('[title="Close"]').click();
    await expect(editor).not.toBeVisible();

    // On: the file uploads directly (POST to the avatar endpoint), no crop modal.
    // (The editor's SafeImage renders nothing when the character has no avatar
    // yet, so the upload POST — not the <img> — is the observable signal.)
    await app.ensureSetting('Never resize avatars (skip crop dialog)', true);
    await app.revealHoverButtons();
    await app.characterRow(name).locator('[title="Edit character"]').click({ force: true });
    await expect(editor).toBeVisible();
    const uploadResponse = page.waitForResponse(
      (resp) =>
        resp.request().method() === 'POST' &&
        /\/api\/characters\/[^/]+\/avatar/.test(resp.url()),
      { timeout: 10000 },
    );
    await editor.locator('.hidden-file-input').setInputFiles(pngFile());
    await uploadResponse;
    await expect(page.locator('.crop-modal')).toHaveCount(0);
    await editor.locator('[title="Close"]').click();
    await expect(editor).not.toBeVisible();
    await app.ensureSetting('Never resize avatars (skip crop dialog)', false);
  });

  test('media display mode and external media CSP', async ({ page }) => {
    test.setTimeout(90000);
    const app = new App(page);
    const name = uniqueName('DisplayMedia');
    await app.createCharacterAndChat({ name, firstMes: `Hello from ${name}.` });

    // Upload an image attachment and send it with the message.
    await page.locator('.message-input-area .hidden-file-input').setInputFiles(pngFile());
    await expect(page.locator('.attachment-previews .attachment-preview')).toBeVisible({ timeout: 5000 });
    await app.sendUserMessage('respond:media reply', { expectReply: true });

    const attachments = app.lastBubble('user').locator('.message-attachments');
    await expect(attachments).toBeVisible();
    await expect(attachments).not.toHaveClass(/grid/);

    const modal = await app.openSettings();
    await settingSelect(modal, 'Media display mode').selectOption('grid');
    await expect(attachments).toHaveClass(/grid/);
    await settingSelect(modal, 'Media display mode').selectOption('list');
    await expect(attachments).not.toHaveClass(/grid/);

    // allowExternalMedia: relaxes the CSP img-src directive with '*'.
    const cspOf = async () => {
      const resp = await page.request.get('/');
      return resp.headers()['content-security-policy'] ?? '';
    };
    await setCheckbox(modal, 'Allow external images', false);
    await expect.poll(cspOf).not.toMatch(/img-src[^;]*\*/);
    await setCheckbox(modal, 'Allow external images', true);
    await expect.poll(cspOf).toMatch(/img-src[^;]*\*/);
    await setCheckbox(modal, 'Allow external images', false);
    await expect.poll(cspOf).not.toMatch(/img-src[^;]*\*/);

    await app.closeSettings();
  });

  test('strict HTML sanitization', async ({ page }) => {
    test.setTimeout(90000);
    const app = new App(page);
    const name = uniqueName('DisplaySanitize');
    await app.createCharacterAndChat({ name, firstMes: `Hello from ${name}.` });

    // Default (permissive) sanitization keeps <h1> (strict blocks it). The
    // user's own bubble renders the h1 as an element, so assert by probe text.
    await app.sendUserMessage('respond:<h1>SanitizeProbeOne</h1>', { expectReply: true, userText: 'SanitizeProbeOne' });
    await expect(app.lastBubble('assistant').locator('.message-content h1')).toContainText('SanitizeProbeOne');

    await app.ensureSetting('Strict HTML sanitization', true);
    await app.sendUserMessage('respond:<h1>SanitizeProbeTwo</h1>', { expectReply: true, userText: 'SanitizeProbeTwo' });
    const strictContent = app.lastBubble('assistant').locator('.message-content');
    await expect(strictContent).toContainText('SanitizeProbeTwo');
    await expect(strictContent.locator('h1')).toHaveCount(0);
    await app.ensureSetting('Strict HTML sanitization', false);
  });

  test('fuzzy character search', async ({ page }) => {
    test.setTimeout(60000);
    const app = new App(page);
    const name = uniqueName('Alice Fzprobe');
    await app.createCharacter({ name });

    const search = page.locator('input[placeholder="Search characters..."]');
    const row = app.characterRow(name);

    // 'Alce' is a subsequence (not substring) of 'Alice': only fuzzy matches.
    await app.ensureSetting('Fuzzy character search', false);
    await search.fill('Alce');
    await expect(page.locator('.character-list li', { hasText: name })).toHaveCount(0);

    await app.ensureSetting('Fuzzy character search', true);
    await search.fill('Alce');
    await expect(row).toBeVisible();

    await app.ensureSetting('Fuzzy character search', false);
    await search.fill('');
  });

  test('display settings persist across reload', async ({ page }) => {
    test.setTimeout(90000);
    const app = new App(page);
    const name = uniqueName('DisplayPersist');
    await app.createCharacterAndChat({ name, firstMes: `Hello from ${name}.` });

    await app.ensureSetting('Compact input area', true);
    await app.ensureSetting('Hide chat names', true);
    await app.waitForSettingSaved('compactInputArea', true);
    await app.waitForSettingSaved('hideChatNames', true);

    await page.reload();
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 10000 });
    await expect(page.locator('.app-shell')).toHaveClass(/compact-input/);

    // Reopen the chat; names should still be hidden.
    await page.locator('.chat-item').first().click();
    await expect(page.locator('.chat-view')).toBeVisible();
    await expect(page.locator('.message-bubble').first()).toBeVisible();
    await expect(page.locator('.message-role')).toHaveCount(0);

    await app.ensureSetting('Compact input area', false);
    await app.ensureSetting('Hide chat names', false);
  });
});
