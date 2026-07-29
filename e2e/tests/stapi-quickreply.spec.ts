/**
 * StApi quick-reply coverage: query / utility / round-trip methods.
 *
 * Each test creates one or two Lua quick replies, clicks them in the quick
 * reply bar, and asserts the narrator bubble the script appends. Lua scripts
 * run a `check(name, cond)` helper that records `name=OK` / `name=FAIL`
 * tokens and finishes with a literal `ALLDONE` end token, so a single
 * narrator bubble proves the whole batch (see helpers/quickReplies.ts).
 *
 * Covers StApi methods not exercised by stapi-integration.spec.ts /
 * stapi-generation.spec.ts: pure utilities, message/chat queries,
 * character/persona queries, settings/backend round-trips (including real
 * sampler wiring into the mock LLM request), variables/meta state, world
 * info, reasoning/generation info, message extras, and error paths.
 */
import { test, expect } from '../fixtures/base.js';
import { login } from '../helpers/auth.js';
import { configureMockBackend, patchActiveBackendConfig, resetBackendConfig } from '../helpers/backendConfig.js';
import { deleteNonDefaultPersonas } from '../helpers/personas.js';
import { App } from '../helpers/app.js';
import { getLastLlmRequest, waitForNextLlmRequest } from '../helpers/llm.js';
import {
  uniqueName,
  createLuaQuickReply,
  clickQuickReply,
  expectNarratorChecks,
} from '../helpers/quickReplies.js';

/** Shared Lua prelude: results accumulator + labeled check recorder. */
const LUA_PREAMBLE = `
local out = {}
local function check(name, cond)
  out[#out + 1] = name .. (cond and '=OK' or '=FAIL')
end
-- wasmoon marshals JS null as a js_null userdata (Lua global 'null'), not
-- nil — StApi query methods return null for misses, so test for both.
local function isnull(v)
  return v == nil or v == null
end
`;

/** Shared Lua epilogue: end token + narrator output. */
const LUA_NARRATE = `
out[#out + 1] = 'ALLDONE'
st.send_narrator(table.concat(out, ' ')):await()
`;

test.describe.configure({ mode: 'serial' });

test.describe('StApi quick-reply coverage', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await configureMockBackend(page);
    // The Backend Config modal's saveConfig ALWAYS writes maxTokens (default
    // 300 when unset — BackendConfigModal.tsx loadConfigData), so any earlier
    // spec that dirtied the modal leaves maxTokens: 300 on the active config.
    // GenerationService prefers backendConfig.maxTokens over the
    // maxResponseTokens setting that st.set_maxTokens drives — clear it so the
    // sampler-setters test observes the values its own quick reply set.
    await patchActiveBackendConfig(page, { maxTokens: null });
  });

  test.afterEach(async ({ page }) => {
    await resetBackendConfig(page);
    // 'character and persona queries' creates a persona via the UI; personas
    // are global and chat.create auto-binds the first one to new chats, so a
    // leftover would hijack {{user}} resolution in later specs.
    await deleteNonDefaultPersonas(page);
  });

  test('pure utilities', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('QR Utils Char');
    const label = uniqueName('QR Utils');

    await createLuaQuickReply(
      page,
      label,
      `${LUA_PREAMBLE}
check('token_count', st.token_count('hello world') > 0)
check('count_tokens', st.count_tokens('hello world') > 0)
local longText = 'one two three four five six seven eight'
check('trim_tokens', st.len(st.trim_tokens(longText, 3)) < st.len(longText))
check('replace', st.replace('aaa', 'a', 'b') == 'bbb')
check('replace_regex', st.replace_regex('a1b2', '[0-9]', '#') == 'a#b#')
check('match', st.join(st.match('a1b2', '[a-z][0-9]'), ',') == 'a1,b2')
check('test', st.test('abc', '^a') and not st.test('abc', '^b'))
check('substring', st.substring('abcdef', 1, 3) == 'bc')
check('trim_start', st.trim_start('hello.world rest') == 'hello.')
check('trim_end', st.trim_end('hello.world rest') == 'world rest')
local r = st.random(3, 9)
check('random', r >= 3 and r <= 9 and st.random(5, 5) == 5)
check('now', st.now() > 1700000000)
check('upper', st.upper('aBc') == 'ABC')
check('lower', st.lower('aBc') == 'abc')
check('is_empty', st.is_empty('') and st.is_empty('   ') and not st.is_empty('x'))
check('len', st.len('abcd') == 4 and st.len(st.split('a,b,c', ',')) == 3)
check('join', st.join(st.split('a,b,c', ','), '-') == 'a-b-c')
check('split', st.join(st.split('x|y|z', '|'), ',') == 'x,y,z')
check('includes', st.includes('hello world', 'o w') and not st.includes('abc', 'z'))
check('starts_with', st.starts_with('hello', 'he') and not st.starts_with('hello', 'lo'))
check('ends_with', st.ends_with('hello', 'lo') and not st.ends_with('hello', 'he'))
check('json_encode', st.json_encode({ n = 5 }) == '{"n":5}')
check('json_decode', st.json_decode('{"b":"x","a":1}').b == 'x')
check('abs', st.abs(-3) == 3)
check('floor', st.floor(2.7) == 2)
check('ceil', st.ceil(2.1) == 3)
check('round', st.round(2.5) == 3)
check('clamp', st.clamp(15, 1, 10) == 10 and st.clamp(-5, 1, 10) == 1)
check('array_wrap', st.len(st.array_wrap(7)) == 1)
check('array_unwrap', st.array_unwrap(st.array_wrap('z')) == 'z')
check('pass', st.pass('q') == 'q' and st.pass(42) == 42)
local sub = st.substitute_macros('{{user}}/{{char}}'):await()
check('substitute_macros', sub:sub(-#'${charName}') == '${charName}')
${LUA_NARRATE}`,
    );
    await app.createCharacterAndChat({ name: charName, firstMes: `Hello! I am ${charName}.` });

    await clickQuickReply(page, label);
    const bubble = await expectNarratorChecks(page);
    await expect(bubble).toContainText('token_count=OK');
    await expect(bubble).toContainText('substitute_macros=OK');
  });

  test('message and chat queries', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('QR Msgs Char');
    const label = uniqueName('QR Msgs');
    const marker = `MARKER${Date.now()}`;

    await createLuaQuickReply(
      page,
      label,
      `${LUA_PREAMBLE}
local msgs = st.get_messages(100):await()
check('get_messages', #msgs >= 3)
local tip = msgs[#msgs]
check('branch_tip_has_marker', tip ~= nil and st.includes(tip.content, '${marker}'))
-- NOTE: st.get_last_message reads getActiveBranch({limit=1})[0], which is the
-- TRUNK HEAD (parent of the active swipe), not the branch tip — so after a
-- user+assistant turn it returns the user message.
local last = st.get_last_message():await()
check('get_last_message', last ~= nil and last.id == msgs[#msgs - 1].id)
local at0 = st.get_message_at(0):await()
check('get_message_at', at0 ~= nil and at0.id == msgs[1].id and at0.role == 'assistant')
local atNeg = st.get_message_at(-1):await()
check('get_message_at_negative', atNeg ~= nil and atNeg.id == tip.id)
local idx = st.get_message_index(tip.id):await()
check('get_message_index', idx == #msgs - 1)
local byid = st.get_message_by_id(tip.id):await()
check('get_message_by_id', byid ~= nil and byid.id == tip.id)
-- NOTE: st.get_message_count walks from head_message_id only — it counts the
-- trunk and excludes the active swipe tip.
local cnt = st.get_message_count():await()
check('get_message_count', cnt == #msgs - 1)
local head = st.get_head():await()
check('get_head', head ~= nil and last ~= nil and head.id == last.id)
local chain = st.get_message_chain(tip.id):await()
check('get_message_chain', #chain == #msgs and chain[#chain].id == tip.id)
local found = st.find_message_by_content('${marker}'):await()
check('find_message_by_content', found ~= nil)
local users = st.find_messages_by_role('user'):await()
check('find_messages_by_role', #users >= 1)
local asText = st.messages_as_text('|'):await()
check('messages_as_text', st.includes(asText, 'assistant: ${marker}'))
local texts = st.get_message_texts():await()
check('get_message_texts', #texts == #msgs and st.includes(texts[#texts], '${marker}'))
local chat = st.get_chat():await()
check('get_chat', chat ~= nil and chat.name ~= nil)
local chatName = st.get_chat_name():await()
check('get_chat_name', chatName ~= nil and chatName == chat.name)
local chats = st.get_chats():await()
check('get_chats', #chats >= 1)
local charId = st.get_character_id():await()
check('get_character_id', charId ~= nil and charId == chat.characterId)
local charName = st.get_character_name():await()
check('get_character_name', charName == '${charName}')
local personaId = st.get_persona_id():await()
check('get_persona_id', personaId == nil or type(personaId) == 'string')
${LUA_NARRATE}`,
    );
    await app.createCharacterAndChat({ name: charName, firstMes: `Hello! I am ${charName}.` });
    await app.sendUserMessage(`respond: ${marker}`, { expectReply: true });

    await clickQuickReply(page, label);
    const bubble = await expectNarratorChecks(page);
    await expect(bubble).toContainText('get_messages=OK');
    await expect(bubble).toContainText('get_message_chain=OK');
  });

  test('character and persona queries', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('QR Chars Char');
    const personaName = uniqueName('QR Persona');
    const label = uniqueName('QR Chars');

    // Create a persona through the Personas UI (pattern from personas.spec.ts).
    await page.locator('button.settings-btn:has-text("Personas")').click();
    const manager = page.locator('.persona-modal');
    await expect(manager).toBeVisible();
    await manager.locator('button:has-text("New Persona")').click();
    await expect(manager.locator('.persona-editor')).toBeVisible();
    await manager.locator('.persona-editor .text-input').first().fill(personaName);
    await manager.locator('.persona-editor .textarea-input').first().fill('E2E persona description.');
    await expect(manager.locator('.save-indicator')).toContainText('Saved', { timeout: 3000 });
    await manager.locator('button.back-btn:has-text("Back")').click();
    await expect(manager.locator('.persona-list')).toContainText(personaName);
    await page.locator('.modal-overlay:has(.persona-modal)').click({ position: { x: 0, y: 0 } });
    await expect(manager).not.toBeVisible();

    await createLuaQuickReply(
      page,
      label,
      `${LUA_PREAMBLE}
local chars = st.get_characters():await()
local hasChar = false
for _, c in ipairs(chars) do
  if c.name == '${charName}' then hasChar = true end
end
check('get_characters', hasChar)
local hit = st.find_character('${charName}'):await()
check('find_character_hit', hit ~= nil and hit.name == '${charName}')
local miss = st.find_character('No Such Character ${Date.now()}'):await()
check('find_character_miss', isnull(miss))
local full = st.get_character(hit.id):await()
check('get_character', full ~= nil and st.includes(full.firstMes, 'Hello'))
local personas = st.get_personas():await()
local target = nil
for _, p in ipairs(personas) do
  if p.name == '${personaName}' then target = p end
end
check('get_personas', target ~= nil)
if target ~= nil then
  local p = st.get_persona(target.id):await()
  check('get_persona', p ~= nil and p.name == '${personaName}' and st.includes(p.description, 'E2E'))
  st.set_persona(target.id):await()
  check('set_persona', st.get_persona_id():await() == target.id)
else
  check('get_persona', false)
  check('set_persona', false)
end
${LUA_NARRATE}`,
    );
    await app.createCharacterAndChat({ name: charName, firstMes: `Hello! I am ${charName}.` });

    await clickQuickReply(page, label);
    const bubble = await expectNarratorChecks(page);
    await expect(bubble).toContainText('find_character_miss=OK');
    await expect(bubble).toContainText('set_persona=OK');
  });

  test('settings and backend round-trips', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('QR Settings Char');
    const label = uniqueName('QR Settings');

    await createLuaQuickReply(
      page,
      label,
      `${LUA_PREAMBLE}
st.set_setting('e2e.qr.key', 'qr-value'):await()
check('set_setting', st.get_setting('e2e.qr.key'):await() == 'qr-value')
local all = st.get_settings():await()
check('get_settings', all['e2e.qr.key'] == 'qr-value')
local cfgs = st.get_backend_configs():await()
check('get_backend_configs', #cfgs >= 1)
local activeId = st.get_setting('activeBackendConfigId'):await()
local cfg = st.get_backend_config(activeId):await()
check('get_backend_config', cfg ~= nil and cfg.model == 'mock-model'
  and cfg.backendProvider == 'openai' and st.includes(cfg.apiUrl, 'http'))
check('get_model', st.get_model():await() == 'mock-model')
local origModel = st.get_setting('model'):await()
st.set_model('e2e-qr-model'):await()
check('set_model', st.get_setting('model'):await() == 'e2e-qr-model')
st.set_model(origModel ~= nil and origModel or 'mock-model'):await()
local origUrl = st.get_apiUrl():await()
st.set_apiUrl('http://e2e.example/v1'):await()
check('set_apiUrl', st.get_apiUrl():await() == 'http://e2e.example/v1')
st.set_apiUrl(origUrl):await()
local origBackend = st.get_backend():await()
st.set_backend('e2e-backend'):await()
check('set_backend', st.get_backend():await() == 'e2e-backend')
st.set_backend(origBackend):await()
local origCtx = st.get_contextLength():await()
st.set_contextLength(2048):await()
check('set_contextLength', st.get_contextLength():await() == 2048)
st.set_contextLength(origCtx):await()
local charId = st.get_character_id():await()
st.set_system_prompt(charId, 'E2E system prompt xyz'):await()
check('system_prompt', st.get_system_prompt(charId):await() == 'E2E system prompt xyz')
${LUA_NARRATE}`,
    );
    await app.createCharacterAndChat({ name: charName, firstMes: `Hello! I am ${charName}.` });

    await clickQuickReply(page, label);
    const bubble = await expectNarratorChecks(page);
    await expect(bubble).toContainText('get_backend_config=OK');
    await expect(bubble).toContainText('system_prompt=OK');
  });

  test('sampler setters reach the outgoing LLM request', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('QR Sampler Char');
    const setLabel = uniqueName('QR Sampler Set');
    const restoreLabel = uniqueName('QR Sampler Restore');

    await createLuaQuickReply(
      page,
      setLabel,
      `st.setvar('origTemp', st.get_temperature():await()):await()
st.setvar('origMax', st.get_maxTokens():await()):await()
st.set_temperature(0.5):await()
st.set_maxTokens(123):await()
st.toast('samplers-set-e2e')`,
    );
    await createLuaQuickReply(
      page,
      restoreLabel,
      `local t = st.getvar('origTemp'):await()
if t ~= nil then st.set_temperature(t):await() end
local m = st.getvar('origMax'):await()
if m ~= nil then st.set_maxTokens(m):await() end
st.toast('samplers-restored-e2e')`,
    );
    await app.createCharacterAndChat({ name: charName, firstMes: `Hello! I am ${charName}.` });

    await clickQuickReply(page, setLabel);
    await expect(page.locator('.toast-container')).toContainText('samplers-set-e2e', {
      timeout: 5000,
    });

    const before = (await getLastLlmRequest()).count;
    await app.sendUserMessage('respond: TEMP_PROBE', { expectReply: true });
    const captured = await waitForNextLlmRequest(before);
    const body = captured.body as Record<string, unknown>;
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(123);

    await clickQuickReply(page, restoreLabel);
    await expect(page.locator('.toast-container')).toContainText('samplers-restored-e2e', {
      timeout: 5000,
    });
  });

  test('variables and meta state', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('QR Vars Char');
    const label = uniqueName('QR Vars');

    await createLuaQuickReply(
      page,
      label,
      `${LUA_PREAMBLE}
st.setvar('k1', 'v1'):await()
st.setvar('k2', 42):await()
check('getvar', st.getvar('k1'):await() == 'v1')
local vars = st.get_variables():await()
local varCount = 0
for k in pairs(vars) do varCount = varCount + 1 end
check('get_variables', varCount >= 2 and vars.k1 == 'v1' and vars.k2 == 42)
st.clear_variables():await()
local after = st.get_variables():await()
local afterCount = 0
for k in pairs(after) do afterCount = afterCount + 1 end
check('clear_variables', afterCount == 0)
st.set_state('e2e.qr.ns', { a = 1 }):await()
local s = st.get_state('e2e.qr.ns'):await()
check('state_roundtrip', s ~= nil and s.a == 1)
st.set_global_state('e2e.qr.gns', { b = 'x' }):await()
local g = st.get_global_state('e2e.qr.gns'):await()
check('global_state_roundtrip', g ~= nil and g.b == 'x')
st.delete_state('e2e.qr.ns'):await()
check('delete_state', isnull(st.get_state('e2e.qr.ns'):await()))
check('global_state_survives', st.get_global_state('e2e.qr.gns'):await() ~= nil)
${LUA_NARRATE}`,
    );
    await app.createCharacterAndChat({ name: charName, firstMes: `Hello! I am ${charName}.` });

    await clickQuickReply(page, label);
    const bubble = await expectNarratorChecks(page);
    await expect(bubble).toContainText('clear_variables=OK');
    await expect(bubble).toContainText('delete_state=OK');
  });

  test('world info on a linked lorebook', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('QR WI Char');
    const bookName = uniqueName('QR WI Book');
    const label = uniqueName('QR WI');

    const bookLabel = await app.createLorebook(bookName, 'greeting', 'WI_SETUP_TOKEN');
    await createLuaQuickReply(
      page,
      label,
      `${LUA_PREAMBLE}
local id = st.wi_add('dragon', 'Dragons are real'):await()
check('wi_add', id ~= nil)
local e = st.wi_get('dragon'):await()
check('wi_get', e ~= nil and e.content == 'Dragons are real')
local list = st.wi_list():await()
check('wi_list', #list >= 2)
check('wi_remove', st.wi_remove('dragon'):await() == true)
check('wi_gone', isnull(st.wi_get('dragon'):await()))
${LUA_NARRATE}`,
    );
    await app.createCharacterAndChat({
      name: charName,
      firstMes: `Hello! I am ${charName}.`,
      lorebookBookLabel: bookLabel,
    });

    await clickQuickReply(page, label);
    const bubble = await expectNarratorChecks(page);
    await expect(bubble).toContainText('wi_add=OK');
    await expect(bubble).toContainText('wi_gone=OK');
  });

  test('reasoning and generation info', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('QR Reasoning Char');
    const label = uniqueName('QR Reasoning');

    await createLuaQuickReply(
      page,
      label,
      `${LUA_PREAMBLE}
-- NOTE: st.get_last_message returns the trunk head (the user message) here,
-- not the active swipe tip — take the tip off the full branch instead.
local msgs = st.get_messages(10):await()
local last = msgs[#msgs]
check('last_is_answer', last ~= nil and st.includes(last.content, 'final answer'))
local hasReasoningPart = false
if last ~= nil and last.extra ~= nil and last.extra.parts ~= nil then
  for _, p in ipairs(last.extra.parts) do
    if p.type == 'reasoning' and st.len(p.text) > 0 then hasReasoningPart = true end
  end
end
check('reasoning_part_streamed', hasReasoningPart)
st.set_reasoning(last.id, 'E2E reasoning override'):await()
check('set_reasoning', st.get_reasoning(last.id):await() == 'E2E reasoning override')
st.clear_reasoning(last.id):await()
check('clear_reasoning', isnull(st.get_reasoning(last.id):await()))
local info = st.get_generation_info(last.id):await()
check('get_generation_info', info ~= nil and info.model == 'mock-model')
${LUA_NARRATE}`,
    );
    await app.createCharacterAndChat({ name: charName, firstMes: `Hello! I am ${charName}.` });
    await app.sendUserMessage('think: please reason', { expectReply: true });

    await clickQuickReply(page, label);
    const bubble = await expectNarratorChecks(page);
    await expect(bubble).toContainText('reasoning_part_streamed=OK');
    await expect(bubble).toContainText('get_generation_info=OK');
  });

  test('message extras round-trip', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('QR Extra Char');
    const label = uniqueName('QR Extra');
    const marker = `EXTRA${Date.now()}`;

    await createLuaQuickReply(
      page,
      label,
      `${LUA_PREAMBLE}
-- Branch tip (assistant reply), not st.get_last_message (trunk head quirk).
local msgs = st.get_messages(10):await()
local last = msgs[#msgs]
check('have_message', last ~= nil and last.content == '${marker}')
st.set_message_extra(last.id, 'e2eKey', 'e2eVal'):await()
check('set_message_extra', st.get_message_extra(last.id, 'e2eKey'):await() == 'e2eVal')
check('get_message_extra_missing', isnull(st.get_message_extra(last.id, 'noSuchKey'):await()))
${LUA_NARRATE}`,
    );
    await app.createCharacterAndChat({ name: charName, firstMes: `Hello! I am ${charName}.` });
    await app.sendUserMessage(`respond: ${marker}`, { expectReply: true });

    await clickQuickReply(page, label);
    const bubble = await expectNarratorChecks(page);
    await expect(bubble).toContainText('set_message_extra=OK');
  });

  test('error paths surface as error toasts', async ({ page }) => {
    const app = new App(page);
    const charName = uniqueName('QR Errors Char');
    const stateLabel = uniqueName('QR Err State');
    const wiLabel = uniqueName('QR Err WI');

    // set_state with an empty namespace must fail namespace validation.
    await createLuaQuickReply(page, stateLabel, `st.set_state('', {}):await()`);
    // wi_add without a lorebook linked to the chat character must fail.
    await createLuaQuickReply(page, wiLabel, `st.wi_add('dragon', 'x'):await()`);
    await app.createCharacterAndChat({ name: charName, firstMes: `Hello! I am ${charName}.` });

    await clickQuickReply(page, stateLabel);
    await expect(page.locator('.toast-container')).toContainText('namespace', { timeout: 5000 });

    await clickQuickReply(page, wiLabel);
    await expect(page.locator('.toast-container')).toContainText('no lorebook linked', {
      timeout: 5000,
    });
  });
});
