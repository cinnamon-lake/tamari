import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { getLastLlmRequest, resetLlmRequests, waitForNextLlmRequest } from '../helpers/llm.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

/** Flatten the captured chat-completion request into one searchable string. */
function promptText(captured: { body: unknown }): string {
  const body = captured.body as Record<string, unknown>;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.map((m: Record<string, unknown>) => String(m.content ?? '')).join('\n');
}

interface EntrySpec {
  keys: string;
  content: string;
  selective?: boolean;
  secondaryKeys?: string;
  recursive?: boolean;
}

/** Create a lorebook with the given entries via the World Info editor UI. */
async function createBookWithEntries(app: App, bookName: string, entries: EntrySpec[]): Promise<void> {
  const page = app.page;
  const btn = page.locator('button.settings-btn:has-text("World Info")');
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  const editor = page.locator('.worldinfo-modal');
  await expect(editor).toBeVisible();

  await editor.locator('button:has-text("New Lorebook")').click();
  await editor.locator('.worldinfo-item').filter({ hasText: 'New Lorebook' }).first().click();
  await expect(editor.locator('.book-editor')).toBeVisible();
  await editor.locator('.book-name-input').fill(bookName);
  await editor.locator('.book-name-input').blur();

  for (const e of entries) {
    await editor.locator('button:has-text("Add Entry")').click();
    // The open entry's row is swapped for its editor, so .entry-row only
    // matches the *other* (unedited) rows — .first() is always the new entry.
    await editor.locator('.entry-row').first().click();
    await expect(editor.locator('.entry-editor')).toBeVisible();
    // Keys first: once Selective is on, "Secondary Keys" also matches "Keys".
    await editor.locator('.entry-editor label:has-text("Keys") input').fill(e.keys);
    await editor.locator('.entry-editor label:has-text("Keys") input').blur();
    await editor.locator('.entry-editor label:has-text("Content") textarea').fill(e.content);
    await editor.locator('.entry-editor label:has-text("Content") textarea').blur();
    if (e.recursive) {
      await editor.locator('.entry-editor label.field-label:has-text("Recursive") input[type="checkbox"]').click();
    }
    if (e.selective) {
      await editor.locator('.entry-editor label.field-label:has-text("Selective") input[type="checkbox"]').click();
      const secondary = editor.locator('.entry-editor label:has-text("Secondary Keys") input');
      await expect(secondary).toBeVisible();
      await secondary.fill(e.secondaryKeys ?? '');
      await secondary.blur();
    }
  }

  await page.locator('.modal-overlay:has(.worldinfo-modal)').click({ position: { x: 0, y: 0 } });
  await expect(editor).not.toBeVisible();
}

/**
 * Create a character linked to a lorebook. The link is selected BEFORE filling
 * fields so every debounced auto-save includes worldInfoId (the 'Saved'
 * indicator then proves the link reached the server) — see wi-decorators.spec.
 */
async function createLinkedCharacter(page: App['page'], charName: string, bookName: string, entriesCount: number): Promise<void> {
  await page.locator('[title="Create character"]').click();
  const charEditor = page.locator('.character-editor-modal');
  await charEditor.locator('.lorebook-selector select').selectOption({ label: `${bookName} (${entriesCount} entries)` });
  await charEditor.locator('.text-input').first().fill(charName);
  await charEditor.locator('.textarea-input').nth(0).fill('Test character.');
  await charEditor.locator('.textarea-input').nth(3).fill(`Hello! I am ${charName}.`);
  await expect(charEditor.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
  await charEditor.locator('[title="Close"]').click();
}

test.describe('Prompt Assembly', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test("author's note is injected into the prompt", async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({ name: uniqueName('AN Char'), firstMes: 'Ready.' });

    await page.locator('.chat-header button[title="Menu"]').click();
    await page.locator(".dropdown-item:has-text(\"Author's Note\")").click();
    const noteInput = page.locator('.authors-note-content-input');
    await expect(noteInput).toBeVisible();
    await noteInput.fill('[AN] AN_NOTE_TOKEN');
    await expect(page.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
    await expectNoAxeViolations(page);
    await page.locator('.authors-note-close-btn').click();
    await expect(noteInput).not.toBeVisible();

    await app.sendUserMessage('hello', { expectReply: true });
    expect(promptText(await getLastLlmRequest())).toContain('AN_NOTE_TOKEN');
  });

  test('recursive world-info entries chain-activate', async ({ page }) => {
    const app = new App(page);
    const bookName = uniqueName('RecurBook');
    // Entry A is recursive: its content joins the next scan round, so the
    // 'bravokey' inside it triggers entry B even though the user never typed it.
    await createBookWithEntries(app, bookName, [
      { keys: 'alphakey', content: '[WI] RECUR_A bravokey', recursive: true },
      { keys: 'bravokey', content: '[WI] RECUR_B' },
    ]);
    const charName = uniqueName('RecurChar');
    await createLinkedCharacter(page, charName, bookName, 2);
    await app.startChat(charName);

    await app.sendUserMessage('alphakey', { expectReply: true });
    const all = promptText(await getLastLlmRequest());
    expect(all).toContain('RECUR_A');
    expect(all).toContain('RECUR_B');
  });

  test('selective entry requires primary AND secondary keys', async ({ page }) => {
    const app = new App(page);
    const bookName = uniqueName('SelBook');
    await createBookWithEntries(app, bookName, [
      { keys: 'magic', content: '[WI] SELECTIVE_TOKEN', selective: true, secondaryKeys: 'wand' },
    ]);
    const charName = uniqueName('SelChar');
    await createLinkedCharacter(page, charName, bookName, 1);
    await app.startChat(charName);

    // Primary key alone → suppressed.
    await app.sendUserMessage('magic', { expectReply: true });
    expect(promptText(await getLastLlmRequest())).not.toContain('SELECTIVE_TOKEN');

    // Scan window now covers both messages: primary + secondary → fires.
    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('magic wand', { expectReply: true });
    expect(promptText(await waitForNextLlmRequest(before))).toContain('SELECTIVE_TOKEN');
  });

  test('hidden messages are excluded from the prompt', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({ name: uniqueName('Hide Char'), firstMes: 'Ready.' });

    const userBubble = await app.sendUserMessage('secretphrase', { expectReply: true });
    await app.hideMessage(userBubble);
    await app.sendUserMessage('another turn', { expectReply: true });

    expect(promptText(await getLastLlmRequest())).not.toContain('secretphrase');
  });

  test('edited message text reaches the next prompt', async ({ page }) => {
    const app = new App(page);
    await app.createCharacterAndChat({ name: uniqueName('Edit Char'), firstMes: 'Ready.' });

    const userBubble = await app.sendUserMessage('original text', { expectReply: true });
    await app.editMessage(userBubble, 'edited text');
    await app.sendUserMessage('second turn', { expectReply: true });

    const all = promptText(await getLastLlmRequest());
    expect(all).toContain('edited text');
    expect(all).not.toContain('original text');
  });
});
