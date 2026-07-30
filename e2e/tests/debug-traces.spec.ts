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

interface TypeAIds {
  customBackendId: string;
  customConfigId: string;
  delegateConfigId: string;
}

/**
 * Register a Lua custom backend + a delegate config (mock LLM) + a
 * custom-provider backend config referencing them, over one WS connection.
 * The custom config id is what run_agent's per-call `backend` arg takes.
 */
async function createTypeAConfig(page: Page, name: string, luaSource: string): Promise<TypeAIds> {
  return await page.evaluate(
    ({ cbName, source, mockUrl }) =>
      new Promise<TypeAIds>((resolve, reject) => {
        const token = localStorage.getItem('st_auth_token') ?? '';
        const ws = new WebSocket(`ws://${window.location.host}/ws?token=${encodeURIComponent(token)}`);
        let customBackendId = '';
        let delegateConfigId = '';
        ws.onopen = () => ws.send(JSON.stringify({ type: 'auth' }));
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'snapshot') {
            ws.send(JSON.stringify({ type: 'custombackend.create', data: { name: cbName, description: 'e2e', luaSource: source } }));
          }
          if (msg.type === 'custombackend.created') {
            customBackendId = msg.item.id;
            ws.send(
              JSON.stringify({
                type: 'backendConfig.create',
                data: { name: `${cbName} delegate`, backendProvider: 'openai', generationMode: 'chat', model: 'mock-model', apiUrl: mockUrl, apiKey: 'mock-api-key' },
              }),
            );
          }
          if (msg.type === 'backendConfig.created' && !delegateConfigId) {
            delegateConfigId = msg.backendConfig.id;
            ws.send(
              JSON.stringify({
                type: 'backendConfig.create',
                data: {
                  name: cbName,
                  backendProvider: 'custom',
                  generationMode: 'chat',
                  model: 'mock-model',
                  providerParams: { customBackendId, delegateConfigId },
                },
              }),
            );
          } else if (msg.type === 'backendConfig.created' && delegateConfigId) {
            ws.close();
            resolve({ customBackendId, customConfigId: msg.backendConfig.id as string, delegateConfigId });
          }
          if (msg.type === 'error') {
            ws.close();
            reject(new Error(msg.message ?? 'Type A setup failed'));
          }
        };
        setTimeout(() => {
          ws.close();
          reject(new Error('createTypeAConfig timed out'));
        }, 10000);
      }),
    { cbName: name, source: luaSource, mockUrl: MOCK_URL },
  );
}

/** Delete custom backends + configs created for a test (best-effort). */
async function deleteTypeAConfigs(page: Page, ids: TypeAIds[]): Promise<void> {
  if (ids.length === 0) return;
  await page.evaluate((list) => {
    return new Promise<void>((resolve) => {
      const token = localStorage.getItem('st_auth_token') ?? '';
      const ws = new WebSocket(`ws://${window.location.host}/ws?token=${encodeURIComponent(token)}`);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'auth' }));
        for (const id of list) {
          ws.send(JSON.stringify({ type: 'custombackend.delete', id: id.customBackendId }));
          ws.send(JSON.stringify({ type: 'backendConfig.delete', backendConfigId: id.customConfigId }));
          ws.send(JSON.stringify({ type: 'backendConfig.delete', backendConfigId: id.delegateConfigId }));
        }
        ws.close();
        resolve();
      };
      setTimeout(() => resolve(), 5000);
    });
  }, ids);
}

/** Create a plain character over WS (host for workbench/scripted-card flows). */
async function createCharacterViaWs(page: Page, charName: string): Promise<string> {
  return await page.evaluate((cn) => {
    return new Promise<string>((resolve, reject) => {
      const token = localStorage.getItem('st_auth_token') ?? '';
      const ws = new WebSocket(`ws://${window.location.host}/ws?token=${encodeURIComponent(token)}`);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth' }));
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string);
        if (msg.type === 'snapshot') {
          ws.send(JSON.stringify({ type: 'character.create', data: { name: cn, firstMes: 'Ready.' } }));
        }
        if (msg.type === 'character.created' && msg.character?.name === cn) {
          ws.close();
          resolve(msg.character.id as string);
        }
        if (msg.type === 'error') {
          ws.close();
          reject(new Error(msg.message ?? 'WS creation failed'));
        }
      };
      setTimeout(() => {
        ws.close();
        reject(new Error('createCharacterViaWs timed out'));
      }, 10000);
    });
  }, charName);
}

// Brace-free Lua (the mock's tool: parser counts braces).
const MAIN_LUA = `local wrap = require('lib/wrap') function generate(prompt, ctx) local res = backends.generate(prompt):await() return wrap(res.text) end`;
const MODULE_LUA = `return function(t) return '[' .. t .. ']' end`;

test.describe.configure({ mode: 'serial' });

test.describe('Debug traces', () => {
  const toolsetIds: string[] = [];
  const typeAIds: TypeAIds[] = [];

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
    await deleteTypeAConfigs(page, typeAIds.splice(0));
  });

  test('run_agent error renders the composed trace chain; success trace id opens in the workbench', async ({ page }) => {
    const app = new App(page);

    // Inner Lua backend throws; outer delegates to it, so the sub-agent fails
    // two Lua layers deep: outer → delegate(cfg) → inner.
    const inner = await createTypeAConfig(page, uniqueName('Inner Trace Backend'), `function generate(p, c) error('INNER_BOOM') end`);
    typeAIds.push(inner);
    const outer = await createTypeAConfig(
      page,
      uniqueName('Outer Trace Backend'),
      `function generate(p, c) local res = backends.generate("${inner.customConfigId}", p):await() return res.text end`,
    );
    typeAIds.push(outer);

    toolsetIds.push(await enableBuiltinToolset(page, 'agent'));
    toolsetIds.push(await enableBuiltinToolset(page, 'workbench'));
    await app.createCharacterAndChat({ name: uniqueName('Trace Host'), firstMes: 'Ready.' });

    // Failing sub-agent (backendOverride → the outer custom config).
    await app.sendUserMessage(
      `tool:run_agent${JSON.stringify({ prompt: 'do the thing', backend: outer.customConfigId })}`,
      { expectReply: true, userText: 'run_agent' },
    );

    let results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(1, { timeout: 15000 });
    const errorResult = results.last();
    await expect(errorResult).toContainText('Agent error:');
    await expect(errorResult).toContainText('subagent(');
    await expect(errorResult).toContainText('Outer Trace Backend');
    await expect(errorResult).toContainText(' → ');
    await expect(errorResult).toContainText('LUA_ERROR');
    await expect(errorResult).toContainText('INNER_BOOM');

    // Successful sub-agent: the result ends with a [trace: <generationId>]
    // reference, which opens read-only in the workbench at /generations/<id>/.
    await app.sendUserMessage(
      `tool:run_agent${JSON.stringify({ prompt: 'respond: sub agent answer' })}`,
      { expectReply: true, userText: 'run_agent' },
    );
    results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(1, { timeout: 15000 });
    await expect(results.last()).toContainText('sub agent answer');
    await expect(results.last()).toContainText('[trace: ');

    const traceId = (await results.last().innerText()).match(/\[trace: ([0-9a-f-]{36})\]/)?.[1];
    expect(traceId).toBeTruthy();

    await app.sendUserMessage(
      `tool:read${JSON.stringify({ path: `/generations/${traceId}/meta.json` })}`,
      { expectReply: true, userText: 'read' },
    );
    results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(1, { timeout: 15000 });
    await expect(results.last()).toContainText('"kind": "subagent"');
    await expect(results.last()).toContainText('"depth": 1');
  });

  test('backend_logic_test dry-run outcome carries the trace (delegations + modulesLoaded)', async ({ page }) => {
    const app = new App(page);
    toolsetIds.push(await enableBuiltinToolset(page, 'workbench'));
    await app.createCharacterAndChat({ name: uniqueName('WB Host'), firstMes: 'Ready.' });
    const cardId = await createCharacterViaWs(page, uniqueName('Dry Trace Card'));

    // Author the script + module, then dry-run with a canned delegate answer.
    await app.sendUserMessage(
      `tool:write${JSON.stringify({ path: `/characters/${cardId}/backend_logic/main.lua`, content: MAIN_LUA })}` +
        `,write${JSON.stringify({ path: `/characters/${cardId}/backend_logic/lib/wrap.lua`, content: MODULE_LUA })}` +
        `,run${JSON.stringify({ verb: 'test_backend_logic', args: { characterId: cardId, input: 'hi', delegateResponse: 'CANNED' } })}`,
      { expectReply: true, userText: 'write' },
    );

    let results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(3, { timeout: 15000 });
    const dryRun = results.nth(2);
    await expect(dryRun).toContainText('[CANNED]');
    await expect(dryRun).toContainText('"layer":"default"');
    await expect(dryRun).toContainText('modulesLoaded');
    await expect(dryRun).toContainText('lib/wrap.lua');

    // Failing delegation: { error } surfaces in the trace instead of text.
    await app.sendUserMessage(
      `tool:run${JSON.stringify({ verb: 'test_backend_logic', args: { characterId: cardId, input: 'hi', delegateResponse: { error: 'delegate died' } } })}`,
      { expectReply: true, userText: 'run' },
    );
    results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(1, { timeout: 15000 });
    await expect(results.last()).toContainText('"error":"delegate died"');
    await expect(results.last()).toContainText('DELEGATE_ERROR');
  });
});
