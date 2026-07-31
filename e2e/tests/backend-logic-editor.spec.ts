import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

const MAIN_LUA = `local util = require('lib/util')
function generate(prompt, ctx)
  return util.reply()
end`;

const MODULE_LUA = `local M = {}
function M.reply()
  return 'module-ok'
end
return M`;

test.describe('Backend logic editor (multi-file)', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  async function openLogicTab(page: import('@playwright/test').Page, app: App, name: string) {
    await app.revealHoverButtons();
    await page.locator('input[placeholder="Search characters..."]').fill(name);
    const row = app.characterRow(name);
    await row.waitFor({ state: 'visible' });
    await row.locator('[title="Edit character"]').click({ force: true });
    const editor = page.locator('.character-editor-modal');
    await expect(editor).toBeVisible();
    await editor.locator('#editor-tab-logic').click();
    return editor;
  }

  test('file tabs persist across reload and the dry-run resolves require through WS', async ({ page }) => {
    const app = new App(page);
    const name = uniqueName('Backend Editor Host');
    await app.createCharacter({ name, firstMes: 'Ready.' });

    // Open the editor on the Logic & Rules tab and author main.lua + a module.
    let editor = await openLogicTab(page, app, name);
    await editor.locator('label.checkbox-row:has-text("Enable backend logic") input').click();
    const sourceArea = editor.locator('.character-backend-editor textarea').first();
    await sourceArea.fill(MAIN_LUA);

    // Add a module file via the tab bar.
    await editor.locator('.backend-file-add').click();
    await editor.locator('.backend-file-path-input').fill('lib/util.lua');
    await editor.locator('.backend-file-path-input').press('Enter');
    await expect(editor.locator('.backend-file-tab-name', { hasText: 'lib/util.lua' })).toBeVisible();
    await sourceArea.fill(MODULE_LUA);

    // Auto-save flushes (indicator), then close.
    await expect(editor.locator('.save-indicator')).toContainText('Saved', { timeout: 5000 });
    await editor.locator('[title="Close"]').click();
    await expect(editor).not.toBeVisible();

    // Reload the page and reopen: both files must have survived the round-trip.
    await page.reload();
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 10000 });
    editor = await openLogicTab(page, app, name);
    await expect(editor.locator('.character-backend-editor textarea').first()).toHaveValue(MAIN_LUA);
    await editor.locator('.backend-file-tab-name', { hasText: 'lib/util.lua' }).click();
    await expect(editor.locator('.character-backend-editor textarea').first()).toHaveValue(MODULE_LUA);

    // Dry-run through the panel: the WS path must see the module (require resolves).
    const panel = editor.locator('.backend-dry-run-panel');
    await panel.locator('textarea').first().fill('hi');
    await panel.locator('button:has-text("Run")').click();
    await expect(panel.locator('.backend-dry-run-result')).toContainText('module-ok', { timeout: 15000 });

    // Cleanup: disable backend logic again.
    await editor.locator('label.checkbox-row:has-text("Enable backend logic") input').click();
    await expect(editor.locator('.save-indicator')).toContainText('Saved', { timeout: 5000 });
  });
});
