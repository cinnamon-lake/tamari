import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { enableBuiltinToolset, deleteToolset } from '../helpers/tools.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

// Compact Lua template source (statements are whitespace-separated, so no
// newlines are needed inside the tool: message's JSON string). Defines an
// `echo_test` tool that reports the text it got and whether `os` is exposed.
const ECHO_LUA =
  'Tool = {} ' +
  'function Tool.getDefinition() return { stateKey = "echo", configSchema = {}, ' +
  'tools = { { name = "echo_test", description = "Echoes", ' +
  'parameters = { type = "object", properties = { text = { type = "string" } } } } } } end ' +
  'function Tool.execute(args, context, toolName) ' +
  'return "echo:" .. tostring(args.text) .. " os:" .. type(os) end ' +
  'return Tool';

test.describe('Lua Tool Workbench', () => {
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

  test('create + test a Lua tool template; sandbox flags control stdlib access', async ({ page }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'workbench');

    await app.createCharacterAndChat({
      name: uniqueName('LW Host'),
      firstMes: 'Ready.',
    });

    const name = uniqueName('Echo Tool');
    // Sequence: create (validated, with allowOs) → test raw unsaved code
    // WITHOUT sandbox flags (os must be nil). Args built via JSON.stringify so
    // the quotes inside the Lua source survive the mock's tool: parser.
    const createArgs = JSON.stringify({
      path: '/luatools/new.json',
      content: JSON.stringify({ name, code: ECHO_LUA, sandbox: { allowOs: true } }),
    });
    const rawTestArgs = JSON.stringify({
      verb: 'test_luatool',
      args: { code: ECHO_LUA, toolName: 'echo_test', args: { text: 'hello' } },
    });
    await app.sendUserMessage(`tool:write${createArgs},run${rawTestArgs}`, {
      expectReply: true,
      // The markdown renderer unescapes \" in the bubble — assert a stable substring.
      userText: 'write',
    });

    const results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(2, { timeout: 15000 });

    // Create result: new id + parsed definition naming the echo_test tool.
    await expect(results.first()).toContainText('"id": "');
    await expect(results.first()).toContainText('echo_test');

    // Raw-code test without flags: runs, but os is stripped.
    await expect(results.last()).toContainText('echo:hello os:nil');

    // Now test the stored template — its saved allowOs flag must apply.
    // The stored template's id is needed; read it from the first tool result.
    const createText = await results.first().innerText();
    const idMatch = createText.match(/"id":\s*"([0-9a-f-]{36})"/);
    expect(idMatch, 'created template id in tool result').toBeTruthy();

    await app.sendUserMessage(
      `tool:run${JSON.stringify({ verb: 'test_luatool', args: { id: idMatch![1], toolName: 'echo_test', args: { text: 'stored' } } })}`,
      { expectReply: true },
    );

    const stored = app.lastBubble('assistant').locator('.tool-result-block').last();
    await expect(stored).toBeVisible({ timeout: 15000 });
    await expect(stored).toContainText('echo:stored os:table');
  });

  test('a write to /luatools/new.json rejects broken code without saving', async ({ page }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'workbench');

    await app.createCharacterAndChat({
      name: uniqueName('LW Host'),
      firstMes: 'Ready.',
    });

    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: '/luatools/new.json',
        content: JSON.stringify({ name: 'Broken', code: 'this is not lua' }),
      })}`,
      { expectReply: true, userText: 'write' },
    );

    const result = app.lastBubble('assistant').locator('.tool-result-block').last();
    await expect(result).toBeVisible({ timeout: 15000 });
    await expect(result).toContainText('validation failed');
  });
});
