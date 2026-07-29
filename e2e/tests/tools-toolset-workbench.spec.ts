import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { enableBuiltinToolset, deleteToolset } from '../helpers/tools.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

// Compact Lua template source (whitespace-separated statements). Defines an
// `echo_live` tool that echoes the text it receives.
const ECHO_LUA =
  'Tool = {} ' +
  'function Tool.getDefinition() return { stateKey = "echolive", configSchema = {}, ' +
  'tools = { { name = "echo_live", description = "Echoes", ' +
  'parameters = { type = "object", properties = { text = { type = "string" } } } } } } end ' +
  'function Tool.execute(args, context, toolName) ' +
  'return "live-echo:" .. tostring(args.text) end ' +
  'return Tool';

test.describe('Toolset Workbench', () => {
  const toolsetIds: string[] = [];

  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
    while (toolsetIds.length > 0) {
      await deleteToolset(page, toolsetIds.pop()!);
    }
  });

  test('full loop: model authors a Lua tool, enables it via a toolset, then calls it', async ({ page }) => {
    const app = new App(page);
    // The single workbench template covers both halves: /luatools authoring
    // and /toolsets enabling.
    toolsetIds.push(await enableBuiltinToolset(page, 'workbench'));

    await app.createCharacterAndChat({
      name: uniqueName('TS Host'),
      firstMes: 'Ready.',
    });

    // 1. Author the template by writing /luatools/new.json.
    const name = uniqueName('Live Echo');
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: '/luatools/new.json',
        content: JSON.stringify({ name, code: ECHO_LUA }),
      })}`,
      {
        expectReply: true,
        // The markdown renderer mangles the escaped quotes in the full message.
        userText: 'write',
      },
    );

    const createResult = app.lastBubble('assistant').locator('.tool-result-block').last();
    await expect(createResult).toContainText('echo_live', { timeout: 15000 });
    const createText = await createResult.innerText();
    const templateId = createText.match(/"id":\s*"([0-9a-f-]{36})"/)?.[1];
    expect(templateId, 'created template id in tool result').toBeTruthy();

    // 2. Enable it via a toolset. Goes live on the NEXT message.
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: '/toolsets/new.json',
        content: JSON.stringify({ templateId, name: `${name} Instance` }),
      })}`,
      { expectReply: true, userText: 'write' },
    );

    const toolsetResult = app.lastBubble('assistant').locator('.tool-result-block').last();
    await expect(toolsetResult).toContainText('"enabled": true', { timeout: 15000 });
    await expect(toolsetResult).toContainText('echo_live');

    // 3. Call the brand-new tool. The mock walks tool: sequences for ANY tool
    // name; the server resolves echo_live through the toolset created in step 2.
    await app.sendUserMessage(`tool:echo_live${JSON.stringify({ text: 'it works' })}`, {
      expectReply: true,
    });

    const echoResult = app.lastBubble('assistant').locator('.tool-result-block').last();
    await expect(echoResult).toContainText('live-echo:it works', { timeout: 15000 });
  });

  test('a write to /luatools/new.json rejects a broken Lua template instead of saving it', async ({ page }) => {
    const app = new App(page);
    toolsetIds.push(await enableBuiltinToolset(page, 'workbench'));

    await app.createCharacterAndChat({
      name: uniqueName('TS Host'),
      firstMes: 'Ready.',
    });

    const name = uniqueName('Broken Tool');
    // The luatools write refuses to save broken code, so the toolsets write
    // never sees an id for it — the sequence asserts both rejection paths in
    // one turn.
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: '/luatools/new.json',
        content: JSON.stringify({ name, code: 'this is not lua' }),
      })},write${JSON.stringify({
        path: '/toolsets/new.json',
        content: JSON.stringify({ templateId: 'nonexistent-template-id' }),
      })}`,
      { expectReply: true, userText: 'write' },
    );

    const results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(2, { timeout: 15000 });
    await expect(results.first()).toContainText('validation failed');
    await expect(results.last()).toContainText('not found');
  });
});
