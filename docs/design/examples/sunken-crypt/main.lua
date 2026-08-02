-- The Sunken Crypt — a FACTORY-ratio card backend (Type B: backend_logic/main.lua)
--
-- The model authors a WHOLE FLOOR at the boundary — a graph of rooms, a
-- monster roster, interactables, ambient lines — in ONE planning sub-gen;
-- Lua then serves that floor for dozens of turns with ZERO model calls,
-- until the player does something nobody planned for (escalation with a
-- cost-structured tool economy). Floors live in the LOG as append-only
-- tagged blobs — newest version wins — never in `state` (state snapshots
-- persist per message; bulk packs would duplicate horribly).
--
-- The boundary unit is the FLOOR, not the room: a card whose packs hold one
-- room each degenerates into room → fight → room — the narrator ratio with
-- extra steps. Make the model lay out a whole map, then let the player get
-- lost in it for free.
--
-- Built on the game lib (docs/design/examples/game-lib/, vendored into this
-- card as backend_logic/lib/*.lua): loop (tool loop), collapse + transcript
-- (delegate view), sanitize (decoded-JSON hygiene), chrome (buttons/acks),
-- ledger (plot promises), todo (delegate self-planning), toolset (tool
-- composition), registry (add_encounter's validate-clamp-file pipeline).
--
-- Companion display rules:
--   /\s*\[sys\].*?\[\/sys\]\s*/gis → "\n\n" (hide [sys] acks — a UNIVERSAL
--   prompt+display rule: [sys] is script chrome hidden from BOTH the player
--   AND the prompt. In-fiction results of player actions are served as
--   VISIBLE text instead — not every ack should be hidden. See "The chrome
--   contract" in topic `game_cards_factory`.)
--   optional: /^\s*\/\w+.*$/s with role userInput → "" (hide command messages;
--   safe because posted commands are bare text with no HTML to mangle)
--   /\[HUD\|([^\]]+)\]/g → panel HTML (HUD recipe, topic `regexes`)
--   /\[pack (\w[\w ]*)\][\s\S]*?\[\/pack \1 summary="([^"]*)"\]/g → plot-log div

local loop = require("lib/loop")
local transcript = require("lib/transcript")
local sanitize = require("lib/sanitize")
local chrome = require("lib/chrome")
local ledger = require("lib/ledger")
local todo = require("lib/todo")
local toolset = require("lib/toolset")
local registry = require("lib/registry")
local summarize = require("lib/summarize")
local maptag = require("lib/maptag")

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
         hint = "Somewhere on this floor place an interactable named 'relic' with effect { item = 'relic' } — the WIN item. Make the player EARN it." },
}

-- ---------- state (hot only — packs live in the log) ----------

local function ensureState()
  if type(state) ~= "table" then state = {} end
  state.maxHp = state.maxHp or 20
  state.hp = state.hp or state.maxHp
  state.atk = state.atk or 4
  state.gold = state.gold or 0
  state.inventory = state.inventory or {} -- name -> count
  state.room = state.room or "f1" -- floor only, until the pack designates an entrance
  state.flags = state.flags or {}
  state.promises = state.promises or {} -- the ledger: plot debts due at a turn { id, what, turn, status }
  state.combat = state.combat or nil -- { name, hp, maxHp, atk, lines, reward }
  state.turn = state.turn or 0
  state.escalations = state.escalations or 0
  state.seen = state.seen or {} -- fog-of-war: full room ids ("f2:r5") the player has visited
  state.won = state.won or false
  state.dead = state.dead or false
end

-- ---------- small helpers ----------

-- state.room is "f2:r5" — floor id : room id. Packs are per floor; rooms are
-- nodes inside the floor's graph.
local function floorOf(roomId) return tostring(roomId):match("^(f%d+)") or "f1" end
local function subOf(roomId) return tostring(roomId):match(":(%w+)$") or "" end
local function depthOfFloor(fid) return (FLOORS[fid] or FLOORS.f1).depth end

local function lastUserText(prompt)
  for i = #prompt.messages, 1, -1 do
    local m = prompt.messages[i]
    if m.role == "user" and type(m.content) == "string" then return m.content end
  end
  return ""
end

local function hud(pack)
  local where = state.room
  if pack then
    local room = pack.rooms[subOf(state.room)]
    where = pack.name .. (room and (" — " .. room.name) or "")
  end
  return string.format("[HUD|where=%s|hp=%d/%d|atk=%d|gold=%d]",
    where, state.hp, state.maxHp, state.atk, state.gold)
end

-- The map as a compact tag: the floor's room graph in one line, FOG-OF-WAR
-- edition — only rooms the player has actually visited get names, rooms on
-- the frontier show as "?", and the stairs marker waits until the stairs
-- room is seen. A display rule (topic `regexes`, HUD recipe) lays it out
-- and renders it; stored text stays small and the map is branch- and
-- era-correct for free.
local function mapTag(pack)
  if not pack then return "" end
  local fid = floorOf(state.room)
  local seen = {}
  for rid in pairs(state.seen) do
    if floorOf(rid) == fid then seen[subOf(rid)] = true end
  end
  return maptag.tag(pack.rooms, {
    cur = subOf(state.room),
    entrance = pack.entrance,
    stairs = pack.stairsDown,
    seen = seen,
  })
end

local function statusTags(pack)
  return hud(pack) .. "\n" .. mapTag(pack)
end

-- Fog-of-war: every turn that leaves the player somewhere marks the room as
-- seen. Called from each return path (planning, continue, serve/escalate).
local function markSeen()
  state.seen[state.room] = true
end

local function buttonsHtml(pack)
  if state.dead or state.won then return "" end
  local out = {}
  if state.combat then
    -- Combat is a MODE: the only verbs are attack and flee, so the only
    -- buttons are Attack and Flee. No exit buttons while a monster lives.
    out[#out + 1] = chrome.btn("attack", "Attack " .. state.combat.name)
    out[#out + 1] = chrome.btn("flee", "Flee")
    return table.concat(out, " ")
  end
  if pack then
    local room = pack.rooms[subOf(state.room)]
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
    if depthOfFloor(floorOf(state.room)) > 1 then
      out[#out + 1] = chrome.btn("up", "Climb up")
    end
  end
  return table.concat(out, " ")
end

local function invList()
  local out = {}
  for k, v in pairs(state.inventory) do out[#out + 1] = k .. " x" .. v end
  return #out > 0 and table.concat(out, ", ") or "nothing"
end

-- ---------- content packs (append-only blobs in the log; newest wins) ----------

local function packTag(id) return "[pack " .. id .. "]" end

local function packBlob(pack, summary)
  return packTag(pack.id) .. "\n" .. json.encode(pack) .. "\n[/pack " .. pack.id .. " summary=\"" .. summary .. "\"]"
end

local function composeSummary(pack, repairs)
  local n = 0
  for _ in pairs(pack.rooms) do n = n + 1 end
  local stairs = pack.rooms[pack.stairsDown]
  local s = "Designed " .. pack.name .. ": " .. n .. " rooms, " .. #pack.encounterTable
    .. " monsters, stairs in " .. (stairs and stairs.name or "?") .. "."
  if repairs and #repairs > 0 then s = s .. " (" .. #repairs .. " repairs)" end
  return s:gsub('"', "'")
end

-- Find the NEWEST pack blob for a floor in the full branch (chat global).
local function findPack(id)
  if not chat then return nil end
  local hits = chat.find(packTag(id), 1):await()
  if #hits == 0 then return nil end
  local body = hits[1].content:match("%[pack " .. id .. "%]%s*(.-)%s*%[/pack " .. id .. "[^%]]*%]")
  if not body then return nil end
  local ok, pack = pcall(json.decode, body)
  if not ok or type(pack) ~= "table" then return nil end
  return sanitize.data(pack)
end

-- ---------- planning: ONE sub-gen per floor, the floor as a GRAPH ----------

-- The planning toolset: ledger (the factory files its own story debts) and
-- todo (the model plans the design out loud) come from the lib; the floor
-- tools are ad-hoc handlers over the draft; the roster is a REGISTRY in
-- draft mode — declare the fields and budgets, the lib owns validation,
-- clamping, the roster cap, and the canonical result.
local function planningToolset(draft, fid)
  local depth = depthOfFloor(fid)
  local ts = toolset.new()
  ts:use(ledger)
  ts:use(todo)

  ts:handle("add_description", function(args)
    draft.description = tostring(args.text or ""):sub(1, 400)
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
        local id = tostring(r.id or ""):lower():sub(1, 12)
        if id == "" or draft.rooms[id] then
          return "rejected: empty or duplicate room id '" .. id .. "' (added so far: " .. table.concat(added, ", ") .. ")"
        end
        local exits = {}
        if type(r.exits) == "table" then
          for dir, to in pairs(r.exits) do
            exits[tostring(dir):lower():sub(1, 12)] = tostring(to):lower():sub(1, 12)
          end
        end
        draft.rooms[id] = {
          name = tostring(r.name or id):sub(1, 30),
          desc = tostring(r.desc or ""):sub(1, 140),
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
    local room = tostring(args.room or ""):lower():sub(1, 12)
    local iname = tostring(args.name or ""):lower():sub(1, 30)
    if room == "" or iname == "" then return "rejected: room and name required" end
    local responses = {}
    if type(args.responses) == "table" then
      for _, r in ipairs(args.responses) do responses[#responses + 1] = tostring(r):sub(1, 200) end
    end
    if #responses == 0 then responses = { "Nothing happens." } end
    local effect
    if type(args.effect) == "table" then
      effect = {}
      if tonumber(args.effect.gold) then effect.gold = math.min(math.floor(tonumber(args.effect.gold)), 5 * depth) end
      if tonumber(args.effect.hp) then effect.hp = math.max(-10, math.min(10, math.floor(tonumber(args.effect.hp)))) end
      if type(args.effect.item) == "string" then effect.item = args.effect.item:lower():sub(1, 30) end
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
      for _, l in ipairs(args.lines) do draft.ambient[#draft.ambient + 1] = tostring(l):sub(1, 200) end
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
  local roster = registry.new({
    tool = "add_encounter",
    description = "Add a monster to the floor's roster (max " .. MAX_ROSTER .. ") with canned combat lines. Lua rolls roster monsters as RANDOM encounters while the player explores. hp/atk/reward clamp to the depth budget.",
    key = "encounterTable",
    id_from = "name",
    cap = MAX_ROSTER,
    store = { get = function() return draft.encounterTable end },
    fields = {
      { name = "name", type = "string", required = true, max = 40 },
      { name = "hp", type = "integer", min = 1, max = function() return 6 + depth * 4 end, default = 6 },
      { name = "atk", type = "integer", min = 1, max = function() return 1 + depth end, default = 2 },
      { name = "reward", type = "integer", min = 0, max = function() return 5 * depth end, default = 5 },
      { name = "lines", type = "table" },
    },
    on_register = function(rec)
      rec.maxHp = rec.hp
      local lines = type(rec.lines) == "table" and rec.lines or {}
      rec.lines = {
        intro = tostring(lines.intro or "It lunges from the dark."):sub(1, 200),
        hit = tostring(lines.hit or "It shrieks."):sub(1, 200),
        death = tostring(lines.death or "It collapses."):sub(1, 200),
      }
    end,
  })
  ts:use(roster)

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

  local stairs
  for _, rid in ipairs(draft.roomOrder) do
    local room = draft.rooms[rid]
    if room then
      for dir, to in pairs(room.exits) do
        if to == "down" then
          if stairs then
            room.exits[dir] = nil
            repairs[#repairs + 1] = "dropped extra stairs in " .. rid
          else
            stairs = rid
          end
        end
      end
    end
  end
  if not stairs then
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

-- Lua rolls the roster, not the model. The entrance is safe; a room goes
-- quiet for ENCOUNTER_COOLDOWN turns after a fight there. A rolled encounter
-- also OPENS a summary-tagged span (state.fightTag): the mechanical blows
-- land in the log as served text, and when the fight ends the delegate
-- writes the one line that survives ("the player BARELY beat the goblin") —
-- the one intentional live call in serve land.
local function maybeRollEncounter(pack)
  if state.combat then return nil end
  local rid = subOf(state.room)
  if rid == "" or rid == pack.entrance then return nil end
  if #pack.encounterTable == 0 then return nil end
  local quietAt = state.flags["quiet:" .. state.room]
  if type(quietAt) == "number" and state.turn - quietAt < ENCOUNTER_COOLDOWN then return nil end
  if math.random() >= ENCOUNTER_CHANCE then return nil end
  local e = pack.encounterTable[math.random(#pack.encounterTable)]
  state.combat = { name = e.name, hp = e.hp, maxHp = e.maxHp, atk = e.atk, lines = e.lines, reward = e.reward }
  state.fightTag = "fight " .. e.name
  return e.lines.intro .. "\n" .. summarize.open(state.fightTag)
end

-- Close the fight's span with a delegate-written gist over the mechanical
-- turns. Fail-soft: a delegate error never eats a winning blow — the fight
-- closes with a fallback gist. Fights that started without a span (a
-- spawn_enemy consequence, legacy state) get NO close tag — an orphan close
-- would make collapse eat the window before it.
local function endFight(prompt)
  local tag = state.fightTag
  state.fightTag = nil
  if not tag then return "" end
  local ok, gist = pcall(summarize.summarize, tag, prompt)
  if not ok then gist = nil end
  return "\n" .. summarize.close(tag, gist or "The crypt keeps the details.")
end

-- ONE planning sub-gen per floor: the model lays out the whole map through
-- tool calls (increments, not a one-shot blob), then writes the intro.
local function planFloor(prompt, fid)
  local floor = FLOORS[fid]
  if not floor then return chrome.ack("Nowhere to go.") end
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
  res = loop.run(sub, res, ts:exec(), 12)
  local repairs = validateGraph(draft)
  if not draft.entrance then
    -- The model filed nothing usable: a skeleton floor keeps the game moving.
    draft.rooms = { r1 = { name = floor.name, desc = floor.theme .. ".", exits = { down = "down" } } }
    draft.roomOrder = { "r1" }
    draft.entrance = "r1"
    draft.stairsDown = "r1"
  end
  draft.roomOrder = nil -- ordering is planning scratch, not pack data
  state.room = fid .. ":" .. draft.entrance
  if draft.description == "" then draft.description = floor.name .. ": " .. floor.theme .. "." end
  local intro = type(res.text) == "string" and res.text:match("^%s*(.-)%s*$") or ""
  if intro == "" then intro = draft.description end
  markSeen()
  return intro .. "\n\n" .. packBlob(draft, composeSummary(draft, repairs))
    .. "\n\n" .. statusTags(draft) .. "\n" .. buttonsHtml(draft)
end

-- ---------- serving (deterministic, zero model) ----------

local function applyEffect(effect)
  if type(effect) ~= "table" then return end
  if effect.gold then state.gold = state.gold + effect.gold end
  if effect.hp then state.hp = math.max(0, math.min(state.maxHp, state.hp + effect.hp)) end
  if effect.item then
    state.inventory[effect.item] = (state.inventory[effect.item] or 0) + 1
    if effect.item == WIN_ITEM then state.won = true end
  end
end

local function serve(cmd, pack)
  local lower = cmd:lower()
  if lower == "" then return { text = "Say something." } end
  local room = pack.rooms[subOf(state.room)]
  if not room then return { text = "You blink; the dark rearranges itself.", moved = true } end

  if lower == "look" then return { text = room.desc } end

  -- COMBAT IS A MODE. While a monster lives it holds the room: movement,
  -- stairs, and interactables are all gated behind it — the only verbs are
  -- attack and flee. Without this gate the player just walks past every
  -- encounter and the roster might as well not exist.
  if state.combat then
    if lower:find("flee", 1, true) or lower:find("run away", 1, true) then
      local depth = depthOfFloor(floorOf(state.room))
      local dc = FLEE_DC + depth
      if math.random(1, 20) + state.atk >= dc then
        state.combat = nil
        state.room = floorOf(state.room) .. ":" .. pack.entrance
        return { text = "You break and scramble back to the " .. (pack.rooms[pack.entrance].name or "entrance") .. ".", moved = true, fightEnded = true }
      end
      local counter = state.combat.atk + math.random(0, 1)
      state.hp = state.hp - counter
      if state.hp <= 0 then
        state.dead = true
        return { text = state.combat.lines.hit .. " You fall. THE CRYPT KEEPS YOU.", fightEnded = true }
      end
      return { text = "You stumble — no escape. " .. state.combat.lines.hit .. " (-" .. counter .. " hp)" }
    end
    if not lower:find("attack", 1, true) then
      return { text = "The " .. state.combat.name .. " is between you and everything else. (attack / flee)" }
    end
  end

  if lower == "up" or lower == "climb" then
    local depth = depthOfFloor(floorOf(state.room))
    if depth <= 1 then return { text = "The entry stair collapsed behind you. Down is the only way." } end
    state.room = "f" .. (depth - 1)
    return { moved = true }
  end

  for dir, to in pairs(room.exits) do
    if lower == dir or lower == "go " .. dir then
      if to == "down" then
        state.room = "f" .. (depthOfFloor(floorOf(state.room)) + 1)
      else
        state.room = floorOf(state.room) .. ":" .. to
      end
      return { moved = true }
    end
  end

  if lower:find("attack", 1, true) then
    if not state.combat then return { text = "Nothing here fights back." } end
    local dmg = state.atk + math.random(0, 3)
    state.combat.hp = state.combat.hp - dmg
    if state.combat.hp <= 0 then
      local reward = state.combat.reward or 0
      local line = state.combat.lines.death
      state.flags["quiet:" .. state.room] = state.turn
      state.combat = nil
      state.gold = state.gold + reward
      return { text = line .. " (+" .. reward .. " gold)", fightEnded = true }
    end
    local counter = state.combat.atk + math.random(0, 1)
    state.hp = state.hp - counter
    if state.hp <= 0 then
      state.dead = true
      return { text = state.combat.lines.hit .. " You fall. THE CRYPT KEEPS YOU.", fightEnded = true }
    end
    return { text = state.combat.lines.hit .. " You hit for " .. dmg .. "; it answers for " .. counter .. "." }
  end

  local prefix = subOf(state.room) .. ":"
  for key, it in pairs(pack.interactables) do
    if key:sub(1, #prefix) == prefix then
      local iname = key:sub(#prefix + 1)
      if lower:find(iname, 1, true) then
        local usedKey = "used:" .. state.room .. ":" .. iname
        if state.flags[usedKey] then
          return { text = it.responses[2] or it.responses[1] or "Nothing more happens." }
        end
        state.flags[usedKey] = true
        applyEffect(it.effect)
        return { text = it.responses[1] or "Nothing happens." }
      end
    end
  end

  return nil -- no match → escalate
end

local function maybeAmbient(pack)
  if #pack.ambient == 0 or state.turn % 4 ~= 0 then return nil end
  return pack.ambient[(math.floor(state.turn / 4) - 1) % #pack.ambient + 1]
end

local function ambientLine(pack)
  if #pack.ambient == 0 then return "Drip. Drip." end
  return pack.ambient[(state.turn % #pack.ambient) + 1]
end

-- ---------- escalation (DM on demand, with a cost structure) ----------

local DM_PROMPT = "You are the dungeon master of a terse dungeon crawler, adjudicating ONE novel player action. "
  .. "Rules: use attempt() for anything risky — the ENGINE rolls and decides; honor its result. "
  .. "Use remove_item/add_exit/set_flag/spawn_enemy to make consequences REAL — costs are deducted by the engine, "
  .. "and the tool result is the canonical record. Never grant what the tools can't express. "
  .. "After the tools, narrate the outcome in 1-3 terse sentences, second person."

-- The DM toolset: the ledger and recall from the lib, the mutation economy
-- as ad-hoc handlers over the pack draft. What the model can call is what's
-- possible; everything else it may only narrate failing at.
local function dmToolset(ctx)
  local ts = toolset.new()
  ts:use(ledger)

  ts:handle("attempt", function(args)
    local difficulty = math.max(5, math.min(20, tonumber(args.difficulty) or 10))
    local roll = math.random(1, 20)
    local total = roll + state.atk
    local outcome = total >= difficulty and "success" or "failure"
    if outcome == "failure" then state.hp = math.max(0, state.hp - 2) end -- failure stings
    return json.encode({ outcome = outcome, roll = roll, total = total, difficulty = difficulty,
      note = "the dice are the engine's, not yours — narrate THIS result" })
  end, {
    type = "function",
    ["function"] = { name = "attempt", description = "Resolve a risky action. The ENGINE rolls (d20+atk vs difficulty) and decides — narrate the result it returns.",
      parameters = { type = "object", properties = { action = { type = "string" }, difficulty = { type = "integer" } }, required = { "action" } } },
  })

  ts:handle("remove_item", function(args)
    local iname = tostring(args.name or ""):lower()
    local n = math.max(1, tonumber(args.n) or 1)
    local have = state.inventory[iname] or 0
    if have < n then return "not carried: " .. iname .. " (has " .. have .. ")" end
    state.inventory[iname] = have - n > 0 and have - n or nil
    return json.encode({ consumed = iname, n = n, left = state.inventory[iname] or 0 })
  end, {
    type = "function",
    ["function"] = { name = "remove_item", description = "Consume items from the player's inventory. The result is canonical: if it says not carried, the player never had it.",
      parameters = { type = "object", properties = { name = { type = "string" }, n = { type = "integer" } }, required = { "name" } } },
  })

  ts:handle("add_exit", function(args)
    local dir = tostring(args.direction or ""):lower():sub(1, 12)
    local to = tostring(args.to or ""):lower()
    local room = ctx.packDraft.rooms[subOf(state.room)]
    if dir == "" or not room or not ctx.packDraft.rooms[to] then
      local ids = {}
      for k in pairs(ctx.packDraft.rooms) do ids[#ids + 1] = k end
      table.sort(ids)
      return "rejected: destination must be a room on this floor (" .. table.concat(ids, ", ") .. ")"
    end
    room.exits[dir] = to
    ctx.dirty = true
    return json.encode({ added = dir .. " -> " .. to, via = tostring(args.via or "") })
  end, {
    type = "function",
    ["function"] = { name = "add_exit", description = "Add a NEW exit from the player's current room to another room ON THIS FLOOR (a new pack version is written). For changed circumstances: blown walls, revealed passages.",
      parameters = { type = "object", properties = {
        direction = { type = "string" }, to = { type = "string" }, via = { type = "string" } }, required = { "direction", "to" } } },
  })

  ts:handle("set_flag", function(args)
    local key = tostring(args.key or ""):sub(1, 30)
    if key == "" then return "rejected: key required" end
    state.flags[key] = args.value == nil and true or args.value
    return "ok: " .. key
  end, {
    type = "function",
    ["function"] = { name = "set_flag", description = "Set a story flag.",
      parameters = { type = "object", properties = { key = { type = "string" }, value = { type = "boolean" } }, required = { "key" } } },
  })

  ts:handle("spawn_enemy", function(args)
    local depth = depthOfFloor(floorOf(state.room))
    local hp = math.max(1, math.min(tonumber(args.hp) or 6, 6 + depth * 4))
    local atk = math.max(1, math.min(tonumber(args.atk) or 2, 1 + depth))
    state.combat = { name = tostring(args.name or "crypt thing"):sub(1, 40), hp = hp, maxHp = hp, atk = atk,
      lines = { intro = "It arrives.", hit = "It strikes.", death = "It falls." }, reward = 0 }
    return json.encode({ spawned = state.combat.name, clamped = { hp = hp, atk = atk } })
  end, {
    type = "function",
    ["function"] = { name = "spawn_enemy", description = "Spawn an enemy into the current room (depth-budget clamped). For consequences.",
      parameters = { type = "object", properties = { name = { type = "string" }, hp = { type = "integer" }, atk = { type = "integer" } }, required = { "name" } } },
  })

  ts:handle("recall", function(args)
    if not chat then return "recall is unavailable outside a live chat" end
    local query = tostring(args.query or "")
    if query == "" then return "rejected: query required" end
    local hits = chat.find(query, 3):await()
    if #hits == 0 then return "no matches for: " .. query end
    local out = {}
    for _, h in ipairs(hits) do
      out[#out + 1] = "[" .. h.role .. " #" .. tostring(h.index) .. "] " .. tostring(h.content):sub(1, 800)
    end
    return table.concat(out, "\n\n")
  end, {
    type = "function",
    ["function"] = {
      name = "recall",
      description = "Search the FULL chat history (far beyond this prompt) for exact past text — what was actually said or done earlier.",
      parameters = { type = "object", properties = { query = { type = "string" } }, required = { "query" } },
    },
  })

  return ts
end

local function copyPack(pack)
  return json.decode(json.encode(pack))
end

local function escalate(prompt, input, pack)
  state.escalations = state.escalations + 1
  local ctx = { packDraft = copyPack(pack), dirty = false }
  local ts = dmToolset(ctx)
  local sub = {}
  for k, v in pairs(prompt) do sub[k] = v end
  sub.tools = ts:schemas()
  sub.messages = {
    { role = "system", content = DM_PROMPT .. "\n\nFLOOR PACK (current design):\n" .. json.encode(pack)
      .. "\n\nPLAYER: hp " .. state.hp .. "/" .. state.maxHp .. ", atk " .. state.atk
      .. ", gold " .. state.gold .. ", at " .. state.room .. ", inventory: " .. invList()
      .. ledger.briefing()
      .. "\n\nRECENT TURNS:\n" .. transcript.recent(prompt, 6) },
    { role = "user", content = 'The player attempts: "' .. input .. '"' },
  }
  local res = backends.generate(sub):await()
  res = loop.run(sub, res, ts:exec())
  local text = type(res.text) == "string" and res.text:match("^%s*(.-)%s*$") or "Nothing comes of it."
  if text == "" then text = "Nothing comes of it." end
  -- Pack mutations are append-only: the new version goes in THIS message.
  if ctx.dirty then
    text = text .. "\n\n" .. packBlob(ctx.packDraft, composeSummary(ctx.packDraft))
  end
  return text
end

-- ---------- the turn ----------

function generate(prompt, ctx)
  ensureState()
  ledger.bind(function() return state.turn end)
  markSeen() -- the room you are standing in is seen by definition

  if state.dead then return chrome.ack("The crypt keeps you. Swipe back to try another fate.") end
  if state.won then return chrome.ack("The relic is yours. The crypt is done with you.") end

  -- Boundary: first contact with a floor triggers the planning sub-gen.
  local fid = floorOf(state.room)
  local pack = findPack(fid)
  if not pack then return planFloor(prompt, fid) end
  if not pack.rooms[subOf(state.room)] then state.room = fid .. ":" .. pack.entrance end

  -- continue never resolves rules or effects — an ambient line only.
  if ctx and ctx.generationType == "continue" then
    markSeen()
    return ambientLine(pack) .. "\n\n" .. statusTags(pack) .. "\n" .. buttonsHtml(pack)
  end

  local input = lastUserText(prompt)
  local cmd = chrome.unwrap(input)
  state.turn = state.turn + 1

  local text
  local served = serve(cmd, pack)
  if served then
    if served.moved then
      local nfid = floorOf(state.room)
      if nfid ~= fid then
        -- A stair: another floor's pack (it exists — the player came from
        -- there), or the boundary fires and a new floor is designed.
        pack = findPack(nfid)
        if not pack then return planFloor(prompt, nfid) end
        state.room = nfid .. ":" .. pack.entrance
        text = pack.description
      else
        -- In-floor move: free, and Lua rolls the roster on entry. A move
        -- with its own line (a successful flee) keeps it ahead of the desc.
        local room = pack.rooms[subOf(state.room)]
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
    text = escalate(prompt, cmd, pack)
    pack = findPack(fid) or pack -- a new pack version may exist now
  end

  -- A fight that just ended (kill, flee, or death) closes its summary span:
  -- the delegate writes the one gist line over the mechanical blows.
  if served and served.fightEnded then
    text = text .. endFight(prompt)
  end

  markSeen()
  return text .. "\n\n" .. statusTags(pack) .. "\n" .. buttonsHtml(pack)
end

function list_models()
  return { { id = "the-sunken-crypt", name = "The Sunken Crypt" } }
end
