/**
 * Lua backend adapter + custom-backend factory coverage.
 *
 * Type B (character-coupled contextual backend): the character's
 * extensions.contextualBackend.luaSource wraps the ACTIVE adapter (the mock
 * LLM) — no backend-config change needed. Covers LuaBackendAdapter.stream()
 * blocking/passthrough/toolCalls/error paths, scriptState restore/capture,
 * and toLuaLiteral prompt/ctx injection.
 *
 * Type A (registry custom backend): a `custom`-provider backend config with
 * providerParams { customBackendId, delegateConfigId } resolves through
 * createCustomBackendAdapter and delegates to a second backend config
 * pointing at the mock LLM. Also covers listModels via GET /api/models.
 *
 * Lua contract (from server/src/backends/LuaBackendAdapter.ts):
 *   - generate(prompt, ctx) may return: a plain string; a table
 *     { text?, reasoning?, usage?, toolCalls?, error? }; or the passthrough
 *     marker { __passthrough = true | "<configId>", prompt? }.
 *   - backends.generate(prompt):await() -> { text, reasoning, finishReason, usage };
 *     a failed delegation with no text throws into Lua.
 *   - Branch state: a global `state` table is json.encode'd after a successful
 *     turn and restored (json.decode into `state`, or the script's own
 *     deserialize(raw)) at the start of the next turn.
 */
import { test, expect } from '../fixtures/base.js';
import type { Page } from '@playwright/test';
import { login } from '../helpers/auth.js';
import { App } from '../helpers/app.js';
import {
  configureMockBackend,
  resetBackendConfig,
  patchActiveBackendConfig,
} from '../helpers/backendConfig.js';
import { enableBuiltinToolset, deleteToolset } from '../helpers/tools.js';

const MOCK_URL = process.env.MOCK_LLM_URL ?? 'http://127.0.0.1:9876';
/** The e2e webServer pins TAMARI_SECRET to this value (playwright.config.ts). */
const AUTH = { Authorization: 'Bearer e2e-test-secret' };

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

/**
 * Set (or clear, with null) a character's extensions.contextualBackend over
 * the WS bus. Merges into the existing extensions blob (read back via
 * character.select) so other extension keys survive the patch.
 */
async function setContextualBackend(
  page: Page,
  characterName: string,
  luaSource: string | null,
): Promise<void> {
  await page.evaluate(
    ({ name, source }) =>
      new Promise<void>((resolve, reject) => {
        const token = localStorage.getItem('st_auth_token') ?? '';
        const ws = new WebSocket(`ws://${window.location.host}/ws?token=${encodeURIComponent(token)}`);
        let characterId = '';
        ws.onopen = () => ws.send(JSON.stringify({ type: 'auth' }));
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'snapshot') {
            const char = (msg.state?.characters ?? []).find(
              (c: { id: string; name: string }) => c.name === name,
            );
            if (!char) {
              ws.close();
              reject(new Error(`character "${name}" not found`));
              return;
            }
            characterId = char.id;
            ws.send(JSON.stringify({ type: 'character.select', characterId }));
          }
          if (msg.type === 'character.snapshot' && msg.character?.id === characterId) {
            const extensions = { ...(msg.character.extensions ?? {}) };
            if (source === null) {
              delete extensions.contextualBackend;
            } else {
              extensions.contextualBackend = { enabled: true, luaSource: source };
            }
            ws.send(
              JSON.stringify({
                type: 'character.update',
                characterId,
                patch: { extensions },
              }),
            );
          }
          if (msg.type === 'character.updated') {
            ws.close();
            resolve();
          }
          if (msg.type === 'error') {
            ws.close();
            reject(new Error(msg.message ?? 'character update failed'));
          }
        };
        setTimeout(() => {
          ws.close();
          reject(new Error('setContextualBackend timed out'));
        }, 10000);
      }),
    { name: characterName, source: luaSource },
  );
}

interface TypeAIds {
  customBackendId: string;
  delegateConfigId: string;
}

/**
 * Type A setup: register a custom backend (custombackend.create) and a
 * delegate backend config pointing at the mock LLM (backendConfig.create),
 * over one WS connection. Returns both ids for patching + cleanup.
 */
async function createCustomBackendAndDelegate(
  page: Page,
  name: string,
  luaSource: string,
): Promise<TypeAIds> {
  return await page.evaluate(
    ({ cbName, source, mockUrl }) =>
      new Promise<TypeAIds>((resolve, reject) => {
        const token = localStorage.getItem('st_auth_token') ?? '';
        const ws = new WebSocket(`ws://${window.location.host}/ws?token=${encodeURIComponent(token)}`);
        let customBackendId = '';
        ws.onopen = () => ws.send(JSON.stringify({ type: 'auth' }));
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'snapshot') {
            ws.send(
              JSON.stringify({
                type: 'custombackend.create',
                data: { name: cbName, description: 'e2e', luaSource: source },
              }),
            );
          }
          if (msg.type === 'custombackend.created') {
            customBackendId = msg.item.id;
            ws.send(
              JSON.stringify({
                type: 'backendConfig.create',
                data: {
                  name: `${cbName} delegate`,
                  backendProvider: 'openai',
                  generationMode: 'chat',
                  model: 'mock-model',
                  apiUrl: mockUrl,
                  apiKey: 'mock-api-key',
                },
              }),
            );
          }
          if (msg.type === 'backendConfig.created') {
            const delegateConfigId = msg.backendConfig.id as string;
            ws.close();
            resolve({ customBackendId, delegateConfigId });
          }
          if (msg.type === 'error') {
            ws.close();
            reject(new Error(msg.message ?? 'Type A setup failed'));
          }
        };
        setTimeout(() => {
          ws.close();
          reject(new Error('createCustomBackendAndDelegate timed out'));
        }, 10000);
      }),
    { cbName: name, source: luaSource, mockUrl: MOCK_URL },
  );
}

/** Delete the custom backend + delegate config created for a Type A test. */
async function deleteCustomBackendAndDelegate(page: Page, ids: TypeAIds): Promise<void> {
  await page.evaluate(
    ({ customBackendId, delegateConfigId }) =>
      new Promise<void>((resolve, reject) => {
        const token = localStorage.getItem('st_auth_token') ?? '';
        const ws = new WebSocket(`ws://${window.location.host}/ws?token=${encodeURIComponent(token)}`);
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'auth' }));
          ws.send(JSON.stringify({ type: 'custombackend.delete', id: customBackendId }));
          ws.send(JSON.stringify({ type: 'backendConfig.delete', backendConfigId: delegateConfigId }));
        };
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'backendConfig.deleted') {
            ws.close();
            resolve();
          }
          if (msg.type === 'error') {
            ws.close();
            reject(new Error(msg.message ?? 'Type A cleanup failed'));
          }
        };
        setTimeout(() => {
          ws.close();
          reject(new Error('deleteCustomBackendAndDelegate timed out'));
        }, 10000);
      }),
    ids,
  );
}

test.describe('Lua custom backends', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
  });

  test('contextual backend transforms delegate output (blocking string return)', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('Lua Transform');
    await app.createCharacterAndChat({
      name: charName,
      description: 'A character with a Lua contextual backend.',
      firstMes: 'Hello from the card.',
    });

    await setContextualBackend(
      page,
      charName,
      'function generate(prompt, ctx) local res = backends.generate(prompt):await() return res.text:upper() end',
    );

    await app.sendUserMessage('respond: marco', { expectReply: true });
    // The mock replied "marco"; the script uppercased the delegate output.
    await app.waitForAssistantText('MARCO');

    await setContextualBackend(page, charName, null);
  });

  test('contextual backend passthrough streams the delegate reply untouched', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('Lua Passthrough');
    await app.createCharacterAndChat({
      name: charName,
      description: 'A character with a passthrough contextual backend.',
      firstMes: 'Hello from the card.',
    });

    await setContextualBackend(
      page,
      charName,
      'function generate(prompt, ctx) return { __passthrough = true } end',
    );

    await app.sendUserMessage('respond: marco', { expectReply: true });
    // Native streaming from the delegate: the reply is NOT post-processed.
    await app.waitForAssistantText('marco');
    expect(await app.lastAssistantText()).toBe('marco');

    await setContextualBackend(page, charName, null);
  });

  test('contextual backend toolCalls run the GenerationService tool loop', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('Lua Tools');
    await app.createCharacterAndChat({
      name: charName,
      description: 'A character whose backend script calls tools.',
      firstMes: 'Hello from the card.',
    });

    const toolsetId = await enableBuiltinToolset(page, 'lua_dice');
    try {
      // Round 1: no tool result in the prompt yet -> request roll_dice.
      // Round 2 (continuation): a tool_result part is present -> delegate and
      // return the reply text.
      await setContextualBackend(
        page,
        charName,
        `function generate(prompt, ctx)
  for _, m in ipairs(prompt.messages) do
    if type(m.content) == "table" then
      for _, part in ipairs(m.content) do
        if part.type == "tool_result" then
          local r = backends.generate(prompt):await()
          return r.text
        end
      end
    end
  end
  return { toolCalls = { { name = "roll_dice", arguments = { count = 1, sides = 6 } } } }
end`,
      );

      await app.sendUserMessage('respond: marco', { expectReply: true });
      const bubble = app.lastBubble('assistant');
      // The tool loop executed roll_dice (dice widget) and the continuation
      // round produced the final text through the delegate.
      await expect(bubble.locator('.dice-result')).toBeVisible({ timeout: 10000 });
      await app.waitForAssistantText('marco');
    } finally {
      await deleteToolset(page, toolsetId);
      await setContextualBackend(page, charName, null);
    }
  });

  test('contextual backend script state round-trips across turns', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('Lua State');
    await app.createCharacterAndChat({
      name: charName,
      description: 'A character whose backend script keeps a counter.',
      firstMes: 'Hello from the card.',
    });

    // The `state` global is captured (json.encode) after a successful turn and
    // restored (json.decode into `state`) before the next generate() call.
    await setContextualBackend(
      page,
      charName,
      `function generate(prompt, ctx)
  state = state or {}
  state.count = (state.count or 0) + 1
  local r = backends.generate(prompt):await()
  return r.text .. " [calls:" .. tostring(state.count) .. "]"
end`,
    );

    await app.sendUserMessage('respond: marco', { expectReply: true });
    await app.waitForAssistantText('[calls:1]');

    await app.sendUserMessage('respond: marco', { expectReply: true });
    // Second turn saw the persisted state: the counter incremented.
    await app.waitForAssistantText('[calls:2]');

    await setContextualBackend(page, charName, null);
  });

  test('contextual backend error contract surfaces script failures', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('Lua Errors');
    await app.createCharacterAndChat({
      name: charName,
      description: 'A character whose backend script fails.',
      firstMes: 'Hello from the card.',
    });

    // 1. Script that does not define generate(prompt, ctx).
    await setContextualBackend(page, charName, 'local answer = 42');
    await app.sendUserMessage('respond: marco');
    await expect(page.locator('.toast-container')).toContainText('does not define generate', {
      timeout: 15000,
    });

    // 2. Script that returns an explicit error table.
    await setContextualBackend(
      page,
      charName,
      'function generate(prompt, ctx) return { error = "custom failure" } end',
    );
    await app.sendUserMessage('respond: marco');
    await expect(page.locator('.toast-container')).toContainText('custom failure', {
      timeout: 15000,
    });

    await setContextualBackend(page, charName, null);
  });

  test('registry custom backend delegates to its delegate config', async ({ page }) => {
    const app = new App(page);
    const cbName = uniqueName('Registry CB');
    const ids = await createCustomBackendAndDelegate(
      page,
      cbName,
      'function generate(prompt, ctx) local r = backends.generate(prompt):await() return "CB:" .. r.text end',
    );
    try {
      await patchActiveBackendConfig(page, {
        backendProvider: 'custom',
        providerParams: {
          customBackendId: ids.customBackendId,
          delegateConfigId: ids.delegateConfigId,
        },
      });

      const charName = uniqueName('Type A Char');
      await app.createCharacterAndChat({
        name: charName,
        description: 'A character speaking through a registry custom backend.',
        firstMes: 'Hello from the card.',
      });

      await app.sendUserMessage('respond: marco', { expectReply: true });
      // Delegate replied "marco"; the registry script prefixed it.
      await app.waitForAssistantText('CB:marco');
    } finally {
      await resetBackendConfig(page);
      await deleteCustomBackendAndDelegate(page, ids);
    }
  });

  test('custom backend list_models surfaces through GET /api/models', async ({ page, request }) => {
    const cbName = uniqueName('Models CB');
    const ids = await createCustomBackendAndDelegate(
      page,
      cbName,
      `function generate(prompt, ctx) local r = backends.generate(prompt):await() return r.text end
function list_models() return { { id = "cb-model-1", name = "CB Model 1" } } end`,
    );
    try {
      await patchActiveBackendConfig(page, {
        backendProvider: 'custom',
        providerParams: {
          customBackendId: ids.customBackendId,
          delegateConfigId: ids.delegateConfigId,
        },
      });

      const res = await request.get('/api/models', { headers: AUTH });
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as { items: Array<{ id: string; name: string }> };
      expect(body.items).toContainEqual({ id: 'cb-model-1', name: 'CB Model 1' });
    } finally {
      await resetBackendConfig(page);
      await deleteCustomBackendAndDelegate(page, ids);
    }
  });
});
