/** Reference doc for the `game_cards_example` topic, served by the Docs tool. */
export const GAME_CARDS_EXAMPLE_DOC = `# The Guildhall (worked example: content factory + event engine)

A complete, TESTED game card: \`backend_logic/main.lua\` plus its vendored game lib (\`backend_logic/lib/*.lua\`) — a social hub run by the event engine over a procedurally-designed dungeon run by the content factory. Idle in the hall (delve / store / blacksmith, or free text); \`/delve\` drops you into a dungeon whose floors Lua lays out as connected room-grid sections (\`lib/layout\` — topology is Lua's, correct by construction) and ONE planning sub-gen themes (sections, rooms, roster, interactables) before Lua serves it for free (movement, combat, loot, a fog-of-war grid map) until you do something unscripted. Commands work with or without a leading \`/\`; \`/help\` lists them from any mode. Theory lives in topic \`game_cards\` (The content factory; The event engine; The game lib); this topic is the steal-able file. (Repo copy \`docs/design/examples/guildhall/main.lua\` + \`docs/design/examples/game-lib/*.lua\`, validated end-to-end through the real adapter by \`server/src/backends/guildhall.example.test.ts\`; install as a playable card with \`server/scripts/add-guildhall.ts\`.) Decisions worth noticing:

- **One card, two boundary positions, ONE events engine.** \`state.mode = hall | dungeon\`. The events engine sits ABOVE both: \`ev.isOpen()\` is checked before the mode turn, so an event opened mid-combat or mid-explore PAUSES that mode and RESUMES it on close — combat state (\`state.dun.combat\`) persists across a scene. The hall delegates every turn it can't serve (conversation can't be commissioned ahead of the input it answers); the dungeon commissions at floor granularity (one planning sub-gen per floor, then free serve turns).
- **The DM is reachable from ANY mode.** Free text always escalates — in the hall to the hall DM, in the dungeon to the dungeon DM. The combat gate is RELAXED: while a monster lives, deterministic movement/look/interact verbs are refused ("the monster is between you and everything else"), but unrecognized input falls through to the dungeon DM (\`serve\` returns nil), which may \`open_event\` even mid-fight. Both roles run the FULL toolset (one toolset, two views — a second \`open_event\` mid-scene or a DM-side \`close_event\` fails as an ordinary error result); casting remains the scene-runner's job by convention, not by schema. Both DMs carry an ENGINE-BACKED economy — \`buy_item\` (hall), \`grant\`/\`remove_item\`/\`add_exit\`/\`spawn_enemy\`/\`end_combat\` (dungeon) — and are told never to narrate gold or items the engine didn't move; the tool result is canonical. \`attempt\` returns only \`outcome\` + \`player_died\` — no roll/total/difficulty for the DM to quote or build crit rules around. A bare compass word into a wall ("go east" with no east exit) is a deterministic refusal, never a paid DM turn.
- **Five registries, two storage shapes.** Characters (\`state.characters\`, unpartitioned, \`mutable = { "personality" }\`, injected into \`events.new\`; per-character dossiers via \`lib/events\`). Dungeon content is PARTITIONED by floor (\`partition_by = "floor"\` — the string form, so model-facing lookups ask for the floor by name) — floors, rooms, enemies, interactables share one pack blob per floor. Enemies file through the registry's own mutation tool during planning; rooms/floors/interactables file card-side from the finished draft. The floor's TOPOLOGY is never the model's: \`lib/layout\` grows the grid (planar, connected, sectioned, stairs placed — all by construction, so there is no validate-and-repair pass), and the planner's toolset speaks to a fixed skeleton — \`theme_section\` names a lettered section, \`furnish_rooms\` fills name/desc for rooms that already exist (unknown ids reject with the valid list), \`finish_floor\` carries the intro. The delve reply IS that intro, never the planner's free text — serving the raw final text leaked the whole design (roster, rewards, hidden rooms) past the fog-of-war map.
- **Trust the model: no \`[sys]\` tag.** Acks are plain visible text — the model sees what the player sees. Don't reach for a hide channel; it just rewrangles the delegate's prompt for no gain.
- **Death, the relic, or climbing out end the DELVE, not the game.** Death and the relic set \`state.dun.delveOver = "dead" | "won"\`; the next turn returns you to the hall (hp reset, room to f1; packs and the relic flag persist). \`up\`/\`climb\` on the TOP floor ends the delve by CHOICE, immediately (no delveOver — a "I head back" that escalated would narrate the hall while state stayed in the dungeon); on deeper floors it lands on the upper floor's stairs, the way you came. The card never terminally ends.
- **Pack blobs in the store, pointers in \`state.packIds\` — and the card never touches a blob.** Writes queue mutation records in \`state\`; \`registry.flush()\` at the end of \`generate()\` applies them (one new put per touched floor) and moves the pointers — a swiped branch keeps its version. The boundary gen is INVISIBLE to the player: no "Designed The Upper Halls" memoir — the /delve reply is just the entrance narration. \`state.dun.*\` is the dungeon's namespaced home — every former unprefixed crypt key lives there, so it can't collide with the hall or the events engine.
- **The event's span IS the scene-runner's prompt — and the test proves the prefix property.** Node zero of the span is the system briefing (instructions + the DM's context via \`ev.eventLine()\`, plus \`rolling.briefing(state.story)\` at open time); then one node per turn in a persistent array in the store (\`state.event.spanId\`), FULL-FIDELITY — user inputs, assistant replies, AND the tool_use/tool_result rounds, so the model never re-issues a read. Each scene turn rebuilds the prompt by reading the span and appending: turn N is a strict prefix of turn N+1 by construction (no log parsing, no history-budget dependence), so the delegate's prefix cache covers the whole scene — and a briefing that must change mid-scene just rides the next node (slower, never wrong). The scene-runner's toolset includes \`inspect_summary\`, so it can zoom into the public record instead of guessing.
- **Dossiers: memory keyed by WHO was there.** \`close_event\` files one take per participant in \`state.dossiers\`; \`get_character\` serves the file + dossier as a read-tool result. Dossiers are \`lib/rolling\` channels: recent takes verbatim, oldest folded into digest entries on read (a never-read character costs no token; a delegate error fails the turn — ids move only once the fold lands, so a swipe retries). An EMPTY dossier means never-met — and the scene-runner prompt says so outright, because a gap in the record loses to a strong prior: models fill silence with assumption, and canon-heavy casts come with the loudest assumptions.
- **The STORY is a rolling channel, and every delegate can zoom into it.** Fight gists land in \`state.story\` (a \`lib/rolling\` channel — world facts like the registered player ride its kv half via \`rolling.set\`) with the fight's mechanical span as their content; both DM briefings AND the span's node-zero briefing carry the \`STORY SO FAR\` lines, and every delegate toolset exposes \`inspect_summary\` — the model tool-calls its way from a digest line down to the actual blows.
- **Onboarding is a script-opened event, and the greeting has NO buttons on purpose.** The first turn opens a registration event in \`ensureState\` (no delegate needed); the scene-runner runs the receptionist, and \`register_player\` files the name, rolls stats, and CLOSES the event itself (its result tells the model the event is closed — do NOT call \`close_event\`; re-closing gets a terminal "already closed" success, not a brick). Registration is defined by a filed name, not by the close: an event that closed without \`register_player\` RE-OPENS next turn. The post-registration close appends a "(Type help anytime…)" hint — the moment the commands start to matter. While it runs, \`buttonsHtml\` returns "" — the menu can't serve anything before registration, so the greeting offers nothing to click (the receptionist asked a question; type, don't click). It is the ONLY script-opened event: with no history to contradict, a static context is safe — every other scene is DM-framed so its context carries the live situation.
- **The card fields are minimal on purpose.** \`description\`/\`creatorNotes\` for the library, \`firstMes\` as the greeting — and personality/scenario/mesExample EMPTY, no lorebook. The script composes every delegate prompt by hand, so engine prompt-assembly fields never reach a delegate; the registries are the lore.
- **\`continue\`/\`impersonate\` throw early; a hard failure BRICKS the branch.** The generation-type guard fires before \`ensureState\` — only \`send\` and \`regenerate\` run, and regenerate IS the send path. Delegate errors are caught (\`pcall\` around the turn body): the card marks \`state.bricked\` and returns the error as the reply — a raw throw would roll the flag back with the rest of state. Further turns on the branch refuse; recovery is a swipe or rewind.

Companion character-scoped regex rules (installed by the script): optional hide for command messages (\`/^\\s*(\\/\\w.*|(delve|shop|smith|look|…|go …))\\s*$/si\`, userInput — slash-commands AND bare command words, so a typed command and a button click leave the same clean transcript), a HUD panel for \`[HUD|name=..|where=..|gold=..]\` (hall) / \`[HUD|name=..|where=..|hp=..|atk=..|gold=..]\` (dungeon — the renderer parses by key, order-agnostic), a \`[MAP|..]\` renderer that draws the grid form (\`id=x,y,Name\` rooms, \`a-b\` passages) as a positioned map and falls back to a room list for pre-grid packs. That's all — memoir lines and event closes are plain prose; there are no structural tags to hide.

The lib modules this card vendors (\`loop\`, \`sanitize\`, \`chrome\`, \`ledger\`, \`toolset\`, \`todo\`, \`registry\`, \`summarize\`, \`maptag\`, \`events\`, \`rolling\`, \`layout\`) are documented in topic \`game_cards\` (The game lib); full sources below.

\`\`\`lua
-- The Guildhall — a COMPLETE game card: a social hub (event engine) over a
-- procedurally-designed dungeon (content factory). Idle in the hall with a menu
-- (delve / store / blacksmith) or free text; the hall DM adjudicates and
-- FRAMES events, the scene-runner casts and writes scenes, and the
-- people you meet keep DOSSIERS — what THEY carried away — and bring it up
-- next time. /delve drops you into the dungeon: Lua LAYS OUT each floor as a
-- planar, connected grid graph of sections (lib/layout — Lua-decided, not
-- reproducible: math.random and hash-order tie-breaks; knobs for
-- sprawl/loops/size), and ONE planning sub-gen sees that skeleton and
-- themes it — sections, rooms, roster, interactables, ambient lines. Lua then
-- serves it for dozens of turns with ZERO model calls (movement,
-- combat, loot, a fog-of-war map) until you do something nobody planned for.
-- Then the dungeon DM resolves it through a cost-economy toolset — and may
-- open a scene EVEN MID-FIGHT. Death, the relic, or climbing back out from
-- the top floor end the DELVE, not the game: you return to the hall.
--
-- Two modes (state.mode = hall | dungeon) under ONE events engine. An open
-- event sits ABOVE both — ev.isOpen() is checked first — so an event opened
-- mid-combat or mid-explore PAUSES that mode and RESUMES it on close (combat
-- state persists across a scene). Free text always escalates to a DM,
-- reachable from any mode; when the DM's open_event fires, the SAME turn
-- continues into the scene phase — the handoff is a dispatch loop, and the
-- DM's prose is the fallback, not the reply.
--
-- Dungeon content lives in PARTITIONED registries (lib/registry): floors,
-- rooms, enemies, interactables are filed per floor and packed ONE store blob
-- per partition; state carries only the pointer table (state.packIds) and the
-- mutation queue (state._regq). Planning files through the same registry
-- mutation path as escalation writes (add_exit, spawn_enemy); registry.flush()
-- at the end of generate() commits each touched floor's pack as ONE new blob
-- plus a pointer move, so old branches keep their old blob.
--
-- Failure UX: generate wraps the real body in pcall — a hard failure marks
-- state.bricked and RETURNS the failure text (a mechanically successful turn,
-- so the flag persists); a bricked branch refuses further input. Recovery is
-- a swipe or rewind. Generation types: only send/regenerate — continue and
-- impersonate throw BEFORE the brick machinery.
--
-- Built on the game lib (docs/design/examples/game-lib/, vendored as
-- backend_logic/lib/*.lua) — the game-lib copy is canonical; edit there and
-- re-vendor, or edit a card's vendored set and backport (this card's vendored
-- set is byte-identical). The modules: loop (tool loop), sanitize (decoded-JSON
-- hygiene), chrome (buttons/unwrap, the shared clean/oneline text hygiene),
-- ledger (plot promises), todo (planning self-organization), toolset
-- (composition), registry (the character roster with mutable fields; the
-- partitioned dungeon content), summarize (the gist engine), maptag (the
-- fog-of-war map), events (the engine over the character registry), rolling
-- (the story channel — { kv, ids }: the player's FACTS plus the STORY SO FAR
-- the DM reads — and the dossier channels underneath events), layout
-- (procedural floor-layout generation — Lua decides the topology, the model
-- only themes it).
--
-- Companion display rules — only FUNCTIONAL chrome (the memoir lines are
-- plain prose; there are no structural tags to hide):
--   optional: hide command messages (role userInput → "") — slash-commands
--   AND bare command words (delve, go east, look, ...), so a typed command
--   and a button click leave the same clean transcript; safe because posted
--   commands are bare text with no HTML to mangle
--   /\\[HUD\\|([^\\]]+)\\]/g → panel HTML (HUD recipe, topic \`regexes\`) — hall
--   shows name/where/gold; the dungeon adds hp/atk (key-parsed, any order).
--   /\\[MAP\\|([^\\]]+)\\]/g → floor-graph map (maptag recipe)

local loop = require("lib/loop")
local sanitize = require("lib/sanitize")
local chrome = require("lib/chrome")
local ledger = require("lib/ledger")
local todo = require("lib/todo")
local toolset = require("lib/toolset")
local registry = require("lib/registry")
local summarize = require("lib/summarize")
local maptag = require("lib/maptag")
local events = require("lib/events")
local rolling = require("lib/rolling")
local layout = require("lib/layout")

local WIN_ITEM = "relic"

-- The scale knobs. Floor size lives in planFloor (6-9 rooms at depth 1,
-- growing with depth) — a real descent game wants more; the layout
-- generator caps at 24. The planning sub-gen is paid ONCE per floor either
-- way, and serve turns are free at any floor size.
local ENCOUNTER_CHANCE = 0.3   -- per room entry (never at the entrance)
local ENCOUNTER_COOLDOWN = 4   -- turns a room stays quiet after a fight there
local MAX_ROSTER = 4           -- monsters per floor's random-encounter table
local FLEE_DC = 8              -- flee rolls d20+atk vs FLEE_DC + floor depth

-- The compass words the card answers deterministically (a bare "go east"
-- into a wall never escalates to the DM).
local COMPASS = { north = true, south = true, east = true, west = true, down = true }

local FLOORS = {
  f1 = { name = "The Upper Halls", theme = "collapsed galleries, dust and old bones", depth = 1 },
  f2 = { name = "The Flooded Stacks", theme = "knee-deep black water, rotting shelves", depth = 2 },
  f3 = { name = "The Relic Vaults", theme = "sealed stone vaults, something glints on a plinth", depth = 3,
         hint = "Somewhere on this floor place an interactable named 'relic' with effect { item = 'relic' } — the WIN item. Make the player EARN it. This is the deepest floor — do NOT place stairs down; the relic is what ends the delve here." },
}

-- ---------- the cast + the event engine over it ----------

-- Characters are the card's registry (state.characters), UNPARTITIONED — the
-- cast is needed on every floor. mutable = { "personality" } emits
-- update_character: a character's personality may EVOLVE (set semantics —
-- the latest value is canon, the id stable). The events engine owns event
-- state, the cast tools, dossiers, the script-owned tags, the append-only
-- span, and the /leave finalize. Records are plain tables, so roster.get(id)
-- returns the LIVE record for ad-hoc mutations.
local roster = registry.new({
  tool = "register_character",
  description = "File a NEW character (check list_characters first — re-filing an existing name returns the existing record).",
  key = "characters",
  id_from = "name",
  mutable = { "personality" },
  fields = {
    { name = "name", type = "string", required = true, max = 40 },
    { name = "role", type = "string", max = 60 },
    { name = "personality", type = "string", max = 200 },
  },
})

local ev = events.new({ roster = roster })

-- ---------- the dungeon's partitioned content registries ----------

-- One pack blob per floor in the store ({ floors = [...], rooms = [...],
-- enemies = [...], interactables = [...] }), the pointer table in
-- state.packIds, the mutation queue in state._regq. Writes update the
-- resolved view immediately and ride the queue; registry.flush() (once at
-- the end of generate) commits each touched floor as ONE new blob plus a
-- pointer move — old branches keep their old blob, so swipes stay correct.
-- The partition is a property OF THE RECORD (rec.floor), declared by name so
-- the registry's model-facing lookups ask for "the floor" — a domain fact,
-- never the word "partition".

-- The depth budget for enemy clamps is whatever floor is being planned (or
-- escalated on) RIGHT NOW — planFloor / spawn_enemy set it before filing.
local activeEnemyDepth = 1

local floorsReg = registry.new({
  tool = "file_floor", -- card-side only: the planning boundary files the validated floor
  description = "File a floor's meta record (name, description, entrance, stairs, ambient lines).",
  key = "floors",
  id_from = "floor",
  partition_by = "floor",
  fields = {
    { name = "floor", type = "string", required = true },
    { name = "name", type = "string", required = true },
    { name = "description", type = "string" },
    { name = "entrance", type = "string" },
    { name = "stairsDown", type = "string" }, -- "" on the terminal floor
    { name = "ambient", type = "array" },
  },
})

local roomsReg = registry.new({
  tool = "add_room", -- card-side only: the layout generator files rooms (never the model)
  description = "File a room of the floor graph.",
  key = "rooms",
  id_from = "id",
  partition_by = "floor",
  mutable = { "exits" }, -- the dungeon DM's add_exit rewrites a room's exits mid-delve
  fields = {
    { name = "id", type = "string", required = true },
    { name = "floor", type = "string", required = true },
    { name = "name", type = "string" },
    { name = "desc", type = "string" },
    { name = "x", type = "integer" }, -- grid position (lib/layout): the map's geometry
    { name = "y", type = "integer" },
    { name = "section", type = "string" },
    { name = "exits", type = "table" },
  },
})

local enemiesReg = registry.new({
  tool = "add_encounter",
  description = "Add a monster to the floor's roster (max " .. MAX_ROSTER .. ") with canned combat lines. Lua rolls roster monsters as RANDOM encounters while the player explores. hp/atk/reward clamp to the depth budget.",
  key = "enemies",
  id_from = "name",
  partition_by = "floor",
  cap = MAX_ROSTER, -- per partition: each floor's own roster
  fields = {
    { name = "name", type = "string", required = true },
    { name = "floor", type = "string", required = true },
    { name = "hp", type = "integer", min = 1, max = function() return 6 + activeEnemyDepth * 4 end, default = 6 },
    { name = "atk", type = "integer", min = 1, max = function() return 1 + activeEnemyDepth end, default = 2 },
    { name = "reward", type = "integer", min = 0, max = function() return 5 * activeEnemyDepth end, default = 5 },
    { name = "lines", type = "table" },
  },
  on_register = function(rec)
    rec.maxHp = rec.hp
    local lines = type(rec.lines) == "table" and rec.lines or {}
    rec.lines = {
      intro = tostring(lines.intro or "It lunges from the dark."),
      hit = tostring(lines.hit or "It shrieks."),
      death = tostring(lines.death or "It collapses."),
    }
  end,
})

local interactablesReg = registry.new({
  tool = "file_interactable", -- card-side: filed at the boundary, after graph validation
  description = "File an interactable object placed in a room.",
  key = "interactables",
  id_from = "key",
  partition_by = "floor",
  fields = {
    { name = "key", type = "string", required = true }, -- "r2:crate"
    { name = "floor", type = "string", required = true },
    { name = "responses", type = "table" },
    { name = "effect", type = "table" },
  },
})

-- ---------- state (hot only — pack POINTERS here, pack blobs in the store) ----------

local function ensureState()
  if type(state) ~= "table" then state = {} end
  -- shared
  state.mode = state.mode or "hall"            -- "hall" | "dungeon"
  state.gold = state.gold or 30
  state.flags = state.flags or {}
  state.turn = state.turn or 0
  -- The story channel (lib/rolling): kv facts verbatim (the player FACTS
  -- block) plus the compacting log of gist entries (STORY SO FAR). Anything
  -- not channel-shaped resets fresh.
  if type(state.story) ~= "table" or type(state.story.kv) ~= "table" or type(state.story.ids) ~= "table" then
    state.story = rolling.channel()
  end
  state.packIds = state.packIds or {}           -- partition ("f1") -> pack blob id
  state.bricked = state.bricked or nil          -- set after a hard failure: the branch refuses input
  -- dungeon (namespaced — every former unprefixed crypt key lives here)
  if type(state.dun) ~= "table" then state.dun = {} end
  state.dun.maxHp = state.dun.maxHp or 20
  state.dun.hp = state.dun.hp or state.dun.maxHp
  state.dun.atk = state.dun.atk or 4
  state.dun.inventory = state.dun.inventory or {} -- name -> count
  state.dun.room = state.dun.room or "f1"        -- floor only until a pack designates an entrance
  state.dun.combat = state.dun.combat or nil     -- { name, hp, maxHp, atk, lines, reward }
  state.dun.seen = state.dun.seen or {}           -- fog-of-war: full room ids visited
  state.dun.escalations = state.dun.escalations or 0
  state.dun.fightName = state.dun.fightName or nil
  state.dun.delveOver = state.dun.delveOver or nil -- nil | "dead" | "won"
  state.onboarded = state.onboarded or false
  state.playerName = state.playerName or ""
  -- Onboarding: the very first turn opens a registration event with the guild
  -- receptionist (script-side — no delegate), so the player's first message is
  -- their ANSWER to her, not a menu command. She gets a name + trade, the
  -- scene-runner calls register_player (which rolls stats and CLOSES the
  -- event itself — a model-deferred close stranded players behind the gate),
  -- and the hall menu appears. Registration is complete ONLY once a name is
  -- filed: if an event closes without register_player, onboarded stays false
  -- and the next turn RE-OPENS registration (the receptionist is re-added if
  -- the roster lost her).
  -- This is the ONLY script-opened event: a static context is safe here
  -- because there is no history to contradict yet (or, on a re-open, the only
  -- history is a registration attempt — which this context still describes).
  -- Once the game has a real past, events are DM-framed (or their context is
  -- composed from state) — a canned context or opener asserts the past
  -- blindly, and the scene-runner will believe it ("welcome back, how was the
  -- dungeon?" on a first meeting).
  if not state.onboarded and state.event == nil then
    state.characters = state.characters or {}
    local haveReceptionist = false
    for _, c in ipairs(state.characters) do
      if c.id == "receptionist" then haveReceptionist = true break end
    end
    if not haveReceptionist then
      state.characters[#state.characters + 1] = { id = "receptionist", name = "The Receptionist",
        role = "guild receptionist", personality = "ink-stained, donut-eating, briskly fond of newcomers" }
    end
    state.eventSeq = (state.eventSeq or 0) + 1
    state.event = { id = "e" .. state.eventSeq, kind = "registration",
      context = "A newcomer at the reception desk. Get their name (and trade if they offer one), call register_player with the name, then close_event to hand them into the hall. Donuts are the best in Thornwall; don't reveal the source.",
      participants = { "receptionist" } }
  end
  -- ledger owns state.promises; events owns state.event/dossiers/characters/eventSeq
end

-- ---------- small helpers ----------

-- state.dun.room is "f2:r5" — floor id : room id. Packs are per floor; rooms
-- are nodes inside the floor's graph.
local function floorOf(roomId) return tostring(roomId):match("^(f%d+)") or "f1" end
local function subOf(roomId) return tostring(roomId):match(":(%w+)$") or "" end
local function depthOfFloor(fid) return (FLOORS[fid] or FLOORS.f1).depth end
local function isTerminalFloor(fid)
  -- The deepest floor: no other floor sits one deeper. It has no stairs down —
  -- the relic (or death) ends the delve, not descent.
  local d = (FLOORS[fid] or {}).depth
  if not d then return false end
  for _, f in pairs(FLOORS) do if f.depth == d + 1 then return false end end
  return true
end

local function lastUserText(prompt)
  for i = #prompt.messages, 1, -1 do
    local m = prompt.messages[i]
    if m.role == "user" and type(m.content) == "string" then return m.content end
  end
  return ""
end

local function trim(s)
  if type(s) ~= "string" then return "" end
  return (s:gsub("^%s*(.-)%s*$", "%1"))
end

local function markSeen() state.dun.seen[state.dun.room] = true end

local function invList()
  local out = {}
  for k, v in pairs(state.dun.inventory) do out[#out + 1] = k .. " x" .. v end
  return #out > 0 and table.concat(out, ", ") or "nothing"
end

-- ---------- floor packs (resolved views over the partitioned registries) ----------

-- The live view of a floor's pack, in the shape the serve path consumes.
-- lib/registry resolves base blob + unflushed queue on every read, so this is
-- current the moment a write lands. nil when the floor was never designed ON
-- THIS BRANCH (no pointer, nothing queued — the caller plans it). A pointer
-- whose blob is missing is a bug, not bad luck — the registry throws.
local function floorPack(fid)
  local meta = floorsReg.get(fid, fid)
  if not meta then return nil end
  local rooms = {}
  for _, r in ipairs(roomsReg.list(fid)) do
    rooms[r.id] = { name = r.name, desc = r.desc, exits = r.exits or {},
      x = r.x, y = r.y, section = r.section }
  end
  local interactables = {}
  for _, it in ipairs(interactablesReg.list(fid)) do
    interactables[it.key] = { responses = it.responses or {}, effect = it.effect }
  end
  return {
    id = fid,
    name = meta.name,
    description = meta.description,
    entrance = meta.entrance ~= "" and meta.entrance or nil,
    stairsDown = meta.stairsDown ~= "" and meta.stairsDown or nil,
    ambient = meta.ambient or {},
    rooms = rooms,
    encounterTable = enemiesReg.list(fid),
    interactables = interactables,
  }
end

-- The pack for the dungeon floor the player is on (nil in the hall).
local function currentPack()
  if state.mode ~= "dungeon" then return nil end
  return floorPack(floorOf(state.dun.room))
end

-- ---------- display ----------

local function mapTag(pack)
  if not pack then return "" end
  local fid = floorOf(state.dun.room)
  local seen = {}
  for rid in pairs(state.dun.seen) do
    if floorOf(rid) == fid then seen[subOf(rid)] = true end
  end
  return maptag.tag(pack.rooms, {
    cur = subOf(state.dun.room),
    entrance = pack.entrance,
    stairs = pack.stairsDown,
    seen = seen,
  })
end

-- The HUD regex parses key=value pairs split on "|" inside [HUD|...], so
-- interpolated names get the same hygiene maptag gives room names: a
-- planner-written "The Vault | West]" would otherwise break the parse.
local function hudClean(s)
  return (tostring(s or ""):gsub("[|%[%]]", " "):gsub("%s+", " "):gsub("^%s*(.-)%s*$", "%1"))
end

local function hud(pack)
  local namePart = state.playerName ~= "" and string.format("name=%s|", hudClean(state.playerName)) or ""
  if state.mode == "hall" then
    return string.format("[HUD|%swhere=The Hall|gold=%d]", namePart, state.gold)
  end
  local where = state.dun.room
  if pack then
    local room = pack.rooms[subOf(state.dun.room)]
    where = hudClean(pack.name) .. (room and (" — " .. hudClean(room.name)) or "")
  end
  return string.format("[HUD|%swhere=%s|hp=%d/%d|atk=%d|gold=%d]",
    namePart, where, state.dun.hp, state.dun.maxHp, state.dun.atk, state.gold)
end

local function statusTags(pack)
  if state.mode == "hall" then return hud(nil) end
  return hud(pack) .. "\\n" .. mapTag(pack)
end

-- The room's interactables, quoted verbatim so the player can type what they
-- see: the planner's names rarely appear in its own room prose ("cistern
-- signet" vs "a cracked cistern"), so without this list the player can only
-- guess at what a room contains. Sorted for determinism; "" when empty.
local function noticeLine(pack)
  local prefix = subOf(state.dun.room) .. ":"
  local names = {}
  for key in pairs(pack.interactables) do
    if key:sub(1, #prefix) == prefix then names[#names + 1] = key:sub(#prefix + 1) end
  end
  if #names == 0 then return "" end
  table.sort(names)
  return "\\n\\nYou notice: " .. table.concat(names, ", ") .. "."
end

-- The button row matches the moment: Leave inside an event, Return after a
-- delve ends, the hall menu in the hall, Attack/Flee in a fight, the room's
-- exits while exploring.
local function buttonsHtml(pack)
  if ev.isOpen() and not state.onboarded then
    return "" -- onboarding: the receptionist asked a question; type, don't click
  end
  if ev.isOpen() then
    return chrome.btn("leave", "Leave")
  end
  if state.mode == "hall" then
    return chrome.btn("delve", "Delve into the dungeon") .. " "
      .. chrome.btn("shop", "Visit the store") .. " "
      .. chrome.btn("smith", "See the blacksmith")
  end
  if state.dun.delveOver then
    return chrome.btn("leave dungeon", "Return to the hall")
  end
  if state.dun.combat then
    return chrome.btn("attack", "Attack " .. state.dun.combat.name) .. " " .. chrome.btn("flee", "Flee")
  end
  local out = {}
  if pack then
    local room = pack.rooms[subOf(state.dun.room)]
    if room then
      local dirs = {}
      for d in pairs(room.exits) do dirs[#dirs + 1] = d end
      table.sort(dirs)
      for _, d in ipairs(dirs) do
        if room.exits[d] == "down" then
          out[#out + 1] = chrome.btn("go down", "Descend")
        else
          out[#out + 1] = chrome.btn("go " .. d, "Go " .. d)
        end
      end
    end
    -- Climb always works: deeper floors go up a floor, the top floor exits the
    -- delve. The label IS the verb ("up"), like the Go <dir> buttons — a
    -- flavor label ("Climb out") teaches words the parser doesn't know, and a
    -- player typing them pays for a DM turn that can contradict the button.
    out[#out + 1] = chrome.btn("up", depthOfFloor(floorOf(state.dun.room)) > 1 and "Up" or "Up (out)")
  end
  return table.concat(out, " ")
end

local function tail(pack)
  return "\\n\\n" .. statusTags(pack) .. "\\n" .. buttonsHtml(pack)
end

-- ---------- encounters, fights, effects, ambient ----------

-- The fight log is MECHANICAL: every blow lands in state.dun.fightLog as it
-- is served (message-shaped entries, branch-aware like everything in state).
-- No tags, no scans — at fight end the gist is written over THIS array.
local function fightLog(entry)
  state.dun.fightLog = state.dun.fightLog or {}
  state.dun.fightLog[#state.dun.fightLog + 1] = entry
end

-- Lua rolls the roster, not the model. The entrance is safe; a room goes
-- quiet for ENCOUNTER_COOLDOWN turns after a fight there. A rolled encounter
-- starts a tracked fight (state.dun.fightName + fightLog): the blows land in
-- the log as served text AND in fightLog, and when the fight ends the
-- delegate writes the one line that survives.
local function maybeRollEncounter(pack)
  if state.dun.combat then return nil end
  local rid = subOf(state.dun.room)
  if rid == "" or rid == pack.entrance then return nil end
  if #pack.encounterTable == 0 then return nil end
  local quietAt = state.flags["quiet:" .. state.dun.room]
  if type(quietAt) == "number" and state.turn - quietAt < ENCOUNTER_COOLDOWN then return nil end
  if math.random() >= ENCOUNTER_CHANCE then return nil end
  local e = pack.encounterTable[math.random(#pack.encounterTable)]
  state.dun.combat = { name = e.name, hp = e.hp, maxHp = e.maxHp, atk = e.atk, lines = e.lines, reward = e.reward }
  state.dun.fightName = "fight " .. e.name
  state.dun.fightLog = nil
  fightLog({ role = "assistant", content = e.lines.intro })
  return e.lines.intro
end

-- End the fight: a delegate-written gist over the mechanical blows (read
-- from state.dun.fightLog, never parsed out of history), filed as a STORY
-- entry (the blows ride along as its content, so inspect_summary can zoom),
-- and served as a PLAIN memoir line — no tags, nothing to regex away. A
-- delegate error bricks the branch (see generate); a swipe retries the gist.
-- The gist + story-entry half, shared with the DM's end_combat tool.
local function recordFightGist(prompt, tag, log)
  -- The gist is a nicety, never worth the fight: a stalled or aborted
  -- summarizer sub-gen degrades to the canned line instead of bricking
  -- the branch (the kill itself is already mechanical at this point).
  local gist
  if log then
    local ok, g = pcall(summarize.gist, prompt, { span = log })
    if ok and type(g) == "string" and g ~= "" then gist = g end
  end
  gist = gist or "The dark keeps the details."
  rolling.push(state.story, { label = tag, gist = gist, content = log })
  return gist
end

-- Fights that started untracked get no summary — but the log is cleared
-- either way: leftover blows must not leak into the next fight's span.
local function endFight(prompt)
  local tag = state.dun.fightName
  state.dun.fightName = nil
  local log = state.dun.fightLog
  state.dun.fightLog = nil
  if not tag then return "" end
  return "\\n\\n" .. recordFightGist(prompt, tag, log)
end

local function applyEffect(effect)
  if type(effect) ~= "table" then return end
  if effect.gold then state.gold = math.max(0, state.gold + effect.gold) end
  if effect.hp then state.dun.hp = math.max(0, math.min(state.dun.maxHp, state.dun.hp + effect.hp)) end
  if effect.item then
    state.dun.inventory[effect.item] = (state.dun.inventory[effect.item] or 0) + 1
    if effect.item == WIN_ITEM then
      state.flags.relic = true
      state.dun.delveOver = "won"
    end
  end
end

-- Death is a STATE, not a code path: hp can reach 0 through combat, a failed
-- attempt(), or a hostile interactable — wherever it happens, the delve ends.
-- Returns the death line when this call ends the delve, nil otherwise.
local function checkDead()
  if state.dun.hp > 0 or state.dun.delveOver then return nil end
  state.dun.delveOver = "dead"
  return " You fall. THE DARK KEEPS YOU."
end

local function maybeAmbient(pack)
  if #pack.ambient == 0 or state.turn % 4 ~= 0 then return nil end
  return pack.ambient[(math.floor(state.turn / 4) - 1) % #pack.ambient + 1]
end

-- ---------- planning: ONE sub-gen per floor, the floor as a GRAPH ----------

local function planningToolset(draft, fid)
  local depth = depthOfFloor(fid)
  activeEnemyDepth = depth -- the enemies registry's budget clamps read this
  local ts = toolset.new()
  ts:use(ledger)
  ts:use(todo)

  ts:handle("add_description", function(args)
    draft.description = tostring(args.text or "")
    return "ok"
  end, {
    type = "function",
    ["function"] = { name = "add_description", description = "Set the floor's one-paragraph overview.",
      parameters = { type = "object", properties = { text = { type = "string" } }, required = { "text" } } },
  })

  ts:handle("theme_section", function(args)
    local sec = tostring(args.section or ""):upper()
    local meta = draft.sectionsById[sec]
    if not meta then
      local ids = {}
      for _, s in ipairs(draft.sections) do ids[#ids + 1] = s.id end
      return "rejected: section must be one of: " .. table.concat(ids, ", ")
    end
    meta.theme = tostring(args.name or ""):sub(1, 40)
    meta.vibe = tostring(args.vibe or ""):sub(1, 200)
    return "ok: section " .. sec
  end, {
    type = "function",
    ["function"] = { name = "theme_section", description = "Name ONE lettered section of the floor's fixed layout and give it a one-line vibe. The rooms already exist; this sets what the section IS.",
      parameters = { type = "object", properties = {
        section = { type = "string", description = "The section letter (A, B, ...)" },
        name = { type = "string", description = "Short section name, e.g. 'The Bone Chapel'" },
        vibe = { type = "string", description = "One line: what this place was, what it is now" } },
        required = { "section", "name", "vibe" } } },
  })

  ts:handle("furnish_rooms", function(args)
    if type(args.rooms) ~= "table" then return "rejected: rooms array required" end
    local known = {}
    for _, rid in ipairs(draft.roomOrder) do known[#known + 1] = rid end
    local ok, bad = {}, {}
    for _, r in ipairs(args.rooms) do
      if type(r) == "table" then
        local id = tostring(r.room or ""):lower()
        local room = draft.rooms[id]
        if room then
          room.name = tostring(r.name or ""):sub(1, 60)
          room.desc = tostring(r.desc or ""):sub(1, 240)
          ok[#ok + 1] = id .. "(" .. room.section .. ")"
        else
          bad[#bad + 1] = tostring(r.room or "?")
        end
      end
    end
    local out = "ok: " .. table.concat(ok, ", ")
    if #bad > 0 then out = out .. " | rejected (not on this floor): " .. table.concat(bad, ", ") .. " — valid: " .. table.concat(known, ", ") end
    return out
  end, {
    type = "function",
    ["function"] = { name = "furnish_rooms", description = "Furnish rooms of the fixed layout IN BATCHES (a whole section per call): each entry a short name and a ONE-line description fitting its section's theme. Do NOT invent rooms — the layout is fixed.",
      parameters = { type = "object", properties = {
        rooms = { type = "array", items = { type = "object", properties = {
          room = { type = "string", description = "Room id from the layout, e.g. r3" },
          name = { type = "string" }, desc = { type = "string" } },
          required = { "room", "name", "desc" } } } },
        required = { "rooms" } } },
  })

  ts:handle("add_interactable", function(args)
    local room = tostring(args.room or ""):lower()
    local iname = tostring(args.name or ""):lower()
    if room == "" or iname == "" then return "rejected: room and name required" end
    if not draft.rooms[room] then
      return "rejected: room '" .. room .. "' is not on this floor's layout"
    end
    local responses = {}
    if type(args.responses) == "table" then
      for _, r in ipairs(args.responses) do responses[#responses + 1] = tostring(r) end
    end
    if #responses == 0 then responses = { "Nothing happens." } end
    local effect
    if type(args.effect) == "table" then
      effect = {}
      if tonumber(args.effect.gold) then effect.gold = math.max(0, math.min(math.floor(tonumber(args.effect.gold)), 5 * depth)) end
      if tonumber(args.effect.hp) then effect.hp = math.max(-10, math.min(10, math.floor(tonumber(args.effect.hp)))) end
      if type(args.effect.item) == "string" then effect.item = args.effect.item:lower() end
    end
    -- The WIN item is structural, not a prompt hint: it only exists on the
    -- deepest floor (an early relic would win the delve on contact).
    if effect and effect.item == WIN_ITEM and not isTerminalFloor(fid) then
      return "rejected: the " .. WIN_ITEM .. " only spawns on the deepest floor — this is " .. fid
    end
    draft.interactables[room .. ":" .. iname] = { responses = responses, effect = effect }
    return "ok: " .. room .. ":" .. iname
  end, {
    type = "function",
    ["function"] = { name = "add_interactable", description = "Place an object in a room. responses[1] fires on first use (with its effect), responses[2] on repeats.",
      parameters = { type = "object", properties = {
        room = { type = "string" },
        name = { type = "string" },
        responses = { type = "array", items = { type = "string" } },
        effect = { type = "object", properties = { gold = { type = "integer" }, hp = { type = "integer" }, item = { type = "string" } } },
      }, required = { "room", "name", "responses" } } },
  })

  ts:handle("add_ambient", function(args)
    if type(args.lines) == "table" then
      for _, l in ipairs(args.lines) do draft.ambient[#draft.ambient + 1] = tostring(l) end
    end
    return "ok"
  end, {
    type = "function",
    ["function"] = { name = "add_ambient", description = "Add rotating ambient flavor lines.",
      parameters = { type = "object", properties = { lines = { type = "array", items = { type = "string" } } }, required = { "lines" } } },
  })

  -- The intro is a TOOL CALL, not the planner's final text: the reply the
  -- player sees is draft.intro and NOTHING else. Serving the planner's raw
  -- final text leaked the whole design doc (sections, roster, interactables
  -- WITH their rewards and locations) into the delve reply — the fog-of-war
  -- map carefully hides unvisited rooms, then the reply spoiled them.
  ts:handle("finish_floor", function(args)
    draft.intro = tostring(args.intro or "")
    return "ok: floor filed — the player is reading the intro now"
  end, {
    type = "function",
    ["function"] = { name = "finish_floor", description = "Call EXACTLY ONCE when the design is complete. intro: the floor's entrance narration — 2-3 terse sentences, second person. This is the ONLY text of yours the player ever reads; everything else you wrote is backstage design and must NOT appear in it (no room ids, no roster, no interactables, no rewards, no stairs, no hints of what lies deeper).",
      parameters = { type = "object", properties = { intro = { type = "string" } }, required = { "intro" } } },
  })

  -- The roster, declared as a partitioned registry: budgets and the cap are
  -- data, the validate-clamp-file pipeline is the lib's, and the write rides
  -- the registry mutation queue into the floor's pack. The card injects the
  -- floor — the partition is a property of the record, never the model's to
  -- speak — so the tool schema is the registry's own minus the floor field.
  local addEncounterSchema = json.decode(json.encode(enemiesReg.tools()[1]))
  addEncounterSchema["function"].parameters.properties.floor = nil
  ts:handle("add_encounter", function(args)
    args.floor = fid
    return enemiesReg.exec("add_encounter", args)
  end, addEncounterSchema)

  return ts
end

-- ONE planning sub-gen per floor: Lua has ALREADY laid the floor out as a
-- grid graph (lib/layout — planar, connected, sectioned, stairs placed, all
-- by construction). The model SEES that skeleton and themes it — sections,
-- rooms, roster, interactables — through tool calls, then finishes with ONE
-- finish_floor call carrying the intro. The boundary is INVISIBLE — the
-- reply is draft.intro and nothing else (the planner's free text is
-- backstage design; serving it spoiled every hidden room and reward); the
-- pack commit (registry.flush at the end of generate) leaves no memoir line.
local function planFloor(prompt, fid)
  local floor = FLOORS[fid]
  if not floor then return "Nowhere to go." end
  local depth = floor.depth
  -- Depth-scaled sizes plus per-floor randomness (sprawl especially) — the
  -- anti-monotony budget, since topology is no longer the model's to vary.
  local lay = layout.generate({
    rooms = math.random(6, 8 + depth),
    sections = math.random(2, 2 + math.min(2, depth - 1)),
    loops = math.random(1, 2),
    sprawl = math.random(),
    terminal = isTerminalFloor(fid),
  })
  local draft = { id = fid, description = "", rooms = {}, roomOrder = lay.order,
    entrance = lay.entrance, stairsDown = lay.stairsDown,
    interactables = {}, ambient = {}, sections = lay.sections }
  draft.sectionsById = {}
  for _, sec in ipairs(lay.sections) do draft.sectionsById[sec.id] = sec end
  for _, rid in ipairs(lay.order) do
    local r = lay.rooms[rid]
    draft.rooms[rid] = { x = r.x, y = r.y, section = r.section, name = "", desc = "", exits = r.exits }
  end
  local ts = planningToolset(draft, fid)
  local sub = {}
  for k, v in pairs(prompt) do sub[k] = v end
  sub.tools = ts:schemas()
  sub.messages = {
    { role = "system", content = "You are the content designer for a terse dark-fantasy dungeon crawler. "
      .. "The floor '" .. floor.name .. "' (" .. floor.theme .. "; depth " .. depth
      .. ") has ALREADY been laid out: " .. #lay.order .. " rooms in " .. #lay.sections
      .. " sections, connections guaranteed. Do NOT add rooms or passages — the skeleton at the end IS the floor. "
      .. "Plan the work with set_todo first, then: theme EVERY section (theme_section), furnish EVERY room to fit "
      .. "its section (furnish_rooms — batch a whole section per call; the entrance is marked and is safe: no "
      .. "encounters roll there), "
      .. "then the roster: 2-" .. MAX_ROSTER .. " monsters via add_encounter with canned lines "
      .. "(intro/hit/death) — Lua rolls them as RANDOM encounters while the player explores. "
      .. "Give every monster a gold REWARD within the clamp: the kill pays it, and a 0-reward "
      .. "monster makes its fight pointless. "
      .. "Sprinkle 2-4 interactables (dead ends hide the best rewards) and 2-6 ambient lines. "
      .. "Terse, concrete, atmospheric. "
      .. (floor.hint and (floor.hint .. " ") or "")
      .. "When the design is done, call finish_floor ONCE with the floor intro: 2-3 terse sentences, second "
      .. "person. The intro is the ONLY text the player reads — your chat text never reaches them, so put "
      .. "NOTHING in the intro but what the entrance shows."
      .. ledger.briefing()
      .. "\\n\\n" .. layout.skeleton(lay) },
    { role = "user", content = "Theme and furnish " .. floor.name .. " now." },
  }
  local res = backends.generate(sub):await()
  loop.run(sub, res, ts:exec(), 32) -- one-tool-per-round delegates need the headroom
  state.todos = {} -- the planner's scratch plan is spent; it must not ride state forever
  -- Fill whatever the model left blank. The topology is already sound, so
  -- gaps are cosmetic: unthemed sections fall back to the floor's theme,
  -- unfurnished rooms to their section's.
  if draft.description == "" then
    -- The planner rarely bothers with add_description; the intro is a far
    -- better re-entry text than the generic "Name: theme." line.
    local intro = trim(draft.intro or "")
    draft.description = intro ~= "" and intro or (floor.name .. ": " .. floor.theme .. ".")
  end
  for _, rid in ipairs(draft.roomOrder) do
    local room = draft.rooms[rid]
    local sec = draft.sectionsById[room.section]
    if room.name == "" then room.name = ((sec and sec.theme) or floor.name) .. " (" .. rid .. ")" end
    if room.desc == "" then room.desc = ((sec and sec.vibe) or floor.theme) .. "." end
  end
  -- File the finished floor into the partitioned registries — the same
  -- mutation path escalation writes use. registry.flush() (end of generate)
  -- commits ONE new pack blob for the floor and moves state.packIds[fid].
  floorsReg.create({ floor = fid, name = floor.name, description = draft.description,
    entrance = draft.entrance, stairsDown = draft.stairsDown or "", ambient = draft.ambient })
  for _, rid in ipairs(draft.roomOrder) do
    local room = draft.rooms[rid]
    roomsReg.create({ id = rid, floor = fid, name = room.name, desc = room.desc,
      x = room.x, y = room.y, section = room.section, exits = room.exits })
  end
  for key, it in pairs(draft.interactables) do
    interactablesReg.create({ key = key, floor = fid, responses = it.responses, effect = it.effect })
  end
  state.dun.room = fid .. ":" .. draft.entrance
  -- The reply is the finish_floor intro ONLY — never res.text (the planner's
  -- raw final text is backstage design; serving it leaked the whole floor).
  local intro = trim(draft.intro or "")
  if intro == "" then intro = draft.description end
  markSeen()
  local pack = floorPack(fid)
  return intro .. noticeLine(pack) .. tail(pack)
end

-- ---------- serving (deterministic, zero model) ----------

-- COMBAT IS A MODE — but the gate is RELAXED. While a monster lives, the
-- deterministic movement/look/interact verbs are refused ("the monster is
-- between you and everything else"); attack and flee work; and any OTHER
-- input falls through to nil → escalate, so the DM (and a scene it opens)
-- stays reachable mid-fight. That is what makes the events engine usable
-- from inside a battle.
local function serve(cmd, pack)
  local lower = cmd:lower()
  if lower == "" then return { text = "Say something." } end
  -- Word-match verbs so "flee" doesn't catch "fleece" and "attack" doesn't
  -- catch "...won't attack"; "run away" stays a phrase match.
  local function has(verb)
    for w in lower:gmatch("%w+") do if w == verb then return true end end
    return false
  end
  local room = pack.rooms[subOf(state.dun.room)]
  if not room then return { text = "You blink; the dark rearranges itself.", moved = true } end

  local inCombat = state.dun.combat ~= nil
  local function gate()
    return { text = "The " .. state.dun.combat.name .. " is between you and everything else. (attack / flee)" }
  end

  if inCombat then
    if has("flee") or lower:find("run away", 1, true) then
      fightLog({ role = "user", content = cmd })
      local depth = depthOfFloor(floorOf(state.dun.room))
      local dc = FLEE_DC + depth
      if math.random(1, 20) + state.dun.atk >= dc then
        state.dun.combat = nil
        state.dun.room = floorOf(state.dun.room) .. ":" .. pack.entrance
        -- Room names carry their own article ("The Collapsed Vestibule") —
        -- strip it so the line doesn't read "back to the The X".
        local dest = ((pack.rooms[pack.entrance] and pack.rooms[pack.entrance].name) or "the entrance"):gsub("^[Tt]he ", "")
        local line = "You break and scramble back to the " .. dest .. "."
        fightLog({ role = "assistant", content = line })
        return { text = line, moved = true, fightEnded = true }
      end
      local counter = state.dun.combat.atk + math.random(0, 1)
      state.dun.hp = state.dun.hp - counter
      if state.dun.hp <= 0 then
        state.dun.delveOver = "dead"
        local line = state.dun.combat.lines.hit .. " You fall. THE DARK KEEPS YOU."
        fightLog({ role = "assistant", content = line })
        return { text = line, fightEnded = true }
      end
      local line = "You stumble — no escape. " .. state.dun.combat.lines.hit .. " (-" .. counter .. " hp)"
      fightLog({ role = "assistant", content = line })
      return { text = line }
    end
    if has("attack") then
      fightLog({ role = "user", content = cmd })
      local dmg = state.dun.atk + math.random(0, 3)
      state.dun.combat.hp = state.dun.combat.hp - dmg
      if state.dun.combat.hp <= 0 then
        local reward = state.dun.combat.reward or 0
        -- No "(+0 gold)": a rewardless kill just reads its death line.
        local line = state.dun.combat.lines.death .. (reward > 0 and (" (+" .. reward .. " gold)") or "")
        state.flags["quiet:" .. state.dun.room] = state.turn
        state.dun.combat = nil
        state.gold = state.gold + reward
        fightLog({ role = "assistant", content = line })
        return { text = line, fightEnded = true }
      end
      local counter = state.dun.combat.atk + math.random(0, 1)
      state.dun.hp = state.dun.hp - counter
      if state.dun.hp <= 0 then
        state.dun.delveOver = "dead"
        local line = state.dun.combat.lines.hit .. " You fall. THE DARK KEEPS YOU."
        fightLog({ role = "assistant", content = line })
        return { text = line, fightEnded = true }
      end
      local line = state.dun.combat.lines.hit .. " You hit for " .. dmg .. "; it answers for " .. counter .. "."
      fightLog({ role = "assistant", content = line })
      return { text = line }
    end
  end

  if lower == "look" then
    return inCombat and gate() or { text = room.desc .. noticeLine(pack) }
  end

  if lower == "up" or lower == "climb" then
    if inCombat then return gate() end
    local depth = depthOfFloor(floorOf(state.dun.room))
    -- Top floor: the stair you came down is the way OUT — a delve is always
    -- escapable, not just survivable. dungeonTurn performs the return.
    if depth <= 1 then return { leave = true } end
    -- Climb back to the stairs you came down (the upper floor's stairsDown),
    -- not its entrance — descent geometry is earned both ways. The upper
    -- pack exists: the player came from there.
    local upFid = "f" .. (depth - 1)
    local upPack = floorPack(upFid)
    local stairs = upPack and upPack.stairsDown or nil
    state.dun.room = stairs and (upFid .. ":" .. stairs) or upFid
    return { moved = true }
  end

  for dir, to in pairs(room.exits) do
    if lower == dir or lower == "go " .. dir then
      if inCombat then return gate() end
      if to == "down" then
        state.dun.room = "f" .. (depthOfFloor(floorOf(state.dun.room)) + 1)
      else
        state.dun.room = floorOf(state.dun.room) .. ":" .. to
      end
      return { moved = true }
    end
  end

  -- A bare compass command naming a passage that ISN'T here is a
  -- deterministic refusal, not a DM escalation: the card knows the compass
  -- words, and a paid DM turn (with the full floor pack in its system
  -- prompt) to say "you can't go that way" is waste that also hallucinates.
  -- Anchored to the whole input — anything richer still escalates.
  local dir = lower:match("^go (%w+)$") or lower:match("^(%w+)$")
  if COMPASS[dir] then
    if inCombat then return gate() end
    return { text = "No passage " .. dir .. " from here." }
  end

  if (not inCombat) and has("attack") then
    return { text = "Nothing here fights back." }
  end

  -- Interactables: the planner invents names ("cistern signet") the room text
  -- never quotes verbatim ("a cracked cistern"), so a full-name substring
  -- match is unfindable — natural input ("open the cistern") used to escalate
  -- to a PAID DM turn that narrated the reward without granting it. Match on
  -- significant words instead: any word of the name (3+ letters, no
  -- stopwords) present in the input counts; the room's best-scoring
  -- interactable fires. Deterministic order (sorted keys) for ties.
  local STOP = { the = true, ["and"] = true, ["for"] = true, ["with"] = true }
  local bestIt, bestScore = nil, 0
  local keys = {}
  for key in pairs(pack.interactables) do keys[#keys + 1] = key end
  table.sort(keys)
  local prefix = subOf(state.dun.room) .. ":"
  for _, key in ipairs(keys) do
    if key:sub(1, #prefix) == prefix then
      local iname = key:sub(#prefix + 1)
      local score = 0
      for w in iname:gmatch("%a+") do
        if #w >= 3 and not STOP[w] and lower:find(w, 1, true) then score = score + 1 end
      end
      if score > bestScore then bestScore = score bestIt = { key = key, it = pack.interactables[key], iname = iname } end
    end
  end
  if bestIt then
    if inCombat then return gate() end
    local it = bestIt.it
    local usedKey = "used:" .. state.dun.room .. ":" .. bestIt.iname
    if state.flags[usedKey] then
      return { text = it.responses[2] or it.responses[1] or "Nothing more happens." }
    end
    state.flags[usedKey] = true
    applyEffect(it.effect)
    return { text = (it.responses[1] or "Nothing happens.") .. (checkDead() or "") }
  end

  return nil -- no deterministic match → escalate (DM reachable from any mode)
end

-- ---------- the delegates ----------

local HALL_DM_PROMPT = "You are the guildhall's dungeon master, adjudicating ONE player action in the idle hall. "
  .. "If the action opens a conversation or scene, call open_event with a kind and a CONTEXT: who the player "
  .. "is and what they are after, framed for the scene-runner who takes over — NO character list; casting is "
  .. "the scene-runner's job. Ground the CONTEXT in the STORY SO FAR: what just happened, and whether the "
  .. "player and the people involved have met before — the scene-runner inherits only your context and the "
  .. "public record. The store and the blacksmith are REAL: use buy_item for any purchase — the ENGINE moves "
  .. "the gold and grants the item; if it says they can't afford it, the sale did not happen. "
  .. "Use attempt() for anything risky — the ENGINE rolls and decides. set_flag for "
  .. "lasting facts, inspect_summary to zoom into what actually happened. Then narrate the outcome in 1-2 terse sentences, "
  .. "second person."

local DUNGEON_DM_PROMPT = "You are the dungeon master of a terse dungeon crawler, adjudicating ONE novel player action. "
  .. "If the action opens a conversation or scene (even mid-fight), call open_event with a kind and a CONTEXT: "
  .. "who the player is and what they are after — NO character list; casting is the scene-runner's job. "
  .. "Ground the CONTEXT in what actually happened (the STORY SO FAR; inspect_summary zooms in) — including "
  .. "whether the player and anyone involved have met before; the scene-runner inherits only your context "
  .. "and the public record. "
  .. "Rules: use attempt() for anything risky — the ENGINE rolls and decides; honor its result. "
  .. "Use remove_item/grant/add_exit/set_flag/spawn_enemy to make consequences REAL — costs and rewards are "
  .. "moved by the engine, and the tool result is the canonical record. A price or bribe the player pays is "
  .. "grant with NEGATIVE gold. NEVER narrate gold changing hands, an item gained or lost, or a purchase the "
  .. "engine did not move. "
  .. "A fight ends by a kill, a flee, or YOUR end_combat call — never by narration: if the creature is "
  .. "parleyed with, bought off, or withdraws, call end_combat, or the player stays trapped behind it. "
  .. "The delve ends ONLY by death, the relic, or the player climbing out from the top floor — the 'up' verb, "
  .. "which Lua performs, never you. If the player wants to leave, point them at the stair they came down; "
  .. "NEVER narrate an exit, a return to the hall, or any location the engine did not put them in. "
  .. "The floor pack below is BACKSTAGE: never quote room ids, stats, prices, rewards, or the contents of "
  .. "rooms the player has not visited. "
  .. "After the tools, narrate the outcome in 1-3 terse sentences, second person."

local CHAT_PROMPT = "You are the scene-runner for one event in a guild-hall RPG. You write EVERY participant "
  .. "except the player — all of them, in one response. Cast the scene from the registry: list_characters "
  .. "before inventing anyone, get_character for a character's file and their history with the player, "
  .. "register_character to file someone NEW, add_to_chat to bring them on stage. Never speak for the player. "
  .. "The STORY SO FAR below is the public record: honor it over assumption, and inspect_summary zooms into "
  .. "any line of it. A character whose dossier is EMPTY has NO history with the player — they have never "
  .. "met; write them that way, with no assumed familiarity the record doesn't show. "
  .. "When the scene is spent, close_event with a gist and one take PER PARTICIPANT. "
  .. "Your visible reply is ALWAYS in-character fiction — even on the closing turn: end on the scene's last "
  .. "in-character beat, NEVER a summary of what happened, what you filed, or that the event is over (the gist "
  .. "and takes live inside close_event; the player must never read them as your report). "
  .. "Terse, concrete, in character.\\n\\nEVENT: "

-- The receptionist's opener — also the card's greeting. On the onboarding turn
-- the script seeds it as a PRIOR assistant message in the span ("something the
-- model wrote on a previous output") so the scene-runner sees her already on
-- stage and just continues, instead of cold-starting through a
-- list_characters/add_to_chat dance. Keep this EXACTLY in sync with the
-- card's first_mes (FIRST_MES in server/scripts/add-guildhall.ts) — the
-- seeded message must be the text the player actually read.
local GREETING = [[The guildhall’s reception desk is a slab of oak lost under forms. Behind it sits a woman with ink to the elbows, eating a donut — powdered sugar on her collar — who does not look up.

“Donut? No? Your loss. Best in Thornwall, and I’m not telling you where I get them.” She licks a finger and slides a blank form your way. “Welcome to the Guildhall. Name and trade, newcomer — let’s get you registered.”

*Tell her your name and trade.*]]

-- Span-is-prompt: the event's prompt IS its record, and node zero is the
-- system briefing (instructions + event context + the STORY SO FAR at open
-- time). The card starts the span when it seeds node zero — right after the
-- event opens. The script-opened registration event also gets the
-- receptionist's greeting as a prior assistant message.
local function ensureSpanSeeded()
  if ev.hasSpan() then return end -- cheap probe: decoding the whole span to check emptiness is waste
  local nodeZero = { role = "system", content = CHAT_PROMPT .. ev.eventLine() .. rolling.briefing(state.story) }
  if state.event.kind == "registration" then
    ev.spanStart({ nodeZero, { role = "assistant", content = GREETING } })
  else
    ev.spanStart({ nodeZero })
  end
end

-- The scene-runner: the events engine's full toolset PLUS rolling — the
-- STORY SO FAR rides node zero of the span, and inspect_summary lets the
-- model zoom into it instead of guessing. The model never types a bracket —
-- ev.strip removes freelanced tags; the cast rides the newest message via
-- ev.castLine(); the script splices the close tag.
local function chatToolset()
  local ts = toolset.new()
  ts:use(ev)
  ts:use(rolling)
  -- Onboarding: file the newcomer's name and roll their starting stats. The
  -- receptionist calls this during registration, then close_event hands them
  -- into the hall. The result is deliberately stat-free: hp/atk/gold live on
  -- the delve HUD, and a result that returns them gets read back to the
  -- player ("23 HP, 5 attack, 32 gold") — stats stay backstage until the HUD.
  ts:handle("register_player", function(args)
    -- Registration is one-time: once a name is filed the tool stays in the
    -- scene-runner's toolset for future events, but it must not rename the
    -- player mid-game.
    if state.playerName ~= "" then
      return "rejected: the player is already registered as " .. state.playerName
    end
    local name = tostring(args.name or ""):gsub("[^%w%s%-%'_]", " "):gsub("%s+", " "):gsub("^%s*(.-)%s*$", "%1")
    if name == "" then return "rejected: name required (ask the newcomer their name)" end
    state.playerName = name
    if not state.onboarded then
      state.dun.maxHp = math.random(16, 24)
      state.dun.hp = state.dun.maxHp
      state.dun.atk = math.random(3, 5)
      state.gold = math.random(20, 40)
    end
    -- The kv demo: the player's name becomes a verbatim FACT in the story
    -- channel — it rides every briefing the channel serves, never folds.
    rolling.set(state.story, "player", name)
    -- Registration closes the event ITSELF: leaving the close to the model's
    -- follow-up close_event stranded the player welcomed-but-gated behind
    -- "Finish your business here first." with no buttons (observed failure).
    -- eventTurn's closed branch pushes the story entry and clears the event.
    if state.event and state.event.kind == "registration" then
      state.event.closed = { gist = name .. " signs the guild register." }
    end
    return json.encode({ registered = name,
      note = "registered and the event is CLOSED — welcome them by name in character as the final beat (no stats, no gifts — the guild grants neither); do NOT call close_event" })
  end, {
    type = "function",
    ["function"] = { name = "register_player", description = "Register the newcomer's name (onboarding). This CLOSES the registration event — then welcome them by name as the final beat.",
      parameters = { type = "object", properties = { name = { type = "string" } }, required = { "name" } } },
  })
  return ts
end

-- One scene-runner call: the prompt is the event's span (node zero, the
-- briefing, then the full-fidelity tail — prior turns' user inputs, tool
-- rounds, and assistant replies) plus the newest user message; then the tool
-- loop, and everything this turn added goes back onto the span. The tail is
-- full-fidelity, so the model never re-issues a read it already made and the
-- delegate's prefix cache covers the whole scene.
local function chatTurn(prompt, cmd)
  ensureSpanSeeded()
  local ts = chatToolset()
  local sub = {}
  for k, v in pairs(prompt) do sub[k] = v end
  sub.tools = ts:schemas()
  sub.messages = {}
  for _, m in ipairs(ev.span()) do sub.messages[#sub.messages + 1] = m end
  -- The cast rides the newest message (volatile state, never deep in the
  -- span) — from state.event.participants, not a tag. castLine() returns the
  -- full parenthetical.
  local castNote = ev.castLine()
  local input = chrome.clean(cmd)
  if castNote ~= "" then input = input .. "\\n\\n" .. castNote end
  local newEntries = { { role = "user", content = input } }
  sub.messages[#sub.messages + 1] = newEntries[1]
  local baseLen = #sub.messages
  local res = loop.run(sub, backends.generate(sub):await(), ts:exec())
  for i = baseLen + 1, #sub.messages do newEntries[#newEntries + 1] = sub.messages[i] end
  local text = trim(ev.strip(res.text or ""))
  if text == "" then text = "The moment stretches." end
  newEntries[#newEntries + 1] = { role = "assistant", content = text }
  ev.spanAppend(newEntries)
  return text
end

-- The tools BOTH DMs carry. The dice are the engine's, never the model's;
-- the dungeon's attempt adds atk and makes failure sting, the hall's is bare.
-- The result carries ONLY the outcome: returning roll/total/difficulty had
-- the DM quoting raw mechanics to the player ("Roll: 20 — critical success",
-- crit rule invented on the spot). Backstage numbers stay backstage.
local function addAttemptTool(ts, withAtk)
  ts:handle("attempt", function(args)
    local difficulty = math.max(5, math.min(20, tonumber(args.difficulty) or 10))
    local roll = math.random(1, 20)
    local total = roll + (withAtk and state.dun.atk or 0)
    local outcome = total >= difficulty and "success" or "failure"
    local died = nil
    if withAtk and outcome == "failure" then
      state.dun.hp = math.max(0, state.dun.hp - 2) -- failure stings
      if checkDead() then died = true end -- hp loss anywhere can kill; the DM must know
    end
    return json.encode({ outcome = outcome, player_died = died,
      note = died and "the player has DIED of their wounds — narrate the death; the delve is over"
        or "the dice are the engine's, not yours — narrate THIS result; never quote rolls, totals, or difficulty" })
  end, {
    type = "function",
    ["function"] = { name = "attempt", description = "Resolve a risky action. The ENGINE rolls (d20"
      .. (withAtk and "+atk" or "") .. " vs difficulty) and decides — narrate the result it returns.",
      parameters = { type = "object", properties = { action = { type = "string" }, difficulty = { type = "integer" } }, required = { "action" } } },
  })
end

local function addSetFlagTool(ts, description)
  ts:handle("set_flag", function(args)
    local key = tostring(args.key or "")
    if key == "" then return "rejected: key required" end
    -- The engine's own flags live here too (quiet:/used:/relic): a DM-written
    -- key must not collide with the mechanics' namespace.
    if key:find(":") or key == "relic" then
      return "rejected: '" .. key .. "' is reserved for the engine — pick a story-level name"
    end
    state.flags[key] = args.value == nil and true or args.value
    return "ok: " .. key
  end, {
    type = "function",
    ["function"] = { name = "set_flag", description = description,
      parameters = { type = "object", properties = { key = { type = "string" }, value = { type = "boolean" } }, required = { "key" } } },
  })
end

-- The same-turn handoff is a DISPATCH LOOP, not a goto: the DM phase
-- adjudicates with the FULL events toolset (one toolset, two roles — a
-- nonsense call like close_event with nothing open fails as an ordinary
-- error result, and the tool loop carries it back), and when open_event
-- fires the SAME turn continues into the scene phase. DM prose is the
-- fallback — the scene's opening line wins.
local function dmDispatch(prompt, dmUserLine, rawCmd, system, ts)
  local phase = "dm"
  local reply = ""
  while phase do
    if phase == "dm" then
      local sub = {}
      for k, v in pairs(prompt) do sub[k] = v end
      sub.tools = ts:schemas()
      sub.messages = {
        { role = "system", content = system },
        { role = "user", content = dmUserLine },
      }
      local res = loop.run(sub, backends.generate(sub):await(), ts:exec())
      reply = trim(ev.strip(res.text or "")) -- DM framing, kept as fallback
      phase = ev.isOpen() and "scene" or nil -- open_event fired: continue as scene
    else -- "scene"
      local chatBlock = chatTurn(prompt, rawCmd)
      if chatBlock ~= "" then reply = chatBlock end -- the scene's opening line wins
      phase = nil
    end
  end
  if reply == "" then reply = "Nothing comes of it." end
  return reply
end

-- The dungeon escalation DM: the mutation economy AND the full events
-- toolset, so a novel action can hand off to the scene-runner mid-explore or
-- mid-fight. Combat is NOT cleared by escalation. Its pack writes (add_exit,
-- spawn_enemy) ride the registry mutation queue — flush commits them. The
-- prompt rides in so end_combat can gist the fight it closes.
local function dungeonDmToolset(prompt)
  local ts = toolset.new()
  ts:use(ledger)
  ts:use(ev)      -- the full toolset: open_event frames, the rest is the scene-runner's
  ts:use(rolling) -- inspect_summary: zoom from a story gist into the raw log

  addAttemptTool(ts, true)

  ts:handle("remove_item", function(args)
    local iname = tostring(args.name or ""):lower()
    local n = math.max(1, tonumber(args.n) or 1)
    local have = state.dun.inventory[iname] or 0
    if have < n then return "not carried: " .. iname .. " (has " .. have .. ")" end
    state.dun.inventory[iname] = have - n > 0 and have - n or nil
    return json.encode({ consumed = iname, n = n, left = state.dun.inventory[iname] or 0 })
  end, {
    type = "function",
    ["function"] = { name = "remove_item", description = "Consume items from the player's inventory. The result is canonical: if it says not carried, the player never had it.",
      parameters = { type = "object", properties = { name = { type = "string" }, n = { type = "integer" } }, required = { "name" } } },
  })

  ts:handle("add_exit", function(args)
    local to = tostring(args.to or ""):lower()
    local fid = floorOf(state.dun.room)
    local cur = subOf(state.dun.room)
    local a = roomsReg.get(fid, cur)
    local b = roomsReg.get(fid, to)
    if to == "" or not a or not b then
      local ids = {}
      for _, r in ipairs(roomsReg.list(fid)) do ids[#ids + 1] = r.id end
      table.sort(ids)
      return "rejected: destination must be a room on this floor (" .. table.concat(ids, ", ") .. ")"
    end
    if to == cur then return "rejected: a room does not connect to itself" end
    if type(a.x) ~= "number" or type(b.x) ~= "number"
      or math.abs(a.x - b.x) + math.abs(a.y - b.y) ~= 1 then
      return "rejected: " .. to .. " is not adjacent to " .. cur
        .. " (the map is a grid — only orthogonal neighbors can connect; a blown wall opens a wall, not space)"
    end
    -- Compass labels come from the geometry; both sides of the passage are written.
    local dir = b.x == a.x + 1 and "east" or b.x == a.x - 1 and "west"
      or b.y == a.y + 1 and "south" or "north"
    local opp = dir == "east" and "west" or dir == "west" and "east"
      or dir == "south" and "north" or "south"
    local ax, bx = {}, {}
    for d, t in pairs(a.exits or {}) do ax[d] = t end
    for d, t in pairs(b.exits or {}) do bx[d] = t end
    ax[dir] = to
    bx[opp] = cur
    roomsReg.update(fid, cur, { exits = ax }) -- queued; flush commits the pack
    roomsReg.update(fid, to, { exits = bx })
    return json.encode({ added = cur .. " " .. dir .. " <-> " .. to, via = tostring(args.via or "") })
  end, {
    type = "function",
    ["function"] = { name = "add_exit", description = "Open a NEW passage between the player's current room and another ADJACENT room on this floor's grid (a new pack version is written). For changed circumstances: blown walls, revealed passages. The compass labels are derived from the map's geometry.",
      parameters = { type = "object", properties = {
        to = { type = "string", description = "Adjacent room id to connect to" }, via = { type = "string" } }, required = { "to" } } },
  })

  addSetFlagTool(ts, "Set a story flag.")

  ts:handle("spawn_enemy", function(args)
    local fid = floorOf(state.dun.room)
    activeEnemyDepth = depthOfFloor(fid)
    local depth = activeEnemyDepth
    local hp = math.max(1, math.min(tonumber(args.hp) or 6, 6 + depth * 4))
    local atk = math.max(1, math.min(tonumber(args.atk) or 2, 1 + depth))
    local name = tostring(args.name or "deep thing")
    local lines = { intro = "It arrives.", hit = "It strikes.", death = "It falls." }
    state.dun.combat = { name = name, hp = hp, maxHp = hp, atk = atk, lines = lines, reward = 0 }
    -- Track the fight like a rolled encounter — untracked fights got no
    -- gist, no STORY entry, and stranded their fightLog in state (observed).
    state.dun.fightName = "fight " .. name
    state.dun.fightLog = nil
    fightLog({ role = "assistant", content = lines.intro })
    -- The spawn also joins the floor's roster — a pack write like any other,
    -- riding the registry mutation queue (best-effort: a full roster rejects
    -- the filing, the combat still happens).
    enemiesReg.create({ name = name, floor = fid, hp = hp, atk = atk, reward = 0, lines = lines })
    return json.encode({ spawned = name, clamped = { hp = hp, atk = atk } })
  end, {
    type = "function",
    ["function"] = { name = "spawn_enemy", description = "Spawn an enemy into the current room (depth-budget clamped). For consequences.",
      parameters = { type = "object", properties = { name = { type = "string" }, hp = { type = "integer" }, atk = { type = "integer" } }, required = { "name" } } },
  })

  -- The ONLY way a fight ends without a kill: parley, bargain, rout. The
  -- engine clears the combat state — a DM who merely narrates "combat ends"
  -- strands the player behind a gate the fiction says is gone (observed
  -- failure). The closed fight gets its gist like any other.
  ts:handle("end_combat", function(args)
    if not state.dun.combat then return "rejected: no fight in progress" end
    local name = state.dun.combat.name
    state.flags["quiet:" .. state.dun.room] = state.turn -- the room stays quiet, as after a kill
    state.dun.combat = nil
    local tag = state.dun.fightName
    state.dun.fightName = nil
    local log = state.dun.fightLog
    state.dun.fightLog = nil
    local gist
    if tag then gist = recordFightGist(prompt, tag, log) end
    return json.encode({ ended = name, via = tostring(args.how or ""), gist = gist,
      note = "combat is over FOR REAL — the gate is lifted; narrate the outcome, never mechanics" })
  end, {
    type = "function",
    ["function"] = { name = "end_combat", description = "End the current fight WITHOUT a kill (parley, bargain, the creature withdraws). The ENGINE clears the combat — never narrate an end to combat without this call, or the player stays trapped behind a monster the fiction says is gone.",
      parameters = { type = "object", properties = { how = { type = "string", description = "One line: how the fight actually ended" } } } },
  })

  -- The engine's half of a reward (or a price): gold and items move ONLY
  -- here. Without it the DM narrated unbacked rewards ("you take 5 gold" —
  -- the gold never moved), the failure buy_item exists to prevent in the
  -- hall (observed). Negative gold CHARGES the player (a bribe, a toll),
  -- clamped to their purse — the result says what was actually paid.
  ts:handle("grant", function(args)
    local gold = math.floor(tonumber(args.gold) or 0)
    if gold < 0 then gold = math.max(gold, -state.gold) end
    local item = nil
    if args.item ~= nil then
      item = tostring(args.item):lower():gsub("^%s*(.-)%s*$", "%1")
      if item == "" then item = nil end
    end
    if item == WIN_ITEM then
      return "rejected: the " .. WIN_ITEM .. " is never granted — it is earned from its interactable on the deepest floor"
    end
    if gold == 0 and not item then return "rejected: nothing to move (gold and/or item required)" end
    if gold ~= 0 then state.gold = state.gold + gold end
    if item then state.dun.inventory[item] = (state.dun.inventory[item] or 0) + 1 end
    return json.encode({ granted = { gold = gold ~= 0 and gold or nil, item = item }, gold = state.gold,
      note = "the engine moved it for real — narrate it as fact" })
  end, {
    type = "function",
    ["function"] = { name = "grant", description = "Move gold and/or an item between the engine and the player: positive gold or an item GRANTS, negative gold CHARGES (bribes, tolls — clamped to their purse). The result is canonical. Never narrate gold or items changing hands without this call.",
      parameters = { type = "object", properties = {
        gold = { type = "integer", description = "Positive grants, negative charges" }, item = { type = "string" } } } },
  })

  return ts
end

local function dungeonDmTurn(prompt, cmd, pack)
  state.dun.escalations = state.dun.escalations + 1
  local system = DUNGEON_DM_PROMPT .. "\\n\\nFLOOR PACK (current design):\\n" .. json.encode(pack)
    .. "\\n\\nPLAYER: hp " .. state.dun.hp .. "/" .. state.dun.maxHp .. ", atk " .. state.dun.atk
    .. ", gold " .. state.gold .. ", at " .. state.dun.room .. ", inventory: " .. invList()
    .. (state.dun.combat and ("\\nIN COMBAT with " .. state.dun.combat.name) or "")
    .. ledger.briefing()
    .. rolling.briefing(state.story)
  return dmDispatch(prompt, 'The player attempts: "' .. cmd .. '"', cmd, system, dungeonDmToolset(prompt))
end

-- The hall DM: adjudicates idle-hall actions and FRAMES events. The economy
-- is REAL here: the store and the blacksmith are advertised on the menu, so
-- the DM carries buy_item — gold is deducted and the item granted by the
-- engine, never narrated into existence (a hallucinated transaction state
-- can't back is the failure this tool exists to prevent). Items land in the
-- delve inventory (one pack on the player's back, hall or dungeon). No map
-- or enemies in the hall; the full events toolset, same as the
-- scene-runner's.
local function hallDmToolset()
  local ts = toolset.new()
  ts:use(ledger)
  ts:use(ev)      -- the full toolset, one toolset two roles
  ts:use(rolling) -- inspect_summary, same as the dungeon DM

  addAttemptTool(ts, false)
  addSetFlagTool(ts, "Set a lasting world fact.")

  ts:handle("buy_item", function(args)
    local iname = tostring(args.item or ""):lower():gsub("^%s*(.-)%s*$", "%1")
    local price = math.max(0, math.floor(tonumber(args.price) or 0))
    if iname == "" then return "rejected: item required" end
    if state.gold < price then
      return json.encode({ bought = false, reason = "the player can't afford it", gold = state.gold, price = price })
    end
    state.gold = state.gold - price
    state.dun.inventory[iname] = (state.dun.inventory[iname] or 0) + 1
    return json.encode({ bought = iname, price = price, gold_left = state.gold,
      note = "the sale is final and real — the gold is gone, the item is in the pack" })
  end, {
    type = "function",
    ["function"] = { name = "buy_item", description = "Sell the player an item (store or blacksmith): the ENGINE deducts the gold and grants the item. The result is canonical — if it says they can't afford it, the sale did not happen. Never narrate a purchase without this call.",
      parameters = { type = "object", properties = {
        item = { type = "string" }, price = { type = "integer", description = "Gold price, 0 for a gift" } },
        required = { "item", "price" } } },
  })

  return ts
end

local function hallDmTurn(prompt, cmd)
  local system = HALL_DM_PROMPT .. "\\n\\nPLAYER: gold " .. state.gold .. ", inventory: " .. invList()
    .. (state.flags.relic and " (carries the relic)" or "")
    .. ledger.briefing()
    .. rolling.briefing(state.story)
  return dmDispatch(prompt, 'The player: "' .. cmd .. '"', cmd, system, hallDmToolset())
end

-- ---------- mode helpers ----------

local function returnToHall()
  state.mode = "hall"
  state.dun.delveOver = nil
  state.dun.combat = nil
  state.dun.fightName = nil
  state.dun.hp = state.dun.maxHp
  state.dun.room = "f1" -- next delve restarts at the top (packs persist in the log)
end

-- /delve enters the dungeon: plan the floor on first contact, else drop the
-- player at the entrance of the floor they're on.
local function enterDungeon(prompt)
  local fid = floorOf(state.dun.room)
  local pack = floorPack(fid)
  if not pack then return planFloor(prompt, fid) end
  state.dun.room = fid .. ":" .. pack.entrance
  markSeen()
  return pack.description .. noticeLine(pack) .. tail(pack)
end

-- The command surface, in one place (the audit found it was undiscoverable:
-- only /delve was documented anywhere). Buttons post slash-commands; typed
-- commands work with or without the slash; anything else is fiction for a DM.
local HELP = table.concat({
  "How to play:",
  "• In the hall: delve · shop · smith — or say anything to anyone.",
  "• In the dungeon: look · north/south/east/west (or go <direction>) · attack · flee · up (deeper floors: climb up a floor; the top floor: climb out of the delve).",
  "• Type the name of something you notice in a room to interact with it (look lists them).",
  "• In a conversation: leave — step away.",
  "• Commands work with or without a leading /. Anything else you say is adjudicated by the DM.",
}, "\\n")

-- Hall menu verbs + dungeon verbs are ALL refused while an event is open.
-- Case-insensitive: a typed "Delve" or "Shop" is the verb, not a paid DM turn.
-- The set mirrors what serve() answers deterministically, bare compass words
-- included — "north" must gate exactly like "go north".
local function isModeVerb(cmd)
  local verb = cmd:lower()
  if verb == "delve" or verb == "shop" or verb == "smith" then return true end
  if verb == "attack" or verb == "flee" or verb == "up" or verb == "climb" or verb == "look" then return true end
  if verb == "go down" or verb:match("^go %w+") then return true end
  if COMPASS[verb] then return true end
  return false
end

-- ---------- the turns ----------

local function hallTurn(prompt, cmd)
  local verb = cmd:lower()
  if verb == "delve" then
    state.mode = "dungeon"
    state.dun.delveOver = nil
    return enterDungeon(prompt)
  end
  if verb == "shop" then
    return "The quartermaster grunts from behind the counter. Shelves of rope, rations, and rust. 'Say what you're after — coin first.'" .. tail(nil)
  end
  if verb == "smith" then
    return "The blacksmith does not look up. 'Arms and armor. Name it, and we'll talk coin.'" .. tail(nil)
  end
  if cmd == "" then
    return "Say something." .. tail(nil)
  end
  return hallDmTurn(prompt, cmd) .. tail(nil)
end

-- Events sit above both modes. Menu/dungeon verbs are gated; /leave is a
-- one-gen exit (a finalize that can't close the event falls back to a
-- script gist — the branch never bricks on content outcomes); otherwise the
-- scene-runner writes a reply. Closing the event resumes whatever mode was
-- active — including combat, which persisted in state.dun.combat. Either
-- way a scene closes, it joins the STORY: the gist as the line, the full
-- span as the zoomable content.
local function eventTurn(prompt, cmd)
  if isModeVerb(cmd) then
    -- Registration gates too — but say WHAT the business is, or a brand-new
    -- player reads "Finish your business" as a brush-off (observed).
    local msg = "Finish your business here first."
    if state.event and state.event.kind == "registration" then
      msg = "The receptionist is still waiting — give her your name (and your trade, if you like)."
    end
    return msg .. tail(currentPack())
  end
  if cmd:lower() == "leave" then
    local wasRegistration = state.event and state.event.kind == "registration"
    local gistLine = ev.finalize(prompt) -- the close's memoir line (plain text)
    rolling.push(state.story, {
      label = state.event.kind,
      gist = (state.event.closed and state.event.closed.gist) or ("The " .. state.event.kind .. " breaks off."),
      content = ev.span(),
    })
    ev.clear()
    -- Registration is done only once a name is on file; a close without
    -- register_player re-opens the event next turn (see ensureState).
    if wasRegistration and state.playerName ~= "" then
      state.onboarded = true
      return gistLine .. "\\n\\nYou step away; the moment ends."
        .. "\\n\\n(Type help anytime — it lists the commands.)" .. tail(currentPack())
    end
    return gistLine .. "\\n\\nYou step away; the moment ends." .. tail(currentPack())
  end
  local out = chatTurn(prompt, cmd)
  if state.event and state.event.closed then
    local wasRegistration = state.event and state.event.kind == "registration"
    rolling.push(state.story, {
      label = state.event.kind,
      gist = state.event.closed.gist,
      content = ev.span(),
    })
    -- No gist re-append here: the scene-runner's closing prose already
    -- summarizes the scene, so appending the gist read as the same summary
    -- twice. The gist's home is the STORY entry above (zoomable via
    -- inspect_summary); the player just gets the exit beat.
    ev.clear()
    if wasRegistration and state.playerName ~= "" then
      state.onboarded = true
      -- New player, new powers: this is the moment the commands matter.
      out = out .. "\\n\\n(Type help anytime — it lists the commands.)"
    else
      out = out .. "\\n\\nThe way on opens up again."
    end
  end
  return out .. tail(currentPack())
end

local function dungeonTurn(prompt, cmd)
  -- A delve that just ended (death or the relic): any input returns to hall.
  -- The death/relic line was emitted last turn with a Return button; this
  -- turn does the actual reset. The card never terminally ends.
  if state.dun.delveOver then
    returnToHall()
    return "You find your way back to the warm noise of the guildhall." .. tail(nil)
  end

  markSeen()

  -- Boundary: first contact with a floor triggers the planning sub-gen.
  local fid = floorOf(state.dun.room)
  local pack = floorPack(fid)
  if not pack then return planFloor(prompt, fid) end
  if not pack.rooms[subOf(state.dun.room)] then state.dun.room = fid .. ":" .. pack.entrance end

  local text
  local served = serve(cmd, pack)
  if served then
    if served.leave then
      -- Climbing out from the top floor: a delve ends by CHOICE too, not only
      -- by death or relic. Without this, a "I head back" escalates to a DM
      -- with no tool to make it real — it narrates the hall while the state
      -- stays in the dungeon (observed failure).
      returnToHall()
      return "You climb back toward the light, and the dark lets you go — this time. The warm noise of the guildhall closes around you." .. tail(nil)
    end
    if served.moved then
      local nfid = floorOf(state.dun.room)
      if nfid ~= fid then
        -- A stair: another floor's pack (it exists — the player came from
        -- there), or the boundary fires and a new floor is designed. Keep
        -- the room serve() chose when it names one (climb-up lands on the
        -- upper floor's stairs, not its entrance); a bare floor id (a
        -- descent, or a pack that no longer holds the room) snaps to the
        -- entrance.
        pack = floorPack(nfid)
        if not pack then return planFloor(prompt, nfid) end
        if not pack.rooms[subOf(state.dun.room)] then state.dun.room = nfid .. ":" .. pack.entrance end
        text = pack.description .. noticeLine(pack)
      else
        -- In-floor move: free, and Lua rolls the roster on entry. A move
        -- with its own line (a successful flee) keeps it ahead of the desc.
        local room = pack.rooms[subOf(state.dun.room)]
        local desc = (room and room.desc ~= "") and room.desc or pack.description
        text = (served.text and (served.text .. "\\n\\n" .. desc) or desc) .. noticeLine(pack)
        local intro = maybeRollEncounter(pack)
        if intro then text = text .. "\\n\\n" .. intro end
      end
    else
      text = served.text
      local amb = maybeAmbient(pack)
      if amb then text = text .. "\\n\\n" .. amb end
    end
  else
    text = dungeonDmTurn(prompt, cmd, pack)
    pack = floorPack(fid) or pack -- queued pack mutations resolve on read
  end

  -- A fight that just ended (kill, flee, or death) closes its summary span.
  if served and served.fightEnded then
    text = text .. endFight(prompt)
  end

  markSeen()
  return text .. tail(pack)
end

-- ---------- the turn ----------

local function realGenerate(prompt)
  local input = lastUserText(prompt)
  local cmd = chrome.unwrap(input)
  state.turn = state.turn + 1

  -- "help" is meta, not a mode verb: it answers from any mode, event or not.
  if cmd:lower() == "help" then
    registry.flush()
    return HELP .. tail(currentPack())
  end

  -- An open event is the HIGHEST gate: it pauses hall AND dungeon (combat
  -- persists) and resumes the prior mode when it closes.
  local out
  if ev.isOpen() then
    out = eventTurn(prompt, cmd)
  elseif state.mode == "hall" then
    out = hallTurn(prompt, cmd)
  else
    out = dungeonTurn(prompt, cmd)
  end
  -- Commit this turn's queued registry writes: ONE new pack blob per touched
  -- floor, one pointer move per flushed partition. Reads resolve base +
  -- queue, so this timing is about state size, never correctness.
  registry.flush()
  return out
end

function generate(prompt, ctx)
  -- Generation types: only two stances. Regenerates and swipes run the
  -- normal path (state rolls back; re-running is correct by construction).
  -- Continue/impersonate are a HARD error — thrown before the brick
  -- machinery, before even ensureState.
  if ctx and ctx.generationType ~= "send" and ctx.generationType ~= "regenerate" then
    error("This card does not support " .. tostring(ctx.generationType) .. ".")
  end
  ensureState()
  -- Failure UX: fail loudly, then brick the branch. A bricked branch refuses
  -- further input; recovery is a swipe or a rewind past the failed turn.
  if state.bricked then
    return "This branch hit an unrecoverable error and can't continue: " .. state.bricked
      .. "\\n\\nSwipe or rewind to a point before the failure to keep playing."
  end
  ledger.bind(function() return state.turn end)
  ev.bindPrompt(prompt) -- the fold's digest sub-gen inherits the turn's token budget

  -- The pcall IS the brick: a thrown turn would roll state back, brick flag
  -- included, so on error the card sets state.bricked and RETURNS the failure
  -- text — a mechanically successful turn, so the snapshot persists.
  local ok, result = pcall(realGenerate, prompt)
  if ok then return result end
  -- An ABORT is not a card failure: the user (or a client timeout) stopped the
  -- generation. Rethrow so the turn fails mechanically and state rolls back —
  -- bricking on an abort would strand a healthy branch (observed: a client-side
  -- timeout mid-planning bricked a fine branch).
  if tostring(result):lower():find("abort") then error(result) end
  state.bricked = tostring(result)
  return "Something broke this turn: " .. state.bricked
    .. "\\n\\nThis branch is bricked — swipe or rewind to retry from before the failure."
end

function list_models()
  return { { id = "the-guildhall", name = "The Guildhall" } }
end
\`\`\`

## The game lib (full sources)

\`\`\`lua
-- lib/loop.lua — the delegate tool loop.
--
-- Drives backends.generate rounds while the delegate keeps calling tools,
-- appending paired tool_use/tool_result messages to sub.messages. The exec
-- callback (name, args) -> string answers each call; loop.run knows nothing
-- about which tools exist.
--
-- Each round's assistant message is REBUILT as what the model actually
-- produced: its thinking block first (with the signature when the delegate
-- reports one), then any narration text, then the tool calls. Sending the
-- thinking back is not cosmetic — Claude with extended thinking REJECTS a
-- tool_use turn whose thinking block is missing (HTTP 400), and everywhere
-- else the replayed prefix matches the model's own output, so provider
-- prefix caches keep hitting.
--
-- Default cap is 16, not 8: a delegate with set_todo spends rounds planning
-- (set list → work → mark done → work…) on top of its real tool calls.
-- maxRounds overrides per call. If the cap is hit with tool calls still
-- pending, loop.run THROWS — a wedged delegate fails the turn loudly (the
-- user sees which tools it was stuck on; a swipe retries) instead of
-- silently dropping the model's pending work.
--
-- opts (both for "the work may already be done" loops, e.g. an event
-- finalizer whose close_event already landed):
--   done  — zero-arg predicate checked before each round; when true the
--           loop stops early and returns the last res (pending toolCalls
--           cleared). Once the goal state is reached, further rounds are
--           pure downside.
--   soft  — hitting the cap RETURNS the last res instead of throwing. The
--           caller owns the fallback (the tool results already executed
--           are real either way).

local M = {}

function M.run(sub, res, exec, maxRounds, opts)
  opts = opts or {}
  local rounds = 0
  local cap = maxRounds or 16
  while res.toolCalls and #res.toolCalls > 0 and rounds < cap
    and not (opts.done and opts.done()) do
    rounds = rounds + 1
    local content = {}
    if type(res.reasoning) == "string" and res.reasoning ~= "" then
      local thought = { type = "reasoning", text = res.reasoning }
      if type(res.reasoningSignature) == "string" and res.reasoningSignature ~= "" then
        thought.signature = res.reasoningSignature
      end
      content[#content + 1] = thought
    end
    if type(res.text) == "string" and res.text ~= "" then
      content[#content + 1] = { type = "text", text = res.text }
    end
    for _, call in ipairs(res.toolCalls) do
      content[#content + 1] = { type = "tool_use", id = call.id, name = call.name, input = call.arguments }
      content[#content + 1] = { type = "tool_result", toolUseId = call.id, name = call.name, content = exec(call.name, call.arguments) }
    end
    sub.messages[#sub.messages + 1] = { role = "assistant", content = content }
    res = backends.generate(sub):await()
  end
  if res.toolCalls and #res.toolCalls > 0 then
    if opts.soft or (opts.done and opts.done()) then
      res.toolCalls = nil -- the caller's fallback owns what happens next
      return res
    end
    local names = {}
    for _, call in ipairs(res.toolCalls) do names[#names + 1] = call.name end
    error("tool loop exceeded " .. cap .. " rounds and the delegate is still calling tools ("
      .. table.concat(names, ", ") .. ") — raise maxRounds or fix whatever keeps it looping", 2)
  end
  return res
end

return M
\`\`\`

\`\`\`lua
-- lib/sanitize.lua — decoded-JSON hygiene.
--
-- json.decode maps JSON null to a truthy js_null userdata, NOT Lua nil —
-- \`if pack.encounter then\` would take the wrong branch and \`..\` on it errors.
-- sanitize.data strips anything that isn't plain data before use.
--
-- ALIASING CONTRACT (mixed by necessity): an ARRAY argument is REBUILT — the
-- return value is a fresh table and the input is untouched (nil-ing a null
-- element in place would punch a sequence hole and break #/ipairs). A MAP
-- argument is MUTATED IN PLACE — the same table comes back, cleaned, and
-- every alias sees the cleaning. So always use the return value, and never
-- assume the input survived unchanged.

local M = {}

function M.data(t)
  if type(t) ~= "table" then return t end
  -- A JSON array may hold null (a truthy js_null sentinel); nil-ing an integer
  -- key would punch a sequence hole and break #/ipairs downstream. So arrays
  -- are rebuilt without holes; maps are cleaned in place.
  local isSeq = true
  for k, _ in pairs(t) do if type(k) ~= "number" then isSeq = false break end end
  if isSeq then
    local out = {}
    for _, v in ipairs(t) do
      local tv = type(v)
      if tv == "table" then out[#out + 1] = M.data(v)
      elseif tv == "string" or tv == "number" or tv == "boolean" then out[#out + 1] = v end
    end
    return out
  end
  for k, v in pairs(t) do
    local tv = type(v)
    if tv == "table" then t[k] = M.data(v)
    elseif tv ~= "string" and tv ~= "number" and tv ~= "boolean" then t[k] = nil end
  end
  return t
end

return M
\`\`\`
\`\`\`lua
-- lib/chrome.lua — player-facing chrome helpers and text hygiene.
--
-- Acks are plain VISIBLE text: the model sees what the player sees, and a
-- capable model needs nothing hidden from it — so game cards have no [sys]
-- tag. (unwrap and clean still tolerate legacy [sys]-wrapped text on the way
-- in.) In-fiction results of player actions are the game's feedback loop;
-- serve them as visible text.

local M = {}

-- Bare command payloads — never wrapped in any tag a display rule hides:
-- display regexes are structure-blind and would mangle the attribute,
-- killing the button.
function M.btn(cmd, label)
  return '<button data-post-response="/' .. cmd .. '">' .. label .. "</button>"
end

-- "[sys]/go north[/sys]" (legacy) or "go north" / "/go north" → "go north"
function M.unwrap(text)
  local inner = text:match("^%s*%[sys%](.-)%[/sys%]%s*$") or text
  inner = inner:gsub("^%s*(.-)%s*$", "%1")
  return (inner:gsub("^/+", ""))
end

-- The deterministic cleaning every delegate view shares: strip legacy
-- [sys]…[/sys], <button>…</button>, [HUD…], and [MAP…]; trim. Transcript and
-- the event span BOTH use this — the append-only-prefix property of the event
-- span depends on the cleaning never diverging between views. Both script
-- tags go: a delegate that ever sees transcript text must not inherit chrome.
function M.clean(text)
  return (tostring(text or "")
    :gsub("%s*%[sys%].-%[/sys%]%s*", "\\n\\n")
    :gsub("%s*<button.-</button>", "")
    :gsub("%[HUD[^%]]*%]", "")
    :gsub("%[MAP[^%]]*%]", "")
    :gsub("^%s*(.-)%s*$", "%1"))
end

-- One safe line: double quotes become single (so the result can ride a
-- summary="…" attribute), whitespace collapses, ends trim. The text itself is
-- never cut — max is opt-in and used for previews/excerpts only (the zoom
-- chain's inspect rendering); filing channels call this WITHOUT a max.
function M.oneline(text, max)
  local s = tostring(text or "")
    :gsub('"', "'")
    :gsub("%s+", " ")
    :gsub("^%s*(.-)%s*$", "%1")
  if max then s = s:sub(1, max) end
  return s
end

return M
\`\`\`
\`\`\`lua
-- lib/ledger.lua — the plot ledger: long-term commitments the delegate files
-- for its future self (foreshadowing, scheduled events, threats that mature).
--
-- Prose cannot carry these: rolling summaries paraphrase foreshadowing away.
-- The ledger is the compaction-proof channel — what's registered is INTENT.
-- Storage is state.promises, so it is branch-aware: a promise filed in a
-- swiped-away turn vanishes with the branch; once persisted, it is canon.
--
-- The ledger rides in every delegate prompt (ledger.briefing); Lua computes
-- due-ness from \`now\` and escalates to DUE NOW. Lifecycle includes failure:
-- pending → kept / failed, and failure is canon too.
--
-- \`now\` is whatever the card's clock says — turns, floors, weeks — bound once
-- per turn with ledger.bind(fn). A filed due date is clamped to now+1 …
-- now+50 of those units: never this turn, never past the horizon. The lib
-- never touches \`state\` beyond its own key.
--
-- SET semantics (the ledger is non-compacting information): records are keyed
-- by id — promise({ id, … }) with an existing id REPLACES the first entry with
-- that id regardless of status (latest is canon, never a duplicate; a resolved
-- id re-filed is REOPENED as pending, so resolve_promise can never strand a
-- shadow copy), and resolve_promise overwrites the status even on a resolved
-- entry.

local M = {}

local getNow = function() return 0 end

--- Bind the card's turn counter: ledger.bind(function() return state.turn end)
function M.bind(fn) getNow = fn end

local function promises()
  if type(state) ~= "table" then state = {} end
  state.promises = state.promises or {}
  return state.promises
end

function M.tools()
  return { {
    type = "function",
    ["function"] = {
      name = "promise",
      description = "File a plot debt for your future self: something that MUST happen at a later turn (foreshadowing, a scheduled event, a threat that matures). due is an ABSOLUTE turn number (not 'in N turns from now'), clamped to now+1 through now+50.",
      parameters = { type = "object", properties = {
        id = { type = "string" }, what = { type = "string" }, due = { type = "integer" } }, required = { "id", "what", "due" } },
    },
  }, {
    type = "function",
    ["function"] = {
      name = "resolve_promise",
      description = "Mark a plot-ledger entry as kept or failed once it comes due.",
      parameters = { type = "object", properties = {
        id = { type = "string" }, outcome = { type = "string", enum = { "kept", "failed" } } }, required = { "id" } },
    },
  } }
end

--- Answers promise/resolve_promise; returns nil when the name is not a ledger
--- tool (so toolset composition can try the next module).
function M.exec(name, args)
  local now = getNow()
  if name == "promise" then
    local id = tostring(args.id or "")
    local what = tostring(args.what or "")
    local due = tonumber(args.due)
    -- The critical validation: a concrete due anchor. No "later".
    if id == "" or what == "" or due == nil then
      return "rejected: id, what, and a concrete due are required"
    end
    due = math.max(now + 1, math.min(math.floor(due), now + 50))
    -- Set semantics: re-filing an existing id REPLACES the first entry with
    -- that id, whatever its status — latest is canon, and the re-file REOPENS
    -- a resolved entry (status cleared), so no shadow duplicate can survive
    -- for resolve_promise to strand.
    for _, p in ipairs(promises()) do
      if p.id == id then
        p.what = what
        p.due = due
        p.status = nil
        return json.encode({ promised = id, due = due, replaced = true })
      end
    end
    local list = promises()
    list[#list + 1] = { id = id, what = what, due = due }
    return json.encode({ promised = id, due = due })
  end
  if name == "resolve_promise" then
    local id = tostring(args.id or "")
    -- Only two canon outcomes; anything else is a model slip, not a "kept".
    if args.outcome ~= "kept" and args.outcome ~= "failed" then
      return "rejected: outcome must be \\"kept\\" or \\"failed\\""
    end
    for _, p in ipairs(promises()) do
      if p.id == id then
        p.status = args.outcome
        return json.encode({ resolved = id, outcome = p.status })
      end
    end
    return "unknown promise: " .. id
  end
  return nil
end

--- The briefing is the memory: pending debts with due-ness computed by Lua.
function M.briefing()
  local now = getNow()
  local lines = {}
  for _, p in ipairs(promises()) do
    if p.status == "failed" then
      -- Failure is canon: it stays on screen so the model honors the consequence
      -- (a closed route, a broken oath) instead of forgetting it ever happened.
      lines[#lines + 1] = string.format("- [FAILED — canon] %s: %s", p.id, p.what)
    elseif not p.status then
      local tag = "pending"
      if now >= p.due then tag = "DUE NOW"
      elseif now == p.due - 1 then tag = "due next turn" end
      lines[#lines + 1] = string.format("- [%s] %s (due %d): %s", tag, p.id, p.due, p.what)
    end
  end
  if #lines == 0 then return "" end
  return "\\nPLOT LEDGER (canon — honor it, resolve with resolve_promise when due):\\n" .. table.concat(lines, "\\n")
end

return M
\`\`\`
\`\`\`lua
-- lib/toolset.lua — compose modules and ad-hoc handlers into ONE toolset:
-- a single schemas array for sub.tools and a single exec for the tool loop.
--
-- Every lib module conforms to the same mini-contract (plain dot calls;
-- registry instances are closures, so the same call shape works for both):
--   mod.tools()            -> array of tool schemas (may be {})
--   mod.exec(name, args)   -> string | nil   (nil = "not mine", try the next)
--
-- Order is explicit and matters: the FIRST non-nil answer wins, and it ends
-- with "unknown tool: X". Replaces hand-rolled try-chains of if-statements.
-- Duplicate tool names are rejected at composition time — "first non-nil
-- wins" would otherwise shadow one of them silently.

local M = {}

function M.new()
  local schemas = {}
  local execs = {}
  local names = {}
  local ts = {}

  local function addSchemas(list)
    if type(list) == "table" then
      for _, s in ipairs(list) do
        local name = s["function"] and s["function"].name
        if name then
          if names[name] then error("toolset: duplicate tool '" .. name .. "'", 3) end
          names[name] = true
        end
        schemas[#schemas + 1] = s
      end
    end
  end

  --- Compose a module (anything with tools()/exec()).
  function ts:use(mod)
    addSchemas(mod.tools())
    execs[#execs + 1] = mod.exec
    return ts
  end

  --- Add an ad-hoc tool: name, handler(args) -> string, optional schema.
  function ts:handle(name, fn, schema)
    if schema then
      addSchemas({ schema }) -- registers and checks the schema's own name
    else
      if names[name] then error("toolset: duplicate tool '" .. name .. "'", 2) end
      names[name] = true
    end
    execs[#execs + 1] = function(n, args)
      if n == name then return fn(args or {}) end
      return nil
    end
    return ts
  end

  --- The concatenated schemas, for sub.tools.
  function ts:schemas() return schemas end

  --- The composed exec, for loop.run.
  function ts:exec()
    return function(name, args)
      for _, e in ipairs(execs) do
        local r = e(name, args)
        if r ~= nil then return r end
      end
      return "unknown tool: " .. tostring(name)
    end
  end

  return ts
end

return M
\`\`\`
\`\`\`lua
-- lib/todo.lua — delegate self-planning: a scratch checklist the model files
-- before and while it works, so multi-step jobs (design a floor, write a
-- content pack) survive the tool loop's amnesia.
--
-- Storage is state.todos — branch-aware: a swiped-away plan vanishes with its
-- branch, and a task spanning turns can resume. Distinct from the ledger:
-- todos are the delegate's own scratch plan; the ledger is canon commitments.
--
-- Every todo tool result echoes the REMAINING list, so the plan rides the
-- tool loop for free — the model sees its own checklist on every round
-- without spending prompt.

local M = {}

local function todos()
  if type(state) ~= "table" then state = {} end
  state.todos = state.todos or {}
  return state.todos
end

local function remaining()
  local out = {}
  for i, t in ipairs(todos()) do
    if not t.done then out[#out + 1] = i .. ". " .. t.text end
  end
  if #out == 0 then return "none" end
  return table.concat(out, "; ")
end

function M.tools()
  return { {
    type = "function",
    ["function"] = {
      name = "set_todo",
      description = "Set your plan: a short ordered checklist for the task at hand. REPLACES the current list — restate it each time. Work the items, then mark them done with todo_done.",
      parameters = { type = "object", properties = {
        items = { type = "array", items = { type = "string" } } }, required = { "items" } },
    },
  }, {
    type = "function",
    ["function"] = {
      name = "todo_done",
      description = "Mark one plan item done by its 1-based index.",
      parameters = { type = "object", properties = {
        index = { type = "integer" } }, required = { "index" } },
    },
  } }
end

function M.exec(name, args)
  if name == "set_todo" then
    -- items is required by the schema: a missing or non-array value is a
    -- malformed call, so reject it instead of silently erasing the plan.
    if type(args.items) ~= "table" then
      return "rejected: items must be an array of strings — the plan is unchanged. remaining: " .. remaining()
    end
    local list = todos()
    while #list > 0 do table.remove(list) end
    for _, item in ipairs(args.items) do
      local text = tostring(item)
      if text ~= "" then list[#list + 1] = { text = text, done = false } end
    end
    return "plan set (" .. #list .. " items). remaining: " .. remaining()
  end
  if name == "todo_done" then
    local i = tonumber(args.index)
    local list = todos()
    if not i or not list[i] then return "rejected: no item " .. tostring(args.index) .. " — remaining: " .. remaining() end
    if list[i].done then
      return "already done: " .. list[i].text .. ". remaining: " .. remaining()
    end
    list[i].done = true
    return "done: " .. list[i].text .. ". remaining: " .. remaining()
  end
  return nil
end

return M
\`\`\`
\`\`\`lua
-- lib/registry.lua — ThingRegistry: declare "a registry of something" and get
-- a full tool (plus optional query/update/custom tools) that OWNS the
-- Fact-lane rules: validate on entry, clamp numbers to budgets, closed lists,
-- id assignment, the canonical tool result, swipe-stability through \`state\`.
--
-- The model invents; Lua files. The tool result is the canonical record —
-- what was ACTUALLY filed, numeric clamps and dropped entries included — so
-- the model's continuing narration matches fact. Text is filed verbatim:
-- truncating prose would fill the registry with cut-off natural language, so
-- string fields take any length. Re-registering an existing id returns the
-- EXISTING record instead of overwriting: on regenerate, state has rolled
-- back and re-filing converges to the same record — swipe-stable by
-- construction. The fallback slug "thing" is never a real id: id_from must
-- name a DECLARED field (checked at construction) and a missing routing
-- value rejects the file — otherwise every record would converge on one
-- slug and the registry would silently cap at a single record.
--
-- STORAGE, two shapes:
--   * Unpartitioned (default): a plain array of records at state[key]
--     (branch-aware), each record carrying its assigned \`id\`. Planning mode:
--     pass store.get to file into a draft table instead of \`state\`.
--   * Partitioned (partition_by declared): records live in PACKS — one store
--     blob per partition, shared by every partitioned registry using the same
--     packs_key (default state.packIds). state carries only the pointer
--     table: state[packs_key] maps each partition name to that partition's
--     pack blob id ({ f1 = "pack#7", craft = "pack#3", … }). The partition is
--     a property OF THE RECORD, read at file time (a monster's partition is
--     the floor it spawns on). Declare partition_by as a FIELD NAME
--     ("floor") whenever the routing field is a real record field: the
--     model-facing query/update tools then ask for it by its DOMAIN name
--     ("the floor the monster is on" — never the word "partition") and every
--     lookup lands in exactly one partition. A function-form partition_by
--     routes the same but leaves the field anonymous, so model-facing
--     lookups must scan all partitions — and an id filed in several
--     partitions is a loud rejection, never a silent guess.
--
-- WRITES (partitioned): a write updates nothing on disk immediately — it
-- queues a mutation record in state._regq (branch-aware) and every READ
-- resolves base blob + queue, so the in-memory view is live at once. The
-- card calls registry.flush() ONCE at the end of generate(): flush groups
-- the queue by partition, applies each group to its pack, does ONE new
-- store.putJson per touched pack, and updates state.packIds[pk] for the
-- flushed partitions only. A forgotten flush is a state-size issue, never a
-- correctness one — the queue rides state, so the next flush (even next
-- turn) compacts it. Swipe correctness falls out: a flush is a NEW put plus
-- a pointer move, so old branches keep their old blob.
--
-- MUTABLE FIELDS (set semantics): registry records are non-compacting
-- information — some fields legitimately EVOLVE (appearance, status).
-- Declare mutable = { "appearance", … } and the registry emits an update
-- tool that OVERWRITES the listed fields on the existing record (same
-- validation and clamps, id stable, latest value canon).
--
-- CUSTOM QUERIES: queries = { { name, args = {...}, run = fn } } adds a read
-- tool (schema built from args) AND a card-side method of the same name.
-- run(records, args) receives the full cross-partition record list.
--
--   local enemies = registry.new({
--     tool = "register_enemy",
--     description = "Register an enemy design. Lua clamps stats to the power budget.",
--     key = "enemies",
--     id_from = "name",
--     partition_by = "floor",               -- optional: packs; a FIELD NAME routes
--                                           --   and names the lookup argument
--     packs_key = "packIds",                -- optional; shared pointer table
--     mutable = { "hp" },                   -- optional: emits update_enemy
--     update_tool = "update_enemy",         -- optional; derived by default
--     query_tool = "get_enemy",             -- optional; omit for no query tool
--     cap = 8,                              -- optional max records (per partition when partitioned)
--     fields = {                            -- ARRAY: order is preserved in the schema
--       { name = "name", type = "string", required = true },
--       { name = "hp",   type = "integer", min = 1, max = 20, default = 6 },
--       -- min/max may be zero-arg functions (depth-scaled budgets):
--       { name = "atk",  type = "integer", min = 1, max = function() return 1 + depth() end, default = 2 },
--       { name = "tags", type = "array", closed = { "flying", "reflect_magic" } },
--       { name = "lines", type = "table" },   -- passthrough; shape it in on_register
--     },
--     queries = {                           -- optional custom read tools
--       { name = "recipes_with_item",
--         args = { { name = "item", type = "string", required = true } },
--         run = function(records, args) … return matching end },
--     },
--     on_register = function(rec) ... end,  -- optional: reshape/side effects
--   })
--
-- Instance surface (conforms to the lib module contract — plain dot calls):
--   R.tools() -> array              R.exec(name, args) -> string|nil
--   Unpartitioned:   R.list()  R.get(id)      R.create(fields)  R.update(id, fields)
--   Partitioned:     R.list(pk)  R.get(pk, id) R.create(fields) R.update(pk, id, fields)
--     (create derives the partition from the record via partition_by)
--   R.all() -> array  (cross-partition when partitioned) — LIVE records when
--     unpartitioned (mutate in place, every consumer sees it); RESOLVED
--     copies when partitioned — mutate those via R.update, not in place.
--   R.briefing(pk?) -> string       -- one line per record, for delegate
--     briefings ("" when empty); lib/events builds list_characters on it
--
-- Module level: registry.flush() — see WRITES above.

local sanitize = require("lib/sanitize")

local M = {}

-- Pack blob bodies are IMMUTABLE (a flush is a new put plus a pointer move),
-- so fetched bodies are memoized module-wide by pointer id — every
-- partitioned registry sharing a packs_key shares the cache, and one serve
-- turn's repeated floorPack() calls cost ONE store round-trip per pack
-- instead of four-plus. The DECODE still runs per call on purpose:
-- resolvePartition mutates records in place while applying the queue, and a
-- shared decoded table would let those mutations leak between resolves.
local packBodies = {} -- pid -> raw body string

local function slugify(s)
  local slug = tostring(s or ""):lower():gsub("[^%w]+", "-"):gsub("^-+", ""):gsub("-+$", "")
  if slug == "" then slug = "thing" end
  return slug
end

local function bound(v)
  if type(v) == "function" then return v() end
  return v
end

--- Coerce ONE field value per its spec. Returns value, dropped (array of
--- closed-list rejections; nil otherwise).
local function coerceOne(f, v)
  if f.type == "integer" then
    local n = tonumber(v)
    if n == nil then n = f.default end
    if n ~= nil then
      n = math.floor(n)
      local lo, hi = bound(f.min), bound(f.max)
      if lo ~= nil and n < lo then n = lo end
      if hi ~= nil and n > hi then n = hi end
      return n
    end
    return nil
  elseif f.type == "array" then
    if type(v) == "table" then
      local arr, dropped = {}, nil
      for _, item in ipairs(v) do
        local s = tostring(item)
        if f.closed then
          local ok = false
          for _, allowed in ipairs(f.closed) do
            if s == allowed then ok = true break end
          end
          if ok then arr[#arr + 1] = s else
            dropped = dropped or {}
            dropped[#dropped + 1] = s
          end
        else
          arr[#arr + 1] = s
        end
      end
      return arr, dropped
    end
    return nil -- a non-table array arg stays nil → missing (full coerce) or skipped (partial)
  elseif f.type == "table" then
    if type(v) == "table" then return v end
    return nil
  else -- string
    if v ~= nil then return tostring(v) end
    if f.default ~= nil then return tostring(f.default) end
    return ""
  end
end

--- Coerce args per the field specs (a full file). Returns rec, dropped, missing.
local function coerce(fields, args)
  local rec, dropped, missing = {}, {}, {}
  for _, f in ipairs(fields) do
    local v, d = coerceOne(f, args[f.name])
    if f.type == "array" and v == nil and not f.required then
      v = {}
    end
    rec[f.name] = v
    if d then for _, s in ipairs(d) do dropped[#dropped + 1] = s end end
    if f.required and (rec[f.name] == nil or rec[f.name] == "") then
      missing[#missing + 1] = f.name
    end
  end
  return rec, dropped, missing
end

--- Coerce only the listed mutable fields PRESENT in args (an update).
--- Returns partial, dropped.
local function coercePartial(fields, args, mutableSet)
  local partial, dropped = {}, {}
  for _, f in ipairs(fields) do
    if mutableSet[f.name] and args[f.name] ~= nil then
      local v, d = coerceOne(f, args[f.name])
      if v ~= nil then partial[f.name] = v end
      if d then for _, s in ipairs(d) do dropped[#dropped + 1] = s end end
    end
  end
  return partial, dropped
end

local function fieldSchema(f)
  if f.type == "integer" then return { type = "integer" } end
  if f.type == "array" then return { type = "array", items = { type = "string" } } end
  if f.type == "table" then return { type = "object" } end
  return { type = "string" }
end

local RESERVED_METHODS = {
  tools = true, exec = true, get = true, all = true, list = true,
  create = true, update = true, briefing = true, fieldNames = true,
}

function M.new(def)
  -- partition_by: a field NAME ("floor") or a function(rec). The string form
  -- is preferred — it names the routing field, so model-facing query/update
  -- tools can ask for it by its domain name ("the floor the monster is on").
  -- A bare function routes fine but leaves the routing field anonymous, and
  -- the model-facing lookups can only scan (see findAll/ambiguity).
  local partitionField = def.partition_field
  local partition_by = def.partition_by
  if type(partition_by) == "string" then
    partitionField = partition_by
    local f = partition_by
    partition_by = function(rec) return rec[f] end
  end
  local partitioned = partition_by ~= nil
  local packsKey = def.packs_key or "packIds"
  if partitioned and def.store then
    error("registry.new: store (draft mode) and partition_by don't combine — "
      .. "partitioned writes ARE the commit path; drop one", 2)
  end
  local known = {}
  for _, f in ipairs(def.fields or {}) do known[f.name] = true end
  -- The routing field must be a real field — the model can't name a floor the
  -- record doesn't carry.
  if partitionField and not known[partitionField] then
    error("registry.new: partition field '" .. tostring(partitionField) .. "' is not a declared field", 2)
  end
  local mutableSet = {}
  if def.mutable then
    for _, name in ipairs(def.mutable) do
      if not known[name] then
        error("registry.new: mutable field '" .. tostring(name) .. "' is not a declared field", 2)
      end
      mutableSet[name] = true
    end
  end
  -- id_from routes the record to its slug; an undeclared field would file
  -- every record under the same fallback slug, capping the registry at one.
  if def.id_from and not known[def.id_from] then
    error("registry.new: id_from '" .. tostring(def.id_from) .. "' is not a declared field", 2)
  end
  local updateTool = def.update_tool
  if not updateTool and def.mutable then
    updateTool = (def.tool or ""):gsub("^register_", "update_")
    if updateTool == def.tool or updateTool == "" then updateTool = "update_" .. tostring(def.key) end
  end
  local queries = def.queries or {}
  for _, q in ipairs(queries) do
    if RESERVED_METHODS[q.name] or q.name == def.tool or q.name == def.query_tool or q.name == updateTool then
      error("registry.new: query name '" .. tostring(q.name) .. "' collides with a built-in", 2)
    end
  end

  local R = {}
  -- Shape marker for consumers whose call conventions differ by partitioning
  -- (lib/events needs an UNPARTITIONED roster: it looks members up one-arg).
  R.partitioned = partitioned

  -- ---------- storage ----------

  -- Unpartitioned records (or the draft table in planning mode).
  local function records()
    if def.store and def.store.get then return def.store.get() end
    if type(state) ~= "table" then state = {} end
    state[def.key] = state[def.key] or {}
    return state[def.key]
  end

  local function mutationQueue()
    if type(state) ~= "table" then state = {} end
    state._regq = state._regq or {}
    return state._regq
  end

  local function loadPackBlob(pks, pk)
    local pid = type(state) == "table" and state[pks] and state[pks][pk] or nil
    if not pid then return {} end
    local body = packBodies[pid]
    if not body then
      body = store.getJson(pid):await()
      if not body then
        error("registry: pack blob missing for partition " .. tostring(pk) .. " (" .. tostring(pid)
          .. ") — blobs are script-written, this is a bug", 3)
      end
      packBodies[pid] = body
    end
    return sanitize.data(json.decode(body))
  end

  --- The live view of one partition for THIS registry: base blob records
  --- plus this registry's queued mutations, in order. Returns array, byId.
  local function resolvePartition(pk)
    local base = loadPackBlob(packsKey, pk)
    local recs, byId = {}, {}
    for _, rec in ipairs(base[def.key] or {}) do
      recs[#recs + 1] = rec
      byId[rec.id] = rec
    end
    for _, m in ipairs(mutationQueue()) do
      if m.pks == packsKey and m.pk == pk and m.reg == def.key then
        if m.op == "set" then
          if byId[m.id] then
            local old = byId[m.id]
            for k in pairs(old) do old[k] = nil end
            for k, v in pairs(m.rec) do old[k] = v end
          else
            recs[#recs + 1] = m.rec
            byId[m.id] = m.rec
          end
        else -- update
          local old = byId[m.id]
          if old then for k, v in pairs(m.fields) do old[k] = v end end
        end
      end
    end
    return recs, byId
  end

  --- Every partition key this registry has records in (pointer table +
  --- queue), sorted for determinism.
  local function partitionKeys()
    local seen, out = {}, {}
    if type(state) == "table" and type(state[packsKey]) == "table" then
      for pk in pairs(state[packsKey]) do
        if not seen[pk] then seen[pk] = true out[#out + 1] = pk end
      end
    end
    for _, m in ipairs(mutationQueue()) do
      if m.pks == packsKey and m.reg == def.key and not seen[m.pk] then
        seen[m.pk] = true
        out[#out + 1] = m.pk
      end
    end
    table.sort(out)
    return out
  end

  local function allRecords()
    if not partitioned then return records() end
    local out = {}
    for _, pk in ipairs(partitionKeys()) do
      for _, rec in ipairs(resolvePartition(pk)) do out[#out + 1] = rec end
    end
    return out
  end

  --- Find by id or id_from value. Partitioned: scans all partitions and also
  --- returns the partition the record lives in (nil when not found).
  local function findRecord(idOrName)
    local needle = tostring(idOrName or ""):lower()
    if not partitioned then
      for _, rec in ipairs(records()) do
        if rec.id == needle then return rec end
        if def.id_from and tostring(rec[def.id_from] or ""):lower() == needle then return rec end
      end
      return nil
    end
    for _, pk in ipairs(partitionKeys()) do
      local recs = resolvePartition(pk)
      for _, rec in ipairs(recs) do
        if rec.id == needle then return rec, pk end
        if def.id_from and tostring(rec[def.id_from] or ""):lower() == needle then return rec, pk end
      end
    end
    return nil
  end

  --- Find within ONE named partition (ids are stored slugified; normalize the
  --- needle so this exact lookup agrees with the case-insensitive scan).
  local function findInPartition(pk, idOrName)
    local recs, byId = resolvePartition(tostring(pk))
    local rec = byId[slugify(idOrName)]
    if rec then return rec end
    local needle = tostring(idOrName or ""):lower()
    for _, r in ipairs(recs) do
      if def.id_from and tostring(r[def.id_from] or ""):lower() == needle then return r end
    end
    return nil
  end

  --- The partition a model-facing call named, or nil plus a rejection string.
  --- The routing field is REQUIRED on partitioned lookups: "the floor the
  --- monster is on" is a domain fact the model knows, not hidden machinery.
  local function namedPartition(args)
    local pk = args and args[partitionField]
    if pk == nil or pk == "" then
      return nil, "rejected: " .. partitionField .. " is required"
    end
    return tostring(pk)
  end

  --- ALL (rec, pk) matches across partitions — the fallback for a partitioned
  --- registry whose routing field is ANONYMOUS (function-form partition_by):
  --- the model-facing execs can't ask for the partition by name, so an id
  --- living in several partitions is an ambiguity they must REPORT — not a
  --- coin flip in sorted-key order (findRecord returns the f1 goblin even
  --- when the player is on f2).
  local function findAll(idOrName)
    local needle = tostring(idOrName or ""):lower()
    local out = {}
    local function match(rec, pk)
      if rec.id == needle then return true end
      return def.id_from and tostring(rec[def.id_from] or ""):lower() == needle
    end
    if not partitioned then
      for _, rec in ipairs(records()) do
        if match(rec) then out[#out + 1] = { rec = rec } end
      end
      return out
    end
    for _, pk in ipairs(partitionKeys()) do
      for _, rec in ipairs(resolvePartition(pk)) do
        if match(rec, pk) then out[#out + 1] = { rec = rec, pk = pk } end
      end
    end
    return out
  end

  --- Rejection text when a model-facing lookup hits an id in >1 partition and
  --- no routing field is nameable (function-form partition_by). String-form
  --- partition_by asks for the field up front, so this never fires there.
  local function ambiguity(id, matches)
    local pks = {}
    for _, m in ipairs(matches) do pks[#pks + 1] = m.pk end
    return "rejected: '" .. id .. "' exists in multiple partitions (" .. table.concat(pks, ", ")
      .. ") and this lookup can't name one — disambiguate card-side with the partition key"
  end

  -- ---------- filing ----------

  --- The shared write path. Returns id, status, record, dropped where status
  --- is "filed" | "already"; or nil, reason on rejection.
  local function file(args)
    local rec, dropped, missing = coerce(def.fields, args)
    if #missing > 0 then
      return nil, "rejected: " .. table.concat(missing, ", ") .. " required"
    end
    -- A missing routing value would slugify to the "thing" fallback, filing
    -- every such record under one slug — reject it like a nil partition.
    if def.id_from and (rec[def.id_from] == nil or rec[def.id_from] == "") then
      return nil, "rejected: " .. def.id_from .. " is required"
    end
    local id = slugify(def.id_from and rec[def.id_from] or nil)
    if partitioned then
      local pk = partition_by(rec)
      if pk == nil then
        error("registry: partition_by returned nil for '" .. id .. "' — the record lacks its routing field", 3)
      end
      pk = tostring(pk)
      local recs = resolvePartition(pk)
      for _, existing in ipairs(recs) do
        if existing.id == id
          or (def.id_from and tostring(existing[def.id_from] or ""):lower() == id) then
          return id, "already", existing
        end
      end
      if def.cap and #recs >= def.cap then
        return nil, "rejected: registry full (" .. def.cap .. " " .. tostring(def.key or "records")
          .. " max in " .. pk .. ")"
      end
      rec.id = id
      if def.on_register then def.on_register(rec) end
      rec.id = id -- reassert the assigned slug: the hook may have clobbered it
      local q = mutationQueue()
      q[#q + 1] = { pks = packsKey, pk = pk, reg = def.key, op = "set", id = id, rec = rec }
      return id, "filed", rec, dropped
    end
    -- Unpartitioned: idempotent dup-check, cap, append to the live array.
    local existing = findRecord(id)
    if existing then return id, "already", existing end
    local list = records()
    if def.cap and #list >= def.cap then
      return nil, "rejected: registry full (" .. def.cap .. " " .. tostring(def.key or "records") .. " max)"
    end
    rec.id = id
    if def.on_register then def.on_register(rec) end
    rec.id = id -- reassert the assigned slug: the hook may have clobbered it
    list[#list + 1] = rec
    return id, "filed", rec, dropped
  end

  local function register(args)
    local id, status, rec, dropped = file(args)
    if not id then return status end -- status carries the rejection reason
    if status == "already" then
      return json.encode({ already_registered = id, record = rec })
    end
    local result = { registered = id, record = rec }
    if dropped and #dropped > 0 then result.dropped = dropped end
    return json.encode(result)
  end

  local function query(args)
    local id = args and args.id
    if partitioned and partitionField then
      -- The routing field is a domain fact ("the floor the monster is on") —
      -- the model names it, the lookup stays inside that partition.
      local pk, err = namedPartition(args)
      if not pk then return err end
      local rec = findInPartition(pk, id)
      if not rec then return "unknown " .. tostring(def.key or "record") .. ": " .. tostring(id) .. " in " .. pk end
      return json.encode(rec)
    end
    if partitioned then
      -- function-form partition_by: no field to ask for — scan, but loudly
      local matches = findAll(id)
      if #matches > 1 then return ambiguity(tostring(id), matches) end
      if #matches == 0 then return "unknown " .. tostring(def.key or "record") .. ": " .. tostring(id) end
      return json.encode(matches[1].rec)
    end
    local rec = findRecord(id)
    if not rec then return "unknown " .. tostring(def.key or "record") .. ": " .. tostring(id) end
    return json.encode(rec)
  end

  --- The shared update path. Partitioned takes pk explicitly (nil pk = scan).
  --- Returns true, dropped | nil, reason.
  local function applyUpdate(pk, id, fields)
    local partial, dropped = coercePartial(def.fields, fields, mutableSet)
    if not next(partial) then
      if not def.mutable then
        return nil, "rejected: no mutable fields declared"
      end
      return nil, "rejected: nothing to update (mutable: " .. table.concat(def.mutable, ", ") .. ")"
    end
    if partitioned then
      local rec, foundPk
      if pk ~= nil then
        foundPk = tostring(pk)
        rec = findInPartition(foundPk, id)
      else
        rec, foundPk = findRecord(id)
      end
      if not rec then return nil, "unknown " .. tostring(def.key or "record") .. ": " .. tostring(id) end
      local q = mutationQueue()
      q[#q + 1] = { pks = packsKey, pk = foundPk, reg = def.key, op = "update", id = rec.id, fields = partial }
      return true, dropped
    end
    local rec = findRecord(id)
    if not rec then return nil, "unknown " .. tostring(def.key or "record") .. ": " .. tostring(id) end
    for k, v in pairs(partial) do rec[k] = v end
    return true, dropped
  end

  local function updateExec(args)
    local id = tostring(args and args.id or "")
    if id == "" then return "rejected: id required" end
    local pk = nil
    if partitioned and partitionField then
      -- The routing field is part of the call ("the floor the monster is
      -- on"), so the update lands in exactly one partition.
      local err
      pk, err = namedPartition(args)
      if not pk then return err end
    elseif partitioned then
      -- function-form partition_by: the model can't name a partition — an id
      -- filed on several floors would silently update whichever sorts first.
      local matches = findAll(id)
      if #matches > 1 then return ambiguity(id, matches) end
    end
    local ok, droppedOrErr = applyUpdate(pk, id, args)
    if not ok then return droppedOrErr end
    local rec = pk and findInPartition(pk, id) or findRecord(id)
    local result = { updated = rec.id, record = rec }
    if pk then result[partitionField] = pk end
    if droppedOrErr and #droppedOrErr > 0 then result.dropped = droppedOrErr end
    return json.encode(result)
  end

  --- The declared field names (validation targets, e.g. lib/events' RESERVED
  --- guard when a roster is INJECTED rather than declared through it).
  function R.fieldNames()
    local out = {}
    for _, f in ipairs(def.fields or {}) do out[#out + 1] = f.name end
    return out
  end

  -- ---------- the tool contract ----------

  -- The routing field rides model-facing lookups under its DOMAIN name — the
  -- model says "the floor the monster is on", never the word "partition".
  local function partitionProp()
    if not (partitioned and partitionField) then return nil end
    return { type = "string",
      description = "The " .. partitionField .. " the " .. tostring(def.key or "record") .. " is in — required; records are filed per " .. partitionField }
  end

  function R.tools()
    local out = {}
    local properties, required = {}, {}
    for _, f in ipairs(def.fields) do
      properties[f.name] = fieldSchema(f)
      if f.required then required[#required + 1] = f.name end
    end
    out[#out + 1] = {
      type = "function",
      ["function"] = {
        name = def.tool,
        description = def.description or ("Register a " .. tostring(def.key or "record") .. "."),
        parameters = { type = "object", properties = properties, required = required },
      },
    }
    if def.query_tool then
      local qprops = { id = { type = "string" } }
      local qreq = { "id" }
      if partitionProp() then
        qprops[partitionField] = partitionProp()
        qreq[#qreq + 1] = partitionField
      end
      out[#out + 1] = {
        type = "function",
        ["function"] = {
          name = def.query_tool,
          description = "Look up a filed " .. tostring(def.key or "record") .. " by id or name. The answer is canonical.",
          parameters = { type = "object", properties = qprops, required = qreq },
        },
      }
    end
    if updateTool then
      local uprops = { id = { type = "string" } }
      local ureq = { "id" }
      if partitionProp() then
        uprops[partitionField] = partitionProp()
        ureq[#ureq + 1] = partitionField
      end
      for _, f in ipairs(def.fields) do
        if mutableSet[f.name] then uprops[f.name] = fieldSchema(f) end
      end
      out[#out + 1] = {
        type = "function",
        ["function"] = {
          name = updateTool,
          description = "Update an existing " .. tostring(def.key or "record")
            .. ": OVERWRITES the given fields (latest value is canon). Only these fields may change: "
            .. table.concat(def.mutable, ", ") .. ".",
          parameters = { type = "object", properties = uprops, required = ureq },
        },
      }
    end
    for _, q in ipairs(queries) do
      local qprops, qreq = {}, {}
      for _, a in ipairs(q.args or {}) do
        qprops[a.name] = fieldSchema(a)
        if a.required then qreq[#qreq + 1] = a.name end
      end
      out[#out + 1] = {
        type = "function",
        ["function"] = {
          name = q.name,
          description = q.description or ("Query " .. tostring(def.key or "records") .. "."),
          parameters = { type = "object", properties = qprops, required = qreq },
        },
      }
    end
    return out
  end

  function R.exec(name, args)
    if name == def.tool then return register(args or {}) end
    if def.query_tool and name == def.query_tool then return query(args or {}) end
    if updateTool and name == updateTool then return updateExec(args or {}) end
    for _, q in ipairs(queries) do
      if name == q.name then
        local res = q.run(allRecords(), args or {})
        if type(res) == "string" then return res end
        return json.encode(res)
      end
    end
    return nil
  end

  -- ---------- the card-side surface ----------

  --- Look up one record. Partitioned: R.get(pk, id). Unpartitioned: R.get(id).
  function R.get(a, b)
    if not partitioned then return findRecord(a) end
    return findInPartition(a, b)
  end

  --- The records of one partition (or the whole registry, unpartitioned).
  function R.list(pk)
    if not partitioned then return records() end
    -- nil used to read as the literal "nil" partition and return {} — a
    -- forgotten argument looked like an empty floor. Loud instead; R.all()
    -- is the cross-partition read.
    if pk == nil then
      error("registry: list() on a partitioned registry needs a partition key (use R.all() for cross-partition)", 2)
    end
    return (resolvePartition(tostring(pk)))
  end

  --- All records — cross-partition when partitioned.
  function R.all() return allRecords() end

  --- File a record from the card. Returns id on success (id, "already_registered"
  --- when the id converges to an existing record), or nil, reason.
  function R.create(fields)
    local id, status = file(fields or {})
    if not id then return nil, status end
    if status == "already" then return id, "already_registered" end
    return id
  end

  --- Overwrite mutable fields on an existing record.
  --- Partitioned: R.update(pk, id, fields). Unpartitioned: R.update(id, fields).
  function R.update(a, b, c)
    if not partitioned then return applyUpdate(nil, a, b or {}) end
    return applyUpdate(a, b, c or {})
  end

  --- One line per record, for delegate briefings ("" when empty).
  --- Partitioned: pass a pk to brief one partition, omit for all.
  function R.briefing(pk)
    local recs
    if not partitioned then
      recs = records()
    elseif pk ~= nil then
      recs = resolvePartition(tostring(pk))
    else
      recs = allRecords()
    end
    local lines = {}
    for _, rec in ipairs(recs) do
      local label = def.id_from and tostring(rec[def.id_from] or "") or ""
      lines[#lines + 1] = "- " .. tostring(rec.id) .. (label ~= "" and (": " .. label) or "")
    end
    if #lines == 0 then return "" end
    return "\\n" .. tostring(def.key or "REGISTRY") .. ":\\n" .. table.concat(lines, "\\n")
  end

  -- Custom queries double as card-side methods (raw return, not encoded).
  for _, q in ipairs(queries) do
    R[q.name] = function(args) return q.run(allRecords(), args or {}) end
  end

  return R
end

--- Flush every queued registry mutation into the packs: one new store.put
--- per touched partition, then the pointer table updates. Call ONCE at the
--- end of generate() — reads resolve base + queue, so timing never affects
--- correctness, only state size. No-op when nothing is queued.
function M.flush()
  if type(state) ~= "table" then return end
  local q = state._regq
  if type(q) ~= "table" or #q == 0 then return end
  local groups, order = {}, {}
  for _, m in ipairs(q) do
    local gk = tostring(m.pks) .. "\\31" .. tostring(m.pk)
    if not groups[gk] then
      groups[gk] = { pks = m.pks, pk = m.pk, mutations = {} }
      order[#order + 1] = gk
    end
    table.insert(groups[gk].mutations, m)
  end
  for _, gk in ipairs(order) do
    local g = groups[gk]
    state[g.pks] = state[g.pks] or {}
    local pid = state[g.pks][g.pk]
    local blob = {}
    if pid then
      local body = packBodies[pid] or store.getJson(pid):await()
      if not body then
        error("registry.flush: pack blob missing for partition " .. tostring(g.pk)
          .. " (" .. tostring(pid) .. ") — blobs are script-written, this is a bug", 2)
      end
      blob = sanitize.data(json.decode(body))
    end
    for _, m in ipairs(g.mutations) do
      local section = blob[m.reg]
      if type(section) ~= "table" then
        section = {}
        blob[m.reg] = section
      end
      if m.op == "set" then
        local found = false
        for i, rec in ipairs(section) do
          if rec.id == m.id then section[i] = m.rec found = true break end
        end
        if not found then section[#section + 1] = m.rec end
      else -- update
        local found = false
        for _, rec in ipairs(section) do
          if rec.id == m.id then
            for k, v in pairs(m.fields) do rec[k] = v end
            found = true
            break
          end
        end
        if not found then
          error("registry.flush: update for unknown id '" .. tostring(m.id)
            .. "' in partition " .. tostring(g.pk), 2)
        end
      end
    end
    local newPid = store.putJson("pack", blob):await()
    -- Seed the memo with the body just written: the next read of this pack
    -- would otherwise pay a store round-trip for bytes already in hand.
    packBodies[newPid] = json.encode(blob)
    state[g.pks][g.pk] = newPid
  end
  state._regq = {}
end

return M
\`\`\`
\`\`\`lua
-- lib/summarize.lua — the gist engine: turn a mechanical span into the ONE
-- model-written line that survives.
--
-- The flow: the script serves a span's mechanical turns plainly (a fight, a
-- shopping trip, an exploration), and at the boundary asks the delegate for
-- the one line — "the player kinda struggled and had to use all of his
-- potions against a zubat lol". That line goes two places, both TAGLESS: a
-- plain memoir line in the reply (the player reads it like any other prose),
-- and a rolling story entry with the span as its zoomable content
-- (lib/rolling). No tags, no display rules — the memoir is just text.
--
-- The span is the caller's, passed via opts.span (message-shaped entries,
-- usually tracked mechanically in state). gist() returns nil only when there
-- is nothing to summarize (no span, empty span, empty delegate answer) — the
-- caller picks the fallback. A delegate ERROR propagates to the CALLER, who
-- decides what it means — main.lua's endFight pcalls gist() and degrades to
-- a canned line rather than failing the turn. One
-- honest bound: the gist is only as good as what the span shows — anything
-- kept out of the delegate's view can't make it into the summary.

local M = {}

--- Run the gist sub-gen over opts.span: one line. opts.instructions: extra
--- guidance appended to the summarizer's prompt. opts.maxSpanChars: span
--- budget (default 6000).
function M.gist(prompt, opts)
  opts = opts or {}
  local span = opts.span
  if not span or #span == 0 then return nil end

  local lines = {}
  local budget = opts.maxSpanChars or 6000
  for i = #span, 1, -1 do -- newest-first until the budget is spent
    -- Tool-call-shaped entries carry no content; skip them, never crash.
    if type(span[i].content) == "string" then
      local line = span[i].role .. ": " .. span[i].content
      if #line > budget then break end
      table.insert(lines, 1, line)
      budget = budget - #line
    end
  end
  if #lines == 0 then return nil end -- no line fit the budget: caller's fallback, not an empty-span sub-gen

  local sub = {}
  for k, v in pairs(prompt) do sub[k] = v end
  sub.tools = nil
  sub.messages = {
    { role = "system", content = "Summarize what happened in ONE line, past tense, second person. "
      .. "Capture how it WENT — costs, close calls, items spent, how close the end came — not just what happened: "
      .. "this line is all that survives; the original text is collapsed away and the reader was not there. "
      .. "No double quotes."
      .. (opts.instructions and (" " .. opts.instructions) or "") },
    { role = "user", content = table.concat(lines, "\\n") },
  }
  local res = backends.generate(sub):await()
  local s = type(res.text) == "string" and res.text or ""
  -- "No double quotes" is a prompt wish the model ignores often enough; fold
  -- them to single quotes here so the constraint is actually real.
  s = s:gsub('"', "'"):gsub("%s+", " "):gsub("^%s*(.-)%s*$", "%1")
  if s == "" then return nil end
  return s
end

return M
\`\`\`
\`\`\`lua
-- lib/maptag.lua — build a [MAP|...] tag from a room graph: the compact
-- one-line form a display rule renders as a map (HUD recipe, topic \`regexes\`).
--
-- The tag carries the graph state of THIS moment, so maps are branch- and
-- era-correct for free, stored text stays small, and the model sees the
-- layout as data. Fog-of-war: pass a \`seen\` set and only visited rooms get
-- names — rooms adjacent to the frontier show as "?" (a place to go), the
-- rest of the graph doesn't exist as far as the player is concerned. The
-- stairs marker is only included once the stairs room is actually seen —
-- never spoil the way down.
--
-- Grid layouts (rooms carry numeric x/y — lib/layout) emit coordinates so
-- the display rule can draw a real 2D map: rooms as \`id=x,y,Name\` and
-- passages as undirected \`a-b\` pairs (coordinates are normalized over the
-- WHOLE graph, not the visible part, so the map never drifts as fog lifts).
-- Rooms without coordinates fall back to the legacy direction-labeled shape,
-- which the rule renders as the old room list.
--
--   local tag = maptag.tag(pack.rooms, {
--     cur = "r2",            -- current room (always shown, highlighted)
--     entrance = pack.entrance,
--     stairs = pack.stairsDown,
--     seen = { r1 = true, r2 = true },   -- nil = reveal the whole graph
--   })

local M = {}

local function clean(s)
  return (tostring(s):gsub("[|;>%[%]=<'\\"&,%-]", " "):gsub("%s+", " "):gsub("^%s*(.-)%s*$", "%1"))
end

--- rooms: { id = { name = string, x = number?, y = number?, exits = { dir -> to } } }
--- opts: { cur, entrance, stairs, seen? } — see above.
function M.tag(rooms, opts)
  opts = opts or {}
  local seen = opts.seen
  local ids = {}
  for id in pairs(rooms) do ids[#ids + 1] = id end
  table.sort(ids)

  -- Grid mode when every room carries coordinates.
  local grid = true
  local minX, minY = math.huge, math.huge
  for _, id in ipairs(ids) do
    local r = rooms[id]
    if type(r.x) == "number" and type(r.y) == "number" then
      if r.x < minX then minX = r.x end
      if r.y < minY then minY = r.y end
    else
      grid = false
    end
  end

  -- Which rooms exist for the player at all: everything, or seen + frontier.
  local visible = {}
  if not seen then
    for _, id in ipairs(ids) do visible[id] = true end
  else
    for _, id in ipairs(ids) do
      if seen[id] then
        visible[id] = true
        for _, to in pairs(rooms[id].exits or {}) do
          if rooms[to] then visible[to] = true end -- the frontier: adjacent to seen
        end
      end
    end
  end
  if opts.cur and rooms[opts.cur] then visible[opts.cur] = true end

  local roomParts, edgeParts, edgeSeen = {}, {}, {}
  for _, id in ipairs(ids) do
    if visible[id] then
      local known = not seen or seen[id]
      local label = known and clean(rooms[id].name) or "?"
      if grid then
        roomParts[#roomParts + 1] = id .. "=" .. (rooms[id].x - minX) .. "," .. (rooms[id].y - minY) .. "," .. label
      else
        roomParts[#roomParts + 1] = id .. "=" .. label
      end
      for d, to in pairs(rooms[id].exits or {}) do
        if rooms[to] and visible[to] then
          local ekey = id < to and (id .. "|" .. to) or (to .. "|" .. id)
          if not edgeSeen[ekey] then
            edgeSeen[ekey] = true
            if grid then
              edgeParts[#edgeParts + 1] = id .. "-" .. to
            else
              edgeParts[#edgeParts + 1] = id .. ">" .. clean(d) .. ">" .. to
            end
          end
        end
      end
    end
  end

  -- The stairs marker only once the stairs room is known.
  local stairs = ""
  if opts.stairs and (not seen or seen[opts.stairs]) then stairs = tostring(opts.stairs) end

  return "[MAP|cur=" .. tostring(opts.cur or "")
    .. "|ent=" .. tostring(opts.entrance or "")
    .. "|rooms=" .. table.concat(roomParts, ";")
    .. "|edges=" .. table.concat(edgeParts, ";")
    .. "|stairs=" .. stairs .. "]"
end

return M
\`\`\`
\`\`\`lua
-- lib/events.lua — the event engine: chat scenes as MODES, with a cast and
-- per-character memory.
--
-- An event is a conversation with a cast, run by a delegate (the
-- scene-runner), until it closes. While state.event lives the card is in
-- event mode — the card gates its other verbs behind it. This module owns
-- the machinery every such card re-derives:
--
--   * event state (state.event = { id, kind, context, participants }) — the
--     MODE, and the only source of truth for it (the engine emits no markup).
--   * the cast: a character registry (lib/registry) plus the casting tools.
--     The character FIELDS are the card's (declared in the def); the
--     validate-file-query pipeline is the lib's.
--   * dossiers: per-character memory as lib/rolling channels.
--     state.dossiers[id] is a rolling channel ({ kv, ids }); close_event
--     pushes one gist-only take per participant to the log half — what THAT
--     character carried away, so knowledge asymmetry is structural. (The
--     character's kv facts live in their roster record, not here.)
--     get_character serves rolling.parts: the recent takes verbatim plus
--     fold entries as the digest, folded ON READ when the backlog outgrows
--     the window (a never-read character costs no token). Loud on error: a
--     delegate failure fails the turn — ids move only after the fold entry
--     is filed, so memory survives intact and a swipe retries the fold.
--   * the cast note, NOT a tag: who is on stage rides the newest message via
--     castLine() (from state.event.participants) — volatile state in the
--     newest message, never deep in the span. strip removes freelanced tags
--     from delegate text (the model never types a bracket).
--   * the span — the event's prompt IS the record: a persistent array in the
--     store (store.append / store.readArray), state.event.spanId pointing at
--     its head. Node zero is the system briefing (instructions + event
--     context + STORY SO FAR at open time); then one node per turn — user
--     inputs, assistant text, AND the tool_use/tool_result rounds, full
--     fidelity, so the model never re-issues a read it already made. Each
--     generate rebuilds the scene-runner's prompt by reading the span and
--     appending — there is no separately-maintained frozen block to fall out
--     of sync. Append-only is the NORM (turn N is a strict prefix of turn
--     N+1, so the delegate's prefix cache hits), but a briefing that must
--     change mid-scene simply rides the next node: the cache degrades to a
--     partial hit — slower, never wrong. Old branches keep pointing at their
--     old head, so swipes stay correct; history budgets are irrelevant — the
--     span never touches the log.
--
-- ONE TOOLSET, TWO ROLES. The DM (escalation) and the scene-runner compose
-- different PROMPTS but get the same full toolset (ts:use(ev) both times).
-- Mode enforcement is a runtime concern, not a schema-shaping one: tools
-- that make no sense in the current mode — a second open_event mid-scene, a
-- close_event with nothing open — fail as ordinary error results, and the
-- tool loop carries the error back like any other.
--
--   local ev = events.new({
--     roster = myRoster,   -- inject the card's own registry instance…
--     fields = {...},      -- …or declare fields and the engine creates it
--     key = "characters",  -- state key for the roster (default)
--   })
--
-- INJECT the roster when anything else needs the cast: the same instance
-- can ride another toolset (a battle-summarizer marking someone dead), and
-- records are plain tables in state[key], so roster.get(id) returns the
-- LIVE record — an ad-hoc tool mutates it (rec.dead = true) and every
-- consumer sees it: get_character copies all record fields into its result.
-- The roster must be UNPARTITIONED: this module calls roster.get(id)
-- one-arg, which a partitioned registry reads as get(pk, id) and never
-- resolves. Registry instances carry an R.partitioned marker, and
-- events.new rejects a partitioned roster at construction.
--
-- Instance surface beyond the contract (PLAIN DOT CALLS):
--   ev.isOpen()  ev.kind()  ev.eventLine()  ev.clear()
--   ev.strip(text)  ev.castLine()
--   ev.hasSpan()  ev.spanStart(entries)  ev.spanAppend(entries)  ev.span()
--   ev.finalize(prompt)  -- the /leave path: one finalize gen, loud on error
--   ev.bindPrompt(prompt)  -- once per generate(), like ledger.bind: arms
--     lib/rolling's fold sub-gens (they inherit the turn's prompt, which
--     real adapters require for prompt.tokenUsage). An unbound turn defers a
--     due fold to the next bound one — but bind on EVERY generate: a card
--     that never binds has a silent unbounded-growth bug, and dormant folds
--     will hide it.
-- exec tries the roster's tools FIRST, then the event tools — don't declare
-- a character field or roster tool named list_characters / get_character /
-- add_to_chat / close_event, and don't declare fields named digest /
-- dossier / older_takes (get_character injects those keys into its result).

local registry = require("lib/registry")
local toolset = require("lib/toolset")
local loop = require("lib/loop")
local chrome = require("lib/chrome")
local rolling = require("lib/rolling")

local M = {}

local RESERVED = { digest = true, dossier = true, older_takes = true }

function M.new(def)
  if def.recent or def.backlog then
    error("events.new: recent/backlog are retired — dossier folds use lib/rolling's fixed window (3 recent + 3 backlog); drop both", 2)
  end
  if not def.roster and not def.fields then
    error("events.new: provide roster (a registry instance) or fields (to create one)", 2)
  end
  -- The RESERVED guard runs on BOTH construction paths: declared fields here,
  -- an injected roster's own fields below (the injected path used to skip it,
  -- so a card could file a character field named digest/dossier/older_takes
  -- and have get_character silently clobber it).
  if def.fields then
    for _, f in ipairs(def.fields) do
      if RESERVED[f.name] then
        error("events.new: field name '" .. f.name .. "' is reserved (get_character injects it)", 2)
      end
    end
  end
  if def.roster and def.roster.fieldNames then
    for _, name in ipairs(def.roster.fieldNames()) do
      if RESERVED[name] then
        error("events.new: injected roster field '" .. name .. "' is reserved (get_character injects it)", 2)
      end
    end
  end
  -- A PARTITIONED roster can never work here: this module looks members up
  -- one-arg (roster.get(id)), which a partitioned registry reads as
  -- get(pk, id). Fail at construction, not on the first get_character.
  if def.roster and def.roster.partitioned then
    error("events.new: the roster must be UNPARTITIONED — events looks characters up one-arg, which a partitioned registry reads as get(pk, id)", 2)
  end
  -- The roster: injected (shared with the card's other subsystems) or
  -- created from the declared fields.
  local roster = def.roster or registry.new({
    tool = "register_character",
    description = "File a NEW character (check list_characters first — re-filing an existing name returns the existing record).",
    key = def.key or "characters",
    id_from = "name",
    fields = def.fields,
  })
  local E = {}

  -- ---------- state ----------

  -- A dossier is a rolling channel: state.dossiers[id] is { kv, ids } (the
  -- log half carries the takes; lib/rolling owns the fold and the store
  -- blobs). Anything not channel-shaped resets — old pinned lib copies keep
  -- their own behavior; this lib starts dossiers fresh.
  local function dossier(id)
    if type(state) ~= "table" then state = {} end
    state.dossiers = state.dossiers or {}
    local d = state.dossiers[id]
    if type(d) ~= "table" or type(d.kv) ~= "table" or type(d.ids) ~= "table" then
      d = rolling.channel()
      state.dossiers[id] = d
    end
    return d
  end

  function E.isOpen() return type(state) == "table" and state.event ~= nil end

  function E.kind() return (state.event and state.event.kind) or nil end

  --- "kind — context": what open_event filed. The card typically composes it
  --- into the span's node-zero briefing at open time.
  function E.eventLine()
    if not state.event then return "" end
    return state.event.kind .. " — " .. state.event.context
  end

  local function participants()
    return (state.event and state.event.participants) or {}
  end

  function E.clear() state.event = nil end

  -- ---------- tags (script-owned) ----------

  -- The model never types a bracket: freelanced structural tags in delegate
  -- text are stripped before serving; the script emits every tag.
  function E.strip(text)
    -- The space after the tag name is OPTIONAL ("[event]" / "[/event]" are
    -- freelanced just the same) — matching the chat tag's pattern, which
    -- never required one.
    return (tostring(text or ""):gsub("%[/?event[^%]]*%]", ""):gsub("%[/?chat[^%]]*%]", ""))
  end

  --- The cast note: who is on stage, from state.event.participants — appended
  --- to the newest user message each scene turn (volatile state rides the
  --- newest message, never deep in the span). "" when nobody is on stage.
  function E.castLine()
    local cast = participants()
    if #cast == 0 then return "" end
    -- Participants are stored as slug ids; the model addresses characters by
    -- NAME, so serve the display name when the record has one (fall back to
    -- the id for a record without a name field or one that went missing).
    local names = {}
    for i, id in ipairs(cast) do
      local rec = roster.get(id)
      names[i] = (rec and type(rec.name) == "string" and rec.name ~= "" and rec.name) or id
    end
    return "(In the scene with you: " .. table.concat(names, ", ") .. ")"
  end

  -- ---------- the span (the event's prompt IS the record) ----------

  -- A persistent array in the store (store.append / store.readArray),
  -- state.event.spanId pointing at its head. Node zero is the system
  -- briefing; then one node per turn — user inputs, the loop's tool rounds,
  -- the final reply — full fidelity, tracked MECHANICALLY, never parsed out
  -- of history. Turn N is a strict prefix of turn N+1 by CONSTRUCTION (no
  -- log parsing, no history-budget dependence), the model never re-issues a
  -- read it already made, and old branches keep their old head.

  --- True once the event has a span (the card's spanStart).
  function E.hasSpan()
    return state.event ~= nil and state.event.spanId ~= nil
  end

  --- Start the span with its seed entries (one node; entries may be {}).
  --- Node zero should carry the scene-runner's system briefing — the card
  --- composes it at open time (instructions + event context + STORY SO FAR).
  --- Errors when no event is open — the card calls this right after the
  --- event opens, when it seeds node zero.
  function E.spanStart(entries)
    if not state.event then error("events: spanStart with no open event", 2) end
    state.event.spanId = store.append(nil, entries or {}):await()
  end

  --- Append one turn's entries (user input, the loop's tool rounds, the
  --- final reply) — ONE node, one await. A mid-scene briefing change rides
  --- its own node here: the prefix cache degrades to partial, never wrong.
  function E.spanAppend(entries)
    if not E.hasSpan() then error("events: spanAppend with no span", 2) end
    state.event.spanId = store.append(state.event.spanId, entries):await()
  end

  --- The whole record, flattened — node zero (the briefing) first ({} when
  --- there's no span). Loud when a node is missing or garbled — blobs are
  --- script-written, that's a bug.
  function E.span()
    if not E.hasSpan() then return {} end
    return json.decode(store.readArray(state.event.spanId):await())
  end

  -- ---------- dossiers (rolling channels) ----------

  --- Bind the turn's prompt (once per generate, next to ledger.bind): arms
  --- lib/rolling's fold sub-gens. Bind on EVERY generate — an unbound turn
  --- defers a due fold to the next bound one, but a card that never binds
  --- has a silent unbounded-growth bug.
  function E.bindPrompt(prompt) rolling.bind(prompt) end

  --- A character's file: the registry record plus their dossier as
  --- { digest, takes, older } — rolling.parts folds the oldest takes into
  --- digest entries when the backlog outgrows the window (on read, so a
  --- never-read character costs no token). Returns nil when no such character.
  local function characterFile(id)
    local rec = roster.get(id)
    if not rec then return nil end
    return rec, rolling.parts(dossier(rec.id))
  end

  -- ---------- opening and closing ----------

  local function openEvent(args)
    if state.event then return "rejected: an event is already open" end
    local kind = tostring(args.kind or ""):lower()
    local context = tostring(args.context or "")
    if kind == "" or context == "" then
      return "rejected: kind and context required — the scene-runner needs framing (who the player is, what they want)"
    end
    state.eventSeq = (state.eventSeq or 0) + 1 -- lib-owned: cards without a turn counter still get unique ids
    state.event = { id = "e" .. state.eventSeq, kind = kind, context = context, participants = {} }
    -- No span yet: the card's dispatch loop starts it (spanStart) when it
    -- seeds node zero. (Starting one with zero entries would NOT round-trip:
    -- an empty entries array serializes as {} and reads back as a phantom
    -- empty entry.)
    return json.encode({ opened = state.event.id, kind = kind,
      note = "the scene-runner takes over now — cast no characters yourself" })
  end

  -- The gist is NEUTRAL (one line for the record — the story entry and the
  -- memoir line consume it); the takes are TARGETED (what each participant
  -- carries away). Keys are validated against the participant list —
  -- strangers are dropped and reported, per the canonical-record rule.
  local function closeEvent(args)
    if not state.event then return "rejected: no event is open" end
    if state.event.closed then
      -- Terminal success, NOT a retryable error: the close already landed, so
      -- re-calling is a no-op that must read as "done" to the model. (An
      -- "already closing" string invited the finalizer to retry until the
      -- round cap threw — bricking the branch AFTER the work had succeeded.)
      return json.encode({ closing = state.event.id, gist = state.event.closed.gist, already_closed = true,
        note = "the event is already closed — this is final; do NOT call close_event again" })
    end
    local gist = chrome.oneline(args.gist or "")
    if gist == "" then gist = "The " .. state.event.kind .. " breaks off." end
    local filed, dropped, pending = {}, {}, {}
    if type(args.takes) == "table" then
      for id, take in pairs(args.takes) do
        local present = false
        for _, p in ipairs(state.event.participants) do
          if p == id then present = true break end
        end
        if present then
          -- Validate BEFORE any push: rolling.push hard-errors on an empty
          -- gist, and a throw out of the tool exec bricks the branch — bad
          -- tool input fails as an ordinary error result instead, retried
          -- without double-filing the takes already collected.
          local text = chrome.oneline(tostring(take or ""))
          if text == "" then
            return "rejected: empty take for " .. tostring(id) .. " — write what they carry away, or omit the key"
          end
          pending[#pending + 1] = { id = id, text = text }
        else
          dropped[#dropped + 1] = tostring(id)
        end
      end
      for _, p in ipairs(pending) do
        rolling.push(dossier(p.id), { label = state.event.kind, gist = p.text })
        filed[#filed + 1] = p.id
      end
    end
    state.event.closed = { gist = gist }
    return json.encode({ closing = state.event.id, gist = gist, takes_filed = filed, takes_dropped = dropped })
  end

  local CLOSE_EVENT_SCHEMA = {
    type = "function",
    ["function"] = { name = "close_event", description = "Close the event when the scene is spent. gist: ONE neutral line for the record (no double quotes). takes: what EACH participant carries away, keyed by character id — facts learned plus impression formed. A character with no take learns nothing.",
      parameters = { type = "object", properties = {
        gist = { type = "string" },
        takes = { type = "object" } },
        required = { "gist" } } },
  }

  --- The /leave path. One finalize gen writes the gist and takes. Loud on a
  --- genuine delegate error: a thrown generate fails the turn (the card's
  --- Failure UX marks the branch bricked; recovery is a swipe or rewind).
  --- Content outcomes never throw: once close_event lands the loop stops
  --- early (further rounds are pure downside — a model re-calling close_event
  --- gets a terminal "already closed" success, not an error to retry), and
  --- if the model spends its rounds WITHOUT calling close_event the loop
  --- ends soft and the event still closes with a script-composed fallback
  --- gist. Returns the gist (a plain-text memoir line to serve).
  function E.finalize(prompt)
    if not state.event then return "" end
    local ts = toolset.new()
    ts:handle("close_event", function(args) return closeEvent(args) end, CLOSE_EVENT_SCHEMA)
    local sub = {}
    for k, v in pairs(prompt) do sub[k] = v end
    sub.tools = ts:schemas()
    sub.messages = {
      { role = "system", content = "The player just walked out of this event. Close it properly: call close_event "
        .. "with a neutral gist of what happened and one take per participant (what THAT character carries away). "
        .. "EVENT: " .. E.eventLine() },
    }
    for _, m in ipairs(E.span()) do
      -- The span's node zero is the scene-runner's system briefing — the
      -- finalizer carries its own system message; a second one mid-array
      -- breaks adapters.
      if m.role ~= "system" then sub.messages[#sub.messages + 1] = m end
    end
    local res = backends.generate(sub):await()
    loop.run(sub, res, ts:exec(), 4, {
      soft = true, -- a capped finalizer falls through to the fallback gist
      done = function() return state.event ~= nil and state.event.closed ~= nil end,
    })
    if not state.event.closed then
      state.event.closed = { gist = "The " .. state.event.kind .. " breaks off." }
    end
    return state.event.closed.gist -- the memoir line, plain text
  end

  -- ---------- the tool contract (ONE toolset for both roles) ----------

  function E.tools()
    local out = roster.tools()
    out[#out + 1] = {
      type = "function",
      ["function"] = { name = "list_characters", description = "List every filed character (id and role). Check BEFORE inventing someone new.",
        parameters = { type = "object", properties = {} } },
    }
    out[#out + 1] = {
      type = "function",
      ["function"] = { name = "get_character", description = "Pull a character's file: registry record plus their dossier (what they carry from past events). Pull it BEFORE writing them.",
        parameters = { type = "object", properties = { id = { type = "string" } }, required = { "id" } } },
    }
    out[#out + 1] = {
      type = "function",
      ["function"] = { name = "add_to_chat", description = "Bring a filed character on stage (they become a participant of this event).",
        parameters = { type = "object", properties = { id = { type = "string" } }, required = { "id" } } },
    }
    out[#out + 1] = {
      type = "function",
      ["function"] = { name = "open_event", description = "Open an event (a conversation or scene) and hand it to the scene-runner. context: who the player is and what they are after. NO character list — casting is the scene-runner's job.",
        parameters = { type = "object", properties = { kind = { type = "string" }, context = { type = "string" } }, required = { "kind", "context" } } },
    }
    out[#out + 1] = CLOSE_EVENT_SCHEMA
    return out
  end

  function E.exec(name, args)
    local r = roster.exec(name, args)
    if r ~= nil then return r end
    if name == "list_characters" then
      -- roster.briefing(): one line per record ("- id: label"), field-agnostic,
      -- and it already opens with its own "\\n<characters>:" header — adding a
      -- "registry:" prefix stacked two labels.
      local b = roster.briefing()
      if b == "" then return "registry: empty — no characters filed yet" end
      return b
    end
    if name == "get_character" then
      local rec, file = characterFile(args and args.id)
      if not rec then return "unknown character: " .. tostring(args and args.id) end
      local out = {}
      for k, v in pairs(rec) do out[k] = v end
      out.digest = file.digest
      out.dossier = file.takes
      out.older_takes = file.older
      return json.encode(out)
    end
    if name == "add_to_chat" then
      if not state.event then return "rejected: no event is open" end
      local rec = roster.get(args and args.id)
      if not rec then return "rejected: unknown character " .. tostring(args and args.id) .. " — register them first" end
      for _, p in ipairs(state.event.participants) do
        if p == rec.id then return "already present: " .. rec.id end
      end
      state.event.participants[#state.event.participants + 1] = rec.id
      return json.encode({ joined = rec.id })
    end
    if name == "open_event" then return openEvent(args or {}) end
    if name == "close_event" then return closeEvent(args or {}) end
    return nil
  end

  return E
end

return M
\`\`\`

\`\`\`lua
-- lib/rolling.lua — one channel, both memory kinds.
--
-- A channel is a single object the card owns in state — rolling.channel()
-- returns { kv = {}, ids = {} } — and the same shape serves the story
-- (state.story), a dossier (state.dossiers[charId]), or any scoped memory
-- the card invents:
--
--   * the NON-COMPACTING half: ch.kv — verbatim facts by key. set overwrites,
--     latest value is canon, values file at any length. The kv block NEVER
--     folds: it is exactly the information judged worth keeping verbatim
--     (a character's appearance, world facts), and overwriting — not
--     appending — is what makes "hair: black" → "hair: white" impossible to
--     contradict.
--   * the COMPACTING half: ch.ids — an array of entry ids. An entry is a blob
--     in the append-only store ({ label, gist, content?, fold }); the entry's
--     id IS the blob id, so the store doubles as the archive: inspect(id)
--     resolves any id forever, live or folded away long ago. When the log
--     outgrows the window the oldest entries FOLD into a digest entry (see
--     below).
--
--   local story = rolling.channel()  -- in ensureState: state.story = state.story or rolling.channel()
--   rolling.bind(prompt)                          -- once per generate: arms folds
--   rolling.set(ch, key, value) / rolling.get(ch, key)   -- the verbatim half
--   rolling.push(ch, { label, gist, content? })   -- file a log entry, return its id
--   rolling.briefing(ch) -> string                -- kv facts, then id-bearing gist lines
--   rolling.parts(ch) -> { digest, takes, older } -- the dossier serve shape
--   rolling.inspect(id) -> string | nil           -- what one summary covers
--   rolling.tools() / rolling.exec(name, args)    -- inspect_summary, for toolset
--   rolling.tools(ch)                             -- per-channel contract object with
--     -- the freestyle kv tools: list_facts / get_fact / set_fact (ts:use(rolling.tools(ch)))
--
-- content is the ACTUAL material the gist covers — a message list, a
-- generated battle log, a nav trace: any JSON-able array. Gist-scale data
-- rides in state; the kilobyte-scale content sits in the store.
--
-- FOLD: when the live list outgrows recent + backlog, briefing (or parts)
-- compresses the oldest entries into ONE fold entry: its gist is a
-- delegate-written digest, its content is the DESCRIPTOR array
-- { id, label, gist } of what it compressed, its id replaces theirs in
-- the array, and it is TAGGED fold = true — reads classify by the tag, not
-- by sniffing the content shape (a plain entry whose content happens to be
-- an array of { id, gist } tables is NOT a fold; the shape sniff survives
-- only as the fallback for entries filed before the tag existed). Fold
-- entries fold the same way, so the model can tool-call its
-- way up the chat: briefing ids → inspect a fold entry → the summaries
-- inside it, each with an id → inspect those for the raw log. Fold-on-read:
-- a channel nobody reads never costs a token. Loud on delegate error — ids
-- move only after the fold entry is filed, so a swipe retries cleanly.
--
-- What this module does NOT do: write gists. The card produces them
-- (lib/summarize, a bespoke sub-gen, a script-composed line) and hands them
-- to push.

local sanitize = require("lib/sanitize")
local chrome = require("lib/chrome")

local M = {}

local RECENT = 3   -- live entries kept verbatim after a fold
local BACKLOG = 3  -- fold when the live list exceeds RECENT + BACKLOG

local boundPrompt = nil

--- Bind the turn's prompt (once per generate, next to ledger.bind): fold
--- sub-gens copy it so real adapters get a complete prompt table. Bind on
--- EVERY generate: an unbound turn defers a due fold to the next bound one,
--- but a card that never binds has a silent unbounded-growth bug.
function M.bind(prompt) boundPrompt = prompt end

--- A memory channel: { kv = {}, ids = {} }. The card owns it in state.
function M.channel() return { kv = {}, ids = {} } end

local function assertChannel(ch, fnName)
  if type(ch) ~= "table" or type(ch.kv) ~= "table" or type(ch.ids) ~= "table" then
    error("rolling." .. fnName .. ": pass a channel from rolling.channel() ({ kv, ids }), not a bare array", 3)
  end
end

-- Fetch an entry the CARD vouched for (an id in a state array): missing is a
-- bug, not bad luck — blobs are script-written — so, loud. (getJson throws
-- just as loudly on one that won't decode.)
local function fetch(id)
  local body = store.getJson(id):await()
  if not body then error("rolling: summary blob missing (" .. tostring(id) .. ") — blobs are script-written, this is a bug", 3) end
  return sanitize.data(json.decode(body))
end

local function isDescriptor(item)
  return type(item) == "table" and type(item.id) == "string" and type(item.gist) == "string"
end

local function isFoldEntry(entry)
  -- Every entry filed by THIS lib is tagged (push marks fold = false, fold()
  -- marks fold = true), so the marker decides; the content-shape sniff is the
  -- fallback for entries filed BEFORE the tag existed (stored state from an
  -- older lib still folds correctly).
  if entry.fold ~= nil then return entry.fold == true end
  return type(entry.content) == "table" and #entry.content > 0 and isDescriptor(entry.content[1])
end

-- ---------- the non-compacting half (kv: verbatim, overwritten, never folded) ----------

--- Overwrite a verbatim fact by key — latest value is canon, any length.
function M.set(ch, key, value)
  assertChannel(ch, "set")
  ch.kv[tostring(key)] = value
end

--- Read a verbatim fact (nil when nothing is filed under key).
function M.get(ch, key)
  assertChannel(ch, "get")
  return ch.kv[tostring(key)]
end

local function factValue(v)
  if type(v) == "table" then return json.encode(v) end
  return tostring(v)
end

local function sortedKeys(t)
  local keys = {}
  for k in pairs(t) do keys[#keys + 1] = k end
  table.sort(keys)
  return keys
end

-- ---------- the compacting half (the log: push, fold, zoom) ----------

--- File one summary into the channel's log. Returns the id.
function M.push(ch, entry)
  assertChannel(ch, "push")
  assert(type(entry) == "table", "rolling.push: entry table required")
  local gist = chrome.oneline(entry.gist)
  if gist == "" then error("rolling.push: gist required", 2) end
  -- fold = false: a PLAIN entry says so explicitly, so isFoldEntry never
  -- misreads descriptor-shaped content as a fold (the marker decides).
  local blob = { label = chrome.oneline(entry.label), gist = gist, fold = false }
  if entry.content ~= nil then blob.content = entry.content end
  local id = store.putJson("roll", blob):await()
  ch.ids[#ch.ids + 1] = id
  return id
end

-- Compress the oldest live entries into one fold entry at the front. The
-- fold entry's content is the descriptor array of what it compressed — the
-- next zoom level down.
local function fold(ids)
  if not boundPrompt then return end -- dormant until the card binds
  local cut = #ids - RECENT
  if cut <= 0 then return end
  local lines, descriptors = {}, {}
  for i = 1, cut do
    local e = fetch(ids[i])
    lines[#lines + 1] = "- [" .. e.label .. "] " .. e.gist
    descriptors[#descriptors + 1] = { id = ids[i], label = e.label, gist = e.gist }
  end
  local sub = {}
  for k, v in pairs(boundPrompt) do sub[k] = v end
  sub.tools = nil
  sub.messages = {
    { role = "system", content = "Compress these episode summaries into ONE short paragraph, past tense. "
      .. "Keep the specifics that would matter later — names, costs, debts, discoveries, outcomes. "
      .. "No double quotes. If a prior digest is given, fold the new episodes INTO it." },
    { role = "user", content = table.concat(lines, "\\n") },
  }
  local res = backends.generate(sub):await() -- loud: an error fails the turn
  local digest = type(res) == "table" and type(res.text) == "string" and chrome.oneline(res.text) or ""
  if digest == "" then return end -- empty answer is a content outcome: retry next read
  local foldId = store.putJson("roll", {
    label = cut .. " episodes", gist = digest, content = descriptors, fold = true,
  }):await()
  for _ = 1, cut do table.remove(ids, 1) end
  table.insert(ids, 1, foldId)
end

--- The channel's briefing: kv facts verbatim first, then one id-bearing line
--- per live log entry ("" when both are empty). Folds first when the log
--- outgrows the window; the kv block never folds.
function M.briefing(ch)
  assertChannel(ch, "briefing")
  local out = {}
  local keys = sortedKeys(ch.kv)
  if #keys > 0 then
    local lines = {}
    for _, k in ipairs(keys) do
      lines[#lines + 1] = "- " .. k .. ": " .. factValue(ch.kv[k])
    end
    out[#out + 1] = "\\nFACTS:\\n" .. table.concat(lines, "\\n")
  end
  local ids = ch.ids
  if #ids > RECENT + BACKLOG then fold(ids) end
  if #ids > 0 then
    local lines = {}
    for _, id in ipairs(ids) do
      local e = fetch(id)
      lines[#lines + 1] = "- [" .. id .. ": " .. e.label .. "] " .. e.gist
    end
    out[#out + 1] = "\\nSTORY SO FAR:\\n" .. table.concat(lines, "\\n")
  end
  return table.concat(out, "\\n")
end

--- The dossier serve shape: fold-entry gists concatenated as the digest,
--- plain-entry gists as the recent takes, older = the fold count. (The log
--- half only — a character's kv facts live in their registry record.)
function M.parts(ch)
  assertChannel(ch, "parts")
  local ids = ch.ids
  if #ids > RECENT + BACKLOG then fold(ids) end
  local digestParts, takes, older = {}, {}, 0
  for _, id in ipairs(ids) do
    local e = fetch(id)
    if isFoldEntry(e) then
      older = older + 1
      digestParts[#digestParts + 1] = e.gist
    else
      takes[#takes + 1] = e.gist
    end
  end
  return { digest = table.concat(digestParts, " "), takes = takes, older = older }
end

--- What one summary covers. nil for an unknown id (a model may guess wrong);
--- getJson throws loudly on a blob that won't decode. Renders by item shape:
--- {role, content} → "role: content" lines (content blocks render one per
--- line: text, → tool_use, ← tool_result), descriptors → id-bearing summary
--- lines (the next zoom level), anything else → verbatim.
function M.inspect(id)
  if type(id) ~= "string" or id == "" then return nil end
  local body = store.getJson(id):await()
  if body == nil then return nil end
  local entry = sanitize.data(json.decode(body))
  local head = "[" .. id .. ": " .. tostring(entry.label or "") .. "]"
  if type(entry.content) ~= "table" then
    return head .. " " .. tostring(entry.gist or "") .. "\\n(no recorded content — gist only)"
  end
  local lines = { head }
  for _, item in ipairs(entry.content) do
    if type(item) == "table" and item.role then
      if type(item.content) == "string" then
        lines[#lines + 1] = tostring(item.role) .. ": " .. chrome.clean(item.content)
      elseif type(item.content) == "table" then
        for _, b in ipairs(item.content) do
          if b.type == "text" then
            lines[#lines + 1] = tostring(item.role) .. ": " .. tostring(b.text)
          elseif b.type == "tool_use" then
            lines[#lines + 1] = "→ " .. tostring(b.name) .. "(" .. json.encode(b.input) .. ")"
          elseif b.type == "tool_result" then
            lines[#lines + 1] = "← " .. chrome.oneline(b.content, 200)
          end
        end
      end
    elseif isDescriptor(item) then
      lines[#lines + 1] = "- [" .. item.id .. ": " .. tostring(item.label or "") .. "] " .. item.gist
    else
      lines[#lines + 1] = tostring(item)
    end
  end
  return table.concat(lines, "\\n")
end

-- ---------- the tool contract ----------

--- With NO argument: the module-level inspect_summary schemas (ts:use(rolling)).
--- With a channel: a contract object ({ tools, exec }) exposing the freestyle
--- kv tools over that one channel — list_facts / get_fact / set_fact. No
--- schema, no closed key list: the model invents keys as the fiction demands
--- ("grudge_against_guild", "current_disguise"), and list_facts keeps it from
--- forking a near-duplicate key. One channel's kv tools per toolset — the
--- tool names are fixed, so two channels in one toolset collide.
function M.tools(ch)
  if ch == nil then
    return { {
      type = "function",
      ["function"] = {
        name = "inspect_summary",
        description = "Open one summary by id (ids appear in the STORY SO FAR briefing). A folded summary lists the summaries inside it, each with its own id — inspect those to keep zooming toward the raw log.",
        parameters = { type = "object", properties = { id = { type = "string" } }, required = { "id" } } },
      },
    }
  end
  assertChannel(ch, "tools")
  return {
    tools = function()
      return { {
        type = "function",
        ["function"] = {
          name = "list_facts",
          description = "List the keys of every verbatim fact currently filed. Check BEFORE writing — re-key an existing fact instead of forking a near-duplicate.",
          parameters = { type = "object", properties = {} } },
      }, {
        type = "function",
        ["function"] = {
          name = "get_fact",
          description = "Read one verbatim fact by key. The answer is canon.",
          parameters = { type = "object", properties = { key = { type = "string" } }, required = { "key" } } },
      }, {
        type = "function",
        ["function"] = {
          name = "set_fact",
          description = "File or OVERWRITE a verbatim fact by key — the latest value is canon. For facts that must survive paraphrase: appearances, world truths, standing rules.",
          parameters = { type = "object", properties = { key = { type = "string" }, value = { type = "string" } }, required = { "key", "value" } } },
      } }
    end,
    exec = function(name, args)
      if name == "list_facts" then
        local keys = sortedKeys(ch.kv)
        if #keys == 0 then return "no facts filed" end
        return table.concat(keys, ", ")
      end
      if name == "get_fact" then
        local k = tostring(args and args.key or "")
        local v = ch.kv[k]
        if v == nil then return "no fact filed under: " .. k end
        return factValue(v)
      end
      if name == "set_fact" then
        local k = tostring(args and args.key or "")
        if k == "" then return "rejected: key required" end
        -- Assigning nil DELETES the key — a missing value must not report
        -- success while silently un-filing the fact.
        if args == nil or args.value == nil then return "rejected: value required" end
        ch.kv[k] = args.value
        return json.encode({ fact_set = k })
      end
      return nil
    end,
  }
end

function M.exec(name, args)
  if name == "inspect_summary" then
    return M.inspect(args and args.id) or "unknown summary: " .. tostring(args and args.id)
  end
  return nil
end

return M
\`\`\`

\`\`\`lua
-- lib/layout.lua — the floor LAYOUT generator: the model never decides
-- topology, Lua does.
--
-- NOT deterministic — math.random drives growth and shuffles, and equal
-- candidates fall to pairs() hash order, so nothing here is reproducible.
-- What is guaranteed is structural: Lua grows a connected blob of cells on
-- an integer grid (passages only between orthogonal neighbors → the map is
-- planar BY CONSTRUCTION, no planarity check anywhere), partitions it into
-- contiguous labeled SECTIONS via balanced multi-source BFS, builds a
-- spanning tree of passages plus a knob-count of loop edges, and picks the
-- entrance (a quiet border cell) and the stairs (the BFS-farthest room).
--
-- Knobs (all optional):
--   rooms    — cell count (default 8)
--   sections — labeled subgraph count (default 2, max 4)
--   loops    — extra non-tree passages (default 1)
--   sprawl   — 0..1 growth bias: 0 snakes corridors, 1 clumps blobs
--              (default 0.5); per-floor randomness here is the anti-monotony
--   terminal — no stairs (the bottom floor; the relic is the way out)
--
-- Output (ids are r1..rN in BFS order from the entrance, so r1 = entrance):
--   {
--     order      = { "r1", "r2", ... },
--     rooms      = { r1 = { x, y, section = "A", exits = { north = "r3", ... } } },
--                  -- exits are compass-labeled from edge geometry and SYMMETRIC
--     edges      = { { a = "r1", b = "r3" }, ... },  -- undirected, deduped
--     entrance   = "r1",
--     stairsDown = "r7" | nil,                      -- nil on terminal floors;
--                  -- the stairs room also gets exits.down = "down" (the serve
--                  -- path's descent trigger)
--     sections   = { { id = "A", rooms = { "r1", ... } }, ... },
--     deadEnds   = { "r5", ... },                   -- degree-1 rooms, sorted
--   }
--
-- M.skeleton(lay) renders the layout as the text block the planning sub-gen
-- sees: a section-letter grid plus per-section room lists, dead ends, and
-- the stairs — the model authors AGAINST this shape, never past it.

local M = {}

local DIRS = {
  { dx = 0, dy = -1, dir = "north" },
  { dx = 1, dy = 0, dir = "east" },
  { dx = 0, dy = 1, dir = "south" },
  { dx = -1, dy = 0, dir = "west" },
}
local OPP = { north = "south", south = "north", east = "west", west = "east" }
local LETTERS = "ABCD"

local function shuffle(t)
  for i = #t, 2, -1 do
    local j = math.random(i)
    t[i], t[j] = t[j], t[i]
  end
  return t
end

local function key(x, y) return x .. "," .. y end

-- Claim one free orthogonal neighbor of some cell; prefer neighbors inside
-- the soft radius so the blob stays map-shaped instead of hiking into a
-- corner. preferNewest = corridor bias (try the newest cell first).
local function growOne(cells, occupied, radius, preferNewest)
  local parents = {}
  for _, c in ipairs(cells) do parents[#parents + 1] = c end
  shuffle(parents)
  if preferNewest then
    local newest = cells[#cells]
    local ordered = { newest }
    for _, c in ipairs(parents) do
      if c ~= newest then ordered[#ordered + 1] = c end
    end
    parents = ordered
  end
  for _, p in ipairs(parents) do
    local cand = {}
    for _, d in ipairs(DIRS) do
      local nx, ny = p.x + d.dx, p.y + d.dy
      if not occupied[key(nx, ny)] then
        cand[#cand + 1] = { x = nx, y = ny, inside = math.max(math.abs(nx), math.abs(ny)) <= radius }
      end
    end
    shuffle(cand)
    local pick = nil
    for _, c in ipairs(cand) do
      if c.inside then pick = c break end
    end
    if not pick and #cand > 0 then pick = cand[1] end
    if pick then
      local cell = { x = pick.x, y = pick.y }
      occupied[key(cell.x, cell.y)] = true
      cells[#cells + 1] = cell
      return cell
    end
  end
  return nil -- fully boxed in (cannot happen on an open grid, but stay honest)
end

-- Multi-hop BFS distances; \`adjacent(node)\` returns neighbor nodes.
local function bfs(start, adjacent)
  local dist = { [start] = 0 }
  local queue = { start }
  local qi = 1
  while qi <= #queue do
    local cur = queue[qi]
    qi = qi + 1
    for _, nxt in ipairs(adjacent(cur)) do
      if dist[nxt] == nil then
        dist[nxt] = dist[cur] + 1
        queue[#queue + 1] = nxt
      end
    end
  end
  return dist
end

function M.generate(opts)
  opts = opts or {}
  local n = math.max(4, math.min(24, math.floor(tonumber(opts.rooms) or 8)))
  local k = math.max(1, math.min(4, math.floor(tonumber(opts.sections) or 2)))
  local loops = math.max(0, math.min(6, math.floor(tonumber(opts.loops) or 1)))
  local sprawl = math.min(1, math.max(0, tonumber(opts.sprawl) or 0.5))
  local terminal = opts.terminal == true
  if n < k * 2 then k = math.max(1, math.floor(n / 2)) end

  -- 1. Grow the blob.
  local radius = 2 + math.ceil(n / 3)
  local cells = { { x = 0, y = 0 } }
  local occupied = { ["0,0"] = true }
  while #cells < n do
    local preferNewest = math.random() >= sprawl
    if not growOne(cells, occupied, radius, preferNewest) then break end
  end
  n = #cells

  local byKey = {}
  for i, c in ipairs(cells) do byKey[key(c.x, c.y)] = i end
  local function cellAdj(cell)
    local out = {}
    for _, d in ipairs(DIRS) do
      local j = byKey[key(cell.x + d.dx, cell.y + d.dy)]
      if j then out[#out + 1] = j end
    end
    return out
  end

  -- 2. Entrance: prefer a degree-1 border cell (a quiet corner); a ring-shaped
  -- blob has none, so the fallback really is ANY cell. Ids r1..rN follow BFS
  -- order from it, so r1 = entrance.
  local anyCell, quiet = {}, {}
  for i, c in ipairs(cells) do
    anyCell[#anyCell + 1] = i
    if #cellAdj(c) == 1 then quiet[#quiet + 1] = i end
  end
  local entranceIdx = quiet[#quiet] or anyCell[math.random(#anyCell)]

  local idOf, cellOf, order = {}, {}, {}
  do
    local dist = bfs(entranceIdx, function(i) return cellAdj(cells[i]) end)
    local sorted = {}
    for i in pairs(dist) do sorted[#sorted + 1] = i end
    table.sort(sorted, function(a, b)
      if dist[a] ~= dist[b] then return dist[a] < dist[b] end
      local ca, cb = cells[a], cells[b]
      if ca.x ~= cb.x then return ca.x < cb.x end
      return ca.y < cb.y
    end)
    for rank, i in ipairs(sorted) do
      local id = "r" .. rank
      idOf[i] = id
      cellOf[id] = cells[i]
      order[#order + 1] = id
    end
  end

  -- 3. Sections: farthest-first seeds, then balanced multi-source BFS. A
  -- section only ever claims cells adjacent to its own claim set, so every
  -- section is contiguous by construction.
  local sectionOf = {}
  local sections = {}
  local seeds = { entranceIdx }
  local isSeed = { [entranceIdx] = true }
  while #seeds < k do
    local best, bestD = nil, -1
    for _, i in pairs(byKey) do
      if not isSeed[i] then
        local nearest = math.huge
        for _, s in ipairs(seeds) do
          local d = math.abs(cells[i].x - cells[s].x) + math.abs(cells[i].y - cells[s].y)
          if d < nearest then nearest = d end
        end
        if nearest > bestD then best, bestD = i, nearest end
      end
    end
    -- No unclaimed cell left (only possible if a caller bypasses the n >= k*2
    -- clamp above): stop rather than seed a duplicate.
    if best == nil then break end
    seeds[#seeds + 1] = best
    isSeed[best] = true
  end
  for si = 1, k do sections[si] = { id = LETTERS:sub(si, si), rooms = {} } end
  local cap = math.ceil(n / k)
  local queues = {}
  for si, s in ipairs(seeds) do
    local id = idOf[s]
    sectionOf[id] = si
    sections[si].rooms[#sections[si].rooms + 1] = id
    queues[si] = { s }
  end
  local progress = true
  while progress do
    progress = false
    for si = 1, k do
      if #sections[si].rooms < cap and queues[si] and #queues[si] > 0 then
        local front = table.remove(queues[si], 1)
        for _, j in ipairs(cellAdj(cells[front])) do
          local id = idOf[j]
          if sectionOf[id] == nil and #sections[si].rooms < cap then
            sectionOf[id] = si
            sections[si].rooms[#sections[si].rooms + 1] = id
            queues[si][#queues[si] + 1] = j
            progress = true
          end
        end
      end
    end
  end
  -- Leftovers (sections boxed out at cap): join any adjacent section.
  local leftovers = {}
  for _, id in ipairs(order) do
    if sectionOf[id] == nil then leftovers[#leftovers + 1] = id end
  end
  while #leftovers > 0 do
    local placed = false
    for li = #leftovers, 1, -1 do
      local id = leftovers[li]
      local c = cellOf[id]
      for _, d in ipairs(DIRS) do
        local j = byKey[key(c.x + d.dx, c.y + d.dy)]
        if j and sectionOf[idOf[j]] then
          local si = sectionOf[idOf[j]]
          sectionOf[id] = si
          sections[si].rooms[#sections[si].rooms + 1] = id
          table.remove(leftovers, li)
          placed = true
          break
        end
      end
    end
    if not placed then -- pathological isolate (cannot happen on a grown blob): park it in section 1
      local id = table.remove(leftovers)
      sectionOf[id] = 1
      sections[1].rooms[#sections[1].rooms + 1] = id
    end
  end
  -- Compact empty sections (defensive; seeds guarantee non-empty) and remap.
  do
    local dense, remap = {}, {}
    for si = 1, #sections do
      if #sections[si].rooms > 0 then
        remap[si] = #dense + 1
        dense[#dense + 1] = sections[si]
      end
    end
    sections = dense
    for id, si in pairs(sectionOf) do sectionOf[id] = remap[si] end
  end

  -- 4. Passages: a union-find spanning tree that keeps every section walkable
  -- INTERNALLY (intra-section edges first), then joins the sections with the
  -- minimum cross-section doorways; up to \`loops\` extra edges on top. Real
  -- dead ends fall out of the tree structure.
  local rooms, edges, edgeSeen = {}, {}, {}
  local function addEdge(a, b)
    local ka = a < b and (a .. "|" .. b) or (b .. "|" .. a)
    if edgeSeen[ka] then return end
    edgeSeen[ka] = true
    edges[#edges + 1] = { a = a, b = b }
  end
  for _, id in ipairs(order) do
    local c = cellOf[id]
    rooms[id] = { x = c.x, y = c.y, section = sections[sectionOf[id]].id, exits = {} }
  end
  local function link(a, b)
    local ca, cb = cellOf[a], cellOf[b]
    local dir
    if cb.x == ca.x + 1 then dir = "east"
    elseif cb.x == ca.x - 1 then dir = "west"
    elseif cb.y == ca.y + 1 then dir = "south"
    else dir = "north" end
    rooms[a].exits[dir] = b
    rooms[b].exits[OPP[dir]] = a
    addEdge(a, b)
  end
  do
    -- Enumerate each grid adjacency once (east + south).
    local intra, cross = {}, {}
    for _, id in ipairs(order) do
      local c = cellOf[id]
      for _, d in ipairs(DIRS) do
        if d.dir == "east" or d.dir == "south" then
          local j = byKey[key(c.x + d.dx, c.y + d.dy)]
          if j then
            local other = idOf[j]
            local list = sectionOf[id] == sectionOf[other] and intra or cross
            list[#list + 1] = { a = id, b = other }
          end
        end
      end
    end
    shuffle(intra)
    shuffle(cross)
    local parent = {}
    for _, id in ipairs(order) do parent[id] = id end
    local function find(x)
      while parent[x] ~= x do
        parent[x] = parent[parent[x]]
        x = parent[x]
      end
      return x
    end
    local function join(e)
      local ra, rb = find(e.a), find(e.b)
      if ra == rb then return false end
      parent[ra] = rb
      link(e.a, e.b)
      return true
    end
    for _, e in ipairs(intra) do join(e) end -- per-section spanning trees
    for _, e in ipairs(cross) do join(e) end -- then the doorways between them
    local extra = {}
    for _, e in ipairs(intra) do
      if find(e.a) ~= find(e.b) then extra[#extra + 1] = e end
    end
    for _, e in ipairs(cross) do
      if find(e.a) ~= find(e.b) then extra[#extra + 1] = e end
    end
    shuffle(extra)
    for i = 1, math.min(loops, #extra) do link(extra[i].a, extra[i].b) end
  end

  -- 5. Stairs: the BFS-farthest room from the entrance (the descent is earned).
  local stairsDown = nil
  if not terminal then
    local dist = bfs(order[1], function(id)
      local out = {}
      for _, to in pairs(rooms[id].exits) do out[#out + 1] = to end
      return out
    end)
    local far, farD = order[1], 0
    for id, d in pairs(dist) do
      if d > farD then far, farD = id, d end
    end
    stairsDown = far
    -- The stairs are an EXIT like any other: serve() descends on
    -- exits.down == "down" and the button row renders Descend from it. The
    -- map tag skips it (the target "down" is no room), so this is invisible
    -- to the graph — but without it the stairs are drawn and can never be
    -- taken (the card's own serve loop once shipped exactly that bug).
    rooms[far].exits.down = "down"
  end

  local deadEnds = {}
  for _, id in ipairs(order) do
    local deg = 0
    for _, to in pairs(rooms[id].exits) do
      if rooms[to] then deg = deg + 1 end -- the down pseudo-exit is no room
    end
    if deg == 1 then deadEnds[#deadEnds + 1] = id end
  end
  table.sort(deadEnds)

  return {
    order = order,
    rooms = rooms,
    edges = edges,
    entrance = order[1],
    stairsDown = stairsDown,
    sections = sections,
    deadEnds = deadEnds,
  }
end

-- The text block the planning sub-gen sees: section-letter grid, per-section
-- room lists, passages, dead ends, and the stairs position.
function M.skeleton(lay)
  local minX, minY, maxX, maxY = math.huge, math.huge, -math.huge, -math.huge
  local grid = {}
  for _, id in ipairs(lay.order) do
    local c = lay.rooms[id]
    grid[key(c.x, c.y)] = c.section
    if c.x < minX then minX = c.x end
    if c.x > maxX then maxX = c.x end
    if c.y < minY then minY = c.y end
    if c.y > maxY then maxY = c.y end
  end
  local rows = {}
  for y = minY, maxY do
    local row = {}
    for x = minX, maxX do
      row[#row + 1] = grid[key(x, y)] or "."
    end
    rows[#rows + 1] = table.concat(row, " ")
  end

  local marks = { [lay.entrance] = "entrance" }
  if lay.stairsDown then marks[lay.stairsDown] = "stairs down" end
  local lines = {
    "THE LAYOUT (already built, FIXED — do not add rooms or passages):",
    "",
    table.concat(rows, "\\n"),
    "(the top of the map is north)",
    "",
    "Sections (one letter each — theme every one):",
  }
  for _, sec in ipairs(lay.sections) do
    -- Sorted so the prompt reads stable across runs of the same layout.
    local ids = {}
    for _, id in ipairs(sec.rooms) do ids[#ids + 1] = id end
    table.sort(ids)
    local parts = {}
    for _, id in ipairs(ids) do
      parts[#parts + 1] = id .. (marks[id] and (" (" .. marks[id] .. ")") or "")
    end
    lines[#lines + 1] = "  " .. sec.id .. ": " .. table.concat(parts, ", ")
  end
  local passages = {}
  for _, e in ipairs(lay.edges) do passages[#passages + 1] = e.a .. "-" .. e.b end
  table.sort(passages)
  lines[#lines + 1] = "Passages: " .. table.concat(passages, ", ")
  -- The entrance is safe by card rule (no encounters — see main.lua's
  -- prompt), so it must not sit in the "hide the best rewards" list even
  -- when it is a degree-1 room; say so explicitly instead.
  local rewardEnds = {}
  for _, id in ipairs(lay.deadEnds) do
    if id ~= lay.entrance then rewardEnds[#rewardEnds + 1] = id end
  end
  if #rewardEnds > 0 then
    lines[#lines + 1] = "Dead ends (hide the best rewards here): " .. table.concat(rewardEnds, ", ")
  end
  lines[#lines + 1] = "The entrance (" .. lay.entrance .. ") is safe: no encounters there."
  if not lay.stairsDown then
    lines[#lines + 1] = "NO stairs down on this floor — it is the bottom; the relic is what ends the delve here."
  end
  return table.concat(lines, "\\n")
end

return M
\`\`\`
`;
