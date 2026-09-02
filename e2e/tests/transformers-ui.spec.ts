/**
 * Request transformers — UI coverage for the two management modals and the
 * chain selector in Backend Config.
 *
 * Covers, through the real UI (WS only for setup/cleanup and one saved-config
 * persistence read):
 * - TransformerChainsModal: the seeded "Default" chain is listed; create a
 *   chain with builtin steps; per-builtin param forms render (whitespace mode,
 *   ensure-thinking placeholder); step reorder + enable toggle; everything
 *   persists across close/reopen
 * - TransformerScriptsModal: create + on-demand validate (ok and syntax-error
 *   paths), edit round-trip, delete with confirm popup
 * - Chains modal Lua step: the add-script row lists existing scripts and a
 *   script step resolves to its name in the step list
 * - BackendConfigModal: the Transformer Chain select lists chains, links one
 *   to the active config (persists at the saved-config level), and unlinks
 *   back to None
 *
 * Verified against:
 * - client/src/components/TransformerChainsModal.tsx
 * - client/src/components/TransformerScriptsModal.tsx
 * - client/src/components/BackendConfigModal.tsx (transformerChainId select)
 * - server/src/dispatch/transformerHandlers.ts (list/save/delete/validate)
 *
 * The e2e server is shared per run: everything created here is deleted again
 * in afterEach, and the active config's transformerChainId is reset to null
 * (resetBackendConfig covers it).
 */

import { test, expect } from '../fixtures/base.js';
import type { Page, Locator } from '@playwright/test';
import { login } from '../helpers/auth.js';
import { resetBackendConfig } from '../helpers/backendConfig.js';
import { wsRpc } from '../helpers/ws.js';
import { uniqueName } from '../helpers/names.js';

// ── modal plumbing ──────────────────────────────────────────────────────────

async function openChainsModal(page: Page): Promise<Locator> {
  const btn = page.locator('button.settings-btn:has-text("Transformer Chains")');
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  const modal = page.locator('.modal.transformer-chains-modal');
  await expect(modal).toBeVisible();
  return modal;
}

async function openScriptsModal(page: Page): Promise<Locator> {
  const btn = page.locator('button.settings-btn:has-text("Transformer Scripts")');
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  const modal = page.locator('.modal.transformer-scripts-modal');
  await expect(modal).toBeVisible();
  return modal;
}

async function openBackendConfig(page: Page): Promise<Locator> {
  const btn = page.locator('button.settings-btn:has-text("Backend Config")');
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  const modal = page.locator('.modal.settings-modal').filter({ hasText: 'Backend Config' });
  await expect(modal).toBeVisible();
  return modal;
}

async function closeModal(modal: Locator): Promise<void> {
  // Backend Config's Close saves a dirty form first; the transformer modals
  // have no dirty state — Close just closes.
  await modal.locator('.modal-actions button:has-text("Close")').click();
  await expect(modal).not.toBeVisible();
}

// ── WS helpers (setup/cleanup/persistence reads only) ───────────────────────

/** Names this spec created; afterEach deletes them so the shared server
    stays clean. The seeded 'default' chain is never touched. */
const createdChainNames: string[] = [];
const createdScriptNames: string[] = [];

interface ListedItem {
  id: string;
  name: string;
}

async function deleteChainsByName(page: Page, names: string[]): Promise<void> {
  if (names.length === 0) return;
  const listed = await wsRpc<{ items: ListedItem[] }>(
    page,
    { type: 'transformerchain.list' },
    'transformerchain.listed',
  );
  for (const item of listed.items) {
    if (item.id !== 'default' && names.includes(item.name)) {
      await wsRpc(page, { type: 'transformerchain.delete', id: item.id }, 'transformerchain.deleted');
    }
  }
}

async function deleteScriptsByName(page: Page, names: string[]): Promise<void> {
  if (names.length === 0) return;
  const listed = await wsRpc<{ items: ListedItem[] }>(
    page,
    { type: 'transformerscript.list' },
    'transformerscript.listed',
  );
  for (const item of listed.items) {
    if (names.includes(item.name)) {
      await wsRpc(page, { type: 'transformerscript.delete', id: item.id }, 'transformerscript.deleted');
    }
  }
}

/** Create a bare chain over the bus; returns its server-assigned id. */
async function createChain(page: Page, name: string): Promise<string> {
  const created = await wsRpc<{ item: { id: string } }>(
    page,
    { type: 'transformerchain.save', data: { name, description: '', steps: [] } },
    'transformerchain.created',
  );
  return created.item.id;
}

/** Read the active config's transformerChainId at the saved level — the
    modal's Close-saves-dirty path must have persisted the selection. */
async function readActiveTransformerChainId(page: Page): Promise<unknown> {
  const loaded = await wsRpc<{ settings?: { activeBackendConfigId?: string } }>(
    page,
    { type: 'settings.get' },
    'settings.loaded',
  );
  const activeId = String(loaded?.settings?.activeBackendConfigId ?? '');
  const snap = await wsRpc<{ backendConfig?: { transformerChainId?: unknown } }>(
    page,
    { type: 'backendConfig.select', backendConfigId: activeId },
    'backendConfig.snapshot',
  );
  return snap.backendConfig?.transformerChainId;
}

// ── spec ────────────────────────────────────────────────────────────────────

test.describe('Transformers UI', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await login(page);
    await resetBackendConfig(page);
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
    await deleteChainsByName(page, createdChainNames.splice(0));
    await deleteScriptsByName(page, createdScriptNames.splice(0));
  });

  test('chains modal: create with builtin steps; reorder, disable and params persist', async ({ page }) => {
    const chainName = uniqueName('E2E Chain');
    createdChainNames.push(chainName);

    let modal = await openChainsModal(page);

    // The seeded Default chain (migration 020) is listed.
    await expect(modal.locator('.flex-between', { hasText: 'Default' })).toBeVisible();

    // Add a chain: whitespace (mode -> full) + ensure-thinking (placeholder).
    await modal.locator('button:has-text("Add Chain")').click();
    await modal.locator('input[placeholder="my-chain"]').fill(chainName);
    await modal.locator('label.field-label:has-text("Description") input').fill('e2e description');

    const addBuiltinSelect = modal.locator('label.field-label:has-text("Add Built-in Transform") select');
    const addBuiltinButton = modal.locator('button:has-text("Add transform")');

    // Default selection is whitespace; adding it renders its Mode param.
    await expect(addBuiltinSelect).toHaveValue('whitespace');
    await addBuiltinButton.click();
    const whitespaceStep = modal.locator('.transformer-chain-step', { hasText: 'Whitespace normalization' });
    await expect(whitespaceStep).toBeVisible();
    const modeSelect = whitespaceStep.locator('label.field-label:has-text("Mode") select');
    await expect(modeSelect).toHaveValue('trim');
    await modeSelect.selectOption('full');

    await addBuiltinSelect.selectOption('ensure-thinking');
    await addBuiltinButton.click();
    const thinkingStep = modal.locator('.transformer-chain-step', { hasText: 'Ensure thinking block' });
    await expect(thinkingStep).toBeVisible();
    await thinkingStep.locator('label.field-label:has-text("Placeholder text") input').fill('…thinking');

    // Reorder: ensure-thinking moves above whitespace.
    const stepNames = modal.locator('.transformer-chain-step-name');
    await expect(stepNames).toHaveText(['Whitespace normalization', 'Ensure thinking block']);
    await thinkingStep.locator('button[aria-label="Move up"]').click();
    await expect(stepNames).toHaveText(['Ensure thinking block', 'Whitespace normalization']);

    // Boundary buttons disable at the ends.
    await expect(
      modal.locator('.transformer-chain-step').nth(0).locator('button[aria-label="Move up"]'),
    ).toBeDisabled();
    await expect(
      modal.locator('.transformer-chain-step').nth(1).locator('button[aria-label="Move down"]'),
    ).toBeDisabled();

    // Disable the first step.
    const firstEnabled = modal.locator('.transformer-chain-step').nth(0).locator('input.checkbox-input');
    await expect(firstEnabled).toBeChecked();
    await firstEnabled.uncheck();

    await modal.locator('button.primary-btn:has-text("Save")').click();
    await expect(modal.locator('.flex-between', { hasText: chainName })).toBeVisible();
    await closeModal(modal);

    // Reopen and edit: order, disabled state and params survived the round-trip.
    modal = await openChainsModal(page);
    await modal.locator('.flex-between', { hasText: chainName }).locator('button:has-text("Edit")').click();
    await expect(modal.locator('input[placeholder="my-chain"]')).toHaveValue(chainName);
    await expect(modal.locator('label.field-label:has-text("Description") input')).toHaveValue('e2e description');
    await expect(stepNames).toHaveText(['Ensure thinking block', 'Whitespace normalization']);
    await expect(modal.locator('.transformer-chain-step').nth(0).locator('input.checkbox-input')).not.toBeChecked();
    await expect(
      modal.locator('.transformer-chain-step', { hasText: 'Ensure thinking block' }).locator('input.input'),
    ).toHaveValue('…thinking');
    await expect(
      modal.locator('.transformer-chain-step', { hasText: 'Whitespace normalization' }).locator('select'),
    ).toHaveValue('full');
    await closeModal(modal);
  });

  test('scripts modal: validate ok/error, edit round-trip, delete with confirm', async ({ page }) => {
    const scriptName = uniqueName('E2E Script');
    createdScriptNames.push(scriptName);
    // Validate executes the chunk with an empty env (no `messages` global), so
    // the valid case must be nil-safe — same guard real scripts need.
    const validSource = 'if messages then\n  return messages\nend';

    let modal = await openScriptsModal(page);
    await modal.locator('button:has-text("Add Script")').click();
    await modal.locator('input[placeholder="strip-ooc"]').fill(scriptName);
    await modal.locator('label.field-label:has-text("Description") input').fill('e2e script');
    const sourceArea = modal.locator('label.field-label:has-text("Lua Source") textarea');
    const statusLine = modal.locator('.transformer-scripts-validation');

    // Valid chunk loads cleanly.
    await sourceArea.fill(validSource);
    await modal.locator('button:has-text("Validate")').click();
    await expect(statusLine).toContainText('Script loads cleanly.');

    // Editing the source resets the result; a syntax error comes back as text.
    await sourceArea.fill('this is not lua ((');
    await expect(statusLine).not.toContainText('Script loads cleanly.');
    await modal.locator('button:has-text("Validate")').click();
    await expect(statusLine.locator('.text-danger')).not.toBeEmpty();

    // Fix and save; the script is listed.
    await sourceArea.fill(validSource);
    await modal.locator('button.primary-btn:has-text("Save")').click();
    await expect(modal.locator('.flex-between', { hasText: scriptName })).toBeVisible();
    await closeModal(modal);

    // Reopen + edit: fields round-trip.
    modal = await openScriptsModal(page);
    const row = modal.locator('.flex-between', { hasText: scriptName });
    await row.locator('button:has-text("Edit")').click();
    await expect(modal.locator('input[placeholder="strip-ooc"]')).toHaveValue(scriptName);
    await expect(modal.locator('label.field-label:has-text("Description") input')).toHaveValue('e2e script');
    await expect(sourceArea).toHaveValue(validSource);
    await modal.locator('button:has-text("Cancel")').click();

    // Delete through the UI: confirm popup names the script, then the row is gone.
    await row.locator('button:has-text("Delete")').click();
    const popup = page.locator('.popup-modal');
    await expect(popup).toBeVisible();
    await expect(popup).toContainText(`Delete transformer script "${scriptName}"?`);
    await popup.locator('button.primary').click();
    await expect(popup).not.toBeVisible();
    await expect(modal.locator('.flex-between', { hasText: scriptName })).toHaveCount(0);
    await closeModal(modal);

    // Already deleted through the UI — afterEach must not look for it again.
    createdScriptNames.splice(createdScriptNames.indexOf(scriptName), 1);
  });

  test('chains modal: Lua script step lists scripts and resolves to its name', async ({ page }) => {
    const scriptName = uniqueName('E2E Lua Step');
    const chainName = uniqueName('E2E Chain');
    createdScriptNames.push(scriptName);
    createdChainNames.push(chainName);

    // Create the script through its own modal first.
    const scriptsModal = await openScriptsModal(page);
    await scriptsModal.locator('button:has-text("Add Script")').click();
    await scriptsModal.locator('input[placeholder="strip-ooc"]').fill(scriptName);
    await scriptsModal.locator('label.field-label:has-text("Lua Source") textarea').fill('return messages');
    await scriptsModal.locator('button.primary-btn:has-text("Save")').click();
    await expect(scriptsModal.locator('.flex-between', { hasText: scriptName })).toBeVisible();
    await closeModal(scriptsModal);

    // The chains modal fetches fresh lists on open: the script is addable.
    const modal = await openChainsModal(page);
    await expect(modal.locator('button:has-text("Add Chain")')).toBeVisible();
    await modal.locator('button:has-text("Add Chain")').click();
    await modal.locator('input[placeholder="my-chain"]').fill(chainName);

    const addLuaSelect = modal.locator('label.field-label:has-text("Add Lua Script") select');
    const addLuaButton = modal.locator('button:has-text("Add script")');
    await expect(addLuaButton).toBeEnabled();
    await expect(modal.locator('.hint-text', { hasText: 'No transformer scripts yet' })).toHaveCount(0);
    await addLuaSelect.selectOption({ label: scriptName });
    await addLuaButton.click();

    // The step label resolves the scriptId to the script's name.
    await expect(modal.locator('.transformer-chain-step-name')).toHaveText([scriptName]);

    await modal.locator('button.primary-btn:has-text("Save")').click();
    await closeModal(modal);

    // Persists across reopen.
    const reopened = await openChainsModal(page);
    await reopened.locator('.flex-between', { hasText: chainName }).locator('button:has-text("Edit")').click();
    await expect(reopened.locator('.transformer-chain-step-name')).toHaveText([scriptName]);
    await closeModal(reopened);
  });

  test('backend config modal: chain select links and unlinks, persisted at the config level', async ({ page }) => {
    const chainName = uniqueName('E2E Chain');
    createdChainNames.push(chainName);
    const chainId = await createChain(page, chainName);

    let modal = await openBackendConfig(page);
    const chainSelect = modal.locator('select[data-testid="backend-config-transformer-chain"]');
    await expect(chainSelect).toBeVisible();
    // Fresh-install state: nothing linked, None selected; the new chain is listed.
    await expect(chainSelect).toHaveValue('');
    await expect(chainSelect.locator('option', { hasText: 'None' })).toHaveCount(1);
    await expect(chainSelect.locator('option', { hasText: chainName })).toHaveCount(1);

    await chainSelect.selectOption({ label: chainName });
    await closeModal(modal);

    // Saved at the config level, not just re-rendered in the form.
    expect(await readActiveTransformerChainId(page)).toBe(chainId);

    modal = await openBackendConfig(page);
    await expect(modal.locator('select[data-testid="backend-config-transformer-chain"]')).toHaveValue(chainId);

    // Unlink back to None; persists as null.
    await modal.locator('select[data-testid="backend-config-transformer-chain"]').selectOption('');
    await closeModal(modal);
    expect(await readActiveTransformerChainId(page)).toBeNull();

    modal = await openBackendConfig(page);
    await expect(modal.locator('select[data-testid="backend-config-transformer-chain"]')).toHaveValue('');
    await closeModal(modal);
  });
});
