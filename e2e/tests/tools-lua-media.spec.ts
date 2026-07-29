import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { enableBuiltinToolset, deleteToolset } from '../helpers/tools.js';
import { App } from '../helpers/app.js';

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

// Compact Lua media tool (whitespace-separated statements). Fetches audio from
// the mock LLM server's /audio/speech endpoint, saves it as an attachment via
// attachments.create, and returns text + audio inline parts. Requires
// allowNet + allowFiles; uses promise:await() inside execute.
const MOCK_URL = process.env.MOCK_LLM_URL ?? 'http://127.0.0.1:9876';
const TTS_LUA =
  'Tool = {} ' +
  'function Tool.getDefinition() return { stateKey = "tts", configSchema = {}, ' +
  'tools = { { name = "tts_test", description = "t", parameters = {} } } } end ' +
  'function Tool.execute() ' +
  `local res = fetch("${MOCK_URL}/audio/speech", { method = "POST", body = "{}" }):await() ` +
  'local att = attachments.create(res.bodyBase64, "audio/wav"):await() ' +
  'return { content = { ' +
  '{ type = "text", text = "speech {{attachment::" .. att.id .. "}}" }, ' +
  '{ type = "audio", source = att.url, mimeType = "audio/wav" } } } end ' +
  'return Tool';

test.describe('Lua Media Capabilities (fetch + attachments)', () => {
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

  test('Lua tool fetches media over HTTP, saves an attachment, returns inline parts', async ({ page }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'workbench');

    await app.createCharacterAndChat({
      name: uniqueName('Media Host'),
      firstMes: 'Ready.',
    });

    await app.sendUserMessage(
      `tool:run${JSON.stringify({ verb: 'test_luatool', args: { code: TTS_LUA, sandbox: { allowNet: true, allowFiles: true }, toolName: 'tts_test' } })}`,
      { expectReply: true, userText: 'test_luatool' },
    );

    // The test_luatool result wraps the tool's return: inline text + audio parts
    // with the attachment URL.
    const result = app.lastBubble('assistant').locator('.tool-result-block').last();
    await expect(result).toBeVisible({ timeout: 15000 });
    await expect(result).toContainText('/api/attachments/');
    await expect(result).toContainText('audio/wav');
  });

  test('fetch stays sandboxed without allowNet', async ({ page }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'workbench');

    await app.createCharacterAndChat({
      name: uniqueName('Media Host'),
      firstMes: 'Ready.',
    });

    // Same code, no flags: fetch is nil, so the script errors cleanly.
    await app.sendUserMessage(
      `tool:run${JSON.stringify({ verb: 'test_luatool', args: { code: TTS_LUA, toolName: 'tts_test' } })}`,
      { expectReply: true, userText: 'test_luatool' },
    );

    const result = app.lastBubble('assistant').locator('.tool-result-block').last();
    await expect(result).toBeVisible({ timeout: 15000 });
    await expect(result).toContainText('nil');
    await expect(result).not.toContainText('/api/attachments/');
  });
});
