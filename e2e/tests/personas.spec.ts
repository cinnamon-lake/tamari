import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { deleteNonDefaultPersonas } from '../helpers/personas.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

test.describe('Personas', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test.afterEach(async ({ page }) => {
    // Personas are global and chat.create auto-binds the first one to new
    // chats — don't leak the created persona into later specs.
    await deleteNonDefaultPersonas(page);
  });

  test('creates a new persona and edits it', async ({ page }) => {
    const personaName = uniqueName('E2E Persona');

    await page.locator('button.settings-btn:has-text("Personas")').click();
    const manager = page.locator('.persona-modal');
    await expect(manager).toBeVisible();
    await expect(manager.locator('.modal-title')).toContainText('Personas');

    await manager.locator('button:has-text("New Persona")').click();
    await expect(manager.locator('.persona-editor')).toBeVisible();

    // Edit the persona name
    const nameInput = manager.locator('.persona-editor .text-input').first();
    await nameInput.fill(personaName);

    // Edit the description
    const descInput = manager.locator('.persona-editor .textarea-input').first();
    await descInput.fill('A persona created by e2e tests.');

    // Wait for the save indicator
    await expect(manager.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });

    await expectNoAxeViolations(page);

    // Go back and verify the persona is listed
    await manager.locator('button.back-btn:has-text("Back")').click();
    await expect(manager.locator('.persona-list')).toContainText(personaName);

    // Close the modal by clicking the overlay backdrop
    await page.locator('.modal-overlay:has(.persona-modal)').click({ position: { x: 0, y: 0 } });
    await expect(manager).not.toBeVisible();
  });
});
