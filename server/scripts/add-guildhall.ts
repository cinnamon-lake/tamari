/**
 * One-off: install "The Guildhall" (docs/design/examples/guildhall/main.lua)
 * as a real character card in the live database, so the event-engine example
 * can be played in the UI.
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
const LIB_MODULES = ['loop', 'collapse', 'transcript', 'chrome', 'ledger', 'toolset', 'registry', 'events'];

const CARD_NAME = 'The Guildhall';

const DESCRIPTION = [
  'The Guildhall is an event engine wearing a tavern. You idle in the hall with a menu — delve',
  'the dungeon, visit the store, see the blacksmith — until you do something nobody planned for.',
  'Then the hall comes alive: a dungeon master frames the scene, and whoever you went looking for',
  'is cast, written, and remembered. Characters you meet keep their own account of you — what',
  'THEY carried away from your last encounter — and bring it up next time. Type anything, or use',
  'the buttons; Leave always works.',
].join(' ');

const FIRST_MES = [
  'Firelight, pipe smoke, the low roar of a guild hall at dusk. A quest board by the far wall,',
  'a barkeep polishing the same glass, and the usual business of the place laid out before you.',
  '',
  '*Type what you do — talk to anyone, cause trouble, anything — or use the buttons.*',
  '',
  // Every message ends with buttons — including the greeting: the script
  // never runs for firstMes, so the opener's buttons are hardcoded.
  '<button data-post-response="/delve">Delve into the dungeon</button>',
  '<button data-post-response="/shop">Visit the store</button>',
  '<button data-post-response="/smith">See the blacksmith</button>',
].join(' ');

const CREATOR_NOTES = [
  'Event-engine game card — the worked example from the docs topic `game_cards_events`.',
  'The card-coupled backend (backend_logic/main.lua) is ENABLED: it wraps your active backend as',
  'its delegate. Idle menu turns are free; the DM frames events; a scene-runner writes every',
  'participant with an append-only (prefix-cache-friendly) prompt. Characters file dossiers on',
  'you. Companion character-scoped regex rules are preinstalled ([sys] hider, HUD panel, event',
  'plot-log, tag hiders).',
].join(' ');

/** Renders the [HUD|gold=..|party=..] tag as a panel (display-only). */
const HUD_REPLACE_LUA = `function replace(match, captures)
  local fields = {}
  for pair in captures[1]:gmatch("[^|]+") do
    local k, v = pair:match("^(%w+)=(.+)$")
    if k then fields[k] = v end
  end
  local party = fields.party and fields.party ~= "none" and (" &middot; party: " .. fields.party) or ""
  return string.format('<div class="hud"><strong>%s gold</strong>%s</div>', fields.gold or "?", party)
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
  // Structural markup (topic `game_cards_events`): visible to the model,
  // hidden from the player. Event opens and chat tags are chrome; the event
  // close's gist is a plot-log line.
  {
    id: randomUUID(),
    name: 'Hide event open',
    findRegex: '/\\[event [\\w ]+\\]/g',
    replaceString: '',
    disabled: false,
    userInput: false,
    aiOutput: true,
    prompt: false,
    display: true,
  },
  {
    id: randomUUID(),
    name: 'Event plot log',
    findRegex: '/\\[\\/event (\\w[\\w ]*) summary="([^"]*)"\\]/g',
    replaceString: '<div class="plot-log">$2</div>',
    disabled: false,
    userInput: false,
    aiOutput: true,
    prompt: false,
    display: true,
  },
  {
    id: randomUUID(),
    name: 'Hide chat markup',
    findRegex: '/\\[\\/?chat[^\\]]*\\]/g',
    replaceString: '',
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
    tags: ['game', 'event-engine', 'social'],
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
