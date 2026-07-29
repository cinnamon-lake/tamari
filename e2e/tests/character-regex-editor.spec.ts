import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

test.describe('Character Regex Editor UI', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test('add a scoped display rule in the editor; assistant text renders transformed', async ({ page }) => {
    const app = new App(page);
    const name = uniqueName('Regex UI Host');
    await app.createCharacter({ name, firstMes: 'Ready.' });

    // Reopen the editor (createCharacter closes it after auto-save).
    await app.revealHoverButtons();
    await page.locator('input[placeholder="Search characters..."]').fill(name);
    const row = app.characterRow(name);
    await row.waitFor({ state: 'visible' });
    await row.locator('[title="Edit character"]').click({ force: true });

    const editor = page.locator('.character-editor-modal');
    await expect(editor).toBeVisible();
    // The character's id is exposed for referencing in chat.
    await expect(editor.locator('.id-badge')).toBeVisible();

    // Add a display rule via the scoped regex editor — it lives on the
    // "Logic & Rules" tab since the editor became tabbed.
    await editor.locator('#editor-tab-logic').click();
    await editor.locator('button:has-text("New Regex Rule")').click();
    const form = editor.locator('.regex-edit-form');
    await form.locator('input').nth(0).fill('Shout');
    await form.locator('input').nth(1).fill('/deterministic/g');
    await form.locator('textarea').first().fill('DETERMINISTIC');
    await editor.locator('button:has-text("Save Rule")').click();

    // Rule row appears; auto-save flushes.
    await expect(editor.locator('.character-regex-editor')).toContainText('Shout');
    await expect(editor.locator('.save-indicator')).toContainText('Saved', { timeout: 5000 });
    await editor.locator('[title="Close"]').click();
    await expect(editor).not.toBeVisible();

    // The default mock reply contains "deterministic" — the display rule must
    // transform it at render time (server-side, character-scoped).
    await app.startChat(name);
    await app.sendUserMessage('hello', { expectReply: true });
    const bubble = app.lastBubble('assistant');
    await expect(bubble).toContainText('DETERMINISTIC mock response', { timeout: 10000 });
    await expect(bubble).not.toContainText('deterministic mock response');
  });
});
