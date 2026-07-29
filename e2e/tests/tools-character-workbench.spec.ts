import { test, expect, type Page } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { enableBuiltinToolset, deleteToolset } from '../helpers/tools.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

/**
 * Create a character over the app's WS bus and return its server-generated id,
 * so scripted `tool:` calls can reference it — the mock's tool sequences can't
 * interpolate prior tool results, so the id has to exist before the message is
 * sent. (The workbench deliberately has no character collection listing:
 * ids come from the user or the surrounding context, here from WS setup.)
 */
async function createCharacterViaWs(page: Page, charName: string, firstMes?: string): Promise<string> {
  return await page.evaluate(
    ({ charName: cn, firstMes: fm }) => {
      return new Promise<string>((resolve, reject) => {
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
              ws.send(JSON.stringify({ type: 'character.create', data: { name: cn, ...(fm ? { firstMes: fm } : {}) } }));
            }
            if (msg.type === 'character.created' && msg.character?.name === cn) {
              ws.close();
              resolve(msg.character.id as string);
            }
            if (msg.type === 'error') {
              ws.close();
              reject(new Error(msg.message ?? 'WS creation failed'));
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
          reject(new Error('createCharacterViaWs timed out'));
        }, 10000);
      });
    },
    { charName, firstMes },
  );
}

test.describe('Character Workbench Tools', () => {
  let toolsetId: string | undefined;

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
    if (toolsetId) {
      await deleteToolset(page, toolsetId);
      toolsetId = undefined;
    }
  });

  test('creating a character via a write to /characters/new appears in the sidebar', async ({ page }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'workbench');

    await app.createCharacterAndChat({
      name: uniqueName('CW Host'),
      firstMes: 'Ready.',
    });

    const name = uniqueName('Tool Made');
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: '/characters/new',
        content: JSON.stringify({ name, description: 'Made by a tool call', tags: ['e2e'] }),
      })}`,
      // The markdown renderer mangles the escaped quotes in the full message.
      { expectReply: true, userText: 'write' },
    );

    // The character.created broadcast lands; the new character shows in the sidebar.
    await page.locator('input[placeholder="Search characters..."]').fill(name);
    await expect(page.locator('.character-list li', { hasText: name })).toBeVisible({ timeout: 10000 });
  });

  test('read meta.json reads a card by id and a write to meta.json renames it', async ({ page }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'workbench');

    await app.createCharacterAndChat({
      name: uniqueName('CW Host'),
      firstMes: 'Ready.',
    });

    const name = uniqueName('Get Target');
    const characterId = await createCharacterViaWs(page, name);

    await app.sendUserMessage(`tool:read${JSON.stringify({ path: `/characters/${characterId}/meta.json` })}`, {
      expectReply: true,
    });
    const getResult = app.lastBubble('assistant').locator('.tool-result-block').last();
    await expect(getResult).toContainText(`"name": "${name}"`, { timeout: 10000 });

    const renamed = uniqueName('Renamed Target');
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: `/characters/${characterId}/meta.json`,
        content: JSON.stringify({ name: renamed }),
      })}`,
      { expectReply: true, userText: 'write' },
    );

    // The character.* broadcasts land; the renamed character shows in the sidebar.
    await page.locator('input[placeholder="Search characters..."]').fill(renamed);
    await expect(page.locator('.character-list li', { hasText: renamed })).toBeVisible({ timeout: 10000 });
  });

  test('a lorebook write auto-creates the character lorebook, and it shows in the World Info UI', async ({ page }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'workbench');

    await app.createCharacterAndChat({
      name: uniqueName('CW Host'),
      firstMes: 'Ready.',
    });

    const charName = uniqueName('Lore Host');
    const characterId = await createCharacterViaWs(page, charName);

    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: `/characters/${characterId}/lorebook/new.json`,
        content: JSON.stringify({ keys: ['dragon'], content: 'Dragons are real' }),
      })},read${JSON.stringify({ path: `/characters/${characterId}/meta.json` })}`,
      { expectReply: true, userText: 'write' },
    );

    const results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(2, { timeout: 15000 });
    // Create result: the entry comes back with a generated id and its real path.
    await expect(results.first()).toContainText('"content": "Dragons are real"');
    await expect(results.first()).toContainText('"id": "');
    await expect(results.first()).toContainText(`"path": "/characters/${characterId}/lorebook/`);
    // Meta read: worldInfoId went from null to the auto-created book's id.
    await expect(results.last()).toContainText('"worldInfoId": "');

    // UI proof: the worldinfo.created broadcast makes the book show in World Info.
    await page.locator('button.settings-btn:has-text("World Info")').click();
    const editor = page.locator('.worldinfo-modal');
    await expect(editor).toBeVisible();
    await expect(editor).toContainText(charName);
    await page.locator('.modal-overlay:has(.worldinfo-modal)').click({ position: { x: 0, y: 0 } });
    await expect(editor).not.toBeVisible();
  });

  test('a regex write scopes a display rule to the character; a new greeting shows the transformed text', async ({
    page,
  }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'workbench');

    await app.createCharacterAndChat({
      name: uniqueName('CW Host'),
      firstMes: 'Ready.',
    });

    const name = uniqueName('Regex Host');
    const characterId = await createCharacterViaWs(page, name, 'Ready.');

    // Add a display-only rule to that card.
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: `/characters/${characterId}/regex/new.json`,
        content: JSON.stringify({
          name: 'Greeting swap',
          findRegex: '/Ready\\./g',
          replaceString: 'Set.',
          prompt: false,
          display: true,
        }),
      })}`,
      { expectReply: true, userText: 'write' },
    );
    const addResult = app.lastBubble('assistant').locator('.tool-result-block').last();
    await expect(addResult).toContainText('Greeting swap', { timeout: 15000 });
    await expect(addResult).toContainText('"id": "');

    // A new chat renders the greeting through the character-scoped display rules.
    await app.startChat(name);
    const greeting = page.locator('.message-bubble.assistant').first();
    await expect(greeting).toContainText('Set.', { timeout: 10000 });
    await expect(greeting).not.toContainText('Ready.');
  });
});
