import { smokeTest as test, expect } from '../fixtures/smoke.js';
import { patchActiveBackendConfig } from '../helpers/backendConfig.js';
import { getLastLlmRequest, resetLlmRequests, waitForNextLlmRequest } from '../helpers/llm.js';
import { uniqueName } from '../helpers/names.js';

async function postSecret(
  page: import('@playwright/test').Page,
  key: string,
  value: string,
  label?: string,
): Promise<void> {
  await page.evaluate(
    async ({ key, value, label }) => {
      const token = localStorage.getItem('st_auth_token') ?? '';
      await fetch('/api/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ key, value, label }),
      });
    },
    { key, value, label },
  );
}

async function deleteSecret(page: import('@playwright/test').Page, key: string): Promise<void> {
  await page.evaluate(
    async ({ key }) => {
      const token = localStorage.getItem('st_auth_token') ?? '';
      await fetch(`/api/secrets/${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    },
    { key },
  );
}

test.describe('Secrets', () => {
  // Login-only test, but `_app` pulls in the fixture's login (the mock
  // backend it also configures is harmless here and reset on teardown).
  test('opens the secrets modal and adds a secret via the UI', async ({ app: _app, page }) => {
    const btn = page.locator('button.settings-btn:has-text("Secrets")');
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    const modal = page.locator('.modal.settings-modal').filter({ hasText: 'Secrets' });
    await expect(modal).toBeVisible();

    // Add a secret
    await page.locator('button:has-text("Add Secret")').click();
    await page.locator('input[placeholder="openai-key"]').fill('ui-test-key');
    await page.locator('input[placeholder="OpenAI – Work"]').fill('UI Test Key');
    await page.locator('input[placeholder="sk-..."]').fill('sk-from-ui');
    await page.locator('button:has-text("Save")').click();

    // Verify it appears in the list
    await expect(page.locator('.settings-modal')).toContainText('UI Test Key', { timeout: 5000 });
    await expect(page.locator('.settings-modal')).toContainText('ui-test-key');

    // Clean up
    await deleteSecret(page, 'ui-test-key');
  });

  test('a secret:<key> apiKey resolves to the vault value at generation', async ({ page, app }) => {
    await resetLlmRequests();

    // Store a secret in the vault
    await postSecret(page, 'resolution-key', 'sk-resolved', 'Resolution Test');

    // Set the backend config's apiKey to a secret reference
    await patchActiveBackendConfig(page, { apiKey: 'secret:resolution-key' });

    const charName = uniqueName('Secret Resolve');
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('hello', { expectReply: true });
    const captured = await waitForNextLlmRequest(before);

    // The resolver replaced secret:resolution-key with sk-resolved from the vault;
    // the adapter sent it as a Bearer token. The mock captures the auth header.
    expect(captured.auth).toBe('Bearer sk-resolved');

    // Clean up
    await deleteSecret(page, 'resolution-key');
  });
});
