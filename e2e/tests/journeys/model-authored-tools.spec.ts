/**
 * Model-authored tools journey.
 *
 * The full self-authoring loop in one conversation:
 *   1. the "model" authors a Lua tool template (write /luatools/new.json),
 *   2. enables it as a toolset (write /toolsets/new.json),
 *   3. calls the brand-new tool, which downloads a markdown document over HTTP
 *      (the Sacred Scrolls of Mocktopia, served statically by the mock LLM
 *      server — hermetic, no real internet needed) via the allowNet fetch,
 *      saves it as an attachment via allowFiles attachments.create,
 *      re-reads the bytes back from the public attachment URL, and prints
 *      an excerpt sourced from the attachment — not from the original fetch,
 *   4. the journey independently verifies the attachment bytes over HTTP,
 *   5. and the chat stays healthy afterwards.
 */
import { journeyTest as test, expect } from '../../fixtures/journey.js';
import { enableBuiltinToolset, deleteToolset } from '../../helpers/tools.js';

// Ports follow the harness (E2E_PORT / MOCK_LLM_PORT) so the journey also runs
// against non-default targets — e.g. the Docker container (playwright.docker.config.ts).
const APP_PORT = Number(process.env.E2E_PORT ?? 8765);
const MOCK_PORT = Number(process.env.MOCK_LLM_PORT ?? 9876);

// Compact Lua template (whitespace-separated statements, no nested-brace
// imbalance so the mock's tool: parser can split args correctly).
const DOCS_LUA =
  'Tool = {} ' +
  'function Tool.getDefinition() return { stateKey = "scrolls", configSchema = {}, ' +
  'tools = { { name = "fetch_scrolls", ' +
  'description = "Downloads the Sacred Scrolls of Mocktopia, saves them as an attachment, and prints an excerpt re-read from the attachment.", ' +
  'parameters = { type = "object", properties = {} } } } } end ' +
  'function Tool.execute(args, context, toolName) ' +
  `local res = fetch("http://127.0.0.1:${MOCK_PORT}/sacred-scrolls.md"):await() ` +
  'if res.status ~= 200 then return "Error: fetch failed with status " .. tostring(res.status) end ' +
  'local att = attachments.create(base64.encode(res.body), "text/markdown"):await() ' +
  `local back = fetch("http://127.0.0.1:${APP_PORT}/api/attachments/" .. att.id):await() ` +
  'local excerpt = string.sub(back.body or "", 1, 400) ' +
  'return "Downloaded " .. tostring(#res.body) .. " chars. Saved as {{attachment::" .. att.id .. "}} at " .. att.url .. ". ' +
  'Excerpt re-read from the attachment: " .. excerpt ' +
  'end ' +
  'return Tool';

test.describe('Model-Authored Tools Journey', () => {
  test('author a template, enable it, call it: download → attachment → printed excerpt', async ({ app, page }) => {
    const stamp = `${Date.now()}`;
    const toolsetIds: string[] = [];
    let templateId: string | undefined;
    let createdToolsetId: string | undefined;

    try {
      await test.step('setup: enable the workbench and open a chat', async () => {
        toolsetIds.push(await enableBuiltinToolset(page, 'workbench'));
        await app.createCharacterAndChat({ name: `Author Char ${stamp}`, firstMes: 'Ready.' });

        // A normal turn first — authoring must work mid-conversation.
        await app.sendUserMessage('seq:hello', { expectReply: true });
        await app.waitForAssistantText(/Turn \d+/);
      });

      await test.step('the model authors the Lua tool template', async () => {
        await app.sendUserMessage(
          `tool:write${JSON.stringify({
            path: '/luatools/new.json',
            content: JSON.stringify({ name: `Sacred Scrolls ${stamp}`, code: DOCS_LUA, sandbox: { allowNet: true, allowFiles: true } }),
          })}`,
          { expectReply: true, userText: 'write' },
        );
        const result = app.lastBubble('assistant').locator('.tool-result-block').last();
        await expect(result).toContainText('fetch_scrolls', { timeout: 15000 });
        templateId = (await result.innerText()).match(/"id":\s*"([0-9a-f-]{36})"/)?.[1];
        expect(templateId, 'created template id in tool result').toBeTruthy();
      });

      await test.step('the model enables the template as a toolset', async () => {
        await app.sendUserMessage(
          `tool:write${JSON.stringify({
            path: '/toolsets/new.json',
            content: JSON.stringify({ templateId, name: `Scrolls Instance ${stamp}` }),
          })}`,
          { expectReply: true, userText: 'write' },
        );
        const result = app.lastBubble('assistant').locator('.tool-result-block').last();
        await expect(result).toContainText('"enabled": true', { timeout: 15000 });
        await expect(result).toContainText('fetch_scrolls');
        createdToolsetId = (await result.innerText()).match(/"id":\s*"([0-9a-f-]{36})"/)?.[1];
      });

      let attachmentId: string | undefined;
      await test.step('the model calls its new tool: download → attachment → excerpt from the attachment', async () => {
        await app.sendUserMessage('tool:fetch_scrolls{}', { expectReply: true });

        const result = app.lastBubble('assistant').locator('.tool-result-block').last();
        // The download really happened…
        await expect(result).toContainText('Downloaded', { timeout: 30000 });
        await expect(result).toContainText('/api/attachments/');
        // …and the printed excerpt comes from RE-READING the attachment.
        // (Generic tool results render verbatim in a <pre>, markdown intact.)
        await expect(result).toContainText('# The Sacred Scrolls of Mocktopia');
        await expect(result).toContainText('incrementeth eternally');

        attachmentId = (await result.innerText()).match(/\/api\/attachments\/([0-9a-f-]{36})/)?.[1];
        expect(attachmentId, 'attachment id in tool result').toBeTruthy();
      });

      await test.step('the attachment bytes are independently verifiable over HTTP', async () => {
        const response = await page.request.get(`http://127.0.0.1:${APP_PORT}/api/attachments/${attachmentId}`);
        expect(response.status()).toBe(200);
        expect(response.headers()['content-type']).toContain('text/markdown');
        const body = await response.text();
        expect(body).toContain('# The Sacred Scrolls of Mocktopia');
        expect(body).toContain('the bag is holy');
      });

      await test.step('the conversation stays healthy after the whole loop', async () => {
        await app.sendUserMessage('seq:still alive', { expectReply: true });
        await app.waitForAssistantText(/Turn \d+/);
      });
    } finally {
      if (createdToolsetId) await deleteToolset(page, createdToolsetId);
      for (const id of toolsetIds) await deleteToolset(page, id);
    }
  });
});
