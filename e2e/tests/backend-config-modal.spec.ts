/**
 * Backend Config modal — UI coverage beyond the basics in backend-config.spec.ts.
 *
 * Covers, all through the real modal UI (no raw-WS edits mid-test):
 * - provider switching: per-provider sections/fields appear and disappear, and
 *   the provider falls back when the generation mode invalidates it
 * - generation-mode select gating the instruct-template select (persists)
 * - advanced sampler knobs: enable/disable checkbox (providerParams.samplerDisabled)
 *   and the omit/on/off radio tri-state for boolean knobs (persist)
 * - logit-bias text parse -> save -> serialize round-trip
 * - OpenRouter: provider filter narrows the model list, reasoning effort/summary
 *   settings persist
 * - custom provider: linking a Lua custom backend (persists)
 * - config duplicate -> rename -> delete with confirm
 * - SecretPicker: pick a vault secret -> apiKey becomes `secret:<key>` (persists)
 *
 * Verified against:
 * - client/src/components/BackendConfigModal.tsx
 * - client/src/components/SecretPicker.tsx
 * - client/src/components/samplerProfiles.ts (per-provider knob profiles)
 * - server/src/dispatch/backendConfigHandlers.ts (create/update/delete semantics)
 *
 * Note: /api/models delegates to the configured provider's adapter (real
 * network), so the OpenRouter test stubs that one endpoint with page.route to
 * give the provider filter slash-namespaced model ids to work with offline.
 */

import { test, expect } from '../fixtures/base.js';
import type { Page, Locator } from '@playwright/test';
import { login } from '../helpers/auth.js';
import { resetBackendConfig, patchActiveBackendConfig } from '../helpers/backendConfig.js';
import { setSetting } from '../helpers/settings.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

// ── modal plumbing ──────────────────────────────────────────────────────────

async function openBackendConfig(page: Page): Promise<Locator> {
  const btn = page.locator('button.settings-btn:has-text("Backend Config")');
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  const modal = page.locator('.modal.settings-modal').filter({ hasText: 'Backend Config' });
  await expect(modal).toBeVisible();
  return modal;
}

async function closeModal(modal: Locator): Promise<void> {
  // The Close button runs the modal's close(): a dirty form is saved first.
  await modal.locator('.modal-actions button:has-text("Close")').click();
  await expect(modal).not.toBeVisible();
}

// Selects are identified by their option signature — the modal renders several
// selects whose labels overlap as plain text ("Provider" vs "OpenRouter Provider").
const chatProviderSelect = (modal: Locator) => modal.locator('select:has(option[value="openrouter"])');
const textProviderSelect = (modal: Locator) => modal.locator('select:has(option[value="koboldcpp"])');
const generationModeSelect = (modal: Locator) => modal.locator('select:has(option[value="chat"])');

// ── vault secrets (same pattern as secrets.spec.ts) ─────────────────────────

async function postSecret(page: Page, key: string, value: string, label?: string): Promise<void> {
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

async function deleteSecret(page: Page, key: string): Promise<void> {
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

/**
 * Read the active backend config over the app's WebSocket bus (read-only).
 * Used where persistence must be checked at the saved-config level rather
 * than the re-rendered form (see the custom-backend link test).
 */
async function readActiveBackendConfig(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const token = localStorage.getItem('st_auth_token') ?? '';
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);

      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth' }));

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'snapshot') {
            const activeId = msg.state?.settings?.activeBackendConfigId;
            ws.send(JSON.stringify({ type: 'backendConfig.select', backendConfigId: activeId }));
          }
          if (msg.type === 'backendConfig.snapshot') {
            ws.close();
            resolve(msg.backendConfig as Record<string, unknown>);
          }
          if (msg.type === 'error') {
            ws.close();
            reject(new Error(msg.message ?? 'backendConfig.select failed'));
          }
        } catch (err) {
          reject(err);
        }
      };

      ws.onerror = (err) => reject(new Error(`WebSocket error: ${err.type}`));
      setTimeout(() => {
        ws.close();
        reject(new Error('readActiveBackendConfig timed out'));
      }, 10000);
    });
  });
}

/**
 * Full reset of every field this spec touches, so each test starts from a
 * known config and leaves nothing behind for other specs. resetBackendConfig
 * covers provider/mode/model/url/key; the patch clears the rest
 * (providerParams REPLACES the whole blob server-side).
 */
async function resetState(page: Page): Promise<void> {
  await resetBackendConfig(page);
  await patchActiveBackendConfig(page, {
    instructTemplate: '',
    logitBias: null,
    openrouterProvider: null,
    providerParams: {},
  });
  await setSetting(page, 'openrouter.reasoningEffort', '');
  await setSetting(page, 'openrouter.reasoningSummary', '');
}

test.describe('Backend Config Modal', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await login(page);
    await resetState(page);
  });

  test.afterEach(async ({ page }) => {
    await resetState(page);
  });

  test('provider switch shows/hides provider-specific sections, with per-mode fallback', async ({ page }) => {
    const modal = await openBackendConfig(page);

    const apiKeyInput = modal.locator('input[placeholder="sk-..."]');
    const apiUrlInput = modal.locator('label.field-label:has-text("API URL") input');
    const customBackendSelect = modal.locator('label.field-label:has-text("Custom Backend") select');
    const delegateSelect = modal.locator('label.field-label:has-text("Delegate Backend") select');
    const instructSelect = modal.locator('label.field-label:has-text("Instruct Template") select');
    const reasoningEffortSelect = modal.locator('label.field-label:has-text("Reasoning Effort") select');

    // chat/openai (reset default): URL + key visible, custom link hidden.
    await expect(chatProviderSelect(modal)).toHaveValue('openai');
    await expect(apiKeyInput).toBeVisible();
    await expect(apiUrlInput).toHaveAttribute('placeholder', 'https://api.openai.com/v1');
    await expect(customBackendSelect).toHaveCount(0);
    await expect(reasoningEffortSelect).toHaveCount(0);
    await expect(instructSelect).toHaveCount(0);

    // claude / gemini: same fields, provider-specific URL placeholders.
    await chatProviderSelect(modal).selectOption('claude');
    await expect(apiUrlInput).toHaveAttribute('placeholder', 'https://api.anthropic.com/v1');
    await expect(apiKeyInput).toBeVisible();

    await chatProviderSelect(modal).selectOption('gemini');
    await expect(apiUrlInput).toHaveAttribute('placeholder', 'https://generativelanguage.googleapis.com/v1beta');

    // openrouter: the reasoning section appears.
    await chatProviderSelect(modal).selectOption('openrouter');
    await expect(apiUrlInput).toHaveAttribute('placeholder', 'https://openrouter.ai/api/v1');
    await expect(reasoningEffortSelect).toBeVisible();

    // custom: connection fields are replaced by the link + delegate selects.
    await chatProviderSelect(modal).selectOption('custom');
    await expect(apiKeyInput).toHaveCount(0);
    await expect(apiUrlInput).toHaveCount(0);
    await expect(reasoningEffortSelect).toHaveCount(0);
    await expect(customBackendSelect).toBeVisible();
    await expect(delegateSelect).toBeVisible();

    // Switching to text mode invalidates 'custom' -> falls back to openai.
    await generationModeSelect(modal).selectOption('text');
    await expect(textProviderSelect(modal)).toHaveValue('openai');
    await expect(apiKeyInput).toBeVisible();
    await expect(customBackendSelect).toHaveCount(0);
    await expect(instructSelect).toBeVisible();

    // koboldcpp / llamacpp: local-server URL placeholders + advanced profiles.
    await textProviderSelect(modal).selectOption('koboldcpp');
    await expect(apiUrlInput).toHaveAttribute('placeholder', 'http://localhost:5001');
    await expect(modal.locator('#sampler-mirostat')).toBeAttached();

    await textProviderSelect(modal).selectOption('llamacpp');
    await expect(apiUrlInput).toHaveAttribute('placeholder', 'http://localhost:8080');

    // Back to chat mode: llamacpp is invalid there -> falls back to openai.
    await generationModeSelect(modal).selectOption('chat');
    await expect(chatProviderSelect(modal)).toHaveValue('openai');
    await expect(instructSelect).toHaveCount(0);
    await expect(apiKeyInput).toBeVisible();

    await closeModal(modal);
  });

  test('text mode reveals the instruct-template select and the choice persists', async ({ page }) => {
    let modal = await openBackendConfig(page);

    // Chat mode: no instruct template.
    await expect(modal.locator('label.field-label:has-text("Instruct Template")')).toHaveCount(0);

    await generationModeSelect(modal).selectOption('text');
    const instructSelect = modal.locator('label.field-label:has-text("Instruct Template") select');
    await expect(instructSelect).toBeVisible();
    // Built-in templates are listed.
    await expect(instructSelect.locator('option[value="alpaca"]')).toHaveCount(1);
    await expect(instructSelect.locator('option[value="llama3"]')).toHaveCount(1);

    await instructSelect.selectOption('llama3');
    await closeModal(modal);

    modal = await openBackendConfig(page);
    await expect(generationModeSelect(modal)).toHaveValue('text');
    await expect(modal.locator('label.field-label:has-text("Instruct Template") select')).toHaveValue('llama3');
    await closeModal(modal);
  });

  test('advanced sampler enable/disable and the omit/on/off tri-state persist', async ({ page }) => {
    let modal = await openBackendConfig(page);

    // Chat profile (openai): the Seed knob renders disabled (unset = not sent).
    await modal.locator('details.advanced-sampling summary').click();
    const seedInput = modal.locator('#sampler-seed');
    const seedToggle = modal.locator('.sampler-field:has(#sampler-seed) input.checkbox-input');
    await expect(seedInput).toBeVisible();
    await expect(seedInput).toBeDisabled();
    await expect(seedToggle).not.toBeChecked();

    // Enable it and set a value.
    await seedToggle.click();
    await expect(seedInput).toBeEnabled();
    await seedInput.fill('1234');
    await closeModal(modal);

    // Reopen: enabled state + value persisted.
    modal = await openBackendConfig(page);
    await modal.locator('details.advanced-sampling summary').click();
    await expect(modal.locator('#sampler-seed')).toBeEnabled();
    await expect(modal.locator('#sampler-seed')).toHaveValue('1234');

    // Text mode exposes boolean knobs with the omit/on/off radio tri-state.
    await generationModeSelect(modal).selectOption('text');
    const dynatempRadio = (label: string) =>
      modal.locator(`label.radio-row:has(input[name="knob-dynatemp"]):has-text("${label}") input`);
    const omitRadio = dynatempRadio('Omit field');
    const onRadio = dynatempRadio('On');
    const offRadio = dynatempRadio('Off');

    // An unset boolean knob starts at 'Omit field'.
    await expect(omitRadio).toBeChecked();
    await onRadio.click();
    await expect(onRadio).toBeChecked();
    await offRadio.click();
    await expect(offRadio).toBeChecked();
    await omitRadio.click();
    await expect(omitRadio).toBeChecked();
    await onRadio.click();
    await expect(onRadio).toBeChecked();
    await closeModal(modal);

    // Persists: text mode and the dynatemp 'On' state survive a reopen.
    modal = await openBackendConfig(page);
    await expect(generationModeSelect(modal)).toHaveValue('text');
    await modal.locator('details.advanced-sampling summary').click();
    await expect(
      modal.locator('label.radio-row:has(input[name="knob-dynatemp"]):has-text("On") input'),
    ).toBeChecked();
    await closeModal(modal);
  });

  test('logit bias text parses on save and serializes back identically', async ({ page }) => {
    let modal = await openBackendConfig(page);
    // Format is "token:bias", one entry per line (see parseLogitBias).
    const logitBiasArea = modal.locator('label.field-label:has-text("Logit Bias") textarea');
    await expect(logitBiasArea).toHaveValue('');
    await logitBiasArea.fill('123:-5\n456:2');
    await closeModal(modal);

    modal = await openBackendConfig(page);
    await expect(modal.locator('label.field-label:has-text("Logit Bias") textarea')).toHaveValue('123:-5\n456:2');
    await closeModal(modal);
  });

  test('openrouter: provider filter narrows the model list; reasoning settings persist', async ({ page }) => {
    // /api/models proxies the real provider; stub it so the OpenRouter provider
    // filter has slash-namespaced model ids to work with offline.
    await page.route('**/api/models', (route) =>
      route.fulfill({
        json: {
          items: [
            { id: 'anthropic/claude-e2e', name: 'Claude E2E' },
            { id: 'google/gemini-e2e', name: 'Gemini E2E' },
            { id: 'openai/gpt-e2e', name: 'GPT E2E' },
          ],
          total: 3,
        },
      }),
    );

    let modal = await openBackendConfig(page);
    await chatProviderSelect(modal).selectOption('openrouter');

    // The provider filter appears once the model list exposes providers.
    const orProviderSelect = modal.locator('label.field-label:has-text("OpenRouter Provider") select');
    await expect(orProviderSelect).toBeVisible();

    // Filtering resets a model that doesn't match the prefix...
    const modelSelect = modal.locator('.model-picker-row select');
    await orProviderSelect.selectOption('anthropic');
    await expect(modelSelect).toHaveValue('');
    // ...and narrows the model list to that provider's models.
    await expect(modelSelect.locator('option', { hasText: 'Claude E2E' })).toHaveCount(1);
    await expect(modelSelect.locator('option', { hasText: 'GPT E2E' })).toHaveCount(0);
    await expect(modelSelect.locator('option', { hasText: 'Gemini E2E' })).toHaveCount(0);
    await modelSelect.selectOption('anthropic/claude-e2e');

    const effortSelect = modal.locator('label.field-label:has-text("Reasoning Effort") select');
    const summarySelect = modal.locator('label.field-label:has-text("Reasoning Summary") select');
    await effortSelect.selectOption('high');
    await summarySelect.selectOption('concise');
    await closeModal(modal);

    modal = await openBackendConfig(page);
    await expect(chatProviderSelect(modal)).toHaveValue('openrouter');
    await expect(modal.locator('label.field-label:has-text("OpenRouter Provider") select')).toHaveValue('anthropic');
    await expect(modal.locator('.model-picker-row select')).toHaveValue('anthropic/claude-e2e');
    await expect(modal.locator('label.field-label:has-text("Reasoning Effort") select')).toHaveValue('high');
    await expect(modal.locator('label.field-label:has-text("Reasoning Summary") select')).toHaveValue('concise');
    await closeModal(modal);
  });

  test('custom provider links a Lua custom backend and the link persists', async ({ page }) => {
    const backendName = uniqueName('Link Backend');

    // Create a custom backend through its own modal first (UI, per
    // custom-backend-crud.spec.ts patterns).
    const cbBtn = page.locator('button.settings-btn:has-text("Custom Backends")');
    await cbBtn.scrollIntoViewIfNeeded();
    await cbBtn.click();
    const cbModal = page.locator('.settings-modal').filter({
      has: page.locator('h2.modal-title', { hasText: 'Custom Backends' }),
    });
    await expect(cbModal).toBeVisible();
    await cbModal.locator('button:has-text("Add Custom Backend")').click();
    await cbModal.locator('input[placeholder="my-backend"]').fill(backendName);
    await cbModal
      .locator('label:has-text("Lua Source") textarea')
      .fill('function generate(prompt, ctx)\n  return "ok"\nend');
    await cbModal.locator('button:has-text("Save")').click();
    await expect(cbModal.locator('.flex-between', { hasText: backendName })).toBeVisible({ timeout: 5000 });
    await closeModal(cbModal);

    // Link it in Backend Config under the custom provider.
    let modal = await openBackendConfig(page);
    await chatProviderSelect(modal).selectOption('custom');
    const linkSelect = modal.locator('label.field-label:has-text("Custom Backend") select');
    await expect(linkSelect).toBeVisible();
    await expect(linkSelect.locator('option', { hasText: backendName })).toHaveCount(1);
    await linkSelect.selectOption({ label: backendName });
    const backendId = await linkSelect.inputValue();
    expect(backendId).not.toBe('');
    await closeModal(modal);

    // Persists across reopen: the provider and the stored link survive.
    modal = await openBackendConfig(page);
    await expect(chatProviderSelect(modal)).toHaveValue('custom');
    const relinkSelect = modal.locator('label.field-label:has-text("Custom Backend") select');
    await expect(relinkSelect.locator('option', { hasText: backendName })).toHaveCount(1);
    // NOTE: the re-rendered select shows the placeholder even though a backend
    // is linked — the modal's onMount custombackend.list response replaces the
    // option nodes after Solid applied the select's value binding, and the
    // binding never re-runs (client display bug, no data loss). Persistence is
    // therefore verified at the saved-config level.
    const saved = await readActiveBackendConfig(page);
    expect(saved['backendProvider']).toBe('custom');
    expect((saved['providerParams'] as Record<string, unknown>)?.['customBackendId']).toBe(backendId);
    await closeModal(modal);

    // Cleanup: unlink (provider back to openai + cleared providerParams), then
    // delete the custom backend through its modal.
    await resetBackendConfig(page);
    await patchActiveBackendConfig(page, { providerParams: {} });
    await cbBtn.scrollIntoViewIfNeeded();
    await cbBtn.click();
    await expect(cbModal).toBeVisible();
    await cbModal.locator('.flex-between', { hasText: backendName }).locator('button:has-text("Delete")').click();
    const popup = page.locator('.popup-modal');
    await expect(popup).toBeVisible();
    await popup.locator('button.primary').click();
    await expect(popup).not.toBeVisible();
    await expect(cbModal.locator('.flex-between', { hasText: backendName })).toHaveCount(0);
    await closeModal(cbModal);
  });

  test('duplicate creates a copy that can be renamed and deleted; original unaffected', async ({ page }) => {
    let modal = await openBackendConfig(page);
    const configSelect = modal.locator('select').first();
    const nameInput = modal.locator('input.input').first();
    const originalName = await nameInput.inputValue();
    const optionTexts = async () => configSelect.locator('option').allTextContents();

    // Duplicate the active config -> "<name> (Copy)" appears alongside it.
    await modal.locator('button:has-text("Duplicate Config")').click();
    const copyDefaultName = `${originalName} (Copy)`;
    await expect.poll(optionTexts).toContain(copyDefaultName);
    expect(await optionTexts()).toContain(originalName);

    // Switch to the copy and rename it. Wait for the copy's snapshot to land
    // in the form first: switchConfig's backendConfig.select round-trips, and
    // if loadConfigData resets the input mid-fill (selection is lost before
    // onInput marks the form dirty), insertText APPENDS to the old name
    // ("Default (Copy)E2E Copy …") instead of replacing it.
    await configSelect.selectOption({ label: copyDefaultName });
    await expect(nameInput).toHaveValue(copyDefaultName);
    const copyName = uniqueName('E2E Copy');
    await nameInput.fill(copyName);
    await nameInput.blur();
    await expect.poll(optionTexts).toContain(copyName);

    // Delete the copy; confirm in the popup.
    await modal.locator('button:has-text("Delete Config")').click();
    const popup = page.locator('.popup-modal');
    await expect(popup).toBeVisible();
    await expect(popup).toContainText(`Delete backend config "${copyName}"?`);
    await popup.locator('button.primary').click();
    await expect(popup).not.toBeVisible();

    // The copy is gone; the original config is still listed.
    await expect.poll(optionTexts).not.toContain(copyName);
    expect(await optionTexts()).toContain(originalName);
    await closeModal(modal);

    // Reopen: the original config is still the active one, name intact.
    modal = await openBackendConfig(page);
    await expect(modal.locator('input.input').first()).toHaveValue(originalName);
    await closeModal(modal);
  });

  test('secret picker writes secret:<key> into the API key field and persists', async ({ page }) => {
    const key = `e2e-picker-${Date.now()}`;
    const label = uniqueName('Picker Secret');
    await postSecret(page, key, 'sk-picked', label);

    try {
      let modal = await openBackendConfig(page);
      await modal.locator('.secret-picker button[title="Use vault secret"]').click();
      const dropdown = modal.locator('.secret-picker-dropdown');
      await expect(dropdown).toBeVisible();
      await dropdown.locator('.secret-picker-item', { hasText: label }).click();
      // Picking closes the dropdown and writes the reference into the field.
      await expect(dropdown).toHaveCount(0);
      await expect(modal.locator('input[placeholder="sk-..."]')).toHaveValue(`secret:${key}`);
      await closeModal(modal);

      modal = await openBackendConfig(page);
      await expect(modal.locator('input[placeholder="sk-..."]')).toHaveValue(`secret:${key}`);
      await closeModal(modal);
    } finally {
      await deleteSecret(page, key);
    }
  });
});
