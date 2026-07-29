/**
 * UX/UI audit screenshot pass.
 *
 * Walks the same shape as the long-roleplay journey (character → conversation
 * → edit → swipe → fork → return) plus the major settings surfaces, and takes
 * viewport screenshots at each breakpoint into e2e/ux-audit/shots/.
 *
 * Not part of CI — run via playwright.ux-audit.config.ts.
 *
 * Desktop pass uses the default 1280x720 viewport; the mobile pass reruns the
 * core flow at 390x844 to check responsive behavior.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { login, TEST_SECRET } from '../helpers/auth.js';
import { configureMockBackend } from '../helpers/backendConfig.js';
import { App } from '../helpers/app.js';

// Tests are launched from the e2e/ directory (see package.json scripts).
const shotsDir = path.join(process.cwd(), 'ux-audit', 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

async function shot(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
}

test.describe('UX audit — desktop', () => {
  test('breakpoint screenshots along the long journey', async ({ page }) => {
    const charName = `Audit Char ${Date.now()}`;
    const greeting = `Hello! I am ${charName}. Ask me anything.`;

    // ── 1. First-run: auth gate ──────────────────────────────────────────
    await page.goto('/');
    await expect(page.locator('[data-testid="auth-input"]')).toBeVisible({ timeout: 10000 });
    await shot(page, '01-login');

    await page.locator('[data-testid="auth-input"]').fill(TEST_SECRET);
    await page.locator('[data-testid="auth-submit"]').click();
    await expect(page.locator('.app-shell')).toBeVisible({ timeout: 10000 });
    await configureMockBackend(page);
    const app = new App(page);

    // ── 2. Empty app state (fresh data dir: no characters, no chats) ─────
    await shot(page, '02-app-empty-state');

    // ── 3. Character creation ────────────────────────────────────────────
    await page.locator('[title="Create character"]').click();
    const editor = page.locator('.character-editor-modal');
    await expect(editor).toBeVisible();
    await shot(page, '03-character-editor-empty');
    await editor.locator('.text-input').first().fill(charName);
    await editor.locator('.textarea-input').nth(0).fill('A character for the UX audit journey.');
    await editor.locator('.textarea-input').nth(3).fill(greeting);
    await expect(editor.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
    await shot(page, '04-character-editor-filled');
    await editor.locator('[title="Close"]').click();
    await expect(editor).not.toBeVisible();
    await page.locator('input[placeholder="Search characters..."]').fill(charName);
    await expect(page.locator('.character-list li', { hasText: charName })).toBeVisible();

    // ── 4. World Info ────────────────────────────────────────────────────
    const wiBtn = page.locator('button.settings-btn:has-text("World Info")');
    await wiBtn.scrollIntoViewIfNeeded();
    await wiBtn.click();
    const wiModal = page.locator('.worldinfo-modal');
    await expect(wiModal).toBeVisible();
    await shot(page, '05-worldinfo-empty');
    await wiModal.locator('button:has-text("New Lorebook")').click();
    await wiModal.locator('.worldinfo-item').filter({ hasText: 'New Lorebook' }).first().click();
    await expect(wiModal.locator('.book-editor')).toBeVisible();
    await wiModal.locator('.book-name-input').fill('Audit Lorebook');
    await wiModal.locator('.book-name-input').blur();
    await wiModal.locator('button:has-text("Add Entry")').click();
    await wiModal.locator('.entry-row').first().click();
    await expect(wiModal.locator('.entry-editor')).toBeVisible();
    await wiModal.locator('.entry-editor label:has-text("Keys") input').fill('kingdom');
    await wiModal.locator('.entry-editor label:has-text("Keys") input').blur();
    await wiModal.locator('.entry-editor label:has-text("Content") textarea').fill('[WI] The kingdom is called Auditia.');
    await wiModal.locator('.entry-editor label:has-text("Content") textarea').blur();
    await shot(page, '06-worldinfo-entry-editor');
    await page.locator('.modal-overlay:has(.worldinfo-modal)').click({ position: { x: 0, y: 0 } });
    await expect(wiModal).not.toBeVisible();

    // ── 5. Start a chat: greeting ────────────────────────────────────────
    await app.startChat(charName);
    await expect(page.locator('.message-bubble.assistant').first()).toContainText(greeting);
    await shot(page, '07-chat-greeting');

    // ── 6. Multi-turn conversation ───────────────────────────────────────
    const turns = [
      'seq:Tell me about the kingdom.',
      'seq:Who are its enemies?',
      'seq:Describe the marketplace.',
    ];
    let expected = 1;
    for (const text of turns) {
      await app.sendUserMessage(text, { expectReply: true });
      expected += 2;
      await app.waitForBubbleCount(expected);
    }
    await shot(page, '08-chat-multiturn');

    // ── 7. Hover-gated message actions (real hover, no automation hack) ──
    const lastAssistant = app.lastBubble('assistant');
    await lastAssistant.hover();
    await page.waitForTimeout(400); // let the opacity transition finish
    await shot(page, '09-message-hover-actions');

    // ── 8. In-place edit ─────────────────────────────────────────────────
    await app.clickMessageAction(lastAssistant, 'Edit');
    await expect(page.locator('.message-bubble.editing .edit-textarea')).toBeVisible();
    await shot(page, '10-message-edit-mode');
    await page.locator('.message-bubble.editing button:has-text("Cancel")').click().catch(async () => {
      // fall back to saving unchanged if there is no Cancel button
      await page.locator('.message-bubble.editing button:has-text("Save")').click();
    });
    await expect(page.locator('.message-bubble.editing')).toHaveCount(0);

    // ── 9. Regenerate → swipes ───────────────────────────────────────────
    await app.regenerate(lastAssistant);
    await expect(page.locator('.swipe-counter')).toHaveText('2/2', { timeout: 10000 });
    await app.waitForAssistantText(/Turn \d+/);
    await shot(page, '11-swipe-navigation');

    // ── 10. Chat header menu ─────────────────────────────────────────────
    await page.locator('.chat-header button[title="Menu"]').click();
    await expect(page.locator('.dropdown-item').first()).toBeVisible();
    await shot(page, '12-chat-header-menu');
    await page.keyboard.press('Escape');

    // ── 11. Settings modal ───────────────────────────────────────────────
    const settings = await app.openSettings();
    await shot(page, '13-settings-modal');
    await app.closeSettings();
    await expect(settings).not.toBeVisible();

    // ── 12. Backend config modal ─────────────────────────────────────────
    const bcBtn = page.locator('button.settings-btn:has-text("Backend")');
    await bcBtn.scrollIntoViewIfNeeded();
    await bcBtn.click();
    const bcModal = page.locator('.modal-overlay').last();
    await expect(bcModal).toBeVisible();
    await page.waitForTimeout(300);
    await shot(page, '14-backend-config-modal');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // ── 13. Persona manager ──────────────────────────────────────────────
    const personaBtn = page.locator('button.settings-btn:has-text("Personas")');
    await personaBtn.scrollIntoViewIfNeeded();
    await personaBtn.click();
    await page.waitForTimeout(300);
    await shot(page, '15-persona-manager');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // ── 14. Fork + rename, populated sidebar ─────────────────────────────
    const originalChatId = await app.activeChatId();
    const firstUser = page.locator('.message-bubble.user').first();
    await app.forkAt(firstUser);
    const forkName = `Audit Branch ${Date.now()}`;
    await app.renameActiveChat(forkName);
    await expect(page.locator('.chat-list')).toContainText(forkName);
    await app.selectChatById(originalChatId as string);
    await shot(page, '16-sidebar-populated');
  });
});

test.describe('UX audit — mobile (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('core flow at mobile viewport', async ({ page }) => {
    const charName = `Audit Mobile ${Date.now()}`;

    await page.goto('/');
    await expect(page.locator('[data-testid="auth-input"]')).toBeVisible({ timeout: 10000 });
    await shot(page, 'm1-login');

    await login(page);
    await configureMockBackend(page);
    const app = new App(page);
    await shot(page, 'm2-app-empty-state');

    // Sidebar is off-canvas on mobile — open it via the hamburger first.
    await page.locator('.mobile-menu-btn').click();
    await expect(page.locator('.sidebar')).toBeVisible();
    await page.waitForTimeout(300);
    await shot(page, 'm3-sidebar-open');

    await app.createCharacter({
      name: charName,
      description: 'Mobile audit character.',
      firstMes: `Hi, I am ${charName}.`,
    });
    // Mobile variant of startChat: the client auto-selects the new chat and the
    // sidebar slides off-canvas, so the explicit chat-item click app.startChat
    // does would be outside the viewport. Just open the chat and wait.
    await app.revealHoverButtons();
    await page.locator('input[placeholder="Search characters..."]').fill(charName);
    await app.characterRow(charName).locator('[title="New chat"]').click({ force: true });
    await expect(page.locator('.chat-view')).toBeVisible();
    await expect(page.locator('.message-bubble')).toHaveCount(1, { timeout: 10000 });
    await app.sendUserMessage('seq:Hello from mobile.', { expectReply: true });
    await shot(page, 'm4-chat-conversation');

    await page.locator('.mobile-menu-btn').click();
    await app.openSettings();
    await shot(page, 'm5-settings-modal');
    await app.closeSettings();
  });
});
