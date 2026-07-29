/**
 * Quick-reply helpers for scripting-API (`st.*` Lua) E2E specs.
 *
 * Extracted from the inline pattern in tests/stapi-integration.spec.ts and
 * tests/stapi-generation.spec.ts: create a global Lua quick reply through
 * Settings → Quick Replies, then click its button in the chat's quick reply
 * bar. Scripts run server-side with the full `st` API; the canonical
 * assertion pattern is building a labeled result string in Lua (one
 * `name=OK` / `name=FAIL` token per check, ending with a literal end token)
 * and pushing it into the chat with `st.send_narrator(out):await()`.
 */
import { expect, type Locator, type Page } from '@playwright/test';

export function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

/** Create a global Lua quick reply via Settings → Quick Replies. */
export async function createLuaQuickReply(page: Page, label: string, script: string): Promise<void> {
  await page.locator('button.settings-btn:has-text("Settings")').click();
  const settings = page.locator('.settings-modal');
  await expect(settings).toBeVisible();

  await settings.locator('h3:has-text("Quick Replies")').scrollIntoViewIfNeeded();
  await settings.locator('button:has-text("Add Quick Reply")').click();

  const editor = page.locator('.qr-modal');
  await expect(editor).toBeVisible();
  await editor.locator('label:has-text("Label") + input').fill(label);
  await editor.locator('label:has-text("Script (Lua)") + textarea').fill(script);
  await editor.locator('button:has-text("Save")').click();
  await expect(editor).not.toBeVisible();

  await settings.locator('button.btn:has-text("Close")').click();
  await expect(settings).not.toBeVisible();
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
