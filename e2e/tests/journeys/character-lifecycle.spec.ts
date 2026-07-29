/**
 * Character lifecycle journey: import → edit → export → re-import → delete.
 *
 * Drives the character-card import/export seams through the real UI and the
 * /api/characters/import endpoint: imports a crafted JSON v2-style card, renames
 * it, exports a PNG (capturing the real download), re-imports that PNG to prove
 * the export round-trips, then deletes a copy.
 */
import { journeyTest as test, expect } from '../../fixtures/journey.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

test.describe('Character Lifecycle Journey', () => {
  test('import a JSON card, edit, export PNG, re-import the PNG, then delete', async ({ app, page }) => {
    const stamp = `${Date.now()}`;
    const name = `Imported Hero ${stamp}`;
    const renamed = `Renamed Hero ${stamp}`;
    const exportPath = path.join(os.tmpdir(), `st-export-${stamp}.png`);

    // Flat card matching @tamari/types LooseCardDataSchema (first_mes / tags / ...).
    const card = {
      name,
      description: 'A hero from a loose JSON card.',
      first_mes: 'Greetings! I am an imported hero.',
      alternate_greetings: ['Alternate greeting.'],
      tags: ['imported', 'e2e'],
    };

    await test.step('import a JSON card through the sidebar', async () => {
      await page.locator('input[accept="image/png,.charx,.json"]').setInputFiles({
        name: 'card.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(card)),
      });
      await page.locator('input[placeholder="Search characters..."]').fill(name);
      await expect(page.locator('.character-list li', { hasText: name })).toBeVisible({ timeout: 10000 });
    });

    await test.step('rename it and export a PNG (capturing the download)', async () => {
      await app.revealHoverButtons();
      await app.characterRow(name).locator('[title="Edit character"]').click();
      const editor = page.locator('.character-editor-modal');
      await expect(editor).toBeVisible();
      await editor.locator('.text-input').first().fill(renamed);
      await expect(editor.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });

      const downloadPromise = page.waitForEvent('download');
      await editor.locator('.export-btn', { hasText: 'Export PNG' }).click();
      const download = await downloadPromise;
      await download.saveAs(exportPath);
      expect(fs.existsSync(exportPath), 'exported PNG was saved').toBe(true);
      expect(fs.statSync(exportPath).size, 'exported PNG is non-empty').toBeGreaterThan(0);

      await editor.locator('[title="Close"]').click();
      await expect(editor).not.toBeVisible();
      await page.locator('input[placeholder="Search characters..."]').fill(renamed);
      await expect(page.locator('.character-list li', { hasText: renamed })).toBeVisible();
    });

    await test.step('re-import the exported PNG and confirm a duplicate appears', async () => {
      const before = await page.locator('.character-list li', { hasText: renamed }).count();
      await page.locator('input[accept="image/png,.charx,.json"]').setInputFiles(exportPath);
      await expect(page.locator('.character-list li', { hasText: renamed })).toHaveCount(before + 1, {
        timeout: 10000,
      });
    });

    await test.step('delete one copy via the editor', async () => {
      await app.revealHoverButtons();
      await app.characterRow(renamed).first().locator('[title="Edit character"]').click();
      const editor = page.locator('.character-editor-modal');
      await expect(editor).toBeVisible();
      await editor.locator('button.danger-btn', { hasText: 'Delete' }).click();
      const popup = page.locator('.popup-modal');
      await expect(popup).toBeVisible();
      await popup.locator('button.primary, button:has-text("Delete")').click();
      await expect(editor).not.toBeVisible();
      // Exactly one copy remains.
      await expect(page.locator('.character-list li', { hasText: renamed })).toHaveCount(1);
    });
  });
});
