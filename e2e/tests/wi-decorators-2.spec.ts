import { test, expect } from '../fixtures/base.js';
import type { Page } from '@playwright/test';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { getLastLlmRequest, resetLlmRequests, waitForNextLlmRequest } from '../helpers/llm.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

interface EntrySpec {
  keys: string;
  content: string;
  /** Set the Probability % field (number input, saved on blur). */
  probability?: number;
  /** Tick the Regex checkbox (keys treated as raw RegExp patterns). */
  regex?: boolean;
}

async function openWorldInfoEditor(page: Page) {
  const btn = page.locator('button.settings-btn:has-text("World Info")');
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  const editor = page.locator('.worldinfo-modal');
  await expect(editor).toBeVisible();
  return editor;
}

/**
 * Create a lorebook with ONE entry (decorators live in `content`), optionally
 * setting the probability field / regex checkbox, then close the editor.
 */
async function createBookWithEntry(page: Page, bookName: string, entry: EntrySpec): Promise<void> {
  const editor = await openWorldInfoEditor(page);

  await editor.locator('button:has-text("New Lorebook")').click();
  await editor.locator('.worldinfo-item').filter({ hasText: 'New Lorebook' }).first().click();
  await expect(editor.locator('.book-editor')).toBeVisible();
  await editor.locator('.book-name-input').fill(bookName);
  await editor.locator('.book-name-input').blur();

  await editor.locator('button:has-text("Add Entry")').click();
  await editor.locator('.entry-row').first().click();
  const entryEditor = editor.locator('.entry-editor');
  await expect(entryEditor).toBeVisible();

  const keysInput = entryEditor.locator('label:has-text("Keys") input');
  await keysInput.fill(entry.keys);
  await keysInput.blur();

  const contentArea = entryEditor.locator('label:has-text("Content") textarea');
  await contentArea.fill(entry.content);
  await contentArea.blur();

  if (entry.probability !== undefined) {
    const probInput = entryEditor.locator('label:has-text("Probability") input');
    await probInput.fill(String(entry.probability));
    await probInput.blur();
  }

  if (entry.regex) {
    // scheduleSave (600ms debounce) — a final blur-save below flushes it.
    await entryEditor.locator('.entry-checkboxes label:has-text("Regex") input[type="checkbox"]').click();
  }

  // Force one final blur-save so every field (incl. a debounced regex toggle)
  // is persisted, and wait for the save indicator to confirm the write went out.
  await keysInput.click();
  await keysInput.blur();
  await expect(entryEditor.locator('.save-indicator')).toBeVisible({ timeout: 3000 });

  await page.locator('.modal-overlay:has(.worldinfo-modal)').click({ position: { x: 0, y: 0 } });
  await expect(editor).not.toBeVisible();
}

/**
 * Create a character linked to an existing one-entry lorebook and open a chat.
 * The lorebook is linked BEFORE filling fields (the debounced auto-save must
 * include worldInfoId before the first generation's prompt build).
 */
async function createLinkedCharacterAndChat(app: App, charName: string, bookName: string): Promise<void> {
  const page = app.page;
  await page.locator('[title="Create character"]').click();
  const charEditor = page.locator('.character-editor-modal');
  await charEditor.locator('.lorebook-selector select').selectOption({ label: `${bookName} (1 entries)` });
  await charEditor.locator('.text-input').first().fill(charName);
  await charEditor.locator('.textarea-input').nth(0).fill('Test character.');
  await charEditor.locator('.textarea-input').nth(3).fill(`Hello! I am ${charName}.`);
  await expect(charEditor.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
  await charEditor.locator('[title="Close"]').click();

  await app.startChat(charName);
}

interface ChatMessage {
  role?: string;
  content?: unknown;
}

function messagesOf(body: unknown): ChatMessage[] {
  const reqBody = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  return Array.isArray(reqBody.messages) ? (reqBody.messages as ChatMessage[]) : [];
}

/** All message contents of the captured request joined for substring assertions. */
function allPromptText(body: unknown): string {
  return messagesOf(body)
    .map((m) => String(m.content ?? ''))
    .join('\n');
}

/**
 * Send a user message, wait for the assistant reply, then return the request
 * body the mock LLM captured for THIS turn (polls past `beforeCount` so a
 * stale capture from a prior turn can't satisfy the read).
 */
async function sendAndCapture(app: App, text: string): Promise<unknown> {
  const before = (await getLastLlmRequest()).count;
  await app.sendUserMessage(text, { expectReply: true });
  const captured = await waitForNextLlmRequest(before);
  return captured.body;
}

/**
 * Assert presence/absence of a `[WI] TOKEN` sentinel in the outgoing prompt.
 * Absence must be checked with the bracket prefix: prior mock replies in the
 * history contain `inject:TOKEN`, which would false-positive a bare check.
 */
function expectWiToken(body: unknown, token: string, present: boolean): void {
  const sentinel = `[WI] ${token}`;
  if (present) {
    expect(allPromptText(body)).toContain(sentinel);
  } else {
    expect(allPromptText(body)).not.toContain(sentinel);
  }
}

test.describe('WI V3 Decorators — activation semantics', () => {
  // Multi-turn activation state (sticky/cooldown/delay history) is per-chat;
  // each test builds its own book+character+chat, so serial mode keeps the
  // shared e2e server's state transitions easy to reason about.
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test('@@additional_keys: additional and primary keys both trigger', async ({ page }) => {
    const app = new App(page);
    const bookName = uniqueName('AddKeys');
    await createBookWithEntry(page, bookName, {
      keys: 'sword',
      content: '@@additional_keys blade\n[WI] ADDTOK',
    });

    // Additional key: fresh chat, scan text only contains "blade".
    const charA = uniqueName('AddCharA');
    await createLinkedCharacterAndChat(app, charA, bookName);
    const bodyA = await sendAndCapture(app, 'I need a blade');
    expectWiToken(bodyA, 'ADDTOK', true);
    // The decorator line must not leak into the prompt.
    expect(allPromptText(bodyA)).not.toContain('@@additional_keys');
    // The mock echoed the sentinel back as the reply text.
    await app.waitForAssistantText('inject:ADDTOK');

    // Primary key still works: separate character => fresh chat history, so
    // "blade" is not in the scan text and only "sword" can trigger.
    const charB = uniqueName('AddCharB');
    await createLinkedCharacterAndChat(app, charB, bookName);
    const bodyB = await sendAndCapture(app, 'I need a sword');
    expectWiToken(bodyB, 'ADDTOK', true);
  });

  test('@@exclude_keys: excluded key no longer triggers, other keys still do', async ({ page }) => {
    const app = new App(page);
    const bookName = uniqueName('ExclKeys');
    await createBookWithEntry(page, bookName, {
      keys: 'sword, blade',
      content: '@@exclude_keys sword\n[WI] EXTOK',
    });

    const charName = uniqueName('ExclChar');
    await createLinkedCharacterAndChat(app, charName, bookName);

    // "sword" was the primary key but is excluded -> no injection.
    const body1 = await sendAndCapture(app, 'my sword is sharp');
    expectWiToken(body1, 'EXTOK', false);

    // "blade" survives the exclusion -> injection. Turn-1 "sword" is still in
    // the scan text here, so this also proves the exclusion holds against
    // history (otherwise the entry would have fired on turn 1 already — and
    // the absence assertion above confirmed it did not).
    const body2 = await sendAndCapture(app, 'my blade is sharper');
    expectWiToken(body2, 'EXTOK', true);
    expect(allPromptText(body2)).not.toContain('@@exclude_keys');
  });

  test('@@keep_activate_after_match: stays injected on later turns without the key', async ({ page }) => {
    const app = new App(page);
    const bookName = uniqueName('Sticky');
    await createBookWithEntry(page, bookName, {
      keys: 'stickykey',
      content: '@@keep_activate_after_match\n[WI] STICKYTOK',
    });

    const charName = uniqueName('StickyChar');
    await createLinkedCharacterAndChat(app, charName, bookName);

    // Turn 1: key match -> injected.
    const body1 = await sendAndCapture(app, 'stickykey appears now');
    expectWiToken(body1, 'STICKYTOK', true);

    // Turn 2: no key anywhere new — sticky carry-over keeps injecting.
    const body2 = await sendAndCapture(app, 'nothing relevant here');
    expectWiToken(body2, 'STICKYTOK', true);

    // Turn 3: sticky is STICKY_INFINITY (1_000_000) — still injected.
    const body3 = await sendAndCapture(app, 'still nothing relevant');
    expectWiToken(body3, 'STICKYTOK', true);
    expect(allPromptText(body3)).not.toContain('@@keep_activate_after_match');
  });

  test('@@dont_activate_after_match: fires once, never again', async ({ page }) => {
    const app = new App(page);
    const bookName = uniqueName('OnceOnly');
    await createBookWithEntry(page, bookName, {
      keys: 'oncekey',
      content: '@@dont_activate_after_match\n[WI] ONCETOK',
    });

    const charName = uniqueName('OnceChar');
    await createLinkedCharacterAndChat(app, charName, bookName);

    // Turn 1: first match -> injected.
    const body1 = await sendAndCapture(app, 'oncekey first time');
    expectWiToken(body1, 'ONCETOK', true);

    // Turn 2: key matched before -> suppressed even though the key is present.
    const body2 = await sendAndCapture(app, 'oncekey second time');
    expectWiToken(body2, 'ONCETOK', false);

    // Turn 3: still suppressed.
    const body3 = await sendAndCapture(app, 'oncekey third time');
    expectWiToken(body3, 'ONCETOK', false);
    expect(allPromptText(body3)).not.toContain('@@dont_activate_after_match');
  });

  test('@@activate_only_every 3: present, absent, present cadence', async ({ page }) => {
    const app = new App(page);
    const bookName = uniqueName('Cooldown');
    await createBookWithEntry(page, bookName, {
      keys: 'coolkey',
      content: '@@activate_only_every 3\n[WI] COOLTOK',
    });

    const charName = uniqueName('CoolChar');
    await createLinkedCharacterAndChat(app, charName, bookName);

    // Cooldown semantics (WorldInfoInjector.scan): after firing at message
    // index i, skip while `messages.length - 1 - i < cooldown`. The scan's
    // chatHistory includes the EMPTY streaming-target assistant bubble (it is
    // appended to the branch before prompt building and only filtered out of
    // the outgoing request later), so the message distance grows by exactly 2
    // per turn. cooldown=2 would therefore never skip (distance is 2 at the
    // very next turn); cooldown=3 yields present -> absent -> present.
    const body1 = await sendAndCapture(app, 'coolkey turn one');
    expectWiToken(body1, 'COOLTOK', true);

    const body2 = await sendAndCapture(app, 'coolkey turn two');
    expectWiToken(body2, 'COOLTOK', false);

    const body3 = await sendAndCapture(app, 'coolkey turn three');
    expectWiToken(body3, 'COOLTOK', true);
    expect(allPromptText(body3)).not.toContain('@@activate_only_every');
  });

  test('@@activate_only_after 4: suppressed until the chat is long enough', async ({ page }) => {
    const app = new App(page);
    const bookName = uniqueName('Delay');
    await createBookWithEntry(page, bookName, {
      keys: 'delaykey',
      content: '@@activate_only_after 4\n[WI] DELAYTOK',
    });

    const charName = uniqueName('DelayChar');
    await createLinkedCharacterAndChat(app, charName, bookName);

    // Delay semantics: skip while `messages.length < delay`. The scan history
    // counts the greeting + the just-sent user message + the empty streaming
    // target bubble, so turn 1 has length 3 (< 4 -> suppressed).
    const body1 = await sendAndCapture(app, 'delaykey too early');
    expectWiToken(body1, 'DELAYTOK', false);

    // Turn 2: history has grown to 5 (>= 4); the key from turn 1 is still
    // in the scan text, so the entry fires now.
    const body2 = await sendAndCapture(app, 'delaykey late enough');
    expectWiToken(body2, 'DELAYTOK', true);
    expect(allPromptText(body2)).not.toContain('@@activate_only_after');
  });

  test('probability 0: key match never activates', async ({ page }) => {
    const app = new App(page);
    const bookName = uniqueName('ProbZero');
    await createBookWithEntry(page, bookName, {
      keys: 'luckkey',
      content: '[WI] LUCKTOK',
      probability: 0,
    });

    const charName = uniqueName('ProbChar');
    await createLinkedCharacterAndChat(app, charName, bookName);

    // roll > 0 is virtually always true, so probability 0 is a deterministic miss.
    const body1 = await sendAndCapture(app, 'luckkey first try');
    expectWiToken(body1, 'LUCKTOK', false);

    const body2 = await sendAndCapture(app, 'luckkey second try');
    expectWiToken(body2, 'LUCKTOK', false);
  });

  test('regex keys: pattern matches, invalid pattern is skipped without crashing', async ({ page }) => {
    const app = new App(page);

    // Valid regex key: `swo?rd` matches both "swrd" and "sword".
    const bookName = uniqueName('RegexKey');
    await createBookWithEntry(page, bookName, {
      keys: 'swo?rd',
      content: '[WI] REGEXTOK',
      regex: true,
    });

    const charA = uniqueName('RegexCharA');
    await createLinkedCharacterAndChat(app, charA, bookName);
    const bodyA = await sendAndCapture(app, 'I saw a swrd today');
    expectWiToken(bodyA, 'REGEXTOK', true);

    // Fresh chat: "sword" also matches the same pattern.
    const charB = uniqueName('RegexCharB');
    await createLinkedCharacterAndChat(app, charB, bookName);
    const bodyB = await sendAndCapture(app, 'I saw a sword today');
    expectWiToken(bodyB, 'REGEXTOK', true);

    // Invalid regex key: new RegExp('/[/') throws -> the key is skipped
    // silently; no injection, and generation still succeeds.
    const badBook = uniqueName('RegexBad');
    await createBookWithEntry(page, badBook, {
      keys: '/[/',
      content: '[WI] BADREGEXTOK',
      regex: true,
    });
    const charC = uniqueName('RegexCharC');
    await createLinkedCharacterAndChat(app, charC, badBook);
    const bodyC = await sendAndCapture(app, 'anything at all');
    expectWiToken(bodyC, 'BADREGEXTOK', false);
    // Generation succeeded: the mock's default reply text landed.
    await app.waitForAssistantText('deterministic mock response');
  });

  test('@@@ fallback: unknown decorator falls back to @@@depth 2', async ({ page }) => {
    const app = new App(page);
    const bookName = uniqueName('FallbackApply');
    // @@unknown_thing is unknown -> the @@@depth 2 fallback applies.
    await createBookWithEntry(page, bookName, {
      keys: 'fbapply',
      content: '@@unknown_thing\n@@@depth 2\n[WI] FB_APPLY',
    });

    const charName = uniqueName('FbApplyChar');
    await createLinkedCharacterAndChat(app, charName, bookName);

    // Two turns so depth 1 vs 2 land at distinct, assertable positions.
    await sendAndCapture(app, 'fbapply turn one');
    const body = await sendAndCapture(app, 'fbapply turn two');

    expectWiToken(body, 'FB_APPLY', true);
    // Neither the unknown decorator nor the fallback line leaks.
    const text = allPromptText(body);
    expect(text).not.toContain('@@unknown_thing');
    expect(text).not.toContain('@@@depth');

    // Depth 2: insertAtDepth counts the empty streaming-target bubble that is
    // still in chatHistory at splice time (it is dropped from the outgoing
    // request afterwards), so depth 2 lands immediately BEFORE the final user
    // message in the captured request.
    const messages = messagesOf(body);
    const tokenIdx = messages.findIndex((m) => String(m.content ?? '').includes('[WI] FB_APPLY'));
    const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user');
    expect(tokenIdx).toBeGreaterThanOrEqual(0);
    expect(lastUserIdx).toBeGreaterThanOrEqual(0);
    expect(tokenIdx).toBe(lastUserIdx - 1);
  });

  test('@@@ fallback: known @@depth 1 skips the @@@depth 2 fallback', async ({ page }) => {
    const app = new App(page);
    const bookName = uniqueName('FallbackSkip');
    // @@depth 1 is known -> the @@@depth 2 fallback is ignored.
    await createBookWithEntry(page, bookName, {
      keys: 'fbskip',
      content: '@@depth 1\n@@@depth 2\n[WI] FB_SKIP',
    });

    const charName = uniqueName('FbSkipChar');
    await createLinkedCharacterAndChat(app, charName, bookName);

    await sendAndCapture(app, 'fbskip turn one');
    const body = await sendAndCapture(app, 'fbskip turn two');

    expectWiToken(body, 'FB_SKIP', true);
    const text = allPromptText(body);
    expect(text).not.toContain('@@@depth');
    expect(text).not.toContain('@@depth');

    // Depth 1: the same streaming-bubble offset applies, so depth 1 lands
    // AFTER the final user message — the injection is the last message of the
    // request (@@depth 1 won, the @@@depth 2 fallback was skipped).
    const messages = messagesOf(body);
    const tokenIdx = messages.findIndex((m) => String(m.content ?? '').includes('[WI] FB_SKIP'));
    const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user');
    expect(tokenIdx).toBeGreaterThanOrEqual(0);
    expect(lastUserIdx).toBeGreaterThanOrEqual(0);
    expect(tokenIdx).toBe(lastUserIdx + 1);
    expect(tokenIdx).toBe(messages.length - 1);
  });

  test('decorator-only content: activates but injects no stray text', async ({ page }) => {
    const app = new App(page);
    const bookName = uniqueName('GhostEntry');
    // Content is ONLY a decorator line -> parsed content is empty.
    await createBookWithEntry(page, bookName, {
      keys: 'ghostkey',
      content: '@@depth 0',
    });

    const charName = uniqueName('GhostChar');
    await createLinkedCharacterAndChat(app, charName, bookName);

    // The entry fires (verified below via the test panel), but its stripped
    // content is empty — nothing may leak into the prompt.
    const body = await sendAndCapture(app, 'ghostkey says boo');
    const text = allPromptText(body);
    expect(text).not.toContain('@@depth');
    // Generation still succeeds with the default mock reply (no [WI] tokens).
    await app.waitForAssistantText('deterministic mock response');

    // Activation proof: the editor's activation-test scan lists the entry.
    const editor = await openWorldInfoEditor(page);
    await editor.locator('.worldinfo-item').filter({ hasText: bookName }).click();
    await expect(editor.locator('.book-editor')).toBeVisible();
    const panel = editor.locator('.test-triggers-panel');
    await panel.locator('textarea').fill('ping ghostkey pong');
    await panel.locator('button:has-text("Test")').click();
    await expect(panel.locator('.test-result-item')).toHaveCount(1);
    await expect(panel.locator('.test-result-item .result-keys')).toContainText('ghostkey');

    await page.locator('.modal-overlay:has(.worldinfo-modal)').click({ position: { x: 0, y: 0 } });
    await expect(editor).not.toBeVisible();
  });

  test('editor activation-test box lists matching entries', async ({ page }) => {
    const bookName = uniqueName('TestBox');
    await createBookWithEntry(page, bookName, {
      keys: 'testkey',
      content: '[WI] TESTBOXTOK',
    });

    const editor = await openWorldInfoEditor(page);
    await editor.locator('.worldinfo-item').filter({ hasText: bookName }).click();
    await expect(editor.locator('.book-editor')).toBeVisible();

    const panel = editor.locator('.test-triggers-panel');

    // Matching scan text -> the entry is reported as activated.
    await panel.locator('textarea').fill('a sample message mentioning testkey here');
    await panel.locator('button:has-text("Test")').click();
    await expect(panel.locator('.test-result-item')).toHaveCount(1);
    await expect(panel.locator('.test-result-item .result-keys')).toContainText('testkey');

    // Non-matching scan text -> explicit empty state.
    await panel.locator('textarea').fill('completely unrelated words');
    await panel.locator('button:has-text("Test")').click();
    await expect(panel.locator('.test-results')).toContainText('No entries triggered.');

    await page.locator('.modal-overlay:has(.worldinfo-modal)').click({ position: { x: 0, y: 0 } });
    await expect(editor).not.toBeVisible();
  });
});
