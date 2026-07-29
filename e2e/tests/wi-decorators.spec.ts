import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, patchActiveBackendConfig, resetBackendConfig } from '../helpers/backendConfig.js';
import { getLastLlmRequest, resetLlmRequests, waitForNextLlmRequest } from '../helpers/llm.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

/**
 * Helper: create a lorebook with one entry whose content starts with V3 decorators,
 * then link it to a new character + start a chat.
 */
async function setupDecoratorEntry(
  app: App,
  bookName: string,
  key: string,
  contentWithDecorators: string,
): Promise<void> {
  const page = app.page;
  // Open World Info editor
  const btn = page.locator('button.settings-btn:has-text("World Info")');
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  const editor = page.locator('.worldinfo-modal');
  await expect(editor).toBeVisible();

  // Create a new lorebook
  await editor.locator('button:has-text("New Lorebook")').click();
  await editor.locator('.worldinfo-item').filter({ hasText: 'New Lorebook' }).first().click();
  await expect(editor.locator('.book-editor')).toBeVisible();
  await editor.locator('.book-name-input').fill(bookName);
  await editor.locator('.book-name-input').blur();

  // Add an entry with decorator-prefixed content
  await editor.locator('button:has-text("Add Entry")').click();
  await editor.locator('.entry-row').first().click();
  await expect(editor.locator('.entry-editor')).toBeVisible();

  await editor.locator('.entry-editor label:has-text("Keys") input').fill(key);
  await editor.locator('.entry-editor label:has-text("Keys") input').blur();

  const contentArea = editor.locator('.entry-editor label:has-text("Content") textarea');
  await contentArea.fill(contentWithDecorators);
  await contentArea.blur();

  // Close the WI editor
  await page.locator('.modal-overlay:has(.worldinfo-modal)').click({ position: { x: 0, y: 0 } });
  await expect(editor).not.toBeVisible();
}

test.describe('WI V3 Decorators', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test('@@activate fires entry without keyword match', async ({ page }) => {
    const app = new App(page);
    const bookName = uniqueName('DecoActivate');
    // @@activate forces activation; content has [WI] sentinel for the mock to echo.
    await setupDecoratorEntry(app, bookName, 'nonexistentkeyword', '@@activate\n[WI] DECO_ACTIVATE');

    // Create a character linked to this lorebook
    const charName = uniqueName('DecoChar1');
    await page.locator('[title="Create character"]').click();
    const charEditor = page.locator('.character-editor-modal');
    // Link the lorebook BEFORE filling fields: the debounced auto-save (600ms)
    // that the 'Saved' indicator confirms must include worldInfoId — selecting
    // it last raced that debounce against the first generation's prompt build.
    await charEditor.locator('.lorebook-selector select').selectOption({ label: `${bookName} (1 entries)` });
    await charEditor.locator('.text-input').first().fill(charName);
    await charEditor.locator('.textarea-input').nth(0).fill('Test character.');
    await charEditor.locator('.textarea-input').nth(3).fill(`Hello! I am ${charName}.`);
    await expect(charEditor.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
    await charEditor.locator('[title="Close"]').click();

    // Start a chat + send a message that does NOT contain the keyword
    await app.startChat(charName);
    await app.sendUserMessage('hello there', { expectReply: true });

    // The mock echoes [WI] tokens that reached the prompt. @@activate should
    // have fired the entry despite no keyword match.
    const captured = await getLastLlmRequest();
    const body = captured.body as Record<string, unknown>;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const allText = messages.map((m: Record<string, unknown>) => String(m.content ?? '')).join('\n');
    expect(allText).toContain('DECO_ACTIVATE');
    // The @@ decorator prefix must NOT leak into the prompt
    expect(allText).not.toContain('@@activate');
  });

  test('@@dont_activate suppresses entry even with keyword match', async ({ page }) => {
    const app = new App(page);
    const bookName = uniqueName('DecoDont');
    // @@dont_activate + a keyword that WILL match → entry should NOT fire.
    await setupDecoratorEntry(app, bookName, 'magic', '@@dont_activate\n[WI] DECO_SUPPRESSED');

    const charName = uniqueName('DecoChar2');
    await page.locator('[title="Create character"]').click();
    const charEditor = page.locator('.character-editor-modal');
    // Link first — same auto-save debounce vs prompt-build race as above.
    await charEditor.locator('.lorebook-selector select').selectOption({ label: `${bookName} (1 entries)` });
    await charEditor.locator('.text-input').first().fill(charName);
    await charEditor.locator('.textarea-input').nth(0).fill('Test character.');
    await charEditor.locator('.textarea-input').nth(3).fill(`Hello! I am ${charName}.`);
    await expect(charEditor.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
    await charEditor.locator('[title="Close"]').click();

    await app.startChat(charName);
    // Send a message containing the keyword "magic" — but @@dont_activate should suppress it.
    await app.sendUserMessage('tell me about magic', { expectReply: true });

    const captured = await getLastLlmRequest();
    const body = captured.body as Record<string, unknown>;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const allText = messages.map((m: Record<string, unknown>) => String(m.content ?? '')).join('\n');
    expect(allText).not.toContain('DECO_SUPPRESSED');
    expect(allText).not.toContain('@@dont_activate');
  });

  test('@@depth injects at depth and @@role sets system role', async ({ page }) => {
    const app = new App(page);
    const bookName = uniqueName('DecoDepth');
    // @@depth 0 + @@role system → inject as a system message at the end of context.
    await setupDecoratorEntry(app, bookName, 'depthkey', '@@depth 0\n@@role system\n[WI] DECO_DEPTH');

    const charName = uniqueName('DecoChar3');
    await page.locator('[title="Create character"]').click();
    const charEditor = page.locator('.character-editor-modal');
    // Link first — same auto-save debounce vs prompt-build race as above.
    await charEditor.locator('.lorebook-selector select').selectOption({ label: `${bookName} (1 entries)` });
    await charEditor.locator('.text-input').first().fill(charName);
    await charEditor.locator('.textarea-input').nth(0).fill('Test character.');
    await charEditor.locator('.textarea-input').nth(3).fill(`Hello! I am ${charName}.`);
    await expect(charEditor.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
    await charEditor.locator('[title="Close"]').click();

    await app.startChat(charName);
    await app.sendUserMessage('depthkey trigger', { expectReply: true });

    const captured = await getLastLlmRequest();
    const body = captured.body as Record<string, unknown>;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const allText = messages.map((m: Record<string, unknown>) => String(m.content ?? '')).join('\n');
    expect(allText).toContain('DECO_DEPTH');
    // No @@ leak
    expect(allText).not.toContain('@@depth');
    expect(allText).not.toContain('@@role');
  });

  test('unknown @@ decorator does not leak into prompt', async ({ page }) => {
    const app = new App(page);
    const bookName = uniqueName('DecoUnknown');
    // Unknown @@ decorator → consumed (not leaked). Content after it is the real content.
    await setupDecoratorEntry(app, bookName, 'unknownkey', '@@unknown_decorator foo\n[WI] DECO_UNKNOWN');

    const charName = uniqueName('DecoChar4');
    await page.locator('[title="Create character"]').click();
    const charEditor = page.locator('.character-editor-modal');
    // Link first — same auto-save debounce vs prompt-build race as above.
    await charEditor.locator('.lorebook-selector select').selectOption({ label: `${bookName} (1 entries)` });
    await charEditor.locator('.text-input').first().fill(charName);
    await charEditor.locator('.textarea-input').nth(0).fill('Test character.');
    await charEditor.locator('.textarea-input').nth(3).fill(`Hello! I am ${charName}.`);
    await expect(charEditor.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
    await charEditor.locator('[title="Close"]').click();

    await app.startChat(charName);
    await app.sendUserMessage('unknownkey trigger', { expectReply: true });

    const captured = await getLastLlmRequest();
    const body = captured.body as Record<string, unknown>;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const allText = messages.map((m: Record<string, unknown>) => String(m.content ?? '')).join('\n');
    // The [WI] content should be injected (keyword matched)
    expect(allText).toContain('DECO_UNKNOWN');
    // The unknown @@ line must NOT leak
    expect(allText).not.toContain('@@unknown_decorator');
  });
});
