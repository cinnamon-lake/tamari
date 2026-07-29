/**
 * Custom Backends modal (Lua backend registry) + BackendDryRunPanel coverage.
 *
 * Exercises the full UI CRUD loop (add → persistence → edit → delete) and the
 * dry-run stack: happy path with a canned delegate, state round-trip via the
 * `state` global / State Out / "Use as state for next run" button, the
 * structured error path, and the per-delegation prompt preview.
 *
 * Verified against:
 * - client/src/components/CustomBackendsModal.tsx
 * - client/src/components/BackendDryRunPanel.tsx
 * - server/src/dispatch/customBackendHandlers.ts (custombackend.* WS messages)
 * - server/src/backends/customBackendDryRun.ts (DryRunOutcome shape)
 * - server/src/backends/LuaBackendAdapter.ts (state protocol: scriptState
 *   restores the `state` global via json.decode; stateOut is json.encode(state)
 *   when no serialize() is defined)
 */

import { test, expect } from '../fixtures/base.js';
import type { Page, Locator } from '@playwright/test';
import { login } from '../helpers/auth.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

async function openModal(page: Page): Promise<Locator> {
  const btn = page.locator('button.settings-btn:has-text("Custom Backends")');
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  const modal = page.locator('.settings-modal').filter({
    has: page.locator('h2.modal-title', { hasText: 'Custom Backends' }),
  });
  await expect(modal).toBeVisible();
  return modal;
}

async function closeModal(page: Page, modal: Locator): Promise<void> {
  await modal.locator('.modal-actions button:has-text("Close")').click();
  await expect(modal).not.toBeVisible();
}

/** Open the add form and fill name + Lua source (description optional). */
async function openAddForm(
  modal: Locator,
  name: string,
  luaSource: string,
  description?: string,
): Promise<void> {
  await modal.locator('button:has-text("Add Custom Backend")').click();
  await modal.locator('input[placeholder="my-backend"]').fill(name);
  if (description !== undefined) {
    await modal.locator('label:has-text("Description") input').fill(description);
  }
  await modal.locator('label:has-text("Lua Source") textarea').fill(luaSource);
}

test.describe('Custom Backends', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('UI CRUD: add, persists across reopen, edit, delete with confirm', async ({ page }) => {
    const name = uniqueName('CRUD Backend');
    const renamed = `${name} renamed`;
    const luaV1 = 'function generate(prompt, ctx)\n  return "v1"\nend';
    const luaV2 = 'function generate(prompt, ctx)\n  return "v2"\nend';

    // ── Add ──────────────────────────────────────────────────────────────
    let modal = await openModal(page);
    await openAddForm(modal, name, luaV1, 'e2e crud description');
    await modal.locator('button:has-text("Save")').click();
    const row = modal.locator('.flex-between', { hasText: name });
    await expect(row).toBeVisible({ timeout: 5000 });
    await expect(row).toContainText('e2e crud description');

    // ── Persistence: close + reopen, item still listed ───────────────────
    await closeModal(page, modal);
    modal = await openModal(page);
    await expect(modal.locator('.flex-between', { hasText: name })).toBeVisible({ timeout: 5000 });

    // ── Edit: rename + change source ─────────────────────────────────────
    await modal.locator('.flex-between', { hasText: name }).locator('button:has-text("Edit")').click();
    await expect(modal.locator('input[placeholder="my-backend"]')).toHaveValue(name);
    await expect(modal.locator('label:has-text("Lua Source") textarea')).toHaveValue(luaV1);
    await modal.locator('input[placeholder="my-backend"]').fill(renamed);
    await modal.locator('label:has-text("Lua Source") textarea').fill(luaV2);
    await modal.locator('button:has-text("Save")').click();
    await expect(modal.locator('.flex-between', { hasText: renamed })).toBeVisible({ timeout: 5000 });
    await expect(modal.locator('.flex-between', { hasText: name }).filter({ hasNotText: 'renamed' })).toHaveCount(0);

    // ── Persistence of the edit: reopen and inspect the stored source ────
    await closeModal(page, modal);
    modal = await openModal(page);
    await expect(modal.locator('.flex-between', { hasText: renamed })).toBeVisible({ timeout: 5000 });
    await modal.locator('.flex-between', { hasText: renamed }).locator('button:has-text("Edit")').click();
    await expect(modal.locator('label:has-text("Lua Source") textarea')).toHaveValue(luaV2);
    await modal.locator('button:has-text("Cancel")').click();

    // ── Delete: confirm popup, then gone (and stays gone after reopen) ───
    await modal.locator('.flex-between', { hasText: renamed }).locator('button:has-text("Delete")').click();
    const popup = page.locator('.popup-modal');
    await expect(popup).toBeVisible();
    await expect(popup).toContainText(`Delete custom backend "${renamed}"?`);
    await popup.locator('button.primary').click();
    await expect(popup).not.toBeVisible();
    await expect(modal.locator('.flex-between', { hasText: renamed })).toHaveCount(0, { timeout: 5000 });

    await closeModal(page, modal);
    modal = await openModal(page);
    await expect(modal.locator('.flex-between', { hasText: renamed })).toHaveCount(0);
    await closeModal(page, modal);
  });

  test('dry-run happy path: canned delegate, usage line, delegations details', async ({ page }) => {
    const modal = await openModal(page);
    await openAddForm(
      modal,
      uniqueName('Dry Run'),
      'function generate(prompt, ctx)\n  local r = backends.generate(prompt):await()\n  return "echo:" .. r.text\nend',
    );

    const panel = modal.locator('.backend-dry-run-panel');
    await panel.locator('label:has-text("Sample Input") textarea').fill('hello world');
    await panel.locator('label:has-text("Delegate Response") input').fill('canned reply');
    await panel.locator("button.primary-btn").click();

    const result = panel.locator('.backend-dry-run-result');
    await expect(result).toBeVisible({ timeout: 15000 });
    // Output: script echoed the canned delegate response.
    await expect(result.locator('span:has-text("Output") + pre')).toHaveText('echo:canned reply');
    // Usage line: the recording delegate reports 0/0 tokens.
    await expect(result.locator('p', { hasText: 'Tokens:' })).toHaveText('Tokens: 0 prompt / 0 completion');
    // Delegations: one <details> per delegated backends.generate() call.
    await expect(result.locator('span', { hasText: 'Delegations' })).toHaveText('Delegations (1)');
    const details = result.locator('details');
    await expect(details).toHaveCount(1);
    await expect(details.locator('summary')).toContainText('default delegate');
    await expect(details.locator('pre')).toHaveText('canned reply');

    await closeModal(page, modal);
  });

  test('dry-run state round-trip: stateOut renders and feeds into the next run', async ({ page }) => {
    const modal = await openModal(page);
    await openAddForm(
      modal,
      uniqueName('Dry Run State'),
      [
        'function generate(prompt, ctx)',
        '  local turn = 0',
        '  if type(state) == "table" and state.turn then turn = state.turn end',
        '  turn = turn + 1',
        '  state = { turn = turn }',
        '  return "turn " .. turn',
        'end',
      ].join('\n'),
    );

    const panel = modal.locator('.backend-dry-run-panel');
    const stateInput = panel.locator('label:has-text("State (JSON") input');
    await panel.locator('label:has-text("Sample Input") textarea').fill('hello world');
    await stateInput.fill('{"turn": 1}');
    await panel.locator("button.primary-btn").click();

    const result = panel.locator('.backend-dry-run-result');
    await expect(result).toBeVisible({ timeout: 15000 });
    await expect(result.locator('span:has-text("Output") + pre')).toHaveText('turn 2');
    // State Out: no serialize() defined, so the adapter json.encodes `state`.
    const stateOut = result.locator('span:has-text("State Out") + pre');
    await expect(stateOut).toContainText(/"turn":\s*2/);

    // Feed the returned state back as the next run's input state, then re-run.
    await result.locator('button:has-text("Use as state for next run")').click();
    await expect(stateInput).toHaveValue(/"turn":\s*2/);
    await panel.locator("button.primary-btn").click();
    await expect(result.locator('span:has-text("Output") + pre')).toHaveText('turn 3', { timeout: 15000 });
    await expect(stateOut).toContainText(/"turn":\s*3/);

    await closeModal(page, modal);
  });

  test('dry-run error path: Lua error surfaces as a structured error', async ({ page }) => {
    const modal = await openModal(page);
    await openAddForm(
      modal,
      uniqueName('Dry Run Error'),
      'function generate(prompt, ctx)\n  error("boom-dry-run")\nend',
    );

    const panel = modal.locator('.backend-dry-run-panel');
    await panel.locator('label:has-text("Sample Input") textarea').fill('hello world');
    await panel.locator("button.primary-btn").click();

    const result = panel.locator('.backend-dry-run-result');
    await expect(result).toBeVisible({ timeout: 15000 });
    // ok=false → the error paragraph renders the adapter's error message.
    await expect(result.locator('p.text-danger')).toContainText('boom-dry-run');

    await closeModal(page, modal);
  });

  test('dry-run prompt preview: delegation summary shows the delegated prompt', async ({ page }) => {
    const modal = await openModal(page);
    await openAddForm(
      modal,
      uniqueName('Dry Run Preview'),
      [
        'function generate(prompt, ctx)',
        '  local r = backends.generate({ messages = { { role = "user", content = "delegated-prompt-sentinel" } } }):await()',
        '  return r.text',
        'end',
      ].join('\n'),
    );

    const panel = modal.locator('.backend-dry-run-panel');
    await panel.locator('label:has-text("Sample Input") textarea').fill('hello world');
    await panel.locator('label:has-text("Delegate Response") input').fill('canned reply');
    await panel.locator("button.primary-btn").click();

    const result = panel.locator('.backend-dry-run-result');
    await expect(result).toBeVisible({ timeout: 15000 });
    // The delegation's promptPreview is "role: content" per message — it must
    // show the prompt the script actually handed to the delegate, not the
    // original sample input.
    await expect(result.locator('details summary')).toContainText('user: delegated-prompt-sentinel');
    await expect(result.locator('details summary')).not.toContainText('hello world');
    await expect(result.locator('span:has-text("Output") + pre')).toHaveText('canned reply');

    await closeModal(page, modal);
  });
});
