/** Reference doc for the `game_cards_example` topic, served by the Docs tool. */
export const GAME_CARDS_EXAMPLE_DOC = `# The Guildhall (worked example: content factory + event engine)

A complete, TESTED game card: \`backend_logic/main.lua\` plus its vendored game lib (\`backend_logic/lib/*.lua\`) — a social hub run by the event engine over a procedurally-designed dungeon run by the content factory. Idle in the hall (delve / store / blacksmith, or free text); \`/delve\` drops you into a dungeon whose floors the model designs as room-graphs and Lua serves for free (movement, combat, loot, a fog-of-war map) until you do something unscripted. Theory lives in topic \`game_cards\` (The content factory; The event engine; The game lib); this topic is the steal-able file. (Repo copy \`docs/design/examples/guildhall/main.lua\` + \`docs/design/examples/game-lib/*.lua\`, validated end-to-end through the real adapter by \`server/src/backends/guildhall.example.test.ts\`; install as a playable card with \`server/scripts/add-guildhall.ts\`.) Decisions worth noticing:

- **One card, two boundary positions, ONE events engine.** \`state.mode = hall | dungeon\`. The events engine sits ABOVE both: \`ev.isOpen()\` is checked before the mode turn, so an event opened mid-combat or mid-explore PAUSES that mode and RESUMES it on close — combat state (\`state.dun.combat\`) persists across a scene. The hall delegates every turn it can't serve (conversation can't be commissioned ahead of the input it answers); the dungeon commissions at floor granularity (one planning sub-gen per floor, then free serve turns).
- **The DM is reachable from ANY mode.** Free text always escalates — in the hall to the hall DM, in the dungeon to the dungeon DM. The combat gate is RELAXED: while a monster lives, deterministic movement/look/interact verbs are refused ("the monster is between you and everything else"), but unrecognized input falls through to the dungeon DM (\`serve\` returns nil), which may \`open_event\` even mid-fight. Both roles run the FULL toolset (one toolset, two views — a second \`open_event\` mid-scene or a DM-side \`close_event\` fails as an ordinary error result); casting remains the scene-runner's job by convention, not by schema.
- **Five registries, two storage shapes.** Characters (\`state.characters\`, unpartitioned, \`mutable = { "personality" }\`, injected into \`events.new\`; per-character dossiers via \`lib/events\`). Dungeon content is PARTITIONED by floor — floors, rooms, enemies, interactables share one pack blob per floor. Enemies file through the registry's own mutation tool during planning; rooms/floors/interactables file card-side after \`validateGraph\` (graph repair needs prune/rewrite, which set/update can't express).
- **Trust the model: no \`[sys]\` tag.** Acks are plain visible text — the model sees what the player sees. Don't reach for a hide channel; it just rewrangles the delegate's prompt for no gain.
- **Death and the relic end the DELVE, not the game.** \`state.dun.delveOver = "dead" | "won"\`; the next turn returns you to the hall (hp reset, room to f1; packs and the relic flag persist). The card never terminally ends.
- **Pack blobs in the store, pointers in \`state.packIds\` — and the card never touches a blob.** Writes queue mutation records in \`state\`; \`registry.flush()\` at the end of \`generate()\` applies them (one new put per touched floor) and moves the pointers — a swiped branch keeps its version. The boundary gen is INVISIBLE to the player: no "Designed The Upper Halls" memoir — the /delve reply is just the entrance narration. \`state.dun.*\` is the dungeon's namespaced home — every former unprefixed crypt key lives there, so it can't collide with the hall or the events engine.
- **The event's span IS the scene-runner's prompt — and the test proves the prefix property.** Node zero of the span is the system briefing (instructions + the DM's context via \`ev.eventLine()\`, plus \`rolling.briefing(state.story)\` at open time); then one node per turn in a persistent array in the store (\`state.event.spanId\`), FULL-FIDELITY — user inputs, assistant replies, AND the tool_use/tool_result rounds, so the model never re-issues a read. Each scene turn rebuilds the prompt by reading the span and appending: turn N is a strict prefix of turn N+1 by construction (no log parsing, no history-budget dependence), so the delegate's prefix cache covers the whole scene — and a briefing that must change mid-scene just rides the next node (slower, never wrong). The scene-runner's toolset includes \`inspect_summary\`, so it can zoom into the public record instead of guessing.
- **Dossiers: memory keyed by WHO was there.** \`close_event\` files one take per participant in \`state.dossiers\`; \`get_character\` serves the file + dossier as a read-tool result. Dossiers are \`lib/rolling\` channels: recent takes verbatim, oldest folded into digest entries on read (a never-read character costs no token; a delegate error fails the turn — ids move only once the fold lands, so a swipe retries). An EMPTY dossier means never-met — and the scene-runner prompt says so outright, because a gap in the record loses to a strong prior: models fill silence with assumption, and canon-heavy casts come with the loudest assumptions.
- **The STORY is a rolling channel, and every delegate can zoom into it.** Fight gists land in \`state.story\` (a \`lib/rolling\` channel — world facts like the registered player ride its kv half via \`rolling.set\`) with the fight's mechanical span as their content; both DM briefings AND the span's node-zero briefing carry the \`STORY SO FAR\` lines, and every delegate toolset exposes \`inspect_summary\` — the model tool-calls its way from a digest line down to the actual blows.
- **Onboarding is a script-opened event, and the greeting has NO buttons on purpose.** The first turn opens a registration event in \`ensureState\` (no delegate needed); the scene-runner runs the receptionist, \`register_player\` files the name and rolls stats, \`close_event\` hands the player into the hall. While it runs, \`buttonsHtml\` returns "" — the menu can't serve anything before registration, so the greeting offers nothing to click (the receptionist asked a question; type, don't click). It is the ONLY script-opened event: with no history to contradict, a static context is safe — every other scene is DM-framed so its context carries the live situation.
- **The card fields are minimal on purpose.** \`description\`/\`creatorNotes\` for the library, \`firstMes\` as the greeting — and personality/scenario/mesExample EMPTY, no lorebook. The script composes every delegate prompt by hand, so engine prompt-assembly fields never reach a delegate; the registries are the lore.
- **\`continue\`/\`impersonate\` throw early; a hard failure BRICKS the branch.** The generation-type guard fires before \`ensureState\` — only \`normal\` and \`regenerate\` run, and regenerate IS the normal path. Delegate errors are caught (\`pcall\` around the turn body): the card marks \`state.bricked\` and returns the error as the reply — a raw throw would roll the flag back with the rest of state. Further turns on the branch refuse; recovery is a swipe or rewind.

Companion character-scoped regex rules (installed by the script): optional hide \`/^\\s*\\/\\w+.*$/s\` (userInput), a HUD panel for \`[HUD|name=..|where=..|gold=..]\` (hall) / \`[HUD|name=..|where=..|hp=..|atk=..|gold=..]\` (dungeon — the renderer parses by key, order-agnostic), a \`[MAP|..]\` floor-graph renderer. That's all — memoir lines and event closes are plain prose; there are no structural tags to hide.

The lib modules this card vendors (\`loop\`, \`sanitize\`, \`chrome\`, \`ledger\`, \`toolset\`, \`todo\`, \`registry\`, \`summarize\`, \`maptag\`, \`events\`, \`rolling\`) are documented in topic \`game_cards\` (The game lib); full sources below.

\`\`\`lua
-- The Guildhall — a COMPLETE game card: a social hub (event engine) over a
-- procedurally-designed dungeon (content factory). Idle in the hall with a menu
-- (delve / store / blacksmith) or free text; the hall DM adjudicates and
-- FRAMES events, the scene-runner casts and writes scenes, and the
-- people you meet keep DOSSIERS — what THEY carried away — and bring it up
-- next time. /delve drops you into the dungeon: ONE planning sub-gen designs
-- each floor as a graph of rooms, a roster, interactables, and ambient lines;
-- Lua then serves it for dozens of turns with ZERO model calls (movement,
-- combat, loot, a fog-of-war map) until you do something nobody planned for.
-- Then the dungeon DM resolves it through a cost-economy toolset — and may
-- open a scene EVEN MID-FIGHT. Death and the relic end the DELVE, not the
-- game: you crawl back to the hall.
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
-- a swipe or rewind. Generation types: only normal/regenerate — continue and
-- impersonate throw BEFORE the brick machinery.
--
-- Built on the game lib (docs/design/examples/game-lib/, vendored as
-- backend_logic/lib/*.lua): loop (tool loop), sanitize (decoded-JSON
-- hygiene), chrome (buttons/unwrap, the shared clean/oneline text hygiene),
-- ledger (plot promises), todo (planning self-organization), toolset
-- (composition), registry (the character roster with mutable fields; the
-- partitioned dungeon content), summarize (the gist engine), maptag (the
-- fog-of-war map), events (the engine over the character registry), rolling
-- (the story channel — { kv, ids }: the player's FACTS plus the STORY SO FAR
-- the DM reads — and the dossier channels underneath events).
--
-- Companion display rules — only FUNCTIONAL chrome (the memoir lines are
-- plain prose; there are no structural tags to hide):
--   optional: /^\\s*\\/\\w+.*$/s with role userInput → "" (hide command messages;
--   safe because posted commands are bare text with no HTML to mangle)
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

local WIN_ITEM = "relic"

-- The scale knobs. ROOMS_PER_FLOOR is the big one: "6-10" keeps this example
-- readable — a real descent game wants "24-40". The planning sub-gen is paid
-- ONCE per floor either way, and serve turns are free at any floor size.
local ROOMS_PER_FLOOR = "6-10"
local ENCOUNTER_CHANCE = 0.3   -- per room entry (never at the entrance)
local ENCOUNTER_COOLDOWN = 4   -- turns a room stays quiet after a fight there
local MAX_ROSTER = 4           -- monsters per floor's random-encounter table
local FLEE_DC = 8              -- flee rolls d20+atk vs FLEE_DC + floor depth

local FLOORS = {
  f1 = { name = "The Upper Halls", theme = "collapsed galleries, dust and old bones", depth = 1 },
  f2 = { name = "The Flooded Stacks", theme = "knee-deep black water, rotting shelves", depth = 2 },
  f3 = { name = "The Relic Vaults", theme = "sealed stone vaults, something glints on a plinth", depth = 3,
         hint = "Somewhere on this floor place an interactable named 'relic' with effect { item = 'relic' } — the WIN item. Make the player EARN it. This is the deepest floor — do NOT place stairs down; the relic is the only way out." },
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
-- The partition is a property OF THE RECORD (rec.floor), derived by the card
-- — the model never hears the word.

-- The depth budget for enemy clamps is whatever floor is being planned (or
-- escalated on) RIGHT NOW — planFloor / spawn_enemy set it before filing.
local activeEnemyDepth = 1

local floorsReg = registry.new({
  tool = "file_floor", -- card-side only: the planning boundary files the validated floor
  description = "File a floor's meta record (name, description, entrance, stairs, ambient lines).",
  key = "floors",
  id_from = "floor",
  partition_by = function(rec) return rec.floor end,
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
  tool = "add_room", -- planning files rooms card-side (validateGraph repairs first)
  description = "File a room of the floor graph.",
  key = "rooms",
  id_from = "id",
  partition_by = function(rec) return rec.floor end,
  mutable = { "exits" }, -- the dungeon DM's add_exit rewrites a room's exits mid-delve
  fields = {
    { name = "id", type = "string", required = true },
    { name = "floor", type = "string", required = true },
    { name = "name", type = "string" },
    { name = "desc", type = "string" },
    { name = "exits", type = "table" },
  },
})

local enemiesReg = registry.new({
  tool = "add_encounter",
  description = "Add a monster to the floor's roster (max " .. MAX_ROSTER .. ") with canned combat lines. Lua rolls roster monsters as RANDOM encounters while the player explores. hp/atk/reward clamp to the depth budget.",
  key = "enemies",
  id_from = "name",
  partition_by = function(rec) return rec.floor end,
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
  partition_by = function(rec) return rec.floor end,
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
  -- scene-runner calls register_player (which rolls stats) and close_event,
  -- and the hall menu appears. Closed → onboarded, never re-opens.
  -- This is the ONLY script-opened event: a static context is safe here
  -- because there is no history to contradict yet. Once the game has a past,
  -- events are DM-framed (or their context is composed from state) — a canned
  -- context or opener asserts the past blindly, and the scene-runner will
  -- believe it ("welcome back, how was the dungeon?" on a first meeting).
  if not state.onboarded and state.event == nil
     and (state.characters == nil or #state.characters == 0) then
    state.characters = {}
    state.characters[#state.characters + 1] = { id = "receptionist", name = "The Receptionist",
      role = "guild receptionist", personality = "ink-stained, donut-eating, briskly fond of newcomers" }
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
    rooms[r.id] = { name = r.name, desc = r.desc, exits = r.exits or {} }
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

local function hud(pack)
  local namePart = state.playerName ~= "" and string.format("name=%s|", state.playerName) or ""
  if state.mode == "hall" then
    return string.format("[HUD|%swhere=The Hall|gold=%d]", namePart, state.gold)
  end
  local where = state.dun.room
  if pack then
    local room = pack.rooms[subOf(state.dun.room)]
    where = pack.name .. (room and (" — " .. room.name) or "")
  end
  return string.format("[HUD|%swhere=%s|hp=%d/%d|atk=%d|gold=%d]",
    namePart, where, state.dun.hp, state.dun.maxHp, state.dun.atk, state.gold)
end

local function statusTags(pack)
  if state.mode == "hall" then return hud(nil) end
  return hud(pack) .. "\\n" .. mapTag(pack)
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
    if depthOfFloor(floorOf(state.dun.room)) > 1 then
      out[#out + 1] = chrome.btn("up", "Climb up")
    end
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
-- Fights that started untracked get no summary.
local function endFight(prompt)
  local tag = state.dun.fightName
  state.dun.fightName = nil
  if not tag then return "" end
  local log = state.dun.fightLog
  state.dun.fightLog = nil
  local gist = log and summarize.gist(prompt, { span = log }) or nil
  gist = gist or "The crypt keeps the details."
  rolling.push(state.story, { label = tag, gist = gist, content = log })
  return "\\n" .. gist
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

  ts:handle("add_rooms", function(args)
    if type(args.rooms) ~= "table" then return "rejected: rooms array required" end
    local added = {}
    for _, r in ipairs(args.rooms) do
      if type(r) == "table" then
        local id = tostring(r.id or ""):lower()
        if id == "" or draft.rooms[id] then
          return "rejected: empty or duplicate room id '" .. id .. "' (added so far: " .. table.concat(added, ", ") .. ")"
        end
        local exits = {}
        if type(r.exits) == "table" then
          for dir, to in pairs(r.exits) do
            exits[tostring(dir):lower()] = tostring(to):lower()
          end
        end
        draft.rooms[id] = {
          name = tostring(r.name or id),
          desc = tostring(r.desc or ""),
          exits = exits,
        }
        draft.roomOrder[#draft.roomOrder + 1] = id
        added[#added + 1] = id
      end
    end
    -- Targets are NOT checked here — later batches may define them. The
    -- graph pass after planning drops dangling exits and prunes strays.
    return "ok: " .. table.concat(added, ", ")
  end, {
    type = "function",
    ["function"] = { name = "add_rooms", description = "Add a batch of rooms to the floor graph (make several calls for a big floor). Each room: id (short, like r3), name, desc (ONE line), exits (direction -> room id; the one stairs room gets down -> \\"DOWN\\"). The FIRST room of your FIRST call is the entrance.",
      parameters = { type = "object", properties = {
        rooms = { type = "array", items = { type = "object", properties = {
          id = { type = "string" }, name = { type = "string" }, desc = { type = "string" },
          exits = { type = "object" } },
          required = { "id", "name", "desc" } } } },
        required = { "rooms" } } },
  })

  ts:handle("add_interactable", function(args)
    local room = tostring(args.room or ""):lower()
    local iname = tostring(args.name or ""):lower()
    if room == "" or iname == "" then return "rejected: room and name required" end
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

-- Judgment as data, graph edition. The model's layout is a PROPOSAL; Lua
-- makes it true: dangling exits dropped, unreachable rooms pruned (BFS from
-- the entrance), exactly one stairs-down guaranteed, interactables on pruned
-- rooms dropped. Runs on the planning scratch draft BEFORE anything is filed.
local function validateGraph(draft)
  local repairs = {}
  draft.entrance = draft.roomOrder[1]
  if not draft.entrance or not draft.rooms[draft.entrance] then return repairs end

  for rid, room in pairs(draft.rooms) do
    for dir, to in pairs(room.exits) do
      if to ~= "down" and not draft.rooms[to] then
        room.exits[dir] = nil
        repairs[#repairs + 1] = "dropped dangling exit " .. rid .. " " .. dir
      end
    end
  end

  local dist = { [draft.entrance] = 0 }
  local queue = { draft.entrance }
  while #queue > 0 do
    local cur = table.remove(queue, 1)
    for _, to in pairs(draft.rooms[cur].exits) do
      if to ~= "down" and dist[to] == nil then
        dist[to] = dist[cur] + 1
        queue[#queue + 1] = to
      end
    end
  end
  for rid in pairs(draft.rooms) do
    if dist[rid] == nil then
      draft.rooms[rid] = nil
      repairs[#repairs + 1] = "pruned unreachable room " .. rid
    end
  end

  local terminal = isTerminalFloor(draft.id)
  local stairs
  for _, rid in ipairs(draft.roomOrder) do
    local room = draft.rooms[rid]
    if room then
      for dir, to in pairs(room.exits) do
        if to == "down" then
          room.exits[dir] = nil
          if terminal then
            repairs[#repairs + 1] = "dropped stairs in " .. rid .. " (terminal floor)"
          elseif stairs then
            repairs[#repairs + 1] = "dropped extra stairs in " .. rid
          else
            stairs = rid
          end
        end
      end
    end
  end
  if not terminal and not stairs then
    local far, farD = draft.entrance, 0
    for rid, d in pairs(dist) do
      if draft.rooms[rid] and d > farD then far, farD = rid, d end
    end
    draft.rooms[far].exits.down = "down"
    stairs = far
    repairs[#repairs + 1] = "stairs placed in " .. far .. " (none designed)"
  end
  draft.stairsDown = stairs

  for key in pairs(draft.interactables) do
    local rid = key:match("^(%w+):")
    if not (rid and draft.rooms[rid]) then
      draft.interactables[key] = nil
      repairs[#repairs + 1] = "dropped interactable " .. key
    end
  end
  return repairs
end

-- ONE planning sub-gen per floor: the model lays out the whole map through
-- tool calls (increments, not a one-shot blob), then writes the intro. The
-- boundary is INVISIBLE — the reply is just the entrance narration; the pack
-- commit (registry.flush at the end of generate) leaves no memoir line.
local function planFloor(prompt, fid)
  local floor = FLOORS[fid]
  if not floor then return "Nowhere to go." end
  local draft = { id = fid, description = "", rooms = {}, roomOrder = {},
    stairsDown = nil, interactables = {}, ambient = {} }
  local ts = planningToolset(draft, fid)
  local sub = {}
  for k, v in pairs(prompt) do sub[k] = v end
  sub.tools = ts:schemas()
  sub.messages = {
    { role = "system", content = "You are the content designer for a terse dark-fantasy dungeon crawler. "
      .. "Design the floor '" .. floor.name .. "' (" .. floor.theme .. "; depth " .. floor.depth
      .. ") as a GRAPH of " .. ROOMS_PER_FLOOR .. " rooms, using ONLY the tools — no prose until the design is done. "
      .. "Plan the work with set_todo first, then execute the plan. "
      .. "Layout: a real map, not a corridor — branches, a loop or two, dead ends. "
      .. "The FIRST room you add is the entrance (safe — no encounters roll there). "
      .. "Both sides of a passage need their exit. Exactly ONE room holds the stairs down "
      .. "(exit down -> \\"DOWN\\") — put it far from the entrance, past the interesting parts; "
      .. "the player should EARN the way down. "
      .. "After you finish, Lua validates the graph — dangling exits dropped, unreachable rooms "
      .. "pruned, missing stairs placed — so design boldly. "
      .. "Then the roster: 2-" .. MAX_ROSTER .. " monsters via add_encounter with canned lines "
      .. "(intro/hit/death) — Lua rolls them as RANDOM encounters while the player explores. "
      .. "Sprinkle 2-4 interactables (dead ends hide the best rewards) and 2-6 ambient lines. "
      .. "Terse, concrete, atmospheric. "
      .. (floor.hint and (floor.hint .. " ") or "")
      .. "When the design is done, write the floor intro: 2-3 terse sentences, second person."
      .. ledger.briefing() },
    { role = "user", content = "Design " .. floor.name .. " now." },
  }
  local res = backends.generate(sub):await()
  res = loop.run(sub, res, ts:exec(), 16)
  validateGraph(draft)
  if not draft.entrance then
    -- The model filed nothing usable: a skeleton floor keeps the game moving.
    draft.rooms = { r1 = { name = floor.name, desc = floor.theme .. ".", exits = { down = "down" } } }
    draft.roomOrder = { "r1" }
    draft.entrance = "r1"
    draft.stairsDown = "r1"
  end
  if draft.description == "" then draft.description = floor.name .. ": " .. floor.theme .. "." end
  -- File the validated floor into the partitioned registries — the same
  -- mutation path escalation writes use. registry.flush() (end of generate)
  -- commits ONE new pack blob for the floor and moves state.packIds[fid].
  floorsReg.create({ floor = fid, name = floor.name, description = draft.description,
    entrance = draft.entrance, stairsDown = draft.stairsDown, ambient = draft.ambient })
  for _, rid in ipairs(draft.roomOrder) do
    local room = draft.rooms[rid]
    if room then
      roomsReg.create({ id = rid, floor = fid, name = room.name, desc = room.desc, exits = room.exits })
    end
  end
  for key, it in pairs(draft.interactables) do
    interactablesReg.create({ key = key, floor = fid, responses = it.responses, effect = it.effect })
  end
  state.dun.room = fid .. ":" .. draft.entrance
  local intro = type(res.text) == "string" and res.text:match("^%s*(.-)%s*$") or ""
  if intro == "" then intro = draft.description end
  markSeen()
  return intro .. tail(floorPack(fid))
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
        local line = "You break and scramble back to the " .. (pack.rooms[pack.entrance].name or "entrance") .. "."
        fightLog({ role = "assistant", content = line })
        return { text = line, moved = true, fightEnded = true }
      end
      local counter = state.dun.combat.atk + math.random(0, 1)
      state.dun.hp = state.dun.hp - counter
      if state.dun.hp <= 0 then
        state.dun.delveOver = "dead"
        local line = state.dun.combat.lines.hit .. " You fall. THE CRYPT KEEPS YOU."
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
        local line = state.dun.combat.lines.death .. " (+" .. reward .. " gold)"
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
        local line = state.dun.combat.lines.hit .. " You fall. THE CRYPT KEEPS YOU."
        fightLog({ role = "assistant", content = line })
        return { text = line, fightEnded = true }
      end
      local line = state.dun.combat.lines.hit .. " You hit for " .. dmg .. "; it answers for " .. counter .. "."
      fightLog({ role = "assistant", content = line })
      return { text = line }
    end
  end

  if lower == "look" then
    return inCombat and gate() or { text = room.desc }
  end

  if lower == "up" or lower == "climb" then
    if inCombat then return gate() end
    local depth = depthOfFloor(floorOf(state.dun.room))
    if depth <= 1 then return { text = "The entry stair collapsed behind you. Down is the only way." } end
    state.dun.room = "f" .. (depth - 1)
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

  if (not inCombat) and has("attack") then
    return { text = "Nothing here fights back." }
  end

  local prefix = subOf(state.dun.room) .. ":"
  for key, it in pairs(pack.interactables) do
    if key:sub(1, #prefix) == prefix then
      local iname = key:sub(#prefix + 1)
      if lower:find(iname, 1, true) then
        if inCombat then return gate() end
        local usedKey = "used:" .. state.dun.room .. ":" .. iname
        if state.flags[usedKey] then
          return { text = it.responses[2] or it.responses[1] or "Nothing more happens." }
        end
        state.flags[usedKey] = true
        applyEffect(it.effect)
        return { text = it.responses[1] or "Nothing happens." }
      end
    end
  end

  return nil -- no deterministic match → escalate (DM reachable from any mode)
end

-- ---------- the delegates ----------

local HALL_DM_PROMPT = "You are the guildhall's dungeon master, adjudicating ONE player action in the idle hall. "
  .. "If the action opens a conversation or scene, call open_event with a kind and a CONTEXT: who the player "
  .. "is and what they are after, framed for the scene-runner who takes over — NO character list; casting is "
  .. "the scene-runner's job. Ground the CONTEXT in the STORY SO FAR: what just happened, and whether the "
  .. "player and the people involved have met before — the scene-runner inherits only your context and the "
  .. "public record. Use attempt() for anything risky — the ENGINE rolls and decides. set_flag for "
  .. "lasting facts, inspect_summary to zoom into what actually happened. Then narrate the outcome in 1-2 terse sentences, "
  .. "second person."

local DUNGEON_DM_PROMPT = "You are the dungeon master of a terse dungeon crawler, adjudicating ONE novel player action. "
  .. "If the action opens a conversation or scene (even mid-fight), call open_event with a kind and a CONTEXT: "
  .. "who the player is and what they are after — NO character list; casting is the scene-runner's job. "
  .. "Ground the CONTEXT in what actually happened (the STORY SO FAR; inspect_summary zooms in) — including "
  .. "whether the player and anyone involved have met before; the scene-runner inherits only your context "
  .. "and the public record. "
  .. "Rules: use attempt() for anything risky — the ENGINE rolls and decides; honor its result. "
  .. "Use remove_item/add_exit/set_flag/spawn_enemy to make consequences REAL — costs are deducted by the engine, "
  .. "and the tool result is the canonical record. Never grant what the tools can't express. "
  .. "After the tools, narrate the outcome in 1-3 terse sentences, second person."

local CHAT_PROMPT = "You are the scene-runner for one event in a guild-hall RPG. You write EVERY participant "
  .. "except the player — all of them, in one response. Cast the scene from the registry: list_characters "
  .. "before inventing anyone, get_character for a character's file and their history with the player, "
  .. "register_character to file someone NEW, add_to_chat to bring them on stage. Never speak for the player. "
  .. "The STORY SO FAR below is the public record: honor it over assumption, and inspect_summary zooms into "
  .. "any line of it. A character whose dossier is EMPTY has NO history with the player — they have never "
  .. "met; write them that way, with no assumed familiarity the record doesn't show. "
  .. "When the scene is spent, close_event with a gist and one take PER PARTICIPANT. "
  .. "Terse, concrete, in character.\\n\\nEVENT: "

-- The receptionist's opener — also the card's firstMes. On the onboarding turn
-- the script seeds it as a PRIOR assistant message in the span ("something the
-- model wrote on a previous output") so the scene-runner sees her already on
-- stage and just continues, instead of cold-starting through a
-- list_characters/add_to_chat dance. Keep this in sync with FIRST_MES in
-- scripts/add-guildhall.ts.
local GREETING = "The guildhall's reception desk is a slab of oak lost under forms. Behind it sits a woman with "
  .. "ink to the elbows, eating a donut — powdered sugar on her collar — who does not look up. "
  .. "\\"Donut? No? Your loss. Best in Thornwall, and I'm not telling you where I get them.\\" She licks "
  .. "a finger and slides a blank form your way. \\"Welcome to the Guildhall. Name and trade, newcomer "
  .. "— let's get you registered.\\""

-- Span-is-prompt: the event's prompt IS its record, and node zero is the
-- system briefing (instructions + event context + the STORY SO FAR at open
-- time). The card starts the span when it seeds node zero — right after the
-- event opens. The script-opened registration event also gets the
-- receptionist's greeting as a prior assistant message.
local function ensureSpanSeeded()
  if #ev.span() > 0 then return end
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
  -- receptionist calls this during registration, reads the result back, and
  -- close_event hands them into the hall.
  ts:handle("register_player", function(args)
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
    return json.encode({ registered = name, hp = state.dun.maxHp, atk = state.dun.atk, gold = state.gold,
      note = "registered — welcome them by name, then close_event" })
  end, {
    type = "function",
    ["function"] = { name = "register_player", description = "Register the newcomer's name (onboarding). Returns their starting stats. Then welcome them by name and close_event.",
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
local function addAttemptTool(ts, withAtk)
  ts:handle("attempt", function(args)
    local difficulty = math.max(5, math.min(20, tonumber(args.difficulty) or 10))
    local roll = math.random(1, 20)
    local total = roll + (withAtk and state.dun.atk or 0)
    local outcome = total >= difficulty and "success" or "failure"
    if withAtk and outcome == "failure" then state.dun.hp = math.max(0, state.dun.hp - 2) end -- failure stings
    return json.encode({ outcome = outcome, roll = roll, total = total, difficulty = difficulty,
      note = "the dice are the engine's, not yours — narrate THIS result" })
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
-- spawn_enemy) ride the registry mutation queue — flush commits them.
local function dungeonDmToolset()
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
    local dir = tostring(args.direction or ""):lower()
    local to = tostring(args.to or ""):lower()
    local fid = floorOf(state.dun.room)
    local cur = subOf(state.dun.room)
    local room = roomsReg.get(fid, cur)
    if dir == "" or not room or not roomsReg.get(fid, to) then
      local ids = {}
      for _, r in ipairs(roomsReg.list(fid)) do ids[#ids + 1] = r.id end
      table.sort(ids)
      return "rejected: destination must be a room on this floor (" .. table.concat(ids, ", ") .. ")"
    end
    local exits = {}
    for d, t in pairs(room.exits) do exits[d] = t end
    exits[dir] = to
    roomsReg.update(fid, cur, { exits = exits }) -- queued; flush commits the pack
    return json.encode({ added = dir .. " -> " .. to, via = tostring(args.via or "") })
  end, {
    type = "function",
    ["function"] = { name = "add_exit", description = "Add a NEW exit from the player's current room to another room ON THIS FLOOR (a new pack version is written). For changed circumstances: blown walls, revealed passages.",
      parameters = { type = "object", properties = {
        direction = { type = "string" }, to = { type = "string" }, via = { type = "string" } }, required = { "direction", "to" } } },
  })

  addSetFlagTool(ts, "Set a story flag.")

  ts:handle("spawn_enemy", function(args)
    local fid = floorOf(state.dun.room)
    activeEnemyDepth = depthOfFloor(fid)
    local depth = activeEnemyDepth
    local hp = math.max(1, math.min(tonumber(args.hp) or 6, 6 + depth * 4))
    local atk = math.max(1, math.min(tonumber(args.atk) or 2, 1 + depth))
    local name = tostring(args.name or "crypt thing")
    local lines = { intro = "It arrives.", hit = "It strikes.", death = "It falls." }
    state.dun.combat = { name = name, hp = hp, maxHp = hp, atk = atk, lines = lines, reward = 0 }
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
  return dmDispatch(prompt, 'The player attempts: "' .. cmd .. '"', cmd, system, dungeonDmToolset())
end

-- The hall DM: adjudicates idle-hall actions and FRAMES events. No mutation
-- economy (the hall has no inventory, map, or enemies); the full events
-- toolset, same as the scene-runner's.
local function hallDmToolset()
  local ts = toolset.new()
  ts:use(ledger)
  ts:use(ev)      -- the full toolset, one toolset two roles
  ts:use(rolling) -- inspect_summary, same as the dungeon DM

  addAttemptTool(ts, false)
  addSetFlagTool(ts, "Set a lasting world fact.")

  return ts
end

local function hallDmTurn(prompt, cmd)
  local system = HALL_DM_PROMPT .. "\\n\\nPLAYER: gold " .. state.gold
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
  return pack.description .. tail(pack)
end

-- Hall menu verbs + dungeon verbs are ALL refused while an event is open.
local function isModeVerb(cmd)
  if cmd == "delve" or cmd == "shop" or cmd == "smith" then return true end
  if cmd == "attack" or cmd == "flee" or cmd == "up" or cmd == "climb" then return true end
  if cmd == "go down" or cmd:match("^go %w+") then return true end
  return false
end

-- ---------- the turns ----------

local function hallTurn(prompt, cmd)
  if cmd == "delve" then
    state.mode = "dungeon"
    state.dun.delveOver = nil
    return enterDungeon(prompt)
  end
  if cmd == "shop" then
    return "The quartermaster grunts from behind the counter. Shelves of rope, rations, and rust." .. tail(nil)
  end
  if cmd == "smith" then
    return "The blacksmith does not look up. 'Arms and armor. Coin first.'" .. tail(nil)
  end
  if cmd == "" then
    return "Say something." .. tail(nil)
  end
  return hallDmTurn(prompt, cmd) .. tail(nil)
end

-- Events sit above both modes. Menu/dungeon verbs are gated; /leave is a
-- one-gen exit (a delegate error bricks the branch — a swipe retries);
-- otherwise the scene-runner writes a reply. Closing the event resumes
-- whatever mode was active — including combat, which persisted in
-- state.dun.combat. Either way a scene closes, it joins the STORY: the gist
-- as the line, the full span as the zoomable content.
local function eventTurn(prompt, cmd)
  if isModeVerb(cmd) then
    return "Finish your business here first." .. tail(currentPack())
  end
  if cmd == "leave" then
    local wasRegistration = state.event and state.event.kind == "registration"
    local gistLine = ev.finalize(prompt) -- the close's memoir line (plain text)
    rolling.push(state.story, {
      label = state.event.kind,
      gist = (state.event.closed and state.event.closed.gist) or ("The " .. state.event.kind .. " breaks off."),
      content = ev.span(),
    })
    ev.clear()
    if wasRegistration then state.onboarded = true end -- leaving onboarding still finishes it
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
    out = out .. "\\n\\n" .. state.event.closed.gist -- the memoir line
    ev.clear()
    if wasRegistration then state.onboarded = true end
    out = out .. "\\n\\nThe way on opens up again."
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
    if served.moved then
      local nfid = floorOf(state.dun.room)
      if nfid ~= fid then
        -- A stair: another floor's pack (it exists — the player came from
        -- there), or the boundary fires and a new floor is designed.
        pack = floorPack(nfid)
        if not pack then return planFloor(prompt, nfid) end
        state.dun.room = nfid .. ":" .. pack.entrance
        text = pack.description
      else
        -- In-floor move: free, and Lua rolls the roster on entry. A move
        -- with its own line (a successful flee) keeps it ahead of the desc.
        local room = pack.rooms[subOf(state.dun.room)]
        local desc = (room and room.desc ~= "") and room.desc or pack.description
        text = served.text and (served.text .. "\\n\\n" .. desc) or desc
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
  if ctx and ctx.generationType ~= "normal" and ctx.generationType ~= "regenerate" then
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
-- Default cap is 16, not 8: a delegate with set_todo spends rounds planning
-- (set list → work → mark done → work…) on top of its real tool calls.
-- maxRounds overrides per call. If the cap is hit with tool calls still
-- pending, loop.run THROWS — a wedged delegate fails the turn loudly (the
-- user sees which tools it was stuck on; a swipe retries) instead of
-- silently dropping the model's pending work.

local M = {}

function M.run(sub, res, exec, maxRounds)
  local rounds = 0
  local cap = maxRounds or 16
  while res.toolCalls and #res.toolCalls > 0 and rounds < cap do
    rounds = rounds + 1
    local content = {}
    for _, call in ipairs(res.toolCalls) do
      content[#content + 1] = { type = "tool_use", id = call.id, name = call.name, input = call.arguments }
      content[#content + 1] = { type = "tool_result", toolUseId = call.id, name = call.name, content = exec(call.name, call.arguments) }
    end
    sub.messages[#sub.messages + 1] = { role = "assistant", content = content }
    res = backends.generate(sub):await()
  end
  if res.toolCalls and #res.toolCalls > 0 then
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
  return (inner:gsub("^/", ""))
end

-- The deterministic cleaning every delegate view shares: strip legacy
-- [sys]…[/sys], <button>…</button>, and [HUD…]; trim. Transcript and the
-- event span BOTH use this — the append-only-prefix property of the event
-- span depends on the cleaning never diverging between views.
function M.clean(text)
  return (tostring(text or "")
    :gsub("%s*%[sys%].-%[/sys%]%s*", "\\n\\n")
    :gsub("%s*<button.-</button>", "")
    :gsub("%[HUD[^%]]*%]", "")
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
-- by id — promise({ id, … }) with an existing pending id OVERWRITES what/due
-- (latest is canon, never a duplicate), and resolve_promise overwrites the
-- status even on a resolved entry.

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
      description = "File a plot debt for your future self: something that MUST happen at a later turn (foreshadowing, a scheduled event, a threat that matures).",
      parameters = { type = "object", properties = {
        id = { type = "string" }, what = { type = "string" }, due = { type = "integer" } }, required = { "id", "what", "due" } },
    },
  }, {
    type = "function",
    ["function"] = {
      name = "resolve_promise",
      description = "Mark a plot-ledger entry as kept or failed once it comes due.",
      parameters = { type = "object", properties = {
        id = { type = "string" }, outcome = { type = "string" } }, required = { "id" } },
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
    -- Set semantics: re-filing an existing pending id OVERWRITES — latest is
    -- canon, never a duplicate.
    for _, p in ipairs(promises()) do
      if p.id == id and not p.status then
        p.what = what
        p.due = due
        return json.encode({ promised = id, due = due, replaced = true })
      end
    end
    local list = promises()
    list[#list + 1] = { id = id, what = what, due = due }
    return json.encode({ promised = id, due = due })
  end
  if name == "resolve_promise" then
    local id = tostring(args.id or "")
    for _, p in ipairs(promises()) do
      if p.id == id then
        p.status = args.outcome == "failed" and "failed" or "kept"
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
-- without spending prompt. todo.briefing() puts the same list in the
-- delegate's system prompt for cross-turn tasks.

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
    local list = todos()
    while #list > 0 do table.remove(list) end
    if type(args.items) == "table" then
      for _, item in ipairs(args.items) do
        local text = tostring(item)
        if text ~= "" then list[#list + 1] = { text = text, done = false } end
      end
    end
    return "plan set (" .. #list .. " items). remaining: " .. remaining()
  end
  if name == "todo_done" then
    local i = tonumber(args.index)
    local list = todos()
    if not i or not list[i] then return "rejected: no item " .. tostring(args.index) .. " — remaining: " .. remaining() end
    list[i].done = true
    return "done: " .. list[i].text .. ". remaining: " .. remaining()
  end
  return nil
end

--- The remaining items as a prompt block ("" when there is no plan).
function M.briefing()
  local out = {}
  for _, t in ipairs(todos()) do
    if not t.done then out[#out + 1] = "- " .. t.text end
  end
  if #out == 0 then return "" end
  return "\\nYOUR PLAN (work it; mark items done with todo_done):\\n" .. table.concat(out, "\\n")
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
-- construction.
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
--     a property OF THE RECORD, derived by the card: partition_by(rec) is
--     read at file time (a monster's partition is the floor it spawns on).
--     The model never hears the word — tool schemas carry no partition
--     field; \`floor\` is just a field the record happens to have.
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
--     partition_by = function(rec) return rec.floor end,  -- optional: packs
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
  create = true, update = true, briefing = true,
}

function M.new(def)
  local partitioned = def.partition_by ~= nil
  local packsKey = def.packs_key or "packIds"
  if partitioned and def.store then
    error("registry.new: store (draft mode) and partition_by don't combine — "
      .. "partitioned writes ARE the commit path; drop one", 2)
  end
  local mutableSet = {}
  if def.mutable then
    local known = {}
    for _, f in ipairs(def.fields or {}) do known[f.name] = true end
    for _, name in ipairs(def.mutable) do
      if not known[name] then
        error("registry.new: mutable field '" .. tostring(name) .. "' is not a declared field", 2)
      end
      mutableSet[name] = true
    end
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
    local body = store.getJson(pid):await()
    if not body then
      error("registry: pack blob missing for partition " .. tostring(pk) .. " (" .. tostring(pid)
        .. ") — blobs are script-written, this is a bug", 3)
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

  -- ---------- filing ----------

  --- The shared write path. Returns id, status, record, dropped where status
  --- is "filed" | "already"; or nil, reason on rejection.
  local function file(args)
    local rec, dropped, missing = coerce(def.fields, args)
    if #missing > 0 then
      return nil, "rejected: " .. table.concat(missing, ", ") .. " required"
    end
    local id = slugify(def.id_from and rec[def.id_from] or nil)
    if partitioned then
      local pk = def.partition_by(rec)
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
    local rec = findRecord(args and args.id)
    if not rec then return "unknown " .. tostring(def.key or "record") .. ": " .. tostring(args and args.id) end
    return json.encode(rec)
  end

  --- The shared update path. Partitioned takes pk explicitly (nil pk = scan).
  --- Returns true, dropped | nil, reason.
  local function applyUpdate(pk, id, fields)
    local partial, dropped = coercePartial(def.fields, fields, mutableSet)
    if not next(partial) then
      return nil, "rejected: nothing to update (mutable: " .. table.concat(def.mutable, ", ") .. ")"
    end
    if partitioned then
      local rec, foundPk
      if pk ~= nil then
        foundPk = tostring(pk)
        local recs, byId = resolvePartition(foundPk)
        rec = byId[tostring(id)]
        if not rec then
          local needle = tostring(id):lower()
          for _, r in ipairs(recs) do
            if def.id_from and tostring(r[def.id_from] or ""):lower() == needle then rec = r break end
          end
        end
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
    local ok, droppedOrErr = applyUpdate(nil, id, args)
    if not ok then return droppedOrErr end
    local rec = findRecord(id)
    local result = { updated = rec.id, record = rec }
    if droppedOrErr and #droppedOrErr > 0 then result.dropped = droppedOrErr end
    return json.encode(result)
  end

  -- ---------- the tool contract ----------

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
      out[#out + 1] = {
        type = "function",
        ["function"] = {
          name = def.query_tool,
          description = "Look up a filed " .. tostring(def.key or "record") .. " by id or name. The answer is canonical.",
          parameters = { type = "object", properties = { id = { type = "string" } }, required = { "id" } },
        },
      }
    end
    if updateTool then
      local uprops = { id = { type = "string" } }
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
          parameters = { type = "object", properties = uprops, required = { "id" } },
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
    local _, byId = resolvePartition(tostring(a))
    local rec = byId[tostring(b)]
    if rec then return rec end
    local needle = tostring(b or ""):lower()
    for _, r in ipairs(resolvePartition(tostring(a))) do
      if def.id_from and tostring(r[def.id_from] or ""):lower() == needle then return r end
    end
    return nil
  end

  --- The records of one partition (or the whole registry, unpartitioned).
  function R.list(pk)
    if not partitioned then return records() end
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
      local body = store.getJson(pid):await()
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
    state[g.pks][g.pk] = store.putJson("pack", blob):await()
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
-- caller picks the fallback. A delegate ERROR propagates and fails the turn —
-- failed turns never overwrite the last good state snapshot, so the user sees
-- the real error and a swipe/regenerate retries from a clean world. One
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
    local line = span[i].role .. ": " .. span[i].content
    if #line > budget then break end
    table.insert(lines, 1, line)
    budget = budget - #line
  end

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
  s = s:gsub("%s+", " "):gsub("^%s*(.-)%s*$", "%1")
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
--   local tag = maptag.tag(pack.rooms, {
--     cur = "r2",            -- current room (always shown, highlighted)
--     entrance = pack.entrance,
--     stairs = pack.stairsDown,
--     seen = { r1 = true, r2 = true },   -- nil = reveal the whole graph
--   })
--
-- The companion display rule (floor map) renders any tag of this shape;
-- its source is in topic \`game_cards_example\` and the \`regexes\` recipe.

local M = {}

local function clean(s)
  return (tostring(s):gsub("[|;>%[%]=<'\\"&]", " "):gsub("%s+", " "):gsub("^%s*(.-)%s*$", "%1"))
end

--- rooms: { id = { name = string, exits = { dir -> to } } }
--- opts: { cur, entrance, stairs, seen? } — see above.
function M.tag(rooms, opts)
  opts = opts or {}
  local seen = opts.seen
  local ids = {}
  for id in pairs(rooms) do ids[#ids + 1] = id end
  table.sort(ids)

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
      roomParts[#roomParts + 1] = id .. "=" .. (known and clean(rooms[id].name) or "?")
      local dirs = {}
      for d in pairs(rooms[id].exits or {}) do dirs[#dirs + 1] = d end
      table.sort(dirs)
      for _, d in ipairs(dirs) do
        local to = rooms[id].exits[d]
        if rooms[to] and visible[to] then
          local key = id < to and (id .. "|" .. to) or (to .. "|" .. id)
          if not edgeSeen[key] then
            edgeSeen[key] = true
            edgeParts[#edgeParts + 1] = id .. ">" .. clean(d) .. ">" .. to
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
  if def.fields then
    for _, f in ipairs(def.fields) do
      if RESERVED[f.name] then
        error("events.new: field name '" .. f.name .. "' is reserved (get_character injects it)", 2)
      end
    end
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
    return (tostring(text or ""):gsub("%[/?event [^%]]*%]", ""):gsub("%[/?chat[^%]]*%]", ""))
  end

  --- The cast note: who is on stage, from state.event.participants — appended
  --- to the newest user message each scene turn (volatile state rides the
  --- newest message, never deep in the span). "" when nobody is on stage.
  function E.castLine()
    local cast = participants()
    if #cast == 0 then return "" end
    return "(In the scene with you: " .. table.concat(cast, ", ") .. ")"
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
    if state.event.closed then return "already closing: " .. state.event.id end
    local gist = chrome.oneline(args.gist or "")
    if gist == "" then gist = "The " .. state.event.kind .. " breaks off." end
    local filed, dropped = {}, {}
    if type(args.takes) == "table" then
      for id, take in pairs(args.takes) do
        local present = false
        for _, p in ipairs(state.event.participants) do
          if p == id then present = true break end
        end
        if present then
          rolling.push(dossier(id), { label = state.event.kind, gist = take })
          filed[#filed + 1] = id
        else
          dropped[#dropped + 1] = tostring(id)
        end
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

  --- The /leave path. One finalize gen writes the gist and takes. Loud on
  --- error: a delegate failure throws and fails the turn (the card's Failure
  --- UX marks the branch bricked; recovery is a swipe or rewind). If the
  --- model just spends its rounds without calling close_event (a content
  --- outcome, not an error), the event still closes with a script-composed
  --- fallback gist. Returns the gist (a plain-text memoir line to serve).
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
    loop.run(sub, res, ts:exec(), 4)
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
      -- roster.briefing(): one line per record ("- id: label"), field-agnostic.
      local b = roster.briefing()
      if b == "" then return "registry: empty — no characters filed yet" end
      return "registry:" .. b
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
--     in the append-only store ({ label, gist, content? }); the entry's id IS
--     the blob id, so the store doubles as the archive: inspect(id) resolves
--     any id forever, live or folded away long ago. When the log outgrows the
--     window the oldest entries FOLD into a digest entry (see below).
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
-- { id, label, gist } of what it compressed, and its id replaces theirs in
-- the array. Fold entries fold the same way, so the model can tool-call its
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
  local blob = { label = chrome.oneline(entry.label), gist = gist }
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
    label = cut .. " episodes", gist = digest, content = descriptors,
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
        ch.kv[k] = args and args.value
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
`;
