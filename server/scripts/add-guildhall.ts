/**
 * One-off: install "The Guildhall" (docs/design/examples/guildhall/main.lua)
 * as a real character card in the live database — the complete game card
 * (event-engine hall + factory-ratio dungeon), so the worked example from
 * docs topic `game_cards_example` can be played in the UI.
 *
 * Idempotent: re-running updates the existing card's fields, regex rules, and
 * backend script in place. Run from server/:  npx tsx scripts/add-guildhall.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { initDatabase } from '../src/db/index.js';
import { CharacterRepository } from '../src/repos/CharacterRepository.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, 'data-v2');
const LUA_PATH = join(ROOT, 'docs', 'design', 'examples', 'guildhall', 'main.lua');
const LIB_DIR = join(ROOT, 'docs', 'design', 'examples', 'game-lib');
const LIB_MODULES = ['loop', 'sanitize', 'chrome', 'ledger', 'toolset', 'todo', 'registry', 'summarize', 'maptag', 'events', 'rolling', 'layout'];

const CARD_NAME = 'The Guildhall';

const DESCRIPTION = [
  'The Guildhall is a complete game card: a social hub (event engine) over a procedurally-designed',
  'dungeon (factory ratio). Idle in the hall with a menu — delve the dungeon, visit the store, see the',
  'blacksmith — or say anything to anyone. /delve drops you into a dungeon whose floors Lua lays out',
  'as connected room-grid sections and the model themes in one planning pass, then Lua serves for free:',
  'movement, combat, loot, and a fog-of-war map, until you do something nobody planned for (a dungeon',
  'DM with a cost economy, who may even open a conversation mid-fight). The people you meet keep',
  'dossiers — what THEY carried away — and bring it up next time. Death, the relic, or climbing back',
  'out end the delve, not the game: you return to the hall. Commands work with or without a leading /',
  '— /help lists them anytime.',
].join(' ');

// The opener is the receptionist's registration beat — flavor, then "name and
// trade?" No menu buttons: the script never runs for firstMes, and the player's
// first message should be their answer. The first generate() opens the
// registration event script-side; the hall menu appears once it closes. Keep
// byte-identical to GREETING in main.lua (the script seeds it as the span's
// prior assistant message).
const FIRST_MES = [
  'The guildhall’s reception desk is a slab of oak lost under forms. Behind it sits a woman with ink to the elbows, eating a donut — powdered sugar on her collar — who does not look up.',
  '',
  '“Donut? No? Your loss. Best in Thornwall, and I’m not telling you where I get them.” She licks a finger and slides a blank form your way. “Welcome to the Guildhall. Name and trade, newcomer — let’s get you registered.”',
  '',
  '*Tell her your name and trade.*',
].join('\n');

const CREATOR_NOTES = [
  'Complete game card — the worked example from docs topic `game_cards_example`. The card-coupled',
  'backend (backend_logic/main.lua) is ENABLED: it wraps your active backend as its delegate. Hall',
  'idle turns and dungeon serve turns are free; the hall DM frames events, a scene-runner writes every',
  'participant with an append-only (prefix-cache-friendly) prompt; the dungeon plans each floor in one',
  'sub-gen and serves it deterministically. An event can open mid-combat and resumes the fight on close.',
  'Companion character-scoped regex rules are preinstalled (HUD panel, fog-of-war map, optional hiding',
  'of slash-prefixed command messages — /help lists the verbs anytime).',
].join(' ');

/** Renders the [HUD|k=v|…] tag as a panel — hall: name/where/gold; the dungeon adds hp/atk. Key-parsed, order-agnostic. */
const HUD_REPLACE_LUA = `function replace(match, captures)
  local fields = {}
  for pair in captures[1]:gmatch("[^|]+") do
    local k, v = pair:match("^(%w+)=(.+)$")
    if k then fields[k] = v end
  end
  local parts = {}
  if fields.name then parts[#parts + 1] = "<strong>" .. fields.name .. "</strong>" end
  if fields.where then parts[#parts + 1] = fields.where end
  if fields.hp then parts[#parts + 1] = "hp " .. fields.hp end
  if fields.atk then parts[#parts + 1] = "atk " .. fields.atk end
  if fields.gold then parts[#parts + 1] = "<strong>" .. fields.gold .. " gold</strong>" end
  return '<div class="hud">' .. table.concat(parts, " &middot; ") .. "</div>"
end`;

/** Renders [MAP|cur=..|rooms=..|edges=..|stairs=..] — grid form (id=x,y,Name) as a positioned map, legacy form (id=Name) as a compact room list. You/stairs marked. */
const MAP_REPLACE_LUA = `function replace(match, captures)
  local fields = {}
  for pair in captures[1]:gmatch("[^|]+") do
    local k, v = pair:match("^(%w+)=(.*)$")
    if k then fields[k] = v end
  end

  -- Rooms: grid form id=x,y,Name; legacy form id=Name (pre-grid packs).
  local rooms, grid, ids = {}, true, {}
  for rpart in (fields.rooms or ""):gmatch("[^;]+") do
    local id, x, y, name = rpart:match("^(%w+)=(%d+),(%d+),(.*)$")
    if id then
      rooms[id] = { x = tonumber(x), y = tonumber(y), name = name }
      ids[#ids + 1] = id
    else
      local lid, lname = rpart:match("^(%w+)=(.*)$")
      if lid then
        rooms[lid] = { name = lname }
        ids[#ids + 1] = lid
        grid = false
      end
    end
  end
  local cur, stairs = fields.cur or "", fields.stairs or ""

  if not grid then
    -- Legacy: the room list (old packs without coordinates).
    local out = { '<div class="map">' }
    table.sort(ids)
    for _, id in ipairs(ids) do
      local mark = ""
      if id == cur then mark = " <strong>(you)</strong>" end
      if stairs ~= "" and id == stairs then mark = mark .. " &#9660;" end
      out[#out + 1] = '<div class="map-room">' .. rooms[id].name .. mark .. '</div>'
    end
    out[#out + 1] = '</div>'
    return table.concat(out, "")
  end

  local edges = {}
  for epart in (fields.edges or ""):gmatch("[^;]+") do
    local a, b = epart:match("^(%w+)%-(%w+)$")
    if a and b then edges[#edges + 1] = { a = a, b = b } end
  end

  local maxX, maxY = 0, 0
  for _, r in pairs(rooms) do
    if r.x > maxX then maxX = r.x end
    if r.y > maxY then maxY = r.y end
  end
  local CW, CH, GX, GY = 104, 34, 26, 14
  local PX, PY = CW + GX, CH + GY
  local W = (maxX + 1) * PX - GX
  local H = (maxY + 1) * PY - GY
  local parts = { '<div class="map" style="position:relative;width:' .. W .. 'px;min-width:' .. W .. 'px;height:' .. H .. 'px;">' }

  -- Passages first, so rooms sit on top.
  for _, e in ipairs(edges) do
    local a, b = rooms[e.a], rooms[e.b]
    if a and b then
      if a.y == b.y then
        local x0 = math.min(a.x, b.x)
        parts[#parts + 1] = '<div style="position:absolute;left:' .. (x0 * PX + CW) .. 'px;top:' .. (a.y * PY + math.floor(CH / 2) - 2) .. 'px;width:' .. GX .. 'px;height:4px;background:var(--color-border-subtle);border-radius:2px;"></div>'
      elseif a.x == b.x then
        local y0 = math.min(a.y, b.y)
        parts[#parts + 1] = '<div style="position:absolute;left:' .. (a.x * PX + math.floor(CW / 2) - 2) .. 'px;top:' .. (y0 * PY + CH) .. 'px;width:4px;height:' .. GY .. 'px;background:var(--color-border-subtle);border-radius:2px;"></div>'
      end
    end
  end

  table.sort(ids)
  for _, id in ipairs(ids) do
    local r = rooms[id]
    local label = r.name
    if stairs ~= "" and id == stairs then label = label .. " &#9660;" end
    local style = 'position:absolute;left:' .. (r.x * PX) .. 'px;top:' .. (r.y * PY) .. 'px;width:' .. CW .. 'px;height:' .. CH .. 'px;line-height:' .. CH .. 'px;text-align:center;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;box-sizing:border-box;padding:0 4px;'
    if r.name == "?" then
      style = style .. 'opacity:.5;border:1px dashed var(--color-border-subtle);border-radius:6px;'
    end
    if id == cur then
      style = style .. 'font-weight:700;border:1px solid var(--color-accent);border-radius:6px;'
    end
    parts[#parts + 1] = '<div class="map-room" style="' .. style .. '">' .. label .. '</div>'
  end
  parts[#parts + 1] = '</div>'
  return table.concat(parts, "")
end`;

interface RegexRule {
  id: string;
  name: string;
  findRegex: string;
  replaceString: string;
  replaceLua?: string;
  disabled: boolean;
  userInput: boolean;
  aiOutput: boolean;
  prompt: boolean;
  display: boolean;
}

const REGEX_RULES: RegexRule[] = [
  // Optional: hide command messages the player posted — slash-commands AND bare
  // command words, so a typed command and a button click leave the same clean transcript.
  { id: randomUUID(), name: 'Hide command messages',
    findRegex: '/^\\s*(\\/\\w.*|(delve|shop|smith|look|attack|flee|up|climb|leave|help|north|south|east|west|down|go (north|south|east|west|down)))\\s*$/si',
    replaceString: '',
    disabled: false, userInput: true, aiOutput: false, prompt: false, display: true },
  // HUD panel (hall: gold; dungeon: where/hp/atk/gold).
  { id: randomUUID(), name: 'HUD panel', findRegex: '/\\[HUD\\|([^\\]]+)\\]/g', replaceString: '', replaceLua: HUD_REPLACE_LUA,
    disabled: false, userInput: false, aiOutput: true, prompt: false, display: true },
  // Fog-of-war floor map.
  { id: randomUUID(), name: 'Floor map', findRegex: '/\\[MAP\\|([^\\]]+)\\]/g', replaceString: '', replaceLua: MAP_REPLACE_LUA,
    disabled: false, userInput: false, aiOutput: true, prompt: false, display: true },
];

/** The vendored game lib, as the card's backend_logic/lib/*.lua VFS map. */
function libFiles(): Record<string, string> {
  return Object.fromEntries(
    LIB_MODULES.map((m) => [`lib/${m}.lua`, readFileSync(join(LIB_DIR, `${m}.lua`), 'utf8')]),
  );
}

async function main(): Promise<void> {
  const luaSource = readFileSync(LUA_PATH, 'utf8');
  const db = await initDatabase({ path: join(DATA_DIR, 'tamari.db') });
  const repo = new CharacterRepository(db);

  const extensions = {
    regexScripts: REGEX_RULES,
    contextualBackend: { enabled: true, luaSource, files: libFiles() },
  };

  const fields = {
    name: CARD_NAME,
    description: DESCRIPTION,
    firstMes: FIRST_MES,
    creatorNotes: CREATOR_NOTES,
    creator: 'tamari',
    characterVersion: '1.0',
    tags: ['game', 'event-engine', 'factory-ratio'],
  };

  const existing = await repo.getByName(CARD_NAME);
  if (existing) {
    await repo.update(existing.id, { ...fields, extensions });
    console.log(`Updated existing card "${CARD_NAME}" (${existing.id})`);
  } else {
    const created = await repo.create(randomUUID(), { ...fields, extensions });
    console.log(`Created card "${CARD_NAME}" (${created.id})`);
  }

  const check = await repo.getByName(CARD_NAME);
  const rules = (check?.extensions['regexScripts'] as unknown[] | undefined) ?? [];
  const backend = check?.extensions['contextualBackend'] as
    | { enabled?: boolean; luaSource?: string; files?: Record<string, string> }
    | undefined;
  console.log(
    `Verify: ${rules.length} regex rules, backend enabled=${String(backend?.enabled)}, ` +
      `lua ${backend?.luaSource?.split('\n').length ?? 0} lines, ${Object.keys(backend?.files ?? {}).length} lib modules`,
  );
}

await main();
