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

/**
 * Create a character WITH card extensions (the contextualBackend script) over
 * the app's WS bus and return its id. The workbench chat that authors the
 * card must be a different, plain character — see the test below.
 */
async function createCharacterViaWs(page: Page, charName: string, extensions: Record<string, unknown>): Promise<string> {
  return await page.evaluate(
    ({ charName: cn, extensions: ext }) => {
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
              ws.send(JSON.stringify({ type: 'character.create', data: { name: cn, firstMes: 'Ready.', extensions: ext } }));
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
    { charName, extensions },
  );
}

// No braces anywhere — the mock's tool: parser counts them. The module is a
// chunk returning a FUNCTION (a valid module value); main.lua requires it.
const MAIN_LUA = `local reply = require('lib/utils') function generate(prompt, ctx) return reply() end`;
const MODULE_LUA = `return function() return 'VFS_MODULE_OK' end`;

const PASSTHROUGH_LUA = `function generate(prompt, ctx)
  prompt.response_format = { type = 'json_schema', schema = { type = 'object' } }
  local res = backends.generate(prompt):await()
  return res.text
end`;

test.describe.configure({ mode: 'serial' });

test.describe('Backend Logic VFS (card multi-file + response_format)', () => {
  const toolsetIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    await resetLlmRequests();
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
    while (toolsetIds.length > 0) {
      await deleteToolset(page, toolsetIds.pop()!);
    }
  });

  test('workbench writes backend_logic/main.lua + a module; generation resolves require', async ({ page }) => {
    const app = new App(page);

    // The scripted card starts with a placeholder script, ENABLED — writes to
    // backend_logic/ replace the entry point while preserving the flag. The
    // workbench host chat is a plain character (a contextual-backend chat
    // would route the tool: turn through the card script instead of the mock).
    const cardName = uniqueName('VFS Card');
    const cardId = await createCharacterViaWs(page, cardName, {
      contextualBackend: { enabled: true, luaSource: 'function generate(p, c) return "PLACEHOLDER" end' },
    });

    toolsetIds.push(await enableBuiltinToolset(page, 'workbench'));
    await app.createCharacterAndChat({ name: uniqueName('WB Host'), firstMes: 'Ready.' });

    // Author the directory: main.lua + lib/utils.lua, then read the module and
    // the legacy alias back.
    await app.sendUserMessage(
      `tool:write${JSON.stringify({ path: `/characters/${cardId}/backend_logic/main.lua`, content: MAIN_LUA })}` +
        `,write${JSON.stringify({ path: `/characters/${cardId}/backend_logic/lib/utils.lua`, content: MODULE_LUA })}` +
        `,read${JSON.stringify({ path: `/characters/${cardId}/backend_logic/lib/utils.lua` })}` +
        `,read${JSON.stringify({ path: `/characters/${cardId}/backend_logic.lua` })}`,
      { expectReply: true, userText: 'write' },
    );

    const results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(4, { timeout: 15000 });
    // The module read returns its source verbatim; the legacy backend_logic.lua
    // alias reads main.lua.
    await expect(results.nth(2)).toContainText(MODULE_LUA);
    await expect(results.nth(3)).toContainText(MAIN_LUA);

    // Switch to the scripted card's own chat: the generation runs the new
    // main.lua, whose require('lib/utils') resolves against the card files.
    await app.startChat(cardName);
    await app.sendUserMessage('hello', { expectReply: true });
    await app.waitForAssistantText('VFS_MODULE_OK');
  });

  test('backend_logic response_format reaches the delegate request', async ({ page }) => {
    const app = new App(page);
    const cardName = uniqueName('RF Card');
    await createCharacterViaWs(page, cardName, {
      contextualBackend: { enabled: true, luaSource: PASSTHROUGH_LUA },
    });
    await app.startChat(cardName);

    await app.sendUserMessage('respond: structured hello', { expectReply: true });
    await app.waitForAssistantText('structured hello');

    // The OpenAI adapter maps responseFormat onto the request body; the mock
    // recorded exactly what the delegate call carried.
    await expect
      .poll(async () => (await getRouteRequest('/chat/completions'))?.route ?? null, { timeout: 10000 })
      .toBe('/chat/completions');
    const captured = await getRouteRequest('/chat/completions');
    const rf = (captured!.body as Record<string, unknown>)['response_format'] as Record<string, unknown>;
    expect(rf['type']).toBe('json_schema');
    expect(rf['json_schema']).toMatchObject({ schema: { type: 'object' }, strict: true });
  });
});
