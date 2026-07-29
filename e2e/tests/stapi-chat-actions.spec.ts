import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { getLastLlmRequest, waitForNextLlmRequest } from '../helpers/llm.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

async function createGlobalQuickReply(page: any, label: string, script: string) {
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
}

async function createCharacterAndChat(page: any, charName: string) {
  await createCharacter(page, charName);

  // Filter the character list so the target row is always reachable regardless of pagination.
  await page.locator('input[placeholder="Search characters..."]').fill(charName);
  const charRow = page.locator('.character-list li').filter({
    has: page.locator('.character-name', { hasText: charName }),
  });
  await charRow.waitFor({ state: 'visible' });
  await page.addStyleTag({ content: '.character-list .character-actions { opacity: 1 !important; }' });
  const newChatBtn = charRow.locator('[title="New chat"]');
  await newChatBtn.waitFor({ state: 'visible' });
  await newChatBtn.click({ force: true });

  // The client auto-selects new chats, but explicit selection is more reliable under load.
  const chatItem = page.locator('.chat-item').filter({ hasText: new RegExp(charName) }).first();
  await expect(chatItem).toBeVisible({ timeout: 10000 });
  await chatItem.click();

  await expect(page.locator('.chat-view')).toBeVisible();
  await expect(page.locator('.message-bubble')).toHaveCount(1, { timeout: 5000 });
}

async function clickQuickReply(page: any, label: string) {
  const qrBtn = page.locator('.quick-reply-bar .quick-reply-btn').filter({ hasText: label });
  await expect(qrBtn).toBeVisible();
  await qrBtn.click();
}

/** Send a message via the chat bar and wait for the mock assistant reply. */
async function sendAndWaitReply(page: any, text: string, expectedReply: string | RegExp) {
  const input = page.locator('.message-textarea');
  await input.fill(text);
  await page.locator('.message-input-area .send-btn').click();
  await expect(input).toHaveValue('');
  await expect(page.locator('.message-bubble.user').last()).toContainText(text, { timeout: 5000 });
  const reply = page.locator('.message-bubble.assistant').last();
  await expect(reply).toContainText(expectedReply, { timeout: 10000 });
  return reply;
}

async function expectErrorToast(page: any, text: string | RegExp) {
  await expect(page.locator('.toast-container .toast-error').last()).toContainText(text, { timeout: 5000 });
}

test.describe.configure({ mode: 'serial' });

test.describe('StApi Chat Actions', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  // ── 1. Generation actions ────────────────────────────────────────────────

  test('st.continue extends the last assistant reply', async ({ page }) => {
    const label = uniqueName('StApi Continue');
    const charName = uniqueName('StApi Continue Character');

    await createGlobalQuickReply(page, label, 'st.continue()');
    await createCharacterAndChat(page, charName);

    const reply = await sendAndWaitReply(page, 'seq:', /Turn \d+/);
    // Compare message CONTENT only: the bubble header renders a token-count
    // badge ("3tk") when an earlier spec left the token-count display setting
    // on, and the badge changes ("5tk") as the continued text grows — that
    // would break a whole-bubble `toContain(before)` without the message text
    // itself changing.
    const replyContent = reply.locator('.message-content');
    const before = (await replyContent.textContent()) ?? '';
    const { count } = await getLastLlmRequest();

    await clickQuickReply(page, label);
    await waitForNextLlmRequest(count);

    // The continued text is appended to the same bubble (another "Turn N" chunk).
    await expect
      .poll(async () => (await replyContent.textContent()) ?? '', { timeout: 10000 })
      .not.toBe(before);
    const after = ((await replyContent.textContent()) ?? '').trim();
    expect(after).toContain(before.trim());
    expect(after.length).toBeGreaterThan(before.trim().length);
  });

  test('st.impersonate fills the composer with a generated user draft', async ({ page }) => {
    const label = uniqueName('StApi Impersonate');
    const charName = uniqueName('StApi Impersonate Character');

    await createGlobalQuickReply(page, label, 'st.impersonate()');
    await createCharacterAndChat(page, charName);

    // The mock resolves its reply from the last user message in the request; the
    // impersonation instruction is injected as a system prompt, so the seeded
    // respond: selector drives the impersonated draft too.
    await sendAndWaitReply(page, 'respond: impersonated draft text', 'impersonated draft text');

    await clickQuickReply(page, label);
    await expect(page.locator('.message-textarea')).toHaveValue('impersonated draft text', {
      timeout: 10000,
    });
  });

  test('st.regenerate adds a swipe, st.swipe navigates, bad direction toasts an error', async ({
    page,
  }) => {
    const regenLabel = uniqueName('StApi Regenerate');
    const swipeLeftLabel = uniqueName('StApi Swipe Left');
    const swipeBadLabel = uniqueName('StApi Swipe Bad');
    const charName = uniqueName('StApi Swipe Character');

    await createGlobalQuickReply(page, regenLabel, 'st.regenerate()');
    await createGlobalQuickReply(page, swipeLeftLabel, 'st.swipe("left")');
    // :await() so the validation error propagates into Lua and surfaces as a
    // script.error toast — fire-and-forget rejections are only logged server-side.
    await createGlobalQuickReply(page, swipeBadLabel, 'st.swipe("up"):await()');
    await createCharacterAndChat(page, charName);

    const reply = await sendAndWaitReply(page, 'seq:', /Turn \d+/);
    const firstTurn = ((await reply.textContent()) ?? '').match(/Turn \d+/)?.[0] ?? '';
    expect(firstTurn).not.toBe('');

    await clickQuickReply(page, regenLabel);
    await expect(page.locator('.swipe-counter')).toHaveText('2/2', { timeout: 10000 });
    // seq: increments per call, so the regenerated swipe is a different Turn N.
    await expect
      .poll(
        async () =>
          ((await page.locator('.message-bubble.assistant').last().textContent()) ?? '').match(/Turn \d+/)?.[0] ??
          '',
        { timeout: 10000 },
      )
      .not.toBe(firstTurn);

    await clickQuickReply(page, swipeLeftLabel);
    await expect(page.locator('.swipe-counter')).toHaveText('1/2', { timeout: 5000 });
    await expect(page.locator('.message-bubble.assistant').last()).toContainText(firstTurn);

    await clickQuickReply(page, swipeBadLabel);
    await expectErrorToast(page, 'swipe: expected');
  });

  // ── 2. Swipe tree management ─────────────────────────────────────────────

  test('st.add_swipe, st.set_active_child, st.get_swipes and st.get_siblings', async ({ page }) => {
    const addLabel = uniqueName('StApi AddSwipe Switch');
    const addHiddenLabel = uniqueName('StApi AddSwipe Keep');
    const narrateLabel = uniqueName('StApi Swipe Counts');
    const restoreLabel = uniqueName('StApi Set Active Child');
    const charName = uniqueName('StApi Swipe Tree Character');

    await createGlobalQuickReply(
      page,
      addLabel,
      'local msgs = st.get_messages(10):await() st.setvar("orig_id", msgs[#msgs].id) st.add_swipe("manual swipe text", true)',
    );
    await createGlobalQuickReply(page, addHiddenLabel, 'st.add_swipe("hidden extra swipe", false)');
    // Counts go through st.toast, NOT st.send_narrator: a narrator message would
    // append after the swiped assistant message and move the branch head, which
    // both changes the swipe set and breaks the later set_active_child call.
    await createGlobalQuickReply(
      page,
      narrateLabel,
      'local sw = st.get_swipes():await() local id = st.getvar("orig_id"):await() local sib = st.get_siblings(id):await() st.toast("swipes=" .. #sw .. " siblings=" .. #sib)',
    );
    await createGlobalQuickReply(
      page,
      restoreLabel,
      'local id = st.getvar("orig_id"):await() st.set_active_child(id)',
    );
    await createCharacterAndChat(page, charName);

    await sendAndWaitReply(page, 'respond: original swipe text', 'original swipe text');

    await clickQuickReply(page, addLabel);
    await expect(page.locator('.message-bubble.assistant').last()).toContainText('manual swipe text', {
      timeout: 5000,
    });
    await expect(page.locator('.swipe-counter')).toHaveText('2/2', { timeout: 5000 });

    // switchTo=false: a third swipe exists but the visible text/counter position stay.
    await clickQuickReply(page, addHiddenLabel);
    await expect(page.locator('.swipe-counter')).toHaveText('2/3', { timeout: 5000 });
    await expect(page.locator('.message-bubble.assistant').last()).toContainText('manual swipe text');

    await clickQuickReply(page, narrateLabel);
    await expect(page.locator('.toast-container')).toContainText('swipes=3 siblings=3', {
      timeout: 5000,
    });

    await clickQuickReply(page, restoreLabel);
    await expect(page.locator('.swipe-counter')).toHaveText('1/3', { timeout: 5000 });
    await expect(page.locator('.message-bubble.assistant').last()).toContainText('original swipe text', {
      timeout: 5000,
    });
  });

  test('st.add_swipe without an assistant message shows an error toast', async ({ page }) => {
    const label = uniqueName('StApi AddSwipe Error');
    const charName = uniqueName('StApi AddSwipe Error Character');

    // :await() so the validation error propagates into Lua and surfaces as a
    // script.error toast — fire-and-forget rejections are only logged server-side.
    await createGlobalQuickReply(page, label, 'st.add_swipe("no target", true):await()');
    await createCharacterAndChat(page, charName);

    // Fresh chat: the greeting is client-rendered, there is no assistant message.
    await clickQuickReply(page, label);
    await expectErrorToast(page, 'add_swipe: no active message to swipe from');
  });

  // ── 3. hide / unhide ─────────────────────────────────────────────────────

  test('st.hide and st.unhide toggle message visibility', async ({ page }) => {
    const hideLabel = uniqueName('StApi Hide');
    const unhideLabel = uniqueName('StApi Unhide');
    const charName = uniqueName('StApi Hide Character');

    // Hide the USER message, not the assistant reply: the reply renders through
    // the active-child/swipe path, which bypasses the hidden filter applied to
    // the bulk message list (getVisibleMessages), so hiding it changes nothing
    // on screen. Bulk messages are filtered.
    await createGlobalQuickReply(page, hideLabel, 'local msgs = st.get_messages(10):await() st.hide(msgs[#msgs - 1].id)');
    await createGlobalQuickReply(
      page,
      unhideLabel,
      'local msgs = st.get_messages(10):await() st.unhide(msgs[#msgs - 1].id)',
    );
    await createCharacterAndChat(page, charName);

    await sendAndWaitReply(page, 'respond: hide me reply', 'hide me reply');
    // Greeting + user message + reply.
    await expect(page.locator('.message-bubble')).toHaveCount(3);

    await clickQuickReply(page, hideLabel);
    // Hidden messages are filtered out of the chat view by default.
    await expect(page.locator('.message-bubble')).toHaveCount(2, { timeout: 5000 });
    await expect(page.locator('.chat-view')).not.toContainText('respond: hide me reply');

    await clickQuickReply(page, unhideLabel);
    await expect(page.locator('.message-bubble')).toHaveCount(3, { timeout: 5000 });
    await expect(page.locator('.chat-view')).toContainText('respond: hide me reply');
  });

  // ── 4. Chat lifecycle ────────────────────────────────────────────────────

  test('st.new_chat creates another chat for the character', async ({ page }) => {
    const label = uniqueName('StApi New Chat');
    const charName = uniqueName('StApi New Chat Character');

    await createGlobalQuickReply(page, label, 'st.new_chat()');
    await createCharacterAndChat(page, charName);

    const chatItems = page.locator('.chat-item').filter({ hasText: new RegExp(charName) });
    await expect(chatItems).toHaveCount(1);

    await clickQuickReply(page, label);
    await expect(chatItems).toHaveCount(2, { timeout: 5000 });
  });

  test('st.temp_chat creates a Temporary Chat entry', async ({ page }) => {
    const label = uniqueName('StApi Temp Chat');
    const charName = uniqueName('StApi Temp Chat Character');

    await createGlobalQuickReply(page, label, 'st.temp_chat()');
    await createCharacterAndChat(page, charName);

    await clickQuickReply(page, label);
    // The sidebar chat list is scoped to the selected character; a characterless
    // temp chat only shows in the global recent-chats view. The toggle is an
    // icon-only button, so match it by title.
    await page.locator('button[title="Show all recent chats"]').click();
    await expect(page.locator('.chat-list')).toContainText('Temporary Chat', { timeout: 5000 });
  });

  test('st.reset_chat clears all messages from the view', async ({ page }) => {
    const label = uniqueName('StApi Reset Chat');
    const charName = uniqueName('StApi Reset Chat Character');

    await createGlobalQuickReply(page, label, 'st.reset_chat()');
    await createCharacterAndChat(page, charName);

    await sendAndWaitReply(page, 'respond: resettable reply', 'resettable reply');
    await expect(page.locator('.message-bubble')).toHaveCount(3);

    await clickQuickReply(page, label);
    // The chat was materialized by the first send, so after reset_chat the client
    // no longer renders the character greeting — the view is simply empty.
    await expect(page.locator('.message-bubble')).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('.chat-view')).not.toContainText('resettable reply');
  });

  test('st.branch creates a (branch) chat in the list', async ({ page }) => {
    const label = uniqueName('StApi Branch');
    const charName = uniqueName('StApi Branch Character');

    await createGlobalQuickReply(
      page,
      label,
      'local msgs = st.get_messages(10):await() st.branch(msgs[#msgs].id)',
    );
    await createCharacterAndChat(page, charName);

    await sendAndWaitReply(page, 'respond: branchable reply', 'branchable reply');

    await clickQuickReply(page, label);
    await expect(page.locator('.chat-list')).toContainText('(branch)', { timeout: 5000 });
  });

  test('st.checkpoint creates a (checkpoint) chat in the list', async ({ page }) => {
    const label = uniqueName('StApi Checkpoint');
    const charName = uniqueName('StApi Checkpoint Character');

    await createGlobalQuickReply(page, label, 'st.checkpoint()');
    await createCharacterAndChat(page, charName);

    await sendAndWaitReply(page, 'respond: checkpoint reply', 'checkpoint reply');

    await clickQuickReply(page, label);
    await expect(page.locator('.chat-list')).toContainText('(checkpoint)', { timeout: 5000 });
  });

  test('st.hard_fork creates a (fork) chat in the list', async ({ page }) => {
    const label = uniqueName('StApi Hard Fork');
    const charName = uniqueName('StApi Hard Fork Character');

    await createGlobalQuickReply(
      page,
      label,
      'local msgs = st.get_messages(10):await() st.hard_fork(msgs[#msgs].id)',
    );
    await createCharacterAndChat(page, charName);

    await sendAndWaitReply(page, 'respond: forkable reply', 'forkable reply');

    await clickQuickReply(page, label);
    await expect(page.locator('.chat-list')).toContainText('(fork)', { timeout: 5000 });
  });

  test('st.delete_chat removes the active chat from the list', async ({ page }) => {
    const label = uniqueName('StApi Delete Chat');
    const charName = uniqueName('StApi Delete Chat Character');

    await createGlobalQuickReply(page, label, 'st.delete_chat()');
    await createCharacterAndChat(page, charName);

    const chatItems = page.locator('.chat-item').filter({ hasText: new RegExp(charName) });
    await expect(chatItems).toHaveCount(1);

    await clickQuickReply(page, label);
    await expect(chatItems).toHaveCount(0, { timeout: 5000 });
  });

  // ── 5. Quiet generation ──────────────────────────────────────────────────

  test('st.generate result can be narrated into the chat', async ({ page }) => {
    const label = uniqueName('StApi Generate');
    const charName = uniqueName('StApi Generate Character');

    // NOTE: the quick-reply runtime wraps st.generate to await internally —
    // appending :await() here would index the resolved string and crash the script.
    await createGlobalQuickReply(
      page,
      label,
      'local text = st.generate("respond: quiet reply") st.send_narrator(text):await()',
    );
    await createCharacterAndChat(page, charName);

    await clickQuickReply(page, label);
    await expect(page.locator('.message-bubble.system').last()).toContainText('quiet reply', {
      timeout: 10000,
    });
  });

  test('st.genraw appends a raw system message with a minimal prompt', async ({ page }) => {
    const label = uniqueName('StApi Genraw');
    const charName = uniqueName('StApi Genraw Character');

    await createGlobalQuickReply(page, label, 'st.genraw("respond: raw reply")');
    await createCharacterAndChat(page, charName);

    // genraw appends its result as a system message; on an unmaterialized chat
    // (no messages yet) such a message never lands on the visible branch, so
    // seed the chat with one real turn first.
    await sendAndWaitReply(page, 'respond: genraw setup', 'genraw setup');

    const { count } = await getLastLlmRequest();
    await clickQuickReply(page, label);

    // handleGenRaw now takes the script's lock holder (GenerationService), so
    // from a quick reply it generates immediately — the old missing
    // pass-through deadlocked until the QR's 10s teardown cap.
    await expect(page.locator('.message-bubble.system').last()).toContainText('raw reply', {
      timeout: 15000,
    });

    // genraw sends just the prompt text — no character description, no history.
    const cap = await waitForNextLlmRequest(count);
    const body = cap.body as { messages?: unknown[] };
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages).toHaveLength(1);
    expect(JSON.stringify(cap.body)).not.toContain('A character created by e2e tests.');
  });

  test('st.ask generates a reply as another character', async ({ page }) => {
    const label = uniqueName('StApi Ask');
    const charName = uniqueName('StApi Ask Character');
    const otherName = uniqueName('StApi Ask Other');

    await createGlobalQuickReply(page, label, `st.ask("${otherName}", "respond: asked reply")`);
    await createCharacterAndChat(page, charName);
    // A second character that handleAsk resolves by name.
    await createCharacter(page, otherName);

    await clickQuickReply(page, label);
    // handleAsk now forwards the script's lock holder through handleSend and
    // executeGeneration — the old path deadlocked until the QR teardown cap.
    await expect(page.locator('.message-bubble.user').last()).toContainText('respond: asked reply', {
      timeout: 15000,
    });
    await expect(page.locator('.message-bubble.assistant').last()).toContainText('asked reply', {
      timeout: 15000,
    });
  });

  test('st.sysgen appends a generated system message', async ({ page }) => {
    const label = uniqueName('StApi Sysgen');
    const charName = uniqueName('StApi Sysgen Character');

    await createGlobalQuickReply(page, label, 'st.sysgen("respond: sysgen reply")');
    await createCharacterAndChat(page, charName);

    // sysgen appends its result as a system message; on an unmaterialized chat
    // (no messages yet) such a message never lands on the visible branch, so
    // seed the chat with one real turn first.
    await sendAndWaitReply(page, 'respond: sysgen setup', 'sysgen setup');

    await clickQuickReply(page, label);
    await expect(page.locator('.message-bubble.system').last()).toContainText('sysgen reply', {
      timeout: 10000,
    });
  });

  // ── 6. inject / flush_inject ─────────────────────────────────────────────

  test('st.inject reaches the next request and st.flush_inject discards it', async ({ page }) => {
    const injectLabel = uniqueName('StApi Inject');
    const flushLabel = uniqueName('StApi Flush Inject');
    const charName = uniqueName('StApi Inject Character');

    // NOTE: st.inject used to require pairing with a script-driven generation
    // because a UI send's action.generate REPLACED the server-side pending
    // injections (an empty client array wiped them). handleGenerate now merges
    // instead, so UI sends preserve Lua injections — asserted below.
    await createGlobalQuickReply(page, injectLabel, 'st.inject("UNIQUE_INJECT_123") st.continue()');
    await createGlobalQuickReply(page, flushLabel, 'st.inject("UNIQUE_INJECT_456") st.flush_inject() st.continue()');
    await createCharacterAndChat(page, charName);

    await sendAndWaitReply(page, 'respond: inject base', 'inject base');

    let { count } = await getLastLlmRequest();
    await clickQuickReply(page, injectLabel);
    const injected = await waitForNextLlmRequest(count);
    expect(JSON.stringify(injected.body)).toContain('UNIQUE_INJECT_123');

    count = injected.count;
    await clickQuickReply(page, flushLabel);
    const flushed = await waitForNextLlmRequest(count);
    expect(JSON.stringify(flushed.body)).not.toContain('UNIQUE_INJECT_456');
  });

  test('st.inject survives a UI-driven send (injections merge, not replace)', async ({ page }) => {
    const injectLabel = uniqueName('StApi Inject UI');
    const charName = uniqueName('StApi Inject UI Character');

    await createGlobalQuickReply(page, injectLabel, 'st.inject("UNIQUE_INJECT_UI_789")');
    await createCharacterAndChat(page, charName);
    await sendAndWaitReply(page, 'respond: ui inject base', 'ui inject base');

    const { count } = await getLastLlmRequest();
    await clickQuickReply(page, injectLabel);
    // A plain UI send must carry the Lua injection — before the merge fix the
    // client's (empty) injections array wiped it.
    await sendAndWaitReply(page, 'respond: after ui inject', 'after ui inject');
    const captured = await waitForNextLlmRequest(count);
    expect(JSON.stringify(captured.body)).toContain('UNIQUE_INJECT_UI_789');
  });

  // ── 7. send_as / comment / trigger ───────────────────────────────────────

  test('st.send_as appends an assistant message as a character', async ({ page }) => {
    const label = uniqueName('StApi Send As');
    const charName = uniqueName('StApi Send As Character');

    await createGlobalQuickReply(page, label, `st.send_as("${charName}", "sent as text")`);
    await createCharacterAndChat(page, charName);

    await clickQuickReply(page, label);
    await expect(page.locator('.message-bubble.assistant').last()).toContainText('sent as text', {
      timeout: 5000,
    });
  });

  test('st.comment stores a hidden comment without a visible bubble', async ({ page }) => {
    const label = uniqueName('StApi Comment');
    const charName = uniqueName('StApi Comment Character');

    // The trailing narrator message proves the script completed without error.
    await createGlobalQuickReply(page, label, 'st.comment("side note"):await() st.send_narrator("comment done"):await()');
    await createCharacterAndChat(page, charName);

    await clickQuickReply(page, label);
    await expect(page.locator('.message-bubble.system').last()).toContainText('comment done', {
      timeout: 5000,
    });
    // Comments are stored hidden: never rendered in the default chat view.
    await expect(page.locator('.chat-view')).not.toContainText('side note');
    await expect(page.locator('.message-bubble')).toHaveCount(2); // greeting + narrator
  });

  test('st.trigger generates an assistant reply', async ({ page }) => {
    const label = uniqueName('StApi Trigger');
    const charName = uniqueName('StApi Trigger Character');

    await createGlobalQuickReply(page, label, 'st.trigger()');
    await createCharacterAndChat(page, charName);

    await sendAndWaitReply(page, 'respond: triggered reply', 'triggered reply');
    // Greeting + user message + reply.
    await expect(page.locator('.message-bubble')).toHaveCount(3);
    const { count } = await getLastLlmRequest();

    await clickQuickReply(page, label);
    await waitForNextLlmRequest(count);
    await expect(page.locator('.message-bubble')).toHaveCount(4, { timeout: 10000 });
    await expect(page.locator('.message-bubble.assistant').last()).toContainText('triggered reply');
  });

  // ── 8. sleep / delay ─────────────────────────────────────────────────────

  test('st.sleep and st.delay complete without error', async ({ page }) => {
    const label = uniqueName('StApi Sleep');
    const charName = uniqueName('StApi Sleep Character');

    // The trailing narrator message proves the script ran to completion.
    // NOTE: the quick-reply runtime wraps st.sleep to await internally —
    // st.sleep(0.1):await() would index nil and crash the script.
    await createGlobalQuickReply(page, label, 'st.sleep(0.1) st.delay(50):await() st.send_narrator("slept"):await()');
    await createCharacterAndChat(page, charName);

    await clickQuickReply(page, label);
    await expect(page.locator('.message-bubble.system').last()).toContainText('slept', { timeout: 5000 });
    await expect(page.locator('.toast-container .toast-error')).toHaveCount(0);
  });
});
