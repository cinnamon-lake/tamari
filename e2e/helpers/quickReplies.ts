/**
 * Quick-reply helpers for scripting-API (`st.*` Lua) E2E specs.
 *
 * Extracted from the inline pattern in tests/stapi-integration.spec.ts and
 * tests/stapi-generation.spec.ts: create a global Lua quick reply through the
 * chat view's quick reply bar (the `+` button opens the QuickReplyEditor;
 * scope defaults to global), then click its button in the bar. Scripts run
 * server-side with the full `st` API; the canonical assertion pattern is
 * building a labeled result string in Lua (one `name=OK` / `name=FAIL` token
 * per check, ending with a literal end token) and pushing it into the chat
 * with `st.send_narrator(out):await()`.
 *
 * NOTE: the quick reply bar only exists in the chat view, so these helpers
 * require an open chat (createCharacterAndChat / group chat first).
 */
import { expect, type Locator, type Page } from '@playwright/test';

export function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

/**
 * Create a global Lua quick reply via the chat view's quick reply bar (`+`
 * button → QuickReplyEditor; the scope select defaults to 'global'). Requires
 * an open chat. Waits for the created broadcast to render the bar button.
 */
export async function createLuaQuickReply(page: Page, label: string, script: string): Promise<void> {
  await page.locator('.quick-reply-bar .quick-reply-add').click();

  const editor = page.locator('.qr-modal');
  await expect(editor).toBeVisible();
  await editor.locator('#qr-label').fill(label);
  await editor.locator('#qr-script').fill(script);
  await editor.locator('button.btn-primary:has-text("Save")').click();
  await expect(editor).not.toBeVisible();

  // Sync point: the quickreply.created broadcast renders the button.
  await expect(
    page.locator('.quick-reply-bar .quick-reply-btn').filter({ hasText: label }),
  ).toBeVisible();
}

/**
 * Delete a quick reply by label via the bar: right-click its button (the
 * bar's onContextMenu opens the editor in edit mode) → Delete. No-op when the
 * label isn't in the current bar (cleanup path after a failed test).
 */
export async function deleteLuaQuickReply(page: Page, label: string): Promise<void> {
  const qrBtn = page.locator('.quick-reply-bar .quick-reply-btn').filter({ hasText: label });
  if ((await qrBtn.count()) === 0) return;
  await qrBtn.first().click({ button: 'right' });

  const editor = page.locator('.qr-modal');
  await expect(editor).toBeVisible();
  await editor.locator('button.btn-danger:has-text("Delete")').click();
  await expect(editor).not.toBeVisible();
  await expect(qrBtn).toHaveCount(0);
}

/** Click a quick reply in the chat's quick reply bar by its label. */
export async function clickQuickReply(page: Page, label: string): Promise<void> {
  const qrBtn = page.locator('.quick-reply-bar .quick-reply-btn').filter({ hasText: label });
  await expect(qrBtn).toBeVisible();
  await qrBtn.click();
}

/** The content node of the most recent narrator (system-role) bubble. */
export function lastNarratorBubble(page: Page): Locator {
  return page.locator('.message-bubble.system .message-content').last();
}

/**
 * Assert the latest narrator bubble reached `endToken` (proof the script ran
 * to completion) and recorded no `name=FAIL` check results.
 */
export async function expectNarratorChecks(page: Page, endToken = 'ALLDONE'): Promise<Locator> {
  const bubble = lastNarratorBubble(page);
  await expect(bubble).toContainText(endToken, { timeout: 15000 });
  await expect(bubble).not.toContainText('=FAIL');
  return bubble;
}
