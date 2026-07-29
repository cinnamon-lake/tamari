/**
 * Group-chat generation strategies, end to end against the mock LLM.
 *
 * Covers GroupChatService.getActivatedMembers for all four activation
 * strategies (NATURAL / LIST / MANUAL / POOLED) plus the settings
 * read/write path (chat metadata groupChatSettings) that the GroupChatPanel
 * strategy select and the WS fallback both go through.
 *
 * Strategy-setting mechanism:
 *  - activationStrategy itself is set through the GroupChatPanel UI select
 *    (`.group-setting select.select`) — the only group setting the panel
 *    exposes.
 *  - MANUAL's manualCharacterId and POOLED's pooledMinMembers/pooledMaxMembers
 *    have NO UI fields (see client/src/components/GroupChatPanel.tsx), so those
 *    are patched over the app's WebSocket bus (`chat.update` with a merged
 *    metadata patch), mirroring what the panel's updateStrategy() sends.
 */
import { test, expect } from '../fixtures/base.js';
import type { Page } from '@playwright/test';
import { login } from '../helpers/auth.js';
import { App } from '../helpers/app.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { getLastLlmRequest, waitForNextLlmRequest, resetLlmRequests } from '../helpers/llm.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

async function fillPromptPopup(page: Page, value: string) {
  const popup = page.locator('.popup-modal');
  await expect(popup).toBeVisible();
  await popup.locator('.popup-input').fill(value);
  await popup.locator('.popup-actions button.primary').click();
  await expect(popup).not.toBeVisible();
}

async function openGroupPanel(page: Page) {
  await page.locator('.group-chat-toolbar button:has-text("Manage Members")').click();
  const panel = page.locator('.group-panel');
  await expect(panel).toBeVisible();
  return panel;
}

async function closeGroupPanel(page: Page) {
  const panel = page.locator('.group-panel');
  await panel.locator('[aria-label="Close"]').click();
  await expect(panel).not.toBeVisible();
}

/**
 * Set the activation strategy through the panel UI, then prove the change
 * round-tripped: close and reopen the panel so the select is re-created from
 * client state, which is only updated by the server's `chat.updated`
 * broadcast (i.e. after the metadata write landed).
 */
async function setStrategyViaPanel(page: Page, strategy: 'NATURAL' | 'LIST' | 'MANUAL' | 'POOLED') {
  const panel = await openGroupPanel(page);
  await panel.locator('.group-setting select.select').selectOption(strategy);
  await closeGroupPanel(page);

  const reopened = await openGroupPanel(page);
  await expect(reopened.locator('.group-setting select.select')).toHaveValue(strategy, { timeout: 5000 });
  await closeGroupPanel(page);
}

/**
 * WS fallback for group settings that have no UI (manualCharacterId,
 * pooledMinMembers, pooledMaxMembers). `chat.update` REPLACES the metadata
 * column wholesale (ChatRepository.updateChat), so the patch must be merged
 * with the chat's current metadata — read back via `chat.select` →
 * `chat.snapshot` — mirroring the spread the panel's updateStrategy() does.
 */
async function patchGroupChatSettings(page: Page, chatId: string, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    ({ chatId, patch }) =>
      new Promise<void>((resolve, reject) => {
        const token = localStorage.getItem('st_auth_token') ?? '';
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'auth' }));
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string);

            if (msg.type === 'snapshot') {
              ws.send(JSON.stringify({ type: 'chat.select', chatId }));
            }

            if (msg.type === 'chat.snapshot' && msg.chat?.id === chatId) {
              const meta = (msg.chat.metadata ?? {}) as Record<string, unknown>;
              const settings = (meta.groupChatSettings ?? {}) as Record<string, unknown>;
              ws.send(
                JSON.stringify({
                  type: 'chat.update',
                  chatId,
                  patch: {
                    metadata: {
                      ...meta,
                      groupChatSettings: { ...settings, ...patch },
                    },
                  },
                }),
              );
            }

            if (msg.type === 'chat.updated' && msg.chat?.id === chatId) {
              ws.close();
              resolve();
            }

            if (msg.type === 'error') {
              ws.close();
              reject(new Error(msg.message ?? 'chat.update failed'));
            }
          } catch (err) {
            reject(err);
          }
        };

        ws.onerror = (err) => {
          reject(new Error(`WebSocket error: ${err.type}`));
        };

        setTimeout(() => {
          ws.close();
          reject(new Error('patchGroupChatSettings timed out'));
        }, 10000);
      }),
    { chatId, patch },
  );
}

interface GroupSetup {
  app: App;
  charA: string;
  charB: string;
  charAId: string;
  charBId: string;
  /** Member with the lexicographically smaller character id (speaks first). */
  firstName: string;
  /** Member with the larger character id (speaks second). */
  secondName: string;
  groupName: string;
  chatId: string;
}

/** Create two characters and a group chat containing both, in insertion order A then B. */
async function setupGroupWithTwoMembers(page: Page): Promise<GroupSetup> {
  const app = new App(page);
  const charA = uniqueName('GrpGen Alpha');
  const charB = uniqueName('GrpGen Beta');
  const groupName = uniqueName('GrpGen Group');

  await app.createCharacter({ name: charA, description: 'First group member.', firstMes: `Hello from ${charA}.` });
  await app.createCharacter({ name: charB, description: 'Second group member.', firstMes: `Hello from ${charB}.` });

  // Create the group chat from the sidebar (same flow as group-chats.spec.ts).
  await page.locator('[title="New group chat"]').click();
  await fillPromptPopup(page, groupName);
  await expect(page.locator('.group-chat-toolbar')).toBeVisible();
  await expect(page.locator('.group-chat-badge')).toContainText('Group Chat');

  const panel = await openGroupPanel(page);
  await panel.locator('button:has-text("Add Member")').click();
  const memberSelect = panel.locator('.add-member-dropdown select');
  await memberSelect.selectOption({ label: charA });
  await expect(panel.locator('.group-members-list')).toContainText(charA);
  await memberSelect.selectOption({ label: charB });
  await expect(panel.locator('.group-members-list')).toContainText(charB);

  // The member row's DOM id IS the character id (GroupChatPanel.tsx).
  const charAId = await panel
    .locator('.group-member-item', { has: page.locator('.group-member-name', { hasText: charA }) })
    .getAttribute('id');
  const charBId = await panel
    .locator('.group-member-item', { has: page.locator('.group-member-name', { hasText: charB }) })
    .getAttribute('id');
  if (!charAId || !charBId) throw new Error('Could not read member character ids from the panel');

  await closeGroupPanel(page);

  const chatId = await app.activeChatId();
  if (!chatId) throw new Error('No active chat id after group creation');

  // GroupChatService activation order is NOT insertion order: the members
  // repository returns rows `ORDER BY character_id` (ChatMemberRepository.
  // getMembers), i.e. random UUID order. Derive the expected speaker order
  // from the ids instead of assuming A-then-B.
  const byId = [
    { id: charAId, name: charA },
    { id: charBId, name: charB },
  ].sort((a, b) => (a.id < b.id ? -1 : 1));

  return { app, charA, charB, charAId, charBId, firstName: byId[0]!.name, secondName: byId[1]!.name, groupName, chatId };
}

/** Wait until exactly `count` assistant bubbles exist, all with landed text and no active stream. */
async function waitForAssistantBubbles(page: Page, count: number) {
  const bubbles = page.locator('.message-bubble.assistant');
  await expect(bubbles).toHaveCount(count, { timeout: 30000 });
  for (let i = 0; i < count; i++) {
    await expect(bubbles.nth(i).locator('.message-content')).not.toBeEmpty({ timeout: 30000 });
  }
  await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 30000 });
}

/**
 * Send a user message and wait for its bubble to actually land.
 *
 * Two races make a naive fill+click flaky in group chats (app.ts documents
 * the "dropped generation" class):
 *  1. While `state.generation.status === 'streaming'`, MessageInput renders
 *     the send button as a Stop button — same `.send-btn` class, different
 *     behavior. Gate on the primary (send) variant being back.
 *  2. Even then, the server can still be finalizing the previous turn; a
 *     send that lands in that gap is silently dropped. Detect the missing
 *     user bubble and retry (bounded).
 */
async function sendUserMessageRobust(app: App, page: Page, text: string) {
  const sendBtn = page.locator('.message-input-area .send-btn.btn-primary');
  const userBubbles = page.locator('.message-bubble.user');
  for (let attempt = 0; attempt < 3; attempt++) {
    await sendBtn.waitFor({ state: 'visible', timeout: 30000 });
    const before = await userBubbles.count();
    await app.messageInput().fill(text);
    await sendBtn.click();
    try {
      await expect(userBubbles).toHaveCount(before + 1, { timeout: 10000 });
      await expect(app.lastBubble('user')).toContainText(text, { timeout: 5000 });
      return;
    } catch {
      // The send may not be dropped at all — just slow (a busy server can take
      // >10s to append the user message). Give it a grace period and re-check
      // before resending, otherwise the resend double-processes the message:
      // two user bubbles, two generations, and an extra assistant reply that
      // breaks the one-reply-per-send assertions below.
      await expect(userBubbles).toHaveCount(before + 1, { timeout: 20000 }).catch(() => {});
      if (
        (await userBubbles.count()) === before + 1 &&
        (await app.lastBubble('user').innerText().catch(() => '')).includes(text)
      ) {
        return;
      }
      // Genuinely dropped — fall through and resend.
    }
  }
  throw new Error(`user message "${text}" was not appended after 3 attempts`);
}

/** Extract the mock's `Turn N` counter from a bubble's rendered text. */
async function turnNumber(bubble: ReturnType<Page['locator']>): Promise<number> {
  const text = await bubble.locator('.message-content').innerText();
  const match = text.match(/Turn (\d+)/);
  if (!match) throw new Error(`Expected a "Turn N" reply, got: ${text}`);
  return Number(match[1]);
}

test.describe('Group Chat Generation', () => {
  test.describe.configure({ mode: 'serial', timeout: 120000 });

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test('NATURAL strategy: both members reply in member order', async ({ page }) => {
    const { app, firstName, secondName } = await setupGroupWithTwoMembers(page);

    // NATURAL is the server default (DEFAULT_GROUP_SETTINGS.activationStrategy).
    const panel = await openGroupPanel(page);
    await expect(panel.locator('.group-setting select.select')).toHaveValue('NATURAL');
    await closeGroupPanel(page);

    const cap0 = await getLastLlmRequest();
    await sendUserMessageRobust(app, page, 'seq:natural');

    await waitForAssistantBubbles(page, 2);

    // Exactly two LLM calls: one per member, chained sequentially.
    const cap = await waitForNextLlmRequest(cap0.count + 1);
    expect(cap.count).toBe(cap0.count + 2);

    const bubbles = page.locator('.message-bubble.assistant');
    const replyFirst = bubbles.nth(0);
    const replySecond = bubbles.nth(1);
    await expect(replyFirst.locator('.message-role')).toHaveText(firstName);
    await expect(replySecond.locator('.message-role')).toHaveText(secondName);

    // seq: gives each call a distinct, monotonically increasing "Turn N" —
    // the ordering proves the first member generated before the second.
    const turnFirst = await turnNumber(replyFirst);
    const turnSecond = await turnNumber(replySecond);
    expect(turnSecond).toBeGreaterThan(turnFirst);
  });

  test('LIST strategy: members alternate round-robin, one reply per send', async ({ page }) => {
    const { app, firstName, secondName } = await setupGroupWithTwoMembers(page);

    await setStrategyViaPanel(page, 'LIST');

    const cap0 = await getLastLlmRequest();

    // First send activates the first member (lastListIndex starts at -1).
    await sendUserMessageRobust(app, page, 'seq:list-1');
    await waitForAssistantBubbles(page, 1);
    await expect(app.lastBubble('assistant').locator('.message-role')).toHaveText(firstName);

    // Second send advances the round-robin to the second member.
    await sendUserMessageRobust(app, page, 'seq:list-2');
    await waitForAssistantBubbles(page, 2);
    await expect(app.lastBubble('assistant').locator('.message-role')).toHaveText(secondName);

    // Exactly one reply (and one LLM call) per user message.
    const cap = await getLastLlmRequest();
    expect(cap.count).toBe(cap0.count + 2);
  });

  test('MANUAL strategy: only the selected member replies', async ({ page }) => {
    const { app, charB, charBId, chatId } = await setupGroupWithTwoMembers(page);

    // manualCharacterId has no panel UI — patch it (plus the strategy) over WS.
    await patchGroupChatSettings(page, chatId, { activationStrategy: 'MANUAL', manualCharacterId: charBId });

    const cap0 = await getLastLlmRequest();
    await sendUserMessageRobust(app, page, 'seq:manual');
    await waitForAssistantBubbles(page, 1);

    await expect(app.lastBubble('assistant').locator('.message-role')).toHaveText(charB);

    const cap = await getLastLlmRequest();
    expect(cap.count).toBe(cap0.count + 1);
  });

  test('POOLED strategy with min=max=1: exactly one member replies', async ({ page }) => {
    const { app, chatId } = await setupGroupWithTwoMembers(page);

    // pooledMinMembers/pooledMaxMembers have no panel UI — patch them over WS.
    await patchGroupChatSettings(page, chatId, {
      activationStrategy: 'POOLED',
      pooledMinMembers: 1,
      pooledMaxMembers: 1,
    });

    const cap0 = await getLastLlmRequest();
    await sendUserMessageRobust(app, page, 'seq:pooled');

    // Count assertion only — with a weighted random pool the identity is
    // deliberately not pinned down, but min=max=1 forces exactly one reply.
    await waitForAssistantBubbles(page, 1);
    const cap = await getLastLlmRequest();
    expect(cap.count).toBe(cap0.count + 1);
  });

  test('strategy changes via the panel persist across reopen and reload', async ({ page }) => {
    const { groupName } = await setupGroupWithTwoMembers(page);

    // Back and forth — each call already asserts persistence across a panel
    // close/reopen (the select re-reads server-broadcast state on remount).
    await setStrategyViaPanel(page, 'LIST');
    await setStrategyViaPanel(page, 'NATURAL');
    await setStrategyViaPanel(page, 'POOLED');
    await setStrategyViaPanel(page, 'LIST');

    // Persistence across a full page reload.
    await page.reload();
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('.chat-item', { hasText: groupName }).first().click();
    await expect(page.locator('.group-chat-toolbar')).toBeVisible();

    const panel = await openGroupPanel(page);
    await expect(panel.locator('.group-setting select.select')).toHaveValue('LIST');
    await closeGroupPanel(page);
  });
});
