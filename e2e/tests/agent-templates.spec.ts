import { test, expect, type Page } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { resetLlmRequests } from '../helpers/llm.js';
import { enableBuiltinToolset, deleteToolset } from '../helpers/tools.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

const MOCK_URL = process.env.MOCK_LLM_URL ?? 'http://127.0.0.1:9876';

interface CapturedRouteRequest {
  route: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

/** GET /last-request?route=<prefix> from the mock — null when nothing captured yet. */
async function getRouteRequest(route: string): Promise<CapturedRouteRequest | null> {
  const res = await fetch(`${MOCK_URL}/last-request?route=${encodeURIComponent(route)}`);
  if (!res.ok) throw new Error(`mock /last-request?route failed: HTTP ${res.status}`);
  return (await res.json()) as CapturedRouteRequest | null;
}

async function fillPromptPopup(page: Page, value: string): Promise<void> {
  const popup = page.locator('.popup-modal');
  await expect(popup).toBeVisible();
  await popup.locator('.popup-input').fill(value);
  await popup.locator('.popup-actions button.primary').click();
  await expect(popup).not.toBeVisible();
}

/**
 * Send a user message and trigger generation with a guaranteed order.
 *
 * The composer's Send button dispatches action.send + action.generate as two
 * independent WS messages; under load the server can start the generation
 * before the append lands, and the generation then walks the tool: sequence
 * of the PREVIOUS user message (seen in practice: the remove turn re-ran
 * add+list and the fresh user bubble got clobbered by stale snapshots). This
 * helper sends action.send, polls chat snapshots until the append is visible
 * server-side, and only then sends action.generate.
 */
async function sendThenGenerate(page: Page, chatId: string, content: string): Promise<void> {
  await page.evaluate(
    ({ chatId, content }) => {
      return new Promise<void>((resolve, reject) => {
        const token = localStorage.getItem('st_auth_token') ?? '';
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
        let sentMessage = false;

        const lastText = (messages: unknown): string => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const arr = (messages as any[]) ?? [];
          const last = arr[arr.length - 1];
          const parts = (last?.extra?.parts ?? []) as Array<{ type: string; text?: string }>;
          return parts
            .filter((p) => p.type === 'text')
            .map((p) => p.text ?? '')
            .join('');
        };

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'auth' }));
          ws.send(JSON.stringify({ type: 'action.send', chatId, content }));
          ws.send(JSON.stringify({ type: 'chat.select', chatId }));
          sentMessage = true;
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === 'chat.snapshot' && msg.chat?.id === chatId && sentMessage) {
              if (lastText(msg.messages) === content) {
                ws.send(JSON.stringify({ type: 'action.generate', chatId }));
                ws.close();
                resolve();
              } else {
                // Append not visible yet — re-poll.
                setTimeout(() => ws.send(JSON.stringify({ type: 'chat.select', chatId })), 250);
              }
            }
            if (msg.type === 'error') {
              ws.close();
              reject(new Error(msg.message ?? 'sendThenGenerate failed'));
            }
          } catch (err) {
            reject(err);
          }
        };

        ws.onerror = () => reject(new Error('WebSocket error'));
        setTimeout(() => {
          ws.close();
          reject(new Error('sendThenGenerate timed out'));
        }, 20000);
      });
    },
    { chatId, content },
  );
}

test.describe('Agent / Workbench / Forge Templates', () => {
  const toolsetIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
    for (const id of toolsetIds.splice(0)) {
      await deleteToolset(page, id);
    }
  });

  test('run_agent delegates the prompt to the chat backend and returns its reply', async ({ page }) => {
    const app = new App(page);
    toolsetIds.push(await enableBuiltinToolset(page, 'agent'));

    await app.createCharacterAndChat({ name: uniqueName('Agent Host'), firstMes: 'Ready.' });

    // The agent template takes {prompt}; its internal LLM call hits the mock,
    // whose respond: selector answers "agent says hi".
    await app.sendUserMessage(`tool:run_agent${JSON.stringify({ prompt: 'respond: agent says hi' })}`, {
      expectReply: true,
      userText: 'tool:run_agent',
    });

    const result = app.lastBubble('assistant').locator('.tool-result-block').last();
    await expect(result).toBeVisible({ timeout: 15000 });
    await expect(result).toContainText('agent says hi');
  });

  test('chat_workbench adds, lists, and removes a group-chat member', async ({ page }) => {
    const app = new App(page);
    const baseName = uniqueName('CW Base');
    const memberName = uniqueName('CW Tool Member');
    const groupName = uniqueName('CW Group');

    await app.createCharacter({ name: baseName, firstMes: `Hello from ${baseName}.` });
    await app.createCharacter({ name: memberName, firstMes: `Hello from ${memberName}.` });
    const memberId = await app.characterRow(memberName).getAttribute('id');
    expect(memberId).toBeTruthy();

    await page.locator('[title="New group chat"]').click();
    await fillPromptPopup(page, groupName);
    await expect(page.locator('.group-chat-toolbar')).toBeVisible();

    // Group generation aborts with 'No group members activated' on an empty
    // roster, so seed one member through the UI; the tool drives the second.
    await page.locator('.group-chat-toolbar button:has-text("Manage Members")').click();
    const panel = page.locator('.group-panel');
    await expect(panel).toBeVisible();
    await panel.locator('button:has-text("Add Member")').click();
    await panel.locator('.add-member-dropdown select').selectOption({ label: baseName });
    await expect(panel.locator('.group-members-list')).toContainText(baseName);
    await panel.locator('[aria-label="Close"]').click();
    await expect(panel).not.toBeVisible();

    toolsetIds.push(await enableBuiltinToolset(page, 'chat_workbench'));

    const chatId = await app.activeChatId();
    expect(chatId).toBeTruthy();

    // Round 1 adds the member, round 2 lists the roster (mock walks the
    // sequence). sendThenGenerate guarantees the append precedes the
    // generation — see the helper's comment for the race it avoids.
    await sendThenGenerate(
      page,
      chatId!,
      `tool:chat_add_member${JSON.stringify({ characterId: memberId })},chat_list_members{}`,
    );
    const results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(2, { timeout: 15000 });
    await expect(results.first()).toContainText(memberId!);
    await expect(results.nth(1)).toContainText(memberName);

    // The group panel roster reflects the tool-driven membership change.
    await page.locator('.group-chat-toolbar button:has-text("Manage Members")').click();
    await expect(panel).toBeVisible();
    await expect(panel.locator('.group-members-list')).toContainText(memberName, { timeout: 5000 });
    await panel.locator('[aria-label="Close"]').click();
    await expect(panel).not.toBeVisible();

    // Remove turn. NATURAL activation runs one generation per member, and each
    // generation's mock context re-emits the tool call — so removeChatMember
    // runs once per speaker: the first succeeds, the rest get
    // 'ChatMember not found'. Which speaker's bubble renders last depends on
    // UUID ordering, so assert the success block exists anywhere in the chat.
    await sendThenGenerate(page, chatId!, `tool:chat_remove_member${JSON.stringify({ characterId: memberId })}`);

    const removed = page.locator('.message-bubble.assistant .tool-result-block', { hasText: '"removed"' });
    await expect(removed.first()).toBeVisible({ timeout: 20000 });
    await expect(removed.first()).toContainText(memberId!);
    await expect(page.locator('.message-bubble.streaming')).toHaveCount(0, { timeout: 30000 });

    await page.locator('.group-chat-toolbar button:has-text("Manage Members")').click();
    await expect(panel).toBeVisible();
    await expect(panel.locator('.group-members-list')).not.toContainText(memberName);
    // The UI-seeded member is untouched.
    await expect(panel.locator('.group-members-list')).toContainText(baseName);
    await panel.locator('[aria-label="Close"]').click();
  });

  test('forge_image generate_image posts txt2img to the configured Forge URL', async ({ page }) => {
    const app = new App(page);
    toolsetIds.push(await enableBuiltinToolset(page, 'forge_image', { url: MOCK_URL }));

    await app.createCharacterAndChat({ name: uniqueName('Forge Host'), firstMes: 'Ready.' });

    await app.sendUserMessage(`tool:generate_image${JSON.stringify({ prompt: 'a red square' })}`, {
      expectReply: true,
      userText: 'tool:generate_image',
    });

    const bubble = app.lastBubble('assistant');
    await expect(bubble.locator('.tool-call-block').first()).toContainText('generate_image', { timeout: 15000 });
    await expect(bubble.locator('.tool-result-block').last()).toBeVisible({ timeout: 15000 });
    // A failed Forge call returns an error string; the happy path must not.
    await expect(bubble.locator('.tool-result-block.error')).toHaveCount(0);

    // The server-side fetch hit the mock's txt2img route with the tool args.
    await expect
      .poll(async () => (await getRouteRequest('/sdapi/v1/txt2img'))?.route ?? null, { timeout: 10000 })
      .toBe('/sdapi/v1/txt2img');
    const captured = await getRouteRequest('/sdapi/v1/txt2img');
    const body = captured?.body as Record<string, unknown>;
    expect(body['prompt']).toBe('a red square');
    // Default orientation is square (1024x1024).
    expect(body['width']).toBe(1024);
    expect(body['height']).toBe(1024);
  });

  test('forge_image surfaces the Forge HTTP error in the tool result', async ({ page }) => {
    const app = new App(page);
    // Points at a route the mock 404s, so execute() hits the !response.ok branch.
    toolsetIds.push(await enableBuiltinToolset(page, 'forge_image', { url: `${MOCK_URL}/nope` }));

    await app.createCharacterAndChat({ name: uniqueName('ForgeErr Host'), firstMes: 'Ready.' });

    await app.sendUserMessage(`tool:generate_image${JSON.stringify({ prompt: 'a red square' })}`, {
      expectReply: true,
      userText: 'tool:generate_image',
    });

    const result = app.lastBubble('assistant').locator('.tool-result-block').last();
    await expect(result).toBeVisible({ timeout: 15000 });
    await expect(result).toContainText('Forge returned 404');
  });
});
