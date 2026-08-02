/**
 * One-off: install "The Sunken Crypt" (docs/design/examples/sunken-crypt/main.lua)
 * as a real character card in the live database, so the factory-ratio example
 * can be played in the UI.
 *
 * Idempotent: re-running updates the existing card's fields, regex rules, and
 * backend script in place. Run from server/:  npx tsx scripts/add-sunken-crypt.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { initDatabase } from '../src/db/index.js';
import { CharacterRepository } from '../src/repos/CharacterRepository.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, 'data-v2');
const LUA_PATH = join(ROOT, 'docs', 'design', 'examples', 'sunken-crypt', 'main.lua');
const LIB_DIR = join(ROOT, 'docs', 'design', 'examples', 'game-lib');
const LIB_MODULES = ['loop', 'collapse', 'transcript', 'sanitize', 'chrome', 'ledger', 'toolset', 'todo', 'registry', 'summarize', 'maptag'];

const CARD_NAME = 'The Sunken Crypt';

const DESCRIPTION = [
  'The Sunken Crypt is a self-running dungeon crawler, not a chat. Three floors — The Upper Halls,',
  'The Flooded Stacks, The Relic Vaults — each laid out as a graph of rooms with branches, loops,',
  'and dead ends that hide the best rewards. Somewhere in the Relic Vaults a relic glints on a',
  'plinth: take it and the run is won. The player explores with bare commands (go north, look,',
  'attack, flee, up) or the buttons under each message; anything nobody planned for is adjudicated',
  'by a dungeon master with real dice and real costs. Death is permanent — unless you swipe back.',
].join(' ');

const FIRST_MES = [
  'Cold steps, down into the dark. Above you the last gray light; below, dripping water and the',
  'slow patient silence of old stone. The Sunken Crypt.',
  '',
  '*Type what you do — look, go north, attack — or use the buttons. Descend. Survive. Take the relic.*',
  '',
  // Every message ends with buttons — including the greeting: the script
  // never runs for firstMes, so the opener's buttons are hardcoded. Either
  // one fires the first turn's floor planning.
  '<button data-post-response="/look">Look around</button> <button data-post-response="/go down">Descend</button>',
].join('\n');

const CREATOR_NOTES = [
  'Factory-ratio game card — the worked example from the docs topic `game_cards_factory`.',
  'The card-coupled backend (backend_logic/main.lua) is ENABLED: it wraps your active backend as',
  'its delegate. Planning a floor costs one delegate call; the dungeon master only wakes for',
  'unplanned actions. Companion character-scoped regex rules are preinstalled ([sys] hider,',
  'HUD panel, pack plot-log).',
].join(' ');

/** Renders the [HUD|where=..|hp=..|atk=..|gold=..] tag as a panel (display-only). */
const HUD_REPLACE_LUA = `function replace(match, captures)
  local fields = {}
  for pair in captures[1]:gmatch("[^|]+") do
    local k, v = pair:match("^(%w+)=(.+)$")
    if k then fields[k] = v end
  end
  return string.format(
    '<div class="hud"><strong>%s</strong> &mdash; HP %s &middot; ATK %s &middot; %s gold</div>',
    fields.where or "?", fields.hp or "?", fields.atk or "?", fields.gold or "?")
end`;

/**
 * Renders the [MAP|cur=..|ent=..|rooms=..|edges=..|stairs=..] tag as a small
 * graph (display-only). Layout: BFS from the entrance with compass vectors,
 * collisions nudged to the nearest free cell; drawn with positioned divs
 * (SVG is stripped by the sanitizer; div+style survives).
 */
const MAP_REPLACE_LUA = `function replace(match, captures)
  local fields = {}
  for pair in captures[1]:gmatch("[^|]+") do
    local k, v = pair:match("^(%w+)=(.+)$")
    if k then fields[k] = v end
  end
  local rooms, order, edges, seen = {}, {}, {}, {}
  for item in (fields.rooms or ""):gmatch("[^;]+") do
    local id, name = item:match("^(%w+)=(.+)$")
    if id then rooms[id] = name; order[#order + 1] = id end
  end
  table.sort(order)
  for item in (fields.edges or ""):gmatch("[^;]+") do
    local a, dir, b = item:match("^(%w+)>([%w ]+)>(%w+)$")
    if a and b then edges[#edges + 1] = { a = a, dir = dir, b = b } end
  end
  local VEC = {
    north = { 0, -1 }, south = { 0, 1 }, east = { 1, 0 }, west = { -1, 0 },
    northeast = { 1, -1 }, northwest = { -1, -1 }, southeast = { 1, 1 }, southwest = { -1, 1 },
  }
  local adj = {}
  for _, e in ipairs(edges) do
    adj[e.a] = adj[e.a] or {}; adj[e.a][#adj[e.a] + 1] = e
    adj[e.b] = adj[e.b] or {}; adj[e.b][#adj[e.b] + 1] = { a = e.b, dir = e.dir, b = e.a }
  end
  local pos, occupied = {}, {}
  local function free(x, y)
    for r = 0, 4 do
      for dx = -r, r do
        for dy = -r, r do
          if not occupied[(x + dx) .. "," .. (y + dy)] then return x + dx, y + dy end
        end
      end
    end
    return x, y + 5
  end
  local ent = rooms[fields.ent] and fields.ent or order[1]
  if ent then
    pos[ent] = { 0, 0 }; occupied["0,0"] = true
    local queue = { ent }
    while #queue > 0 do
      local cur = table.remove(queue, 1)
      local list = adj[cur] or {}
      table.sort(list, function(p, q) return p.dir < q.dir end)
      for _, e in ipairs(list) do
        if not pos[e.b] then
          local v = VEC[e.dir] or VEC.east
          local x, y = free(pos[cur][1] + v[1], pos[cur][2] + v[2])
          pos[e.b] = { x, y }; occupied[x .. "," .. y] = true
          queue[#queue + 1] = e.b
        end
      end
    end
  end
  local minx, miny = 0, 0
  for _, id in ipairs(order) do
    if not pos[id] then
      miny = miny - 1
      local x, y = free(0, miny)
      pos[id] = { x, y }; occupied[x .. "," .. y] = true
    end
  end
  local maxx, maxy = 0, 0
  minx, miny = 0, 0
  for _, p in pairs(pos) do
    if p[1] < minx then minx = p[1] end
    if p[2] < miny then miny = p[2] end
    if p[1] > maxx then maxx = p[1] end
    if p[2] > maxy then maxy = p[2] end
  end
  local CW, CH = 110, 52
  local W = (maxx - minx + 1) * CW
  local H = (maxy - miny + 1) * CH
  local function cx(id) return (pos[id][1] - minx) * CW + CW / 2 end
  local function cy(id) return (pos[id][2] - miny) * CH + CH / 2 end
  local out = { '<div class="crypt-map" style="position:relative;width:' .. W .. 'px;height:' .. H .. 'px;margin:6px 0">' }
  for _, e in ipairs(edges) do
    if pos[e.a] and pos[e.b] then
      local x1, y1, x2, y2 = cx(e.a), cy(e.a), cx(e.b), cy(e.b)
      local dx, dy = x2 - x1, y2 - y1
      local len = math.floor(math.sqrt(dx * dx + dy * dy))
      local ang = math.deg(math.atan(dy, dx))
      out[#out + 1] = '<div style="position:absolute;left:' .. x1 .. 'px;top:' .. y1
        .. 'px;width:' .. len .. 'px;height:2px;background:#5a5048;opacity:.7;transform:rotate('
        .. string.format("%.1f", ang) .. 'deg);transform-origin:0 50%"></div>'
    end
  end
  for _, id in ipairs(order) do
    local x = (pos[id][1] - minx) * CW + 5
    local y = (pos[id][2] - miny) * CH + 5
    local isCur = id == fields.cur
    local border = isCur and "2px solid #d8b24a" or "1px solid #6b6157"
    local bg = isCur and "#3a3324" or "#24211c"
    local stairs = id == fields.stairs and " &#9660;" or ""
    out[#out + 1] = '<div style="position:absolute;left:' .. x .. 'px;top:' .. y .. 'px;width:' .. (CW - 10)
      .. 'px;height:' .. (CH - 10) .. 'px;border:' .. border .. ';background:' .. bg
      .. ';border-radius:6px;font-size:11px;line-height:1.15;padding:3px 4px;box-sizing:border-box;overflow:hidden;color:#d8d2c4">'
      .. (rooms[id] or id) .. stairs .. "</div>"
  end
  out[#out + 1] = "</div>"
  return table.concat(out)
end`;

const REGEX_RULES = [
  {
    id: randomUUID(),
    name: 'Hide system acks',
    findRegex: '/\\s*\\[sys\\].*?\\[\\/sys\\]\\s*/gis',
    replaceString: '\n\n',
    disabled: false,
    userInput: false,
    aiOutput: false,
    prompt: true,
    display: true,
  },
  {
    id: randomUUID(),
    name: 'HUD panel',
    findRegex: '/\\[HUD\\|([^\\]]+)\\]/g',
    replaceString: '',
    replaceLua: HUD_REPLACE_LUA,
    disabled: false,
    userInput: false,
    aiOutput: true,
    prompt: false,
    display: true,
  },
  {
    id: randomUUID(),
    name: 'Pack plot log',
    findRegex: '/\\[pack (\\w[\\w ]*)\\][\\s\\S]*?\\[\\/pack \\1 summary="([^"]*)"\\]/g',
    replaceString: '<div class="plot-log">$2</div>',
    disabled: false,
    userInput: false,
    aiOutput: true,
    prompt: false,
    display: true,
  },
  {
    id: randomUUID(),
    name: 'Crypt map',
    findRegex: '/\\[MAP\\|([^\\]]+)\\]/g',
    replaceString: '',
    replaceLua: MAP_REPLACE_LUA,
    disabled: false,
    userInput: false,
    aiOutput: true,
    prompt: false,
    display: true,
  },
  // Fight spans (lib/summarize): the blows are visible prose the player
  // lived — only the TAGS are chrome. Hide the open; render the close's
  // gist as a plot-log line.
  {
    id: randomUUID(),
    name: 'Fight span open',
    findRegex: '/\\[fight [\\w ]+\\]/g',
    replaceString: '',
    disabled: false,
    userInput: false,
    aiOutput: true,
    prompt: false,
    display: true,
  },
  {
    id: randomUUID(),
    name: 'Fight span close',
    findRegex: '/\\[\\/fight [\\w ]+ summary="([^"]*)"\\]/g',
    replaceString: '<div class="plot-log">⚔ $1</div>',
    disabled: false,
    userInput: false,
    aiOutput: true,
    prompt: false,
    display: true,
  },
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
    tags: ['game', 'dungeon-crawler', 'factory-ratio'],
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
