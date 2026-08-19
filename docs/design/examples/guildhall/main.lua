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
--   /\[HUD\|([^\]]+)\]/g → panel HTML (HUD recipe, topic `regexes`) — hall
--   shows name/where/gold; the dungeon adds hp/atk (key-parsed, any order).
--   /\[MAP\|([^\]]+)\]/g → floor-graph map (maptag recipe)

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
  return hud(pack) .. "\n" .. mapTag(pack)
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
  return "\n\nYou notice: " .. table.concat(names, ", ") .. "."
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
  return "\n\n" .. statusTags(pack) .. "\n" .. buttonsHtml(pack)
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
  return "\n\n" .. recordFightGist(prompt, tag, log)
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
      .. "\n\n" .. layout.skeleton(lay) },
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
  .. "Terse, concrete, in character.\n\nEVENT: "

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
  if castNote ~= "" then input = input .. "\n\n" .. castNote end
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
  local system = DUNGEON_DM_PROMPT .. "\n\nFLOOR PACK (current design):\n" .. json.encode(pack)
    .. "\n\nPLAYER: hp " .. state.dun.hp .. "/" .. state.dun.maxHp .. ", atk " .. state.dun.atk
    .. ", gold " .. state.gold .. ", at " .. state.dun.room .. ", inventory: " .. invList()
    .. (state.dun.combat and ("\nIN COMBAT with " .. state.dun.combat.name) or "")
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
  local system = HALL_DM_PROMPT .. "\n\nPLAYER: gold " .. state.gold .. ", inventory: " .. invList()
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
}, "\n")

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
      return gistLine .. "\n\nYou step away; the moment ends."
        .. "\n\n(Type help anytime — it lists the commands.)" .. tail(currentPack())
    end
    return gistLine .. "\n\nYou step away; the moment ends." .. tail(currentPack())
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
      out = out .. "\n\n(Type help anytime — it lists the commands.)"
    else
      out = out .. "\n\nThe way on opens up again."
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
        text = (served.text and (served.text .. "\n\n" .. desc) or desc) .. noticeLine(pack)
        local intro = maybeRollEncounter(pack)
        if intro then text = text .. "\n\n" .. intro end
      end
    else
      text = served.text
      local amb = maybeAmbient(pack)
      if amb then text = text .. "\n\n" .. amb end
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
      .. "\n\nSwipe or rewind to a point before the failure to keep playing."
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
    .. "\n\nThis branch is bricked — swipe or rewind to retry from before the failure."
end

function list_models()
  return { { id = "the-guildhall", name = "The Guildhall" } }
end
