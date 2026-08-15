/**
 * Quick Reply auto-execute coverage — server/src/scripting/QuickReplyService.ts
 * (runAutoExecute) + the trigger checkboxes in client/src/components/QuickReplyEditor.tsx,
 * plus the script.error → toast surfacing path (client/src/stores/serverStore.ts).
 *
 * Trigger wiring: dispatch/generationHandlers.ts runs
 * runAutoExecute(chatId, QuickReplyAutoExecute.USER_MESSAGE) right after
 * action.send appends the user message — no button click involved.
 *
 * HISTORY — the send/generate race (FIXED): the send button used to dispatch
 * action.send AND action.generate as separate frames, which the server
 * dispatched fire-and-forget — the two coroutines raced at the chat mutex and
 * the USER_MESSAGE auto-execute was silently skipped whenever generation won
 * (observed: 5/5 passes solo, failure under full-suite load). The fix:
 * MessageInput now sends ONE atomic action.sendAndGenerate; the server runs
 * append → USER_MESSAGE auto-execute → generate in a single dispatch
 * coroutine, so the QR always gets the lock. The empty-group-chat trick below
 * (generation short-circuits before locking) is kept as extra determinism
 * but is no longer load-bearing.
 *
 * HISTORY — lifecycle triggers (FIXED): 'Before generation' and 'AI message'
 * QRs used to be structurally unable to run — the callbacks fired INSIDE the
 * generation's lock tenure, so the QR's fail-fast tryLock always failed and
 * silent mode swallowed it. The callbacks now run OUTSIDE the tenure (before
 * acquire / after release), so these triggers execute — asserted in the last
 * test below.
 *
 * NOTE on error surfacing: per QuickReplyService.execute(), `silent: true` only
 * suppresses the "Chat is busy" lock-acquisition error; a Lua runtime error is
 * still relayed as script.error → error toast for BOTH manual and auto
 * execution.
 *
 * st.send_narrator is used in its two-argument (name, content) form — the
 * single-argument overload is a known live bug (see
 * tests/quickreply-send-narrator.spec.ts).
 *
 * Created quick replies are deleted in afterEach so their triggers can't
 * leak into other specs (QRs are global and the e2e server is shared).
 */
import { test, expect } from '../fixtures/base.js';
import type { Page } from '@playwright/test';
import { login } from '../helpers/auth.js';
import { createLuaQuickReply, deleteLuaQuickReply, clickQuickReply } from '../helpers/quickReplies.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

/** createLuaQuickReply + checking one Auto-execute trigger checkbox. */
async function createLuaQuickReplyWithTrigger(
  page: Page,
  label: string,
  script: string,
  triggerLabel: string,
): Promise<void> {
  await page.locator('.quick-reply-bar .quick-reply-add').click();

  const editor = page.locator('.qr-modal');
  await expect(editor).toBeVisible();
  await editor.locator('#qr-label').fill(label);
  await editor.locator('#qr-script').fill(script);
  const triggerBox = editor
    .locator('label.qr-checkbox', { hasText: triggerLabel })
    .locator('input[type="checkbox"]');
  await triggerBox.check();
  await expect(triggerBox).toBeChecked();
  await editor.locator('button.btn-primary:has-text("Save")').click();
  await expect(editor).not.toBeVisible();

  // Sync point: the quickreply.created broadcast renders the bar button.
  await expect(
    page.locator('.quick-reply-bar .quick-reply-btn').filter({ hasText: label }),
  ).toBeVisible();
}

/**
 * Create a group chat with no members. With zero activated members,
 * handleGenerate errors out BEFORE acquiring the per-chat mutex, so a
 * USER_MESSAGE auto-execute QR never races a generation for the lock.
 */
async function createEmptyGroupChat(page: Page, groupName: string): Promise<void> {
  await page.locator('[title="New group chat"]').click();
  const popup = page.locator('.popup-modal');
  await expect(popup).toBeVisible();
  await popup.locator('.popup-input').fill(groupName);
  await popup.locator('.popup-actions button.primary').click();
  await expect(popup).not.toBeVisible();
  await expect(page.locator('.group-chat-toolbar')).toBeVisible();
}

async function deleteQuickReply(page: Page, label: string): Promise<void> {
  // Right-click the bar button → editor opens in edit mode → Delete. No-op
  // when the label isn't in the current bar (cleanup after a failed test).
  await deleteLuaQuickReply(page, label);
}

test.describe('Quick Reply auto-execute triggers', () => {
  const createdLabels: string[] = [];

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
    for (const label of createdLabels.splice(0)) {
      await deleteQuickReply(page, label);
    }
  });

  test('a User-message quick reply auto-executes without being clicked', async ({ page }) => {
    const app = new App(page);
    // Empty group chat: generation short-circuits before locking the chat, so
    // the auto-execute QR deterministically wins the lock (see header).
    await createEmptyGroupChat(page, uniqueName('QR Auto Group'));

    const label = uniqueName('QR Auto UserMsg');
    const token = `AUTO_FIRED_${Date.now()}`;
    createdLabels.push(label);
    await createLuaQuickReplyWithTrigger(
      page,
      label,
      `st.send_narrator("Narrator", "${token}"):await()`,
      'User message',
    );

    // Sending any message fires the trigger (generationHandlers action.send →
    // runAutoExecute); the narrator bubble appears with no QR button click.
    await app.sendUserMessage('auto trigger ok');
    await expect(
      page.locator('.message-bubble.system .message-content', { hasText: token }),
    ).toBeVisible({ timeout: 15000 });
  });

  test('a manually clicked erroring quick reply surfaces an error toast', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('QR Manual Err Char');
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    const label = uniqueName('QR Manual Boom');
    const token = `boom_manual_${Date.now()}`;
    createdLabels.push(label);
    await createLuaQuickReply(page, label, `error('${token}')`);

    await clickQuickReply(page, label);
    await expect(page.locator('.toast-container')).toContainText(token, { timeout: 15000 });
  });

  test('an auto-executed erroring quick reply surfaces script.error (silent only hides busy-lock)', async ({ page }) => {
    const app = new App(page);
    // Empty group chat, like the positive auto-execute test: the QR runs
    // deterministically instead of racing the generation for the chat lock.
    await createEmptyGroupChat(page, uniqueName('QR Auto Err Group'));

    const label = uniqueName('QR Auto Boom');
    const token = `boom_auto_${Date.now()}`;
    createdLabels.push(label);
    await createLuaQuickReplyWithTrigger(page, label, `error('${token}')`, 'User message');

    await app.sendUserMessage('auto error turn');
    // QuickReplyService.execute sends script.error for Lua runtime errors even
    // in silent (auto-execute) mode — only the lock-contention error is suppressed.
    await expect(page.locator('.toast-container')).toContainText(token, { timeout: 15000 });
  });

  test('a Before-generation quick reply executes (lifecycle callbacks run outside the lock)', async ({ page }) => {
    const app = new App(page);
    await configureMockBackend(page);
    const charName = uniqueName('QR Before Char');
    await app.createCharacterAndChat({ name: charName, firstMes: `I am ${charName}.` });

    const label = uniqueName('QR Auto Before');
    const token = `before_fired_${Date.now()}`;
    createdLabels.push(label);
    // 'Before generation' fires from onBeforeGeneration, which now runs BEFORE
    // the generation acquires the chat mutex — the QR executes, and its Lua
    // error still surfaces as a toast even in silent (auto-execute) mode.
    await createLuaQuickReplyWithTrigger(page, label, `error('${token}')`, 'Before generation');

    // The generation still completes normally…
    await app.sendUserMessage('respond: before ok', { expectReply: true });
    // …and the QR's error toast proves it ran (it used to be silently skipped
    // every time — the tryLock inside the generation tenure always failed).
    await expect(page.locator('.toast-container')).toContainText(token, { timeout: 15000 });
  });
});
