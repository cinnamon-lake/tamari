import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { App } from '../helpers/app.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

// Minimal 1x1 transparent PNG in base64 (same fixture as attachments.spec.ts)
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test.describe('UI Surfaces', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('hotswap bar lists recent characters and switches the selection', async ({ page }) => {
    const app = new App(page);
    const nameA = uniqueName('Hotswap A');
    const nameB = uniqueName('Hotswap B');
    // A chat shows the (virtual) greeting without any generation, so no mock
    // backend is needed — but firstMes must be non-empty for a bubble to render.
    await app.createCharacterAndChat({ name: nameA, firstMes: `Hello from ${nameA}` });
    await app.createCharacterAndChat({ name: nameB, firstMes: `Hello from ${nameB}` });

    const items = page.locator('.hotswap-bar .hotswap-item');
    await expect(items.first()).toBeVisible();
    expect(await items.count()).toBeGreaterThanOrEqual(2);

    // B was created last and is selected; clicking A's hotswap item must move
    // the sidebar selection to A. Clear the leftover name search first so both
    // character rows are rendered. (The "<name> Chats" section title is NOT a
    // reliable signal here — it tracks state.activeCharacter, which hotswap
    // selection does not refresh.)
    await page.locator('input[placeholder="Search characters..."]').fill('');
    await page.locator(`.hotswap-bar .hotswap-item[title="${nameA}"]`).click();
    await expect(page.locator('.character-list li.selected')).toContainText(nameA);
  });

  test('character context menu opens on right-click and dismisses on Escape', async ({ page }) => {
    const app = new App(page);
    const name = uniqueName('Context Menu');
    await app.createCharacter({ name });

    const row = app.characterRow(name);
    await row.click({ button: 'right' });

    const menu = page.locator('.context-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.context-menu-item', { hasText: 'New chat' })).toBeVisible();
    await expect(menu.locator('.context-menu-item', { hasText: 'Edit' })).toBeVisible();
    await expect(menu.locator('.context-menu-item', { hasText: 'Export' })).toBeVisible();
    await expect(menu.locator('.context-menu-item', { hasText: 'Delete' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
  });

  test('chat message search filters the visible messages', async ({ page }) => {
    const app = new App(page);
    const name = uniqueName('Search');
    await configureMockBackend(page);
    try {
      await app.createCharacterAndChat({ name, firstMes: `Hello from ${name}` });
      // Virtual greetings bypass search filtering entirely (ChatView renders
      // them outside the filtered message list), so send a real message to
      // materialize the chat before searching.
      await app.sendUserMessage('needle in the haystack', { expectReply: true });

      await page.locator('.chat-header button[title="Search messages"]').click();
      const searchInput = page.locator('.chat-header .chat-search');
      await expect(searchInput).toBeVisible();

      // Matching query keeps the user bubble visible.
      await searchInput.fill('needle');
      await expect(page.locator('.message-bubble.user').last()).toContainText('needle');

      // Non-matching query filters the user bubble (and the greeting) out.
      // Note: the chat's active-child swipe (the last assistant reply) renders
      // outside the search-filtered list in ChatView, so one assistant bubble
      // remains — assert on the user bubble, not a total of zero.
      await searchInput.fill('zz-no-such-text-zz');
      await expect(page.locator('.message-bubble.user')).toHaveCount(0);
    } finally {
      await resetBackendConfig(page);
    }
  });

  test('chat header menu lists enabled export items and closes on Escape', async ({ page }) => {
    const app = new App(page);
    const name = uniqueName('Export Menu');
    await app.createCharacterAndChat({ name, firstMes: `Hello from ${name}` });

    await page.locator('.chat-header button[title="Menu"]').click();
    const menu = page.locator('.chat-header .dropdown-menu');
    await expect(menu).toBeVisible();

    // Presence + enabled only — clicking would window.open() a download URL.
    const exportJsonl = menu.locator('.dropdown-item', { hasText: 'Export JSONL' });
    const exportTxt = menu.locator('.dropdown-item', { hasText: 'Export TXT' });
    await expect(exportJsonl).toBeVisible();
    await expect(exportJsonl).toBeEnabled();
    await expect(exportTxt).toBeVisible();
    await expect(exportTxt).toBeEnabled();

    await page.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
  });

  test('character tag filtering and grid view toggle', async ({ page }) => {
    const app = new App(page);
    const tagged = uniqueName('TagTarget');
    const untagged = uniqueName('TagBystander');
    const tag = `e2e-tag-${Date.now()}`;
    await app.createCharacter({ name: tagged });
    await app.createCharacter({ name: untagged });

    // Open the tagged character's editor and add a tag.
    await app.revealHoverButtons();
    await page.locator('input[placeholder="Search characters..."]').fill(tagged);
    const row = app.characterRow(tagged);
    await row.waitFor({ state: 'visible' });
    await row.locator('[title="Edit character"]').click({ force: true });
    const editor = page.locator('.character-editor-modal');
    await expect(editor).toBeVisible();
    await editor.locator('.tag-input').fill(tag);
    await editor.locator('.tag-input').press('Enter');
    await expect(editor.locator('.tag-list .tag-chip', { hasText: tag })).toBeVisible();
    // Closing the editor flushes any pending auto-save (CharacterEditor onCleanup).
    await editor.locator('[title="Close"]').click();
    await expect(editor).not.toBeVisible();

    // The tag chip appears in the sidebar once the update round-trips.
    const chip = page.locator('.tag-filters .tag-chip', { hasText: tag });
    await expect(chip).toBeVisible({ timeout: 5000 });

    // Clear the leftover name search so both characters would otherwise show,
    // then activate the tag filter.
    await page.locator('input[placeholder="Search characters..."]').fill('');
    await chip.click();
    await expect(chip).toHaveClass(/active/);
    await expect(app.characterRow(tagged)).toBeVisible();
    await expect(page.locator('.character-list li', { hasText: untagged })).toHaveCount(0);
    await chip.click();
    await expect(chip).not.toHaveClass(/active/);

    // Grid view toggle adds/removes the `grid` class on the character list.
    const gridToggle = page.locator('button[title="Toggle grid view"]');
    await gridToggle.click();
    await expect(page.locator('.character-list.grid')).toBeVisible();
    await gridToggle.click();
    await expect(page.locator('.character-list.grid')).toHaveCount(0);
  });

  test('clicking an image attachment opens and closes the lightbox', async ({ page }) => {
    const app = new App(page);
    const name = uniqueName('Lightbox');
    await configureMockBackend(page);
    try {
      await app.createCharacterAndChat({ name, firstMes: `Hello from ${name}` });

      await page.locator('.message-input-area .hidden-file-input').setInputFiles({
        name: 'test-image.png',
        mimeType: 'image/png',
        buffer: Buffer.from(PNG_BASE64, 'base64'),
      });
      await expect(page.locator('.attachment-previews .attachment-preview')).toBeVisible({
        timeout: 5000,
      });
      await app.sendUserMessage('here is an image', { expectReply: true });

      const imageButton = app.lastBubble('user').locator('button[aria-label="Image attachment"]');
      await expect(imageButton).toBeVisible();
      await imageButton.click();

      await expect(page.locator('.lightbox-overlay')).toBeVisible();
      await expect(page.locator('.lightbox-img')).toBeVisible();
      await page.locator('.lightbox-overlay button[aria-label="Close"]').click();
      await expect(page.locator('.lightbox-overlay')).not.toBeVisible();
    } finally {
      await resetBackendConfig(page);
    }
  });

  test.describe('mobile navigation', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('sidebar opens/closes via menu button, overlay, and close button', async ({ page }) => {
      // Off-canvas at mobile width: the hamburger is visible and the sidebar
      // carries no `open` class.
      const menuButton = page.locator('.mobile-menu-btn');
      await expect(menuButton).toBeVisible();
      await expect(page.locator('.sidebar.open')).toHaveCount(0);

      // Open via the hamburger; close via the overlay.
      await menuButton.click();
      await expect(page.locator('.sidebar.open')).toBeVisible();
      await expect(page.locator('.mobile-overlay')).toBeVisible();
      // The open sidebar (same z-index as the overlay, later in DOM) covers the
      // overlay's center once its slide-in transition finishes, so a default
      // center click races that transition — and loses it whenever the sidebar
      // is slow to settle (e.g. a long character list accumulated by earlier
      // specs, whose rows then intercept the click). Click the strip of
      // overlay right of the sidebar (max-width 320px) instead: same user
      // gesture, deterministic target.
      await page.locator('.mobile-overlay').click({ position: { x: 370, y: 400 } });
      await expect(page.locator('.sidebar.open')).toHaveCount(0);
      await expect(page.locator('.mobile-overlay')).toHaveCount(0);

      // Open again; close via the in-sidebar close button.
      await menuButton.click();
      await expect(page.locator('.sidebar.open')).toBeVisible();
      await page.locator('.mobile-close').click();
      await expect(page.locator('.sidebar.open')).toHaveCount(0);
    });
  });
});
