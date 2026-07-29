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
 * sent. (Same helper as tools-character-workbench.spec.ts.)
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

// Compact Lua template source (statements are whitespace-separated, so no
// newlines are needed inside the tool: message's JSON string). Same echo tool
// as tools-luatool-workbench.spec.ts.
const ECHO_LUA =
  'Tool = {} ' +
  'function Tool.getDefinition() return { stateKey = "echo", configSchema = {}, ' +
  'tools = { { name = "echo_test", description = "Echoes", ' +
  'parameters = { type = "object", properties = { text = { type = "string" } } } } } } end ' +
  'function Tool.execute(args, context, toolName) ' +
  'return "echo:" .. tostring(args.text) .. " os:" .. type(os) end ' +
  'return Tool';

// A Type A custom-backend script (no braces — the mock's tool: parser counts
// them). generate(prompt, ctx) returns a plain string.
const PONG_LUA = 'function generate(prompt, ctx) return "pong" end';

test.describe.configure({ mode: 'serial' });

test.describe('Workbench VFS Tools', () => {
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

  async function setupWorkbenchChat(page: Page, app: App): Promise<void> {
    toolsetIds.push(await enableBuiltinToolset(page, 'workbench'));
    await app.createCharacterAndChat({
      name: uniqueName('WB Host'),
      firstMes: 'Ready.',
    });
  }

  test('grep finds a substring and a regex match inside one character entity', async ({ page }) => {
    const app = new App(page);
    await setupWorkbenchChat(page, app);
    const characterId = await createCharacterViaWs(page, uniqueName('Grep Target'));

    // Collections can never be grepped, so the path is the entity dir.
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: `/characters/${characterId}/description`,
        content: 'A dragon sleeps here.\nSecond line is calm.',
      })},grep${JSON.stringify({ path: `/characters/${characterId}/`, pattern: 'dragon' })}`,
      { expectReply: true, userText: 'write' },
    );

    let results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(2, { timeout: 15000 });
    // Output format: path:line:text.
    await expect(results.last()).toContainText(`/characters/${characterId}/description:1:`);
    await expect(results.last()).toContainText('A dragon sleeps here.');

    await app.sendUserMessage(
      `tool:grep${JSON.stringify({ path: `/characters/${characterId}/`, pattern: 'drag.n', regex: true })}`,
      { expectReply: true, userText: 'grep' },
    );

    results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(1, { timeout: 15000 });
    await expect(results.last()).toContainText(`/characters/${characterId}/description:1:`);
    await expect(results.last()).toContainText('A dragon sleeps here.');
  });

  test('edit replaces a unique string and refuses an ambiguous one', async ({ page }) => {
    const app = new App(page);
    await setupWorkbenchChat(page, app);
    const characterId = await createCharacterViaWs(page, uniqueName('Edit Target'));

    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: `/characters/${characterId}/description`,
        content: 'alpha beta gamma',
      })},edit${JSON.stringify({
        path: `/characters/${characterId}/description`,
        oldString: 'beta',
        newString: 'BETA',
      })}`,
      { expectReply: true, userText: 'write' },
    );

    let results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(2, { timeout: 15000 });
    await expect(results.last()).toContainText(`Edited /characters/${characterId}/description (1 replacement).`);

    // oldString occurring twice without replaceAll is an error asking for uniqueness.
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: `/characters/${characterId}/description`,
        content: 'dup and dup',
      })},edit${JSON.stringify({
        path: `/characters/${characterId}/description`,
        oldString: 'dup',
        newString: 'x',
      })}`,
      { expectReply: true, userText: 'write' },
    );

    results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(2, { timeout: 15000 });
    await expect(results.last()).toContainText('oldString matches 2 locations');
    await expect(results.last()).toContainText('replaceAll: true');
  });

  test('read pages a file with offset/limit and truncates long files with a hint', async ({ page }) => {
    const app = new App(page);
    await setupWorkbenchChat(page, app);
    const characterId = await createCharacterViaWs(page, uniqueName('Read Target'));

    const fiveLines = ['line-one-alpha', 'line-two-bravo', 'line-three-charlie', 'line-four-delta', 'line-five-echo'].join(
      '\n',
    );
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: `/characters/${characterId}/description`,
        content: fiveLines,
      })},read${JSON.stringify({ path: `/characters/${characterId}/description`, offset: 2, limit: 1 })}`,
      { expectReply: true, userText: 'write' },
    );

    let results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(2, { timeout: 15000 });
    // Ranged reads render 1-based tab-numbered lines (tab collapses in text).
    await expect(results.last()).toContainText(/2\s+line-two-bravo/);
    await expect(results.last()).not.toContainText('line-one-alpha');
    await expect(results.last()).not.toContainText('line-three-charlie');

    // A full read over ~400 lines is capped with a paging hint.
    const longBody = Array.from({ length: 410 }, (_, i) => `row-${String(i + 1).padStart(4, '0')}`).join('\n');
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: `/characters/${characterId}/description`,
        content: longBody,
      })},read${JSON.stringify({ path: `/characters/${characterId}/description` })}`,
      { expectReply: true, userText: 'write' },
    );

    results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(2, { timeout: 15000 });
    await expect(results.last()).toContainText('row-0001');
    await expect(results.last()).toContainText('row-0400');
    await expect(results.last()).not.toContainText('row-0410');
    await expect(results.last()).toContainText('[truncated — 410 lines total; page with offset/limit');
  });

  test('run with no verb returns the verb menu', async ({ page }) => {
    const app = new App(page);
    await setupWorkbenchChat(page, app);

    await app.sendUserMessage('tool:run{}', { expectReply: true, userText: 'run' });

    const result = app.lastBubble('assistant').locator('.tool-result-block').last();
    await expect(result).toBeVisible({ timeout: 15000 });
    await expect(result).toContainText('run verbs');
    await expect(result).toContainText('- test_backend');
    await expect(result).toContainText('- test_custom_backend');
    await expect(result).toContainText('- clone_character');
    await expect(result).toContainText('- move_lorebook_entry');
  });

  test('/backends: write creates a config, read returns it, rm is refused', async ({ page }) => {
    const app = new App(page);
    await setupWorkbenchChat(page, app);

    const name = uniqueName('WB Backend');
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: '/backends/new.json',
        content: JSON.stringify({ name, backendProvider: 'openai', model: 'wb-e2e-model' }),
      })}`,
      { expectReply: true, userText: 'write' },
    );

    const createResult = app.lastBubble('assistant').locator('.tool-result-block').last();
    await expect(createResult).toContainText(`"name": "${name}"`, { timeout: 15000 });
    const createText = await createResult.innerText();
    const idMatch = createText.match(/"path": "\/backends\/([0-9a-f-]{36})\.json"/);
    expect(idMatch, 'created backend config path in tool result').toBeTruthy();
    const configId = idMatch![1];

    await app.sendUserMessage(
      `tool:read${JSON.stringify({ path: `/backends/${configId}.json` })},rm${JSON.stringify({
        path: `/backends/${configId}.json`,
      })}`,
      { expectReply: true, userText: 'read' },
    );

    const results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(2, { timeout: 15000 });
    await expect(results.first()).toContainText('"model": "wb-e2e-model"');
    // Backend configs have no delete — rm is refused with an explanation.
    await expect(results.last()).toContainText('backend configs have no delete');
  });

  test('/toolsets: read returns the toolset JSON; a write disables it', async ({ page }) => {
    const app = new App(page);
    await setupWorkbenchChat(page, app);
    // Disable target is a SECOND toolset: tools are re-collected at every
    // generation, so disabling the workbench toolset itself would end the
    // sequence before the read-back.
    const docsToolsetId = await enableBuiltinToolset(page, 'docs');
    toolsetIds.push(docsToolsetId);

    await app.sendUserMessage(
      `tool:read${JSON.stringify({ path: `/toolsets/${docsToolsetId}.json` })},write${JSON.stringify({
        path: `/toolsets/${docsToolsetId}.json`,
        content: JSON.stringify({ enabled: false }),
      })},read${JSON.stringify({ path: `/toolsets/${docsToolsetId}.json` })}`,
      { expectReply: true, userText: 'read' },
    );

    const results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(3, { timeout: 15000 });
    await expect(results.nth(0)).toContainText('"enabled": true');
    await expect(results.nth(1)).toContainText('"enabled": false');
    await expect(results.nth(2)).toContainText('"enabled": false');
  });

  test('/luatools: ls the entity dir, read + rewrite code.lua', async ({ page }) => {
    const app = new App(page);
    await setupWorkbenchChat(page, app);

    const name = uniqueName('WB Echo Tool');
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: '/luatools/new.json',
        content: JSON.stringify({ name, code: ECHO_LUA }),
      })}`,
      { expectReply: true, userText: 'write' },
    );

    const createResult = app.lastBubble('assistant').locator('.tool-result-block').last();
    await expect(createResult).toContainText('"id": "', { timeout: 15000 });
    const createText = await createResult.innerText();
    const idMatch = createText.match(/"id":\s*"([0-9a-f-]{36})"/);
    expect(idMatch, 'created template id in tool result').toBeTruthy();
    const templateId = idMatch![1];

    const modifiedLua = ECHO_LUA.replace('return "echo:"', 'return "echo2:"');
    await app.sendUserMessage(
      `tool:ls${JSON.stringify({ path: `/luatools/${templateId}/` })},read${JSON.stringify({
        path: `/luatools/${templateId}/code.lua`,
      })},write${JSON.stringify({
        path: `/luatools/${templateId}/code.lua`,
        content: modifiedLua,
      })},read${JSON.stringify({ path: `/luatools/${templateId}/code.lua` })}`,
      { expectReply: true, userText: 'ls' },
    );

    const results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(4, { timeout: 15000 });
    // Two-file entity dir.
    await expect(results.nth(0)).toContainText('meta.json');
    await expect(results.nth(0)).toContainText('code.lua');
    // Original code.
    await expect(results.nth(1)).toContainText('return "echo:"');
    // code.lua writes re-validate and save; the read-back shows the new version.
    await expect(results.nth(3)).toContainText('return "echo2:"');
  });

  test('/quickreplies: read the created reply JSON; a write updates the label', async ({ page }) => {
    const app = new App(page);
    await setupWorkbenchChat(page, app);

    const label = uniqueName('WB QR');
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: '/quickreplies/global/_/new.json',
        content: JSON.stringify({ label, script: "return 'hi'" }),
      })}`,
      { expectReply: true, userText: 'write' },
    );

    const createResult = app.lastBubble('assistant').locator('.tool-result-block').last();
    await expect(createResult).toContainText(`"label": "${label}"`, { timeout: 15000 });
    const createText = await createResult.innerText();
    const idMatch = createText.match(/"path": "\/quickreplies\/global\/_\/([^".]+)\.json"/);
    expect(idMatch, 'created quick reply path in tool result').toBeTruthy();
    const qrPath = `/quickreplies/global/_/${idMatch![1]}.json`;

    const newLabel = uniqueName('WB QR Renamed');
    await app.sendUserMessage(
      `tool:read${JSON.stringify({ path: qrPath })},write${JSON.stringify({
        path: qrPath,
        content: JSON.stringify({ label: newLabel }),
      })},read${JSON.stringify({ path: qrPath })}`,
      { expectReply: true, userText: 'read' },
    );

    const results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(3, { timeout: 15000 });
    await expect(results.nth(0)).toContainText(`"label": "${label}"`);
    await expect(results.nth(1)).toContainText(`"label": "${newLabel}"`);
    await expect(results.nth(2)).toContainText(`"label": "${newLabel}"`);
    await expect(results.nth(2)).not.toContainText(label);
  });

  test('/custom-backends: create, ls, read source + meta, test_custom_backend, rm the dir', async ({ page }) => {
    const app = new App(page);
    await setupWorkbenchChat(page, app);

    const name = uniqueName('WB Custom Backend');
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: '/custom-backends/new.json',
        content: JSON.stringify({ name, description: 'e2e pong backend', luaSource: PONG_LUA }),
      })}`,
      { expectReply: true, userText: 'write' },
    );

    const createResult = app.lastBubble('assistant').locator('.tool-result-block').last();
    await expect(createResult).toContainText(`"name": "${name}"`, { timeout: 15000 });
    const createText = await createResult.innerText();
    const idMatch = createText.match(/"path": "\/custom-backends\/([0-9a-f-]{36})\/"/);
    expect(idMatch, 'created custom backend path in tool result').toBeTruthy();
    const customId = idMatch![1];

    await app.sendUserMessage(
      `tool:ls${JSON.stringify({ path: `/custom-backends/${customId}/` })},read${JSON.stringify({
        path: `/custom-backends/${customId}/source.lua`,
      })},read${JSON.stringify({ path: `/custom-backends/${customId}/meta.json` })},run${JSON.stringify({
        verb: 'test_custom_backend',
        args: { id: customId, input: 'hi' },
      })},rm${JSON.stringify({ path: `/custom-backends/${customId}/` })}`,
      { expectReply: true, userText: 'ls' },
    );

    const results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(5, { timeout: 15000 });
    await expect(results.nth(0)).toContainText('meta.json');
    await expect(results.nth(0)).toContainText('source.lua');
    await expect(results.nth(1)).toContainText('return "pong"');
    await expect(results.nth(2)).toContainText(`"name": "${name}"`);
    // Dry-run outcome: ok with the script's text.
    await expect(results.nth(3)).toContainText('"ok":true');
    await expect(results.nth(3)).toContainText('pong');
    // rm on the entity dir deletes the script.
    await expect(results.nth(4)).toContainText(`Deleted custom backend "${customId}".`);
  });

  test('error paths: missing entity, read-only write, collection grep', async ({ page }) => {
    const app = new App(page);
    await setupWorkbenchChat(page, app);
    const characterId = await createCharacterViaWs(page, uniqueName('Err Target'));

    await app.sendUserMessage(
      `tool:read${JSON.stringify({ path: '/characters/00000000-0000-0000-0000-000000000000/meta.json' })},write${JSON.stringify({
        path: `/characters/${characterId}/modules/00000000-0000-0000-0000-000000000000.json`,
        content: '{}',
      })},grep${JSON.stringify({ path: '/characters/', pattern: 'dragon' })}`,
      { expectReply: true, userText: 'read' },
    );

    const results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(3, { timeout: 15000 });
    // Structured error string, never thrown.
    await expect(results.nth(0)).toContainText('Error: character "00000000-0000-0000-0000-000000000000" not found');
    // Risu modules are read-only in the fs.
    await expect(results.nth(1)).toContainText('is read-only');
    // Grep never crosses entity boundaries — collections are refused.
    await expect(results.nth(2)).toContainText('cannot list collections');
  });
});
