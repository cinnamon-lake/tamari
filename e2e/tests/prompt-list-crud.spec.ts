/**
 * Prompt List CRUD coverage for server/src/dispatch/promptListHandlers.ts
 * (select / create / update / delete + active-list fallback) driven through
 * client/src/components/PromptListModal.tsx.
 *
 * Unlike tests/prompt-list.spec.ts (which toggles a checkbox and closes
 * without waiting for the debounced save, so promptList.update may never
 * land), every mutation here waits for the debounced auto-save round-trip:
 * the modal title shows 'Saving…' while promptList.update is in flight
 * (PromptListModal.tsx saving() signal) and clears once the broadcast is
 * processed. waitForPromptListSave() observes that title with a
 * MutationObserver so the 300ms indicator window can't be missed by polling.
 */
import { test, expect } from '../fixtures/base.js';
import type { Locator, Page } from '@playwright/test';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { getLastLlmRequest, waitForNextLlmRequest } from '../helpers/llm.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

async function openPromptListModal(page: Page): Promise<Locator> {
  const btn = page.locator('button.settings-btn:has-text("Prompt List")');
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  const modal = page.locator('.modal.settings-modal').filter({ hasText: 'Prompt List' });
  await expect(modal).toBeVisible();
  await expect(modal.locator('.modal-title')).toContainText('Prompt List');
  return modal;
}

async function closePromptListModal(page: Page, modal: Locator): Promise<void> {
  // Clicking the overlay invokes close(), which also flushes a pending dirty save.
  await page.locator('.modal-overlay:has(.modal.settings-modal:has-text("Prompt List"))').click({ position: { x: 0, y: 0 } });
  await expect(modal).not.toBeVisible();
}

/**
 * Wait for one full debounced auto-save cycle: title gains 'Saving…' then
 * loses it. Attach immediately after the dirtying action — the debounce is
 * 500ms, so the observer is always in place before the indicator appears.
 */
async function waitForPromptListSave(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const title = document.querySelector('.modal.settings-modal .modal-title');
        if (!title) {
          reject(new Error('prompt list modal title not found'));
          return;
        }
        let sawSaving = title.textContent?.includes('Saving') ?? false;
        const obs = new MutationObserver(() => {
          const saving = title.textContent?.includes('Saving') ?? false;
          if (saving) sawSaving = true;
          if (sawSaving && !saving) {
            obs.disconnect();
            resolve();
          }
        });
        obs.observe(title, { childList: true, characterData: true, subtree: true });
        setTimeout(() => {
          obs.disconnect();
          reject(new Error(`timed out waiting for prompt list save (sawSaving=${sawSaving})`));
        }, 10000);
      }),
  );
}

/** The list selector is the first <select> in the modal (role selects come later). */
function listSelect(modal: Locator): Locator {
  return modal.locator('select.select').first();
}

async function selectedListLabel(modal: Locator): Promise<string> {
  return listSelect(modal).evaluate((el: HTMLSelectElement) => el.options[el.selectedIndex]?.textContent ?? '');
}

async function optionLabels(modal: Locator): Promise<string[]> {
  return listSelect(modal).evaluate((el: HTMLSelectElement) =>
    Array.from(el.options).map((o) => o.textContent ?? ''),
  );
}

/** Add a custom prompt via the Add Prompt row. Does not wait for the save. */
async function addCustomPrompt(modal: Locator, name: string, content: string): Promise<void> {
  await modal.locator('button.text-btn:has-text("Add Prompt")').click();
  const addRow = modal.locator('.prompt-add-row');
  await expect(addRow).toBeVisible();
  await addRow.locator('input.input').fill(name);
  // Role defaults to System — leave it.
  await addRow.locator('textarea').fill(content);
  await addRow.locator('button.text-btn:has-text("Add")').click();
  await expect(modal.locator('.prompt-item', { hasText: name })).toBeVisible();
}

test.describe('Prompt List CRUD', () => {
  test.beforeEach(async ({ page }) => {
    // The app's WS bus reconnects after the auth submit and login() returns
    // before the post-auth snapshot lands. PromptListModal.onMount sends its
    // one-shot promptList.select immediately — if the socket isn't open yet
    // the send is dropped, state.activePromptList stays null, and every
    // debounced save silently no-ops (saveList early-returns). Wait for the
    // snapshot frame before touching the modal.
    let resolveSync!: () => void;
    const synced = new Promise<void>((r) => (resolveSync = r));
    page.on('websocket', (ws) => {
      ws.on('framereceived', (f) => {
        if (typeof f.payload === 'string' && f.payload.includes('"type":"snapshot"')) resolveSync();
      });
    });
    await login(page);
    await Promise.race([
      synced,
      new Promise((_, reject) => setTimeout(() => reject(new Error('app bus sync timeout')), 15000)),
    ]);
  });

  test.afterEach(async ({ page }) => {
    // Only the generation-impact test points the backend at the mock; resetting
    // unconditionally keeps that from leaking into other specs.
    await resetBackendConfig(page);
  });

  test('duplicates the active list and selects the copy', async ({ page }) => {
    const modal = await openPromptListModal(page);
    const originalLabel = await selectedListLabel(modal);
    const copyLabel = `${originalLabel} (Copy)`;

    await modal.locator('button.text-btn:has-text("Duplicate List")').click();

    // promptList.create → promptList.listed broadcast adds the copy to the dropdown.
    await expect
      .poll(async () => (await optionLabels(modal)).includes(copyLabel), { timeout: 10000 })
      .toBe(true);

    // promptList.select → promptList.snapshot loads the copy into the editor.
    await listSelect(modal).selectOption({ label: copyLabel });
    await expect(modal.locator('h3.section-heading', { hasText: `Edit: ${copyLabel}` })).toBeVisible();
    expect(await selectedListLabel(modal)).toBe(copyLabel);

    await closePromptListModal(page, modal);
  });

  test('adds a custom prompt, waits for the save, and it persists', async ({ page }) => {
    const modal = await openPromptListModal(page);
    const name = uniqueName('E2E Persist Prompt');
    const token = `E2E_TOKEN_${Date.now()}`;

    await addCustomPrompt(modal, name, token);
    // The step prompt-list.spec.ts misses: wait for the debounced save round-trip.
    await waitForPromptListSave(page);

    await closePromptListModal(page, modal);

    const reopened = await openPromptListModal(page);
    const item = reopened.locator('.prompt-item', { hasText: name });
    await expect(item).toBeVisible();
    await expect(item.locator('textarea')).toHaveValue(token);
    await closePromptListModal(page, reopened);
  });

  test('a saved custom prompt reaches the outgoing LLM request', async ({ page }) => {
    const modal = await openPromptListModal(page);
    const name = uniqueName('E2E Inject Prompt');
    const token = `E2E_INJECT_${Date.now()}`;
    await addCustomPrompt(modal, name, token);
    await waitForPromptListSave(page);
    await closePromptListModal(page, modal);

    await configureMockBackend(page);
    const app = new App(page);
    const charName = uniqueName('Prompt List Char');
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('respond: prompt list ok', { expectReply: true });
    const cap = await waitForNextLlmRequest(before);

    const body = cap.body as { messages?: Array<{ role?: string; content?: unknown }> };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const hit = messages.find(
      (m) => typeof m.content === 'string' && (m.content as string).includes(token),
    );
    expect(hit, 'custom prompt entry should be in the outgoing request').toBeTruthy();
    expect(hit!.role).toBe('system');
  });

  test('reorders custom prompts and the order persists', async ({ page }) => {
    const modal = await openPromptListModal(page);
    const ts = Date.now();
    const nameA = `E2E Order A ${ts}`;
    const nameB = `E2E Order B ${ts}`;

    await addCustomPrompt(modal, nameA, `content A ${ts}`);
    await addCustomPrompt(modal, nameB, `content B ${ts}`);

    // B was appended after A; move it above A.
    await modal.locator('.prompt-item', { hasText: nameB }).locator('button[title="Move up"]').click();
    await waitForPromptListSave(page);
    await closePromptListModal(page, modal);

    const reopened = await openPromptListModal(page);
    const names = await reopened.locator('.prompt-item .prompt-name').allTextContents();
    const idxA = names.findIndex((n) => n.trim() === nameA);
    const idxB = names.findIndex((n) => n.trim() === nameB);
    expect(idxA, 'prompt A present after reopen').toBeGreaterThanOrEqual(0);
    expect(idxB, 'prompt B present after reopen').toBeGreaterThanOrEqual(0);
    expect(idxB, 'B should sort above A after the move').toBeLessThan(idxA);
    await closePromptListModal(page, reopened);
  });

  test('deleting the active list falls back to the first list', async ({ page }) => {
    const modal = await openPromptListModal(page);
    const originalLabel = await selectedListLabel(modal);
    const copyLabel = `${originalLabel} (Copy)`;

    await modal.locator('button.text-btn:has-text("Duplicate List")').click();
    await expect
      .poll(async () => (await optionLabels(modal)).includes(copyLabel), { timeout: 10000 })
      .toBe(true);
    await listSelect(modal).selectOption({ label: copyLabel });
    await expect(modal.locator('h3.section-heading', { hasText: `Edit: ${copyLabel}` })).toBeVisible();

    // The server's fallback is the first remaining list summary.
    const firstOption = (await optionLabels(modal)).find((l) => l !== copyLabel)!;

    await modal.locator('button.text-btn:has-text("Delete List")').click();
    const popup = page.locator('.popup-modal');
    await expect(popup).toBeVisible();
    await popup.locator('button.primary').click();
    await expect(popup).not.toBeVisible();

    // promptList.delete → settings.changed(activePromptListId=fallback) +
    // promptList.deleted → the store selects the fallback list.
    await expect.poll(async () => selectedListLabel(modal), { timeout: 10000 }).toBe(firstOption);
    await expect(modal.locator('h3.section-heading', { hasText: `Edit: ${firstOption}` })).toBeVisible();

    await closePromptListModal(page, modal);
  });

  test('reset to defaults restores the built-in prompts', async ({ page }) => {
    const modal = await openPromptListModal(page);
    const name = uniqueName('E2E Reset Prompt');
    await addCustomPrompt(modal, name, `reset token ${Date.now()}`);
    await waitForPromptListSave(page);

    await modal.locator('button.text-btn:has-text("Reset to Defaults")').click();
    const popup = page.locator('.popup-modal');
    await expect(popup).toBeVisible();
    await popup.locator('button.primary').click();
    await expect(popup).not.toBeVisible();

    // The custom entry is gone and a built-in is back, then persisted.
    await expect(modal.locator('.prompt-item', { hasText: name })).toHaveCount(0);
    await expect(modal.locator('.prompt-item', { hasText: 'Main Prompt' })).toBeVisible();
    await waitForPromptListSave(page);
    await closePromptListModal(page, modal);

    const reopened = await openPromptListModal(page);
    await expect(reopened.locator('.prompt-item', { hasText: name })).toHaveCount(0);
    await expect(reopened.locator('.prompt-item', { hasText: 'Main Prompt' })).toBeVisible();
    await closePromptListModal(page, reopened);
  });
});
