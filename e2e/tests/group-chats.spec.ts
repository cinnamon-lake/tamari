import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { expectNoAxeViolations } from '../helpers/a11y.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

async function createCharacter(page: any, charName: string) {
  await page.locator('[title="Create character"]').click();
  const editor = page.locator('.character-editor-modal');
  await expect(editor).toBeVisible();
  await editor.locator('.text-input').first().fill(charName);
  await editor.locator('.textarea-input').nth(0).fill('A character created by e2e tests.');
  await editor.locator('.textarea-input').nth(3).fill(`Hello! I am ${charName}.`);
  await expect(editor.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
  await editor.locator('[title="Close"]').click();
  await expect(editor).not.toBeVisible();
  // Filter the character list so the target row is always reachable regardless of pagination.
  await page.locator('input[placeholder="Search characters..."]').fill(charName);
  await expect(page.locator('.character-list li', { hasText: charName })).toBeVisible();
}

async function fillPromptPopup(page: any, value: string) {
  const popup = page.locator('.popup-modal');
  await expect(popup).toBeVisible();
  await popup.locator('.popup-input').fill(value);
  await popup.locator('.popup-actions button.primary').click();
  await expect(popup).not.toBeVisible();
}

test.describe('Group Chats', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('creates a group chat and adds a member', async ({ page }) => {
    const charName = uniqueName('Group Member Character');
    const groupName = uniqueName('E2E Group Chat');

    await createCharacter(page, charName);

    // Create a new group chat from the sidebar.
    await page.locator('[title="New group chat"]').click();
    await fillPromptPopup(page, groupName);

    // The group chat should become active.
    await expect(page.locator('.group-chat-toolbar')).toBeVisible();
    await expect(page.locator('.group-chat-badge')).toContainText('Group Chat');

    // Open the member management panel.
    await page.locator('.group-chat-toolbar button:has-text("Manage Members")').click();
    const panel = page.locator('.group-panel');
    await expect(panel).toBeVisible();

    // Add the character we created.
    await panel.locator('button:has-text("Add Member")').click();
    await panel.locator('.add-member-dropdown select').selectOption({ label: charName });

    // Verify the member appears in the list.
    await expect(panel.locator('.group-members-list')).toContainText(charName);

    await panel.locator('[aria-label="Close"]').click();
    await expect(panel).not.toBeVisible();

    // Sending a message should work in the group chat.
    const input = page.locator('.message-textarea');
    await input.fill('Hello group!');
    await page.locator('.message-input-area .send-btn').click();
    await expect(input).toHaveValue('');

    const userBubble = page.locator('.message-bubble.user').last();
    await expect(userBubble).toContainText('Hello group!', { timeout: 5000 });

    await expectNoAxeViolations(page);
  });
});
