import { test, expect, type Page, type Locator } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, resetBackendConfig } from '../helpers/backendConfig.js';
import { enableBuiltinToolset, deleteToolset } from '../helpers/tools.js';
import { wsDeleteByPrefix } from '../helpers/cleanup.js';
import { App } from '../helpers/app.js';

/**
 * Coverage for the character workbench verbs/paths NOT already exercised by
 * tools-character-workbench.spec.ts (which covers /characters/new, meta.json,
 * lorebook/new.json and regex/new.json):
 *
 *  - run clone_character (deep copy: lorebook entries, regex rules, sidebar)
 *  - lorebook/<entryId>.json update + read-back, run move_lorebook_entry, rm
 *  - regex/<ruleId>.json update (disabled) + read-back, run test_regex, rm
 *  - greetings/new + greetings/<n> vfs, greeting swipe arrows in a fresh chat
 *  - backend_logic.lua write/read/edit + run test_backend_logic (delegations, stateOut)
 *  - run set_avatar from a UI-uploaded attachment, assets/new.json, run copy_assets
 *
 * Verb names and result shapes verified against
 * server/src/services/workbench/CharacterWorkbench.ts and
 * server/src/services/templates/workbench/{WorkbenchTemplate,routes/characters}.ts.
 */

function uniqueName(base: string): string {
  return `${base} ${Date.now()}`;
}

/** Minimal 1x1 transparent PNG (same fixture as attachments.spec.ts). */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

/** Extract the first `"id": "<uuid>"` from a tool result block's pretty JSON. */
async function resultUuid(block: Locator): Promise<string> {
  const text = await block.innerText();
  const match = text.match(/"id": "([0-9a-f-]{36})"/);
  if (!match) throw new Error(`no uuid in tool result block: ${text.slice(0, 300)}`);
  return match[1]!;
}

test.describe('Character Workbench (verbs & vfs)', () => {
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

  // The lorebook vfs writes materialize world_info books named after their
  // character ('Clone Source …', 'Lore Edit Host …'), and every test leaves its
  // characters on the shared server. Any leftover book makes CharacterEditor
  // render its (unlabeled) `.lorebook-selector > select`, tripping the axe
  // checks in character.spec — so delete both books and characters.
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await login(page);
    await wsDeleteByPrefix(page, {
      charPrefixes: [
        'CW Host ',
        'Clone Source ',
        'Lore Edit Host ',
        'Regex Edit Host ',
        'Greeting Host ',
        'Lua Host ',
        'Avatar Target ',
        'Asset Copy Target ',
      ],
      bookPrefixes: ['Clone Source ', 'Lore Edit Host '],
    });
    await page.close();
  });

  test('clone_character deep-copies lorebook + regex and the clone shows in the sidebar', async ({ page }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'workbench');

    await app.createCharacterAndChat({
      name: uniqueName('CW Host'),
      firstMes: 'Ready.',
    });

    const sourceName = uniqueName('Clone Source');
    const sourceId = await createCharacterViaWs(page, sourceName, 'Ready.');

    // Seed the source with a lorebook entry + a regex rule, then clone — one
    // tool: sequence, one call per round.
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: `/characters/${sourceId}/lorebook/new.json`,
        content: JSON.stringify({ keys: ['clone'], content: 'Clone seed entry' }),
      })},write${JSON.stringify({
        path: `/characters/${sourceId}/regex/new.json`,
        content: JSON.stringify({ name: 'Clone rule', findRegex: '/Ready\\./g', replaceString: 'Set.' }),
      })},run${JSON.stringify({ verb: 'clone_character', args: { sourceCharacterId: sourceId } })}`,
      { expectReply: true, userText: 'write' },
    );

    const results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(3, { timeout: 20000 });
    const cloneResult = results.nth(2);
    // characterClone result: { id, name, lorebookEntries, assetsCopied, modulesCopied }.
    // `run` returns the provider's content verbatim — COMPACT JSON (no ": ").
    await expect(cloneResult).toContainText(`"name":"${sourceName} (Copy)"`);
    await expect(cloneResult).toContainText('"lorebookEntries":1');
    await expect(cloneResult).toContainText('"assetsCopied":0');

    // The character.created broadcast lands; the clone shows in the sidebar.
    await page.locator('input[placeholder="Search characters..."]').fill(`${sourceName} (Copy)`);
    await expect(page.locator('.character-list li', { hasText: `${sourceName} (Copy)` })).toBeVisible({
      timeout: 10000,
    });
  });

  test('lorebook entry update + read-back, move_lorebook_entry, then rm', async ({ page }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'workbench');

    await app.createCharacterAndChat({
      name: uniqueName('CW Host'),
      firstMes: 'Ready.',
    });

    const characterId = await createCharacterViaWs(page, uniqueName('Lore Edit Host'));

    // Two entries so the move has a visible effect on entryOrder.
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: `/characters/${characterId}/lorebook/new.json`,
        content: JSON.stringify({ keys: ['alpha'], content: 'Alpha entry' }),
      })},write${JSON.stringify({
        path: `/characters/${characterId}/lorebook/new.json`,
        content: JSON.stringify({ keys: ['beta'], content: 'Beta entry' }),
      })}`,
      { expectReply: true, userText: 'write' },
    );
    const seedResults = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(seedResults).toHaveCount(2, { timeout: 20000 });
    const entryA = await resultUuid(seedResults.first());
    const entryB = await resultUuid(seedResults.nth(1));

    // Whole-file write patches the entry; read-back proves the update landed.
    const edited = `Edited content ${Date.now()}`;
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: `/characters/${characterId}/lorebook/${entryA}.json`,
        content: JSON.stringify({ content: edited }),
      })},read${JSON.stringify({ path: `/characters/${characterId}/lorebook/${entryA}.json` })}`,
      { expectReply: true, userText: 'write' },
    );
    const updateResults = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(updateResults).toHaveCount(2, { timeout: 20000 });
    await expect(updateResults.first()).toContainText(edited);
    await expect(updateResults.last()).toContainText(edited);

    // Move A (index 0) to index 1 — entryOrder flips to [B, A].
    await app.sendUserMessage(
      `tool:run${JSON.stringify({
        verb: 'move_lorebook_entry',
        args: { characterId, entryId: entryA, index: 1 },
      })}`,
      { expectReply: true, userText: 'run' },
    );
    const moveResult = app.lastBubble('assistant').locator('.tool-result-block').last();
    // lorebookEntryMove result: { entryId, index, entryOrder } — compact JSON via `run`.
    await expect(moveResult).toContainText(`"entryId":"${entryA}"`, { timeout: 20000 });
    await expect(moveResult).toContainText('"index":1');
    const moveText = await moveResult.innerText();
    const orderMatch = moveText.match(/"entryOrder":\s*\[([\s\S]*?)\]/);
    expect(orderMatch, 'move result carries entryOrder').toBeTruthy();
    const orderText = orderMatch![1]!;
    expect(orderText.indexOf(entryB)).toBeGreaterThanOrEqual(0);
    expect(orderText.indexOf(entryB)).toBeLessThan(orderText.indexOf(entryA));

    // rm removes the entry; a read afterwards is a vfs error.
    await app.sendUserMessage(
      `tool:rm${JSON.stringify({ path: `/characters/${characterId}/lorebook/${entryA}.json` })},read${JSON.stringify({
        path: `/characters/${characterId}/lorebook/${entryA}.json`,
      })}`,
      { expectReply: true, userText: 'rm' },
    );
    const rmResults = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(rmResults).toHaveCount(2, { timeout: 20000 });
    await expect(rmResults.first()).toContainText(`"removed": "${entryA}"`);
    await expect(rmResults.last()).toContainText('no such file');
  });

  test('regex rule disable + read-back, test_regex preview, then rm', async ({ page }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'workbench');

    await app.createCharacterAndChat({
      name: uniqueName('CW Host'),
      firstMes: 'Ready.',
    });

    const characterId = await createCharacterViaWs(page, uniqueName('Regex Edit Host'), 'Ready.');

    const ruleName = uniqueName('Swap rule');
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: `/characters/${characterId}/regex/new.json`,
        content: JSON.stringify({ name: ruleName, findRegex: '/Ready\\./g', replaceString: 'Set.' }),
      })}`,
      { expectReply: true, userText: 'write' },
    );
    const addResult = app.lastBubble('assistant').locator('.tool-result-block').last();
    await expect(addResult).toContainText(ruleName, { timeout: 20000 });
    const ruleId = await resultUuid(addResult);

    // Disable the rule via a whole-file write; read-back shows the patch.
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: `/characters/${characterId}/regex/${ruleId}.json`,
        content: JSON.stringify({ disabled: true }),
      })},read${JSON.stringify({ path: `/characters/${characterId}/regex/${ruleId}.json` })}`,
      { expectReply: true, userText: 'write' },
    );
    const disableResults = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(disableResults).toHaveCount(2, { timeout: 20000 });
    await expect(disableResults.first()).toContainText('"disabled": true');
    await expect(disableResults.last()).toContainText('"disabled": true');

    // test_regex previews merged rules (global + character-scoped): the only
    // rule is disabled, so it neither counts nor transforms the sample text.
    // (regex-engine.spec.ts resets global rules to [] in its afterEach.)
    await app.sendUserMessage(
      `tool:run${JSON.stringify({ verb: 'test_regex', args: { characterId, text: 'Ready.' } })}`,
      { expectReply: true, userText: 'run' },
    );
    const testResult = app.lastBubble('assistant').locator('.tool-result-block').last();
    // regexTest result: { role, ruleCount, prompt, display } — compact JSON via `run`.
    await expect(testResult).toContainText('"ruleCount":0', { timeout: 20000 });
    await expect(testResult).toContainText('"prompt":"Ready."');
    await expect(testResult).toContainText('"display":"Ready."');

    // rm removes the rule; a read afterwards is a vfs error.
    await app.sendUserMessage(
      `tool:rm${JSON.stringify({ path: `/characters/${characterId}/regex/${ruleId}.json` })},read${JSON.stringify({
        path: `/characters/${characterId}/regex/${ruleId}.json`,
      })}`,
      { expectReply: true, userText: 'rm' },
    );
    const rmResults = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(rmResults).toHaveCount(2, { timeout: 20000 });
    await expect(rmResults.first()).toContainText(`"removed": "${ruleId}"`);
    await expect(rmResults.last()).toContainText('no such file');
  });

  test('greetings vfs: new greeting gets index 0, a fresh chat shows swipe arrows, rm removes it', async ({
    page,
  }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'workbench');

    await app.createCharacterAndChat({
      name: uniqueName('CW Host'),
      firstMes: 'Ready.',
    });

    const charName = uniqueName('Greeting Host');
    const characterId = await createCharacterViaWs(page, charName, 'Ready.');

    const alt = `Alt greeting ${Date.now()}`;
    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: `/characters/${characterId}/greetings/new`,
        content: alt,
      })},read${JSON.stringify({ path: `/characters/${characterId}/greetings/0` })}`,
      { expectReply: true, userText: 'write' },
    );
    const greetingResults = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(greetingResults).toHaveCount(2, { timeout: 20000 });
    // The created path reports the assigned index.
    await expect(greetingResults.first()).toContainText(`"path": "/characters/${characterId}/greetings/0"`);
    await expect(greetingResults.last()).toContainText(alt);

    // UI proof: a new (unmaterialized) chat renders the virtual greeting with
    // swipe arrows now that an alternate greeting exists (firstMes + 1 alt).
    await app.startChat(charName);
    await expect(page.locator('button[title="Swipe left"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button[title="Swipe right"]')).toBeVisible();
    await expect(page.locator('.swipe-counter')).toHaveText('1/2');

    // rm the alternate greeting (from the fresh chat); a read afterwards fails.
    await app.sendUserMessage(
      `tool:rm${JSON.stringify({ path: `/characters/${characterId}/greetings/0` })},read${JSON.stringify({
        path: `/characters/${characterId}/greetings/0`,
      })}`,
      { expectReply: true, userText: 'rm' },
    );
    const rmResults = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(rmResults).toHaveCount(2, { timeout: 20000 });
    await expect(rmResults.last()).toContainText('no such file');
  });

  test('backend_logic.lua write/read/edit and test_backend_logic dry-run', async ({ page }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'workbench');

    await app.createCharacterAndChat({
      name: uniqueName('CW Host'),
      firstMes: 'Ready.',
    });

    const characterId = await createCharacterViaWs(page, uniqueName('Lua Host'), 'Ready.');

    // Single-line source: the mock's tool: selector matches one line only.
    // The script bumps a state counter and delegates once per turn.
    const luaSource =
      'function generate(prompt, ctx) if type(state) ~= "table" then state = { turns = 0 } end ' +
      'state.turns = state.turns + 1 return "B:" .. backends.generate(prompt):await().text end';

    await app.sendUserMessage(
      `tool:write${JSON.stringify({
        path: `/characters/${characterId}/backend_logic.lua`,
        content: luaSource,
      })},read${JSON.stringify({ path: `/characters/${characterId}/backend_logic.lua` })}`,
      { expectReply: true, userText: 'write' },
    );
    const writeResults = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(writeResults).toHaveCount(2, { timeout: 20000 });
    // backend_logic_set result: { enabled, luaSource } — new scripts default disabled.
    await expect(writeResults.first()).toContainText('"enabled": false');
    await expect(writeResults.last()).toContainText('function generate(prompt, ctx)');

    // Surgical edit on the .lua file (delegates to backend_logic_edit, which
    // load-validates before saving).
    await app.sendUserMessage(
      `tool:edit${JSON.stringify({
        path: `/characters/${characterId}/backend_logic.lua`,
        oldString: '"B:"',
        newString: '"BB:"',
      })}`,
      { expectReply: true, userText: 'edit' },
    );
    const editResult = app.lastBubble('assistant').locator('.tool-result-block').last();
    // backend_logic_edit result: { replacements, lines, enabled } — compact JSON
    // (the edit tool returns the provider's content verbatim for .lua files).
    await expect(editResult).toContainText('"replacements":1', { timeout: 20000 });
    await expect(editResult).toContainText('"enabled":false');

    // Dry-run the edited script: delegation answered with canned text.
    await app.sendUserMessage(
      `tool:run${JSON.stringify({
        verb: 'test_backend_logic',
        args: { characterId, input: 'hi', delegateResponse: 'canned' },
      })}`,
      { expectReply: true, userText: 'run' },
    );
    const testResult = app.lastBubble('assistant').locator('.tool-result-block').last();
    // DryRunOutcome: { ok, text, usage, stateOut, delegations } — compact JSON via `run`.
    await expect(testResult).toContainText('"ok":true', { timeout: 20000 });
    await expect(testResult).toContainText('"text":"BB:canned"');
    await expect(testResult).toContainText('"response":"canned"');
    await expect(testResult).toContainText('user: hi');
    await expect(testResult).toContainText('"stateOut":"{\\"turns\\":1}"');
  });

  test('set_avatar from a UI-uploaded attachment, assets/new.json, and copy_assets', async ({ page }) => {
    const app = new App(page);
    toolsetId = await enableBuiltinToolset(page, 'workbench');

    await app.createCharacterAndChat({
      name: uniqueName('CW Host'),
      firstMes: 'Ready.',
    });

    const charAName = uniqueName('Avatar Target');
    const idA = await createCharacterViaWs(page, charAName);
    const idB = await createCharacterViaWs(page, uniqueName('Asset Copy Target'));

    // Upload an image through the message UI (attachments.spec.ts pattern):
    // the preview element's id IS the server attachment id. Removing the
    // preview is client-side only — the uploaded attachment persists.
    const fileInput = page.locator('.message-input-area .hidden-file-input');
    await fileInput.setInputFiles({
      name: 'avatar.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BASE64, 'base64'),
    });
    const preview = page.locator('.attachment-previews .attachment-preview');
    await expect(preview).toBeVisible({ timeout: 5000 });
    const attachmentId = await preview.getAttribute('id');
    expect(attachmentId, 'attachment preview carries the server attachment id').toBeTruthy();
    await preview.locator('button[aria-label="Remove attachment"]').click();
    await expect(preview).not.toBeVisible();

    const assetName = uniqueName('pic');
    await app.sendUserMessage(
      `tool:run${JSON.stringify({
        verb: 'set_avatar',
        args: { characterId: idA, attachmentId },
      })},write${JSON.stringify({
        path: `/characters/${idA}/assets/new.json`,
        content: JSON.stringify({ attachmentId, name: assetName }),
      })},run${JSON.stringify({
        verb: 'copy_assets',
        args: { characterId: idB, sourceCharacterId: idA },
      })}`,
      { expectReply: true, userText: 'run' },
    );

    const results = app.lastBubble('assistant').locator('.tool-result-block');
    await expect(results).toHaveCount(3, { timeout: 20000 });
    // set_avatar result: { id, avatarUrl, thumbnailUrl } — compact JSON via `run`;
    // storage paths carry the files/ prefix.
    await expect(results.nth(0)).toContainText(`"id":"${idA}"`);
    await expect(results.nth(0)).toContainText('"avatarUrl":"/files/avatars/');
    // character_asset_add result + created path (pretty JSON via the write route).
    await expect(results.nth(1)).toContainText(`"name": "${assetName}"`);
    await expect(results.nth(1)).toContainText(`"assetUrl": "/api/characters/${idA}/assets/`);
    await expect(results.nth(1)).toContainText(`"path": "/characters/${idA}/assets/`);
    // character_assets_copy result: { copied, skipped, assets } — compact JSON via `run`.
    await expect(results.nth(2)).toContainText('"copied":1');
    await expect(results.nth(2)).toContainText('"skipped":0');

    // UI proof: the character.listed broadcast refreshed the sidebar avatar.
    await page.locator('input[placeholder="Search characters..."]').fill(charAName);
    const row = page.locator('.character-list li', { hasText: charAName });
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row.locator('img.character-avatar')).toHaveAttribute('src', /\/files\/avatars\//, {
      timeout: 10000,
    });
  });
});
