import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { enableBuiltinToolset, deleteToolset } from '../helpers/tools.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

// Compact Lua template using the curated st API (allowSt): chat-scoped vars,
// a chat query, and an entity write — plus proof that chat actions (st.send)
// are NOT in the subset.
const ST_LUA =
  'Tool = {} ' +
  'function Tool.getDefinition() return { stateKey = "ste2e", configSchema = {}, ' +
  'tools = { { name = "ste2e", description = "t", parameters = {} } } } end ' +
  'function Tool.execute() ' +
  'st.setvar("mark", "hail-mocktopia"):await() ' +
  'local v = st.getvar("mark"):await() ' +
  'local name = st.get_chat_name():await() ' +
  'local c = st.create_character({ name = "__CHARNAME__" }):await() ' +
  'return "chat:" .. tostring(name ~= nil) .. " var:" .. tostring(v) .. " char:" .. c.name .. " send:" .. type(st.send) ' +
  'end ' +
  'return Tool';

test.describe('Lua st API (allowSt)', () => {
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

  test('allowSt template uses the st subset in a live chat; chat actions stay excluded', async ({ page }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'workbench');

    await app.createCharacterAndChat({
      name: uniqueName('ST Host'),
      firstMes: 'Ready.',
    });

    const charName = uniqueName('ST Made');
    const code = ST_LUA.replace('__CHARNAME__', charName);
    await app.sendUserMessage(
      `tool:run${JSON.stringify({ verb: 'test_luatool', args: { code, sandbox: { allowSt: true }, toolName: 'ste2e' } })}`,
      { expectReply: true, userText: 'test_luatool' },
    );

    const result = app.lastBubble('assistant').locator('.tool-result-block').last();
    await expect(result).toBeVisible({ timeout: 15000 });
    // var round-trip + chat query + entity write worked…
    await expect(result).toContainText('var:hail-mocktopia');
    await expect(result).toContainText('chat:true');
    await expect(result).toContainText(`char:${charName}`);
    // …and generation-flow functions are not in the subset.
    await expect(result).toContainText('send:nil');

    // The st.create_character broadcast landed: the character is in the sidebar.
    await page.locator('input[placeholder="Search characters..."]').fill(charName);
    await expect(page.locator('.character-list li', { hasText: charName })).toBeVisible({ timeout: 10000 });
  });

  test('st is unavailable without the allowSt flag', async ({ page }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'workbench');

    await app.createCharacterAndChat({
      name: uniqueName('ST Host'),
      firstMes: 'Ready.',
    });

    const code = ST_LUA.replace('__CHARNAME__', uniqueName('ST Made'));
    await app.sendUserMessage(
      `tool:run${JSON.stringify({ verb: 'test_luatool', args: { code, toolName: 'ste2e' } })}`,
      { expectReply: true, userText: 'test_luatool' },
    );

    const result = app.lastBubble('assistant').locator('.tool-result-block').last();
    await expect(result).toBeVisible({ timeout: 15000 });
    await expect(result).toContainText('Lua execution error');
  });
});
