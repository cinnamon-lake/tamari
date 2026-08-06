-- The Guildhall — a COMPLETE game card: a social hub (event engine) over a
-- procedurally-designed dungeon (factory ratio). Idle in the hall with a menu
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
-- reachable from any mode; a DM may open_event whenever the action opens a
-- scene. Trust the model: acks are plain visible text, no [sys] channel.
--
-- Built on the game lib (docs/design/examples/game-lib/, vendored as
-- backend_logic/lib/*.lua): loop (tool loop), sanitize (decoded-JSON
-- hygiene), chrome (buttons/unwrap, the shared clean/oneline text hygiene),
-- ledger (plot promises), todo (planning self-organization), toolset
-- (composition), registry (TWO: characters with dossiers, enemies with canned
-- lines), summarize (the gist engine), maptag (the fog-of-war map), events
-- (the engine over the character registry), rolling (recursive summaries:
-- the STORY channel fight gists land in — the DM's ONLY history view — and
-- the dossiers underneath events; inspect_summary zooms from a gist into
-- the raw log).
--
-- Companion display rules — only FUNCTIONAL chrome (the memoir lines are
-- plain prose; there are no structural tags to hide):
--   optional: /^\s*\/\w+.*$/s with role userInput → "" (hide command messages;
--   safe because posted commands are bare text with no HTML to mangle)
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

-- Characters are the card's registry (state.characters); the events engine
-- owns event state, the cast tools, dossiers, the script-owned tags, the
-- append-only span, and the /leave finalize. Records are plain tables, so
-- roster.get(id) returns the LIVE record for ad-hoc mutations.
local roster = registry.new({
  tool = "register_character",
  description = "File a NEW character (check list_characters first — re-filing an existing name returns the existing record).",
  key = "characters",
  id_from = "name",
  fields = {
    { name = "name", type = "string", required = true, max = 40 },
    { name = "role", type = "string", max = 60 },
    { name = "personality", type = "string", max = 200 },
  },
})

local ev = events.new({ roster = roster })

-- ---------- state (hot only — pack POINTERS here, pack blobs in the store) ----------

local function ensureState()
  if type(state) ~= "table" then state = {} end
  -- shared
  state.mode = state.mode or "hall"            -- "hall" | "dungeon"
  state.gold = state.gold or 30
  state.flags = state.flags or {}
  state.turn = state.turn or 0
  state.story = state.story or {}              -- rolling summary ids (lib/rolling)
  -- dungeon (namespaced — every former unprefixed crypt key lives here)
  if type(state.dun) ~= "table" then state.dun = {} end
  state.dun.maxHp = state.dun.maxHp or 20
  state.dun.hp = state.dun.hp or state.dun.maxHp
  state.dun.atk = state.dun.atk or 4
  state.dun.inventory = state.dun.inventory or {} -- name -> count
  state.dun.packIds = state.dun.packIds or {}     -- floor id -> store blob id ("pack:f1#3")
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

-- ---------- content packs (blobs in the store; pointers in state) ----------

-- A floor pack is kilobytes of JSON — far too big for per-message state
-- snapshots. The blob goes into the append-only `store` (store.put ->
-- "pack:f1#3"); the branch-aware POINTER (state.dun.packIds[fid]) stays in
-- state. A mutation is a NEW put plus moving the pointer — old branches still
-- point at their version, so swipes stay correct. The player sees a plain
-- memoir line (composeSummary); no tags, no display rules.
local function composeSummary(pack, repairs)
  local n = 0
  for _ in pairs(pack.rooms) do n = n + 1 end
  local stairs = pack.rooms[pack.stairsDown]
  local s = "Designed " .. pack.name .. ": " .. n .. " rooms, " .. #pack.encounterTable
    .. " monsters, stairs in " .. (stairs and stairs.name or "?") .. "."
  if repairs and #repairs > 0 then s = s .. " (" .. #repairs .. " repairs)" end
  return s
end

local function packBlob(pack, summary)
  local pid = store.putJson("pack:" .. pack.id, pack):await()
  state.dun.packIds[pack.id] = pid
  return summary
end

local function copyPack(pack)
  return json.decode(json.encode(pack))
end

-- The pack for a floor: the pointer is in state, the blob in the store.
-- No pointer → nil (the floor was never designed ON THIS BRANCH — the caller
-- plans it). A pointer whose blob is missing is a bug, not bad luck — blobs
-- are script-written — so it throws (getJson throws just as loudly on one
-- that won't decode).
local function findPack(id)
  local pid = state.dun.packIds[id]
  if not pid then return nil end
  local body = store.getJson(pid):await()
  if not body then
    error("pack blob missing for " .. id .. " (" .. pid .. ") — blobs are script-written, this is a bug", 2)
  end
  return sanitize.data(json.decode(body))
end

-- The pack for the dungeon floor the player is on (nil in the hall).
local function currentPack()
  if state.mode ~= "dungeon" then return nil end
  return findPack(floorOf(state.dun.room))
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
  return hud(pack) .. "\n" .. mapTag(pack)
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
-- delegate error fails the turn — the last good state snapshot is untouched,
-- so a swipe/regenerate replays the blow AND retries the gist. Fights that
-- started untracked (a spawn_enemy consequence) get no summary.
local function endFight(prompt)
  local tag = state.dun.fightName
  state.dun.fightName = nil
  if not tag then return "" end
  local log = state.dun.fightLog
  state.dun.fightLog = nil
  local gist = log and summarize.gist(prompt, { span = log }) or nil
  gist = gist or "The crypt keeps the details."
  rolling.push(state.story, { label = tag, gist = gist, content = log })
  return "\n" .. gist
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

local function ambientLine(pack)
  if not pack or #pack.ambient == 0 then return "Drip. Drip." end
  return pack.ambient[(state.turn % #pack.ambient) + 1]
end

-- ---------- planning: ONE sub-gen per floor, the floor as a GRAPH ----------

local function planningToolset(draft, fid)
  local depth = depthOfFloor(fid)
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
    ["function"] = { name = "add_rooms", description = "Add a batch of rooms to the floor graph (make several calls for a big floor). Each room: id (short, like r3), name, desc (ONE line), exits (direction -> room id; the one stairs room gets down -> \"DOWN\"). The FIRST room of your FIRST call is the entrance.",
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

  -- The roster, declared as a registry: budgets and the cap are data, the
  -- validate-clamp-file pipeline is the lib's. Draft mode: records land in
  -- draft.encounterTable, not `state` — the pack is written at the boundary.
  local enemies = registry.new({
    tool = "add_encounter",
    description = "Add a monster to the floor's roster (max " .. MAX_ROSTER .. ") with canned combat lines. Lua rolls roster monsters as RANDOM encounters while the player explores. hp/atk/reward clamp to the depth budget.",
    key = "encounterTable",
    id_from = "name",
    cap = MAX_ROSTER,
    store = { get = function() return draft.encounterTable end },
    fields = {
      { name = "name", type = "string", required = true },
      { name = "hp", type = "integer", min = 1, max = function() return 6 + depth * 4 end, default = 6 },
      { name = "atk", type = "integer", min = 1, max = function() return 1 + depth end, default = 2 },
      { name = "reward", type = "integer", min = 0, max = function() return 5 * depth end, default = 5 },
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
  ts:use(enemies)

  return ts
end

-- Judgment as data, graph edition. The model's layout is a PROPOSAL; Lua
-- makes it true: dangling exits dropped, unreachable rooms pruned (BFS from
-- the entrance), exactly one stairs-down guaranteed, interactables on pruned
-- rooms dropped. The repair count rides in the pack's summary line.
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
-- tool calls (increments, not a one-shot blob), then writes the intro.
local function planFloor(prompt, fid)
  local floor = FLOORS[fid]
  if not floor then return "Nowhere to go." end
  local draft = { id = fid, name = floor.name, description = "", rooms = {}, roomOrder = {},
    stairsDown = nil, encounterTable = {}, interactables = {}, ambient = {} }
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
      .. "(exit down -> \"DOWN\") — put it far from the entrance, past the interesting parts; "
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
  local repairs = validateGraph(draft)
  if not draft.entrance then
    -- The model filed nothing usable: a skeleton floor keeps the game moving.
    draft.rooms = { r1 = { name = floor.name, desc = floor.theme .. ".", exits = { down = "down" } } }
    draft.roomOrder = { "r1" }
    draft.entrance = "r1"
    draft.stairsDown = "r1"
  end
  draft.roomOrder = nil -- ordering is planning scratch, not pack data
  state.dun.room = fid .. ":" .. draft.entrance
  if draft.description == "" then draft.description = floor.name .. ": " .. floor.theme .. "." end
  local intro = type(res.text) == "string" and res.text:match("^%s*(.-)%s*$") or ""
  if intro == "" then intro = draft.description end
  markSeen()
  return intro .. "\n\n" .. packBlob(draft, composeSummary(draft, repairs))
    .. "\n\n" .. statusTags(draft) .. "\n" .. buttonsHtml(draft)
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
  .. "Terse, concrete, in character.\n\nEVENT: "

-- The receptionist's opener — also the card's firstMes. On the onboarding turn
-- the script seeds it as a PRIOR assistant message in the span ("something the
-- model wrote on a previous output") so the scene-runner sees her already on
-- stage and just continues, instead of cold-starting through a
-- list_characters/add_to_chat dance. Keep this in sync with FIRST_MES in
-- scripts/add-guildhall.ts.
local GREETING = "The guildhall's reception desk is a slab of oak lost under forms. Behind it sits a woman with "
  .. "ink to the elbows, eating a donut — powdered sugar on her collar — who does not look up. "
  .. "\"Donut? No? Your loss. Best in Thornwall, and I'm not telling you where I get them.\" She licks "
  .. "a finger and slides a blank form your way. \"Welcome to the Guildhall. Name and trade, newcomer "
  .. "— let's get you registered.\""

-- The scene-runner: the events engine's full toolset PLUS rolling — the
-- STORY SO FAR rides the frozen system block (chatTurn), and inspect_summary
-- lets the model zoom into it instead of guessing. The model never types a
-- bracket — ev.strip removes freelanced tags; the cast rides the newest
-- message via ev.castLine(); the script splices the close tag.
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
    return json.encode({ registered = name, hp = state.dun.maxHp, atk = state.dun.atk, gold = state.gold,
      note = "registered — welcome them by name, then close_event" })
  end, {
    type = "function",
    ["function"] = { name = "register_player", description = "Register the newcomer's name (onboarding). Returns their starting stats. Then welcome them by name and close_event.",
      parameters = { type = "object", properties = { name = { type = "string" } }, required = { "name" } } },
  })
  return ts
end

-- One scene-runner call: frozen system + the event's span (the mechanical
-- tail — prior turns' user inputs, tool rounds, and assistant replies), then the
-- tool loop, and everything this turn added goes back onto the span. The
-- tail is full-fidelity, so the model never re-issues a read it already made
-- and the delegate's prefix cache covers the whole scene.
local function chatTurn(prompt, cmd)
  local ts = chatToolset()
  local sub = {}
  for k, v in pairs(prompt) do sub[k] = v end
  sub.tools = ts:schemas()
  sub.messages = {
    -- The STORY SO FAR rides the FROZEN block: the story channel changes
    -- only at an event close (which ends the event) or a fight gist (fights
    -- can't end while an event is open), so this stays byte-identical for
    -- the event's lifetime — the prefix-cache property is untouched.
    { role = "system", content = CHAT_PROMPT .. ev.eventLine() .. rolling.briefing(state.story) },
  }
  for _, m in ipairs(ev.span()) do sub.messages[#sub.messages + 1] = m end
  -- The cast rides the newest message (volatile state, never the frozen
  -- prefix) — from state.event.participants, not a tag.
  local castNote = ev.castLine()
  local input = chrome.clean(cmd)
  if castNote ~= "" then input = input .. "\n\n(" .. castNote .. ")" end
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

-- The dungeon escalation DM: the mutation economy AND open_event (the one
-- addition over the old crypt DM), so a novel action can hand off to a
-- scene-runner mid-explore or mid-fight. Combat is NOT cleared by escalation.
local function dungeonDmToolset(dctx)
  local ts = toolset.new()
  ts:use(ledger)
  ts:use(ev.dm()) -- open_event only — casting is the scene-runner's
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
    local room = dctx.packDraft.rooms[subOf(state.dun.room)]
    if dir == "" or not room or not dctx.packDraft.rooms[to] then
      local ids = {}
      for k in pairs(dctx.packDraft.rooms) do ids[#ids + 1] = k end
      table.sort(ids)
      return "rejected: destination must be a room on this floor (" .. table.concat(ids, ", ") .. ")"
    end
    room.exits[dir] = to
    dctx.dirty = true
    return json.encode({ added = dir .. " -> " .. to, via = tostring(args.via or "") })
  end, {
    type = "function",
    ["function"] = { name = "add_exit", description = "Add a NEW exit from the player's current room to another room ON THIS FLOOR (a new pack version is written). For changed circumstances: blown walls, revealed passages.",
      parameters = { type = "object", properties = {
        direction = { type = "string" }, to = { type = "string" }, via = { type = "string" } }, required = { "direction", "to" } } },
  })

  addSetFlagTool(ts, "Set a story flag.")

  ts:handle("spawn_enemy", function(args)
    local depth = depthOfFloor(floorOf(state.dun.room))
    local hp = math.max(1, math.min(tonumber(args.hp) or 6, 6 + depth * 4))
    local atk = math.max(1, math.min(tonumber(args.atk) or 2, 1 + depth))
    state.dun.combat = { name = tostring(args.name or "crypt thing"), hp = hp, maxHp = hp, atk = atk,
      lines = { intro = "It arrives.", hit = "It strikes.", death = "It falls." }, reward = 0 }
    return json.encode({ spawned = state.dun.combat.name, clamped = { hp = hp, atk = atk } })
  end, {
    type = "function",
    ["function"] = { name = "spawn_enemy", description = "Spawn an enemy into the current room (depth-budget clamped). For consequences.",
      parameters = { type = "object", properties = { name = { type = "string" }, hp = { type = "integer" }, atk = { type = "integer" } }, required = { "name" } } },
  })


  return ts
end

local function dungeonDmTurn(prompt, input, pack)
  state.dun.escalations = state.dun.escalations + 1
  local dctx = { packDraft = copyPack(pack), dirty = false }
  local ts = dungeonDmToolset(dctx)
  local sub = {}
  for k, v in pairs(prompt) do sub[k] = v end
  sub.tools = ts:schemas()
  sub.messages = {
    { role = "system", content = DUNGEON_DM_PROMPT .. "\n\nFLOOR PACK (current design):\n" .. json.encode(pack)
      .. "\n\nPLAYER: hp " .. state.dun.hp .. "/" .. state.dun.maxHp .. ", atk " .. state.dun.atk
      .. ", gold " .. state.gold .. ", at " .. state.dun.room .. ", inventory: " .. invList()
      .. (state.dun.combat and ("\nIN COMBAT with " .. state.dun.combat.name) or "")
      .. ledger.briefing()
      .. rolling.briefing(state.story) },
    { role = "user", content = 'The player attempts: "' .. input .. '"' },
  }
  local res = loop.run(sub, backends.generate(sub):await(), ts:exec())
  local text = trim(ev.strip(res.text or ""))
  if text == "" then text = "Nothing comes of it." end
  -- Pack mutations are append-only: the new version goes in THIS message.
  if dctx.dirty then
    text = text .. "\n\n" .. packBlob(dctx.packDraft, composeSummary(dctx.packDraft))
  end
  -- If the DM framed a scene (even mid-fight), run the scene-runner's first
  -- reply THIS turn — the DM's transition and the first reply land in one
  -- message. ev.isOpen() is now true.
  if ev.isOpen() then
    if not ev.hasSpan() then ev.spanStart({}) end -- open_event already started one
    if text ~= "" then ev.spanAppend({ { role = "assistant", content = text } }) end -- the DM's transition
    local chatBlock = chatTurn(prompt, input)
    if text == "" then text = "The dark shifts around you." end
    text = text .. "\n\n" .. chatBlock
  end
  return text
end

-- The hall DM: adjudicates idle-hall actions and FRAMES events. No mutation
-- economy (the hall has no inventory, map, or enemies); open_event only.
local function hallDmToolset()
  local ts = toolset.new()
  ts:use(ledger)
  ts:use(ev.dm()) -- open_event, nothing else — casting is the scene-runner's
  ts:use(rolling) -- inspect_summary, same as the dungeon DM

  addAttemptTool(ts, false)
  addSetFlagTool(ts, "Set a lasting world fact.")

  return ts
end

local function hallDmTurn(prompt, cmd)
  local ts = hallDmToolset()
  local sub = {}
  for k, v in pairs(prompt) do sub[k] = v end
  sub.tools = ts:schemas()
  sub.messages = {
    { role = "system", content = HALL_DM_PROMPT .. "\n\nPLAYER: gold " .. state.gold
      .. (state.flags.relic and " (carries the relic)" or "")
      .. ledger.briefing()
      .. rolling.briefing(state.story) },
    { role = "user", content = 'The player: "' .. cmd .. '"' },
  }
  local res = loop.run(sub, backends.generate(sub):await(), ts:exec())
  local text = trim(ev.strip(res.text or ""))
  if ev.isOpen() then
    -- Boundary turn: the DM framed a scene — run the scene-runner's first
    -- reply now, all in one message.
    if not ev.hasSpan() then ev.spanStart({}) end
    if text ~= "" then ev.spanAppend({ { role = "assistant", content = text } }) end
    local chatBlock = chatTurn(prompt, cmd)
    if text == "" then text = "The hall shifts around you." end
    return text .. "\n\n" .. chatBlock .. tail(nil)
  end
  if text == "" then text = "Nothing comes of it." end
  return text .. tail(nil)
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
  local pack = findPack(fid)
  if not pack then return planFloor(prompt, fid) end
  state.dun.room = fid .. ":" .. pack.entrance
  markSeen()
  return pack.description .. tail(pack)
end

local function continueLine()
  if state.mode == "hall" then return "The hall murmurs on." end
  return ambientLine(findPack(floorOf(state.dun.room)))
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
  return hallDmTurn(prompt, cmd)
end

-- Events sit above both modes. Menu/dungeon verbs are gated; /leave is a
-- one-gen exit (a delegate error fails the turn — swipe retries); otherwise
-- the scene-runner writes a reply. Closing the event resumes whatever
-- mode was active — including combat, which persisted in state.dun.combat.
-- Either way a scene closes, it joins the STORY: the gist as the line, the
-- full span as the zoomable content.
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
    return gistLine .. "\n\nYou step away; the moment ends." .. tail(currentPack())
  end
  -- A script-opened event (onboarding) has no DM boundary: seed the span with
  -- the receptionist's greeting as a prior assistant message.
  if not ev.hasSpan() then
    ev.spanStart({ { role = "assistant", content = GREETING } })
  end
  local out = chatTurn(prompt, cmd)
  if state.event and state.event.closed then
    local wasRegistration = state.event and state.event.kind == "registration"
    rolling.push(state.story, {
      label = state.event.kind,
      gist = state.event.closed.gist,
      content = ev.span(),
    })
    out = out .. "\n\n" .. state.event.closed.gist -- the memoir line
    ev.clear()
    if wasRegistration then state.onboarded = true end
    out = out .. "\n\nThe way on opens up again."
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
  local pack = findPack(fid)
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
        pack = findPack(nfid)
        if not pack then return planFloor(prompt, nfid) end
        state.dun.room = nfid .. ":" .. pack.entrance
        text = pack.description
      else
        -- In-floor move: free, and Lua rolls the roster on entry. A move
        -- with its own line (a successful flee) keeps it ahead of the desc.
        local room = pack.rooms[subOf(state.dun.room)]
        local desc = (room and room.desc ~= "") and room.desc or pack.description
        text = served.text and (served.text .. "\n\n" .. desc) or desc
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
    pack = findPack(fid) or pack -- a new pack version may exist now
  end

  -- A fight that just ended (kill, flee, or death) closes its summary span.
  if served and served.fightEnded then
    text = text .. endFight(prompt)
  end

  markSeen()
  return text .. tail(pack)
end

-- ---------- the turn ----------

function generate(prompt, ctx)
  ensureState()
  ledger.bind(function() return state.turn end)
  ev.bindPrompt(prompt) -- the fold's digest sub-gen inherits the turn's token budget

  -- continue never resolves rules or effects — an ambient line only.
  if ctx and ctx.generationType == "continue" then
    return continueLine() .. tail(currentPack())
  end

  local input = lastUserText(prompt)
  local cmd = chrome.unwrap(input)
  state.turn = state.turn + 1

  -- An open event is the HIGHEST gate: it pauses hall AND dungeon (combat
  -- persists) and resumes the prior mode when it closes.
  if ev.isOpen() then return eventTurn(prompt, cmd) end
  if state.mode == "hall" then return hallTurn(prompt, cmd) end
  return dungeonTurn(prompt, cmd)
end

function list_models()
  return { { id = "the-guildhall", name = "The Guildhall" } }
end
