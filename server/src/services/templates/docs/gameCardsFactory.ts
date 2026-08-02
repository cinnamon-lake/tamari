/** Reference doc for the `game_cards_factory` topic, served by the Docs tool. */
export const GAME_CARDS_FACTORY_DOC = `# The Sunken Crypt (factory-ratio worked example)

A complete, TESTED factory-ratio card: \`backend_logic/main.lua\` plus its vendored game lib (\`backend_logic/lib/*.lua\`) — three floors of room-graphs, a relic, and a model that authors content in bulk instead of narrating every turn. Theory lives in topic \`game_cards\` (The content factory; the lib modules are referenced there); this topic is the steal-able file. (Repo copies \`docs/design/examples/sunken-crypt/main.lua\` + \`docs/design/examples/game-lib/*.lua\`, validated end-to-end through the real adapter by \`server/src/backends/sunkenCrypt.example.test.ts\`.) Decisions worth noticing:

- **The card is built on the vendored game lib** (\`lib/\` modules, contract and reference in topic \`game_cards\`): \`loop\` runs the tool loop (default cap 16 — a todo-planning delegate eats rounds), \`transcript\` + \`collapse\` build the DM's compressed view, \`sanitize\` tames decoded JSON, \`chrome\` owns buttons/acks/unwrap, \`ledger\` is the plot promises, \`todo\` lets the planning delegate file its own checklist (the planning prompt opens with set_todo), \`toolset\` composes everything into ONE schemas array + ONE exec, the roster is a \`registry\` in draft mode — budgets and the cap are DATA, the validate-clamp-file pipeline is the lib's — and \`maptag\` builds the fog-of-war map tag (visited rooms named, frontier as "?", stairs marker only once seen).
- **The boundary unit is the FLOOR — a graph of rooms, designed in ONE planning sub-gen.** First contact with a floor fires \`planFloor\`: the model lays out the whole map by calling \`add_description\` / \`add_rooms\` (batched — id, name, one-line desc, exits; the first room added is the entrance) / \`add_interactable\` (placed in a named room) / \`add_ambient\` / \`add_encounter\` — increments, not a one-shot json blob — then writes the intro. The prompt demands a REAL layout: branches, a loop or two, dead ends with the best rewards, exactly one stairs-down hidden far from the entrance so the player EARNS the way down. A card whose packs hold one room each degenerates into room → fight → room — the narrator ratio with extra steps.
- **Lua validates the graph; the model's layout is a proposal.** After the loop, \`validateGraph\` drops dangling exits, prunes unreachable rooms (BFS from the entrance), guarantees exactly one stairs-down (placed in the farthest room if the model forgot), and drops interactables on pruned rooms. The repair count rides in the pack's summary line. Exit targets are deliberately NOT checked per \`add_rooms\` call — later batches may define them; the graph pass owns correctness. Per-call clamps as usual: depth budgets for hp/atk/reward, effect caps, the roster cap.
- **Random encounters come from the floor's preset roster — Lua rolls, not the model.** On entering a non-entrance room, Lua rolls \`ENCOUNTER_CHANCE\`, pulls a monster from \`encounterTable\`, and serves its canned lines; killing it sets a \`quiet:\` flag that keeps the room calm for \`ENCOUNTER_COOLDOWN\` turns. The model authors teeth once; Lua decides when they bite. Zero delegate calls, stable under regenerate by construction.
- **Fights are summary SPANS — the gist is delegate-written.** A rolled encounter opens \`[fight <name>]\`; the mechanical blows land in the log as served text; the kill, the flee, or the player's death closes the block with a gist written by the delegate over exactly that span (\`lib/summarize\` — fail-soft to a fallback line, and no close tag at all for fights that started without a span, since an orphan close would eat the window). This is the one intentional live call in serve land, and the "the player BARELY beat the goblin" capability made structural: the gist can only say it because the blows are VISIBLE text, never \`[sys]\`.
- **Combat is a MODE, not an event.** While \`state.combat\` lives, every verb except \`attack\`/\`flee\` is gated — movement, stairs, and interactables all answer "the monster is between you and everything else" — and the button row matches the mode (Attack, Flee, no exits). Without the gate the player just walks past every encounter and the roster might as well not exist. \`flee\` is an engine roll (d20+atk vs \`FLEE_DC\` + depth): success clears combat and returns the player to the floor entrance, failure costs a hit.
- **Scale is one constant.** \`ROOMS_PER_FLOOR\` is "6-10" here so the example stays readable — a real descent game wants "24-40". The planning sub-gen is paid ONCE per floor either way, and serve turns are free at any floor size. (Big floors also want \`loop.run\`'s round cap raised — the Crypt passes 12 for planning.)
- **Packs live in the LOG as append-only tagged blobs — never in \`state\`.** \`state\` snapshots persist per message; bulk packs would duplicate horribly. \`findPack\` reads the newest blob back via \`chat.find\` (newest-first), so pack mutation is a NEW blob in the same turn's message, not an edit. The blob's close tag carries a script-composed summary, so \`collapse.blocks\`-style compaction and plot-log display rules work unchanged. \`state.room\` is \`"f2:r5"\` — floor : room — so flags key off it for free (\`used:f2:r5:crate\`, \`quiet:f2:r5\`).
- **Serve turns are FREE.** Movement along room exits, stairs (down to the next boundary — which may fire planning — up to the previous floor's entrance), look, interactables (first-use effect + alternate repeat line), combat with canned lines plus the flee roll, rotating ambient — all deterministic Lua against the pack. The tests assert the delegate is NOT called on serve turns.
- **Escalation is the DM, with a cost structure.** Unmatched input fires \`escalate\`: the delegate gets the mutation toolset and the floor pack, and resolves the attempt through tools. The economy: \`attempt\` (the ENGINE rolls d20+atk vs difficulty; the model narrates the result it is given), \`remove_item\` (canonical — "not carried" means never had it), \`add_exit\` (targets a room ON THIS FLOOR; marks the pack dirty → new version blob appended), \`set_flag\`, \`spawn_enemy\` (budget-clamped). \`state.escalations\` is the pack-quality metric.
- **\`continue\` never resolves** — an ambient line only, so no effect can double-apply.
- **The ledger lets the factory file its own story debts.** \`promise\`/\`resolve_promise\` are merged into BOTH toolsets — the planning model plants ("the water keeps rising — by turn 20…"), the DM resolves. Due-ness is computed from \`state.turn\` and escalates to DUE NOW in the delegate prompts; vague due anchors are rejected at registration.
- **\`recall\` is in the DM toolset** — the DM can pull verbatim past text from the full branch (\`chat.find\`), so "what did the player actually do three rooms ago" has a truthful answer.
- **The DM sees a RECENT TURNS transcript** — chrome-stripped, capped, and block-collapsed by \`collapse.blocks\`: pack blobs arrive as their one-line summaries ("Designed The Upper Halls: …"), not kilobytes of JSON. Emission and collapse in one card.
- **\`sanitize.data\` is load-bearing.** \`json.decode\` maps JSON \`null\` to a truthy js_null userdata, NOT Lua nil — \`if pack.encounter then\` takes the wrong branch and concatenating it errors. Sanitize decoded JSON before use.

Companion character-scoped regex rules (\`write /characters/<id>/regex/new.json\`): \`/\\s*\\[sys\\].*?\\[\\/sys\\]\\s*/gis\` → \`"\\n\\n"\` (hide \`[sys]\` acks), optionally \`/^\\s*\\/\\w+.*$/s\` with role \`userInput\` → \`""\` (hide whole-message commands — safe because posted commands are bare text with no HTML to mangle), \`/\\[HUD\\|([^\\]]+)\\]/g\` → panel HTML (topic \`regexes\`), \`/\\[MAP\\|([^\\]]+)\\]/g\` → the floor graph rendered as a small div-map (BFS layout from the entrance, current room highlighted, stairs marked; SVG is sanitizer-stripped, positioned divs survive), \`/[fight [\\w ]+]/g\` → \`""\` and \`/[\\/fight [\\w ]+ summary="([^"]*)"]/g\` → \`<div class="plot-log">⚔ $1</div>\` (fight spans: the blows are visible prose the player lived — only the TAGS are chrome; hide the open, plot-log the close's gist), and \`/\\[pack (\\w[\\w ]*)\\][\\s\\S]*?\\[\\/pack \\1 summary="([^"]*)"\\]/g\` → \`<div class="plot-log">$2</div>\` (pack blobs render as plot-log lines). Dry-run with the workbench \`test_backend_logic\` verb — its \`history\` option is how you feed canned pack blobs to \`chat.find\`.

**The chrome contract: \`[sys]\` is hidden from BOTH the player AND the prompt.** That is what the tag MEANS — script-only chrome. Two mechanisms make it true: the hiding rule above is universal (prompt + display), and \`transcript.recent\` strips \`[sys]\` blocks before any delegate sees the history. So separate, deliberately and early, the three channels a piece of script output can live in:

- **Hidden acks — \`[sys]...[/sys]\`.** Out-of-fiction notices neither the player nor the model needs: death screens, "Nowhere to go.", meta instructions ("Swipe back to try another fate."). The Crypt's only \`[sys]\` uses.
- **Visible results — plain served text.** In-fiction consequences of a player action: combat outcomes, costs, room descriptions. NOT every acknowledgment of a user action should be hidden — "You hit for 5; it answers for 3" IS the feedback loop the player is playing for, and hiding it would gut the game. Default to visible; hide only what is genuinely chrome.
- **Delegate-visible chrome.** Sometimes the model SHOULD see the script channel: the DM can only analyze player-vs-engine interaction and summarize it properly ("the player BARELY beat the goblin") if mechanical outcomes reach it. The Crypt strips \`[sys]\` from \`transcript.recent\` — and that is exactly why the combat numbers ride in VISIBLE text instead: the transcript keeps them. If you wrap mechanics in \`[sys]\`, pass them to the delegate yourself, or accept that the model can never reference them. Rule of thumb: if the model should ever narrate ABOUT it, don't hide it from the prompt.

A fourth, purely cosmetic channel: a display-only rule can APPEND constant chrome the model never sees — e.g. re-emit the HUD tag with a hint line attached (\`$&\\n\\n*Try 'look' if stuck.*\`). Render-only, restylable, era-correct per message. Recipe in topic \`regexes\` (Appending constant chrome).

One hard rule, learned in production: buttons post BARE commands (\`data-post-response="/go north"\`). Never \`[sys]\`-wrap a button payload — display regexes are structure-blind and a \`[sys]\`-hiding rule will mangle the attribute and kill the button.

\`\`\`lua
-- The Sunken Crypt — a FACTORY-ratio card backend (Type B: backend_logic/main.lua)
--
-- The model authors a WHOLE FLOOR at the boundary — a graph of rooms, a
-- monster roster, interactables, ambient lines — in ONE planning sub-gen;
-- Lua then serves that floor for dozens of turns with ZERO model calls,
-- until the player does something nobody planned for (escalation with a
-- cost-structured tool economy). Floors live in the LOG as append-only
-- tagged blobs — newest version wins — never in \`state\` (state snapshots
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
--   /\\s*\\[sys\\].*?\\[\\/sys\\]\\s*/gis → "\\n\\n" (hide [sys] acks — a UNIVERSAL
--   prompt+display rule: [sys] is script chrome hidden from BOTH the player
--   AND the prompt. In-fiction results of player actions are served as
--   VISIBLE text instead — not every ack should be hidden. See "The chrome
--   contract" in topic \`game_cards_factory\`.)
--   optional: /^\\s*\\/\\w+.*$/s with role userInput → "" (hide command messages;
--   safe because posted commands are bare text with no HTML to mangle)
--   /\\[HUD\\|([^\\]]+)\\]/g → panel HTML (HUD recipe, topic \`regexes\`)
--   /\\[pack (\\w[\\w ]*)\\][\\s\\S]*?\\[\\/pack \\1 summary="([^"]*)"\\]/g → plot-log div

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
-- room is seen. A display rule (topic \`regexes\`, HUD recipe) lays it out
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
  return hud(pack) .. "\\n" .. mapTag(pack)
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
  return packTag(pack.id) .. "\\n" .. json.encode(pack) .. "\\n[/pack " .. pack.id .. " summary=\\"" .. summary .. "\\"]"
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
    ["function"] = { name = "add_rooms", description = "Add a batch of rooms to the floor graph (make several calls for a big floor). Each room: id (short, like r3), name, desc (ONE line), exits (direction -> room id; the one stairs room gets down -> \\"DOWN\\"). The FIRST room of your FIRST call is the entrance.",
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
  -- draft.encounterTable, not \`state\` — the pack is written at the boundary.
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
  return e.lines.intro .. "\\n" .. summarize.open(state.fightTag)
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
  return "\\n" .. summarize.close(tag, gist or "The crypt keeps the details.")
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
  return intro .. "\\n\\n" .. packBlob(draft, composeSummary(draft, repairs))
    .. "\\n\\n" .. statusTags(draft) .. "\\n" .. buttonsHtml(draft)
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
    return table.concat(out, "\\n\\n")
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
    { role = "system", content = DM_PROMPT .. "\\n\\nFLOOR PACK (current design):\\n" .. json.encode(pack)
      .. "\\n\\nPLAYER: hp " .. state.hp .. "/" .. state.maxHp .. ", atk " .. state.atk
      .. ", gold " .. state.gold .. ", at " .. state.room .. ", inventory: " .. invList()
      .. ledger.briefing()
      .. "\\n\\nRECENT TURNS:\\n" .. transcript.recent(prompt, 6) },
    { role = "user", content = 'The player attempts: "' .. input .. '"' },
  }
  local res = backends.generate(sub):await()
  res = loop.run(sub, res, ts:exec())
  local text = type(res.text) == "string" and res.text:match("^%s*(.-)%s*$") or "Nothing comes of it."
  if text == "" then text = "Nothing comes of it." end
  -- Pack mutations are append-only: the new version goes in THIS message.
  if ctx.dirty then
    text = text .. "\\n\\n" .. packBlob(ctx.packDraft, composeSummary(ctx.packDraft))
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
    return ambientLine(pack) .. "\\n\\n" .. statusTags(pack) .. "\\n" .. buttonsHtml(pack)
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
    text = escalate(prompt, cmd, pack)
    pack = findPack(fid) or pack -- a new pack version may exist now
  end

  -- A fight that just ended (kill, flee, or death) closes its summary span:
  -- the delegate writes the one gist line over the mechanical blows.
  if served and served.fightEnded then
    text = text .. endFight(prompt)
  end

  markSeen()
  return text .. "\\n\\n" .. statusTags(pack) .. "\\n" .. buttonsHtml(pack)
end

function list_models()
  return { { id = "the-sunken-crypt", name = "The Sunken Crypt" } }
end
\`\`\`

## The lib sources (vendor as backend_logic/lib/*.lua)

### lib/loop.lua

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
-- maxRounds overrides per call.

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
  return res
end

return M
\`\`\`

### lib/collapse.lua

\`\`\`lua
-- lib/collapse.lua — summary-tagged block compaction.
--
-- Collapses [/TAG summary="..."] blocks in a message list — script-side
-- compaction of a delegate's view; stored text is never touched. Cases:
--   pair visible   → the span is replaced by the close tag's summary
--   orphan close   → window start..close replaced (history cuts drop OLD
--                    messages first, so the visible prefix IS the block's tail)
--   orphan open    → still open on THIS branch → left untouched
-- Oldest-close-first, so interleaved blocks can never mismatch.
-- Never ONE lazy regex over the window: interleaved blocks plus a window
-- boundary make lazy spans mismatch and eat a live block.

local M = {}

local CLOSE_PAT = "%[/([%w][%w%s_%-]-)%s*summary=\\"(.-)\\"%s*%]"

local function findCloseWithSummary(msgs)
  for i = 1, #msgs do
    local s, e, name, summary = msgs[i].content:find(CLOSE_PAT)
    if s then return i, s, e, name, summary end
  end
  return nil
end

local function findOpen(msgs, closeMsg, closeS, name)
  local pat = "%[" .. name:gsub("(%W)", "%%%1") .. "%]"
  for i = closeMsg, 1, -1 do
    local limit = (i == closeMsg) and (closeS - 1) or #msgs[i].content
    local foundS
    local pos = 1
    while true do
      local s, e = msgs[i].content:find(pat, pos)
      if not s or s > limit then break end
      foundS = s
      pos = e + 1
    end
    if foundS then return i, foundS end
  end
  return nil
end

function M.blocks(messages)
  local msgs = {}
  for _, m in ipairs(messages) do msgs[#msgs + 1] = m end
  while true do
    local closeMsg, closeS, closeE, name, summary = findCloseWithSummary(msgs)
    if not closeMsg then return msgs end
    local openMsg, openS = findOpen(msgs, closeMsg, closeS, name)
    local out = {}
    if openMsg then
      for i = 1, openMsg - 1 do out[#out + 1] = msgs[i] end
      local before = msgs[openMsg].content:sub(1, openS - 1)
      if before:match("%S") then out[#out + 1] = { role = msgs[openMsg].role, content = before } end
    end
    out[#out + 1] = { role = msgs[closeMsg].role, content = summary }
    local after = msgs[closeMsg].content:sub(closeE + 1)
    if after:match("%S") then out[#out + 1] = { role = msgs[closeMsg].role, content = after } end
    for i = closeMsg + 1, #msgs do out[#out + 1] = msgs[i] end
    msgs = out
  end
end

return M
\`\`\`

### lib/transcript.lua

\`\`\`lua
-- lib/transcript.lua — a delegate's view of recent history.
--
-- transcript.recent(prompt, n) returns ONE string — the "RECENT TURNS"
-- briefing — one message per line rendered as "role: content".
--
-- Pipeline order matters: filter → collapse → cap.
--   1. Filter/clean: keep string-content messages; strip [sys]…[/sys],
--      <button>…</button>, [HUD…]; trim; drop anything left empty and any
--      bare /command user message. Empty messages never reach the cap.
--      [sys] is stripped here as well as by the display rules: anything the
--      delegate should analyze (how close the fight was) must ride in
--      VISIBLE text, never in [sys].
--   2. Collapse: summary-tagged blocks become their one-line summaries
--      (pack blobs arrive as "Designed The Upper Halls: …", not kilobytes
--      of JSON).
--   3. Cap: drop from the FRONT until n (default 6) remain — newest
--      messages always survive.

local collapse = require("lib/collapse")

local M = {}

function M.recent(prompt, n)
  local msgs = {}
  for _, m in ipairs(prompt.messages) do
    if type(m.content) == "string" then
      local cleaned = m.content
        :gsub("%s*%[sys%].-%[/sys%]%s*", "\\n\\n")
        :gsub("%s*<button.-</button>", "")
        :gsub("%[HUD[^%]]*%]", "")
        :gsub("^%s*(.-)%s*$", "%1")
      local isCommand = m.role == "user" and cleaned:match("^/") ~= nil
      if cleaned ~= "" and not isCommand then msgs[#msgs + 1] = { role = m.role, content = cleaned } end
    end
  end
  msgs = collapse.blocks(msgs)
  while #msgs > (n or 6) do table.remove(msgs, 1) end
  local lines = {}
  for _, m in ipairs(msgs) do lines[#lines + 1] = m.role .. ": " .. m.content end
  return table.concat(lines, "\\n")
end

return M
\`\`\`

### lib/sanitize.lua

\`\`\`lua
-- lib/sanitize.lua — decoded-JSON hygiene.
--
-- json.decode maps JSON null to a truthy js_null userdata, NOT Lua nil —
-- \`if pack.encounter then\` would take the wrong branch and \`..\` on it errors.
-- sanitize.data strips anything that isn't plain data before use.

local M = {}

function M.data(t)
  if type(t) ~= "table" then return t end
  for k, v in pairs(t) do
    local tv = type(v)
    if tv == "table" then M.data(v)
    elseif tv ~= "string" and tv ~= "number" and tv ~= "boolean" then t[k] = nil end
  end
  return t
end

return M
\`\`\`

### lib/chrome.lua

\`\`\`lua
-- lib/chrome.lua — player-facing chrome helpers.
--
-- The chrome contract: [sys] is script-only output hidden from BOTH the
-- player AND the prompt (a universal prompt+display hiding rule, plus
-- transcript stripping for delegates). In-fiction results of player actions
-- are served as VISIBLE text instead — not every ack should be hidden, and
-- anything a delegate should analyze must stay in a channel it can see.

local M = {}

-- Bare command payloads — NEVER [sys]-wrapped: display regexes are
-- structure-blind and would mangle the attribute, killing the button.
function M.btn(cmd, label)
  return '<button data-post-response="/' .. cmd .. '">' .. label .. "</button>"
end

-- Hidden ack: visible to neither the player nor the prompt.
function M.ack(text)
  return "[sys]" .. text .. "[/sys]"
end

-- "[sys]/go north[/sys]" (legacy) or "go north" / "/go north" → "go north"
function M.unwrap(text)
  local inner = text:match("^%s*%[sys%](.-)%[/sys%]%s*$") or text
  inner = inner:gsub("^%s*(.-)%s*$", "%1")
  return (inner:gsub("^/", ""))
end

return M
\`\`\`

### lib/ledger.lua

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
-- \`now\` is the card's current turn counter. Bind it once per turn with
-- ledger.bind(fn) (toolset composition calls exec without a \`now\`), or pass
-- \`now\` explicitly to exec/briefing. The lib never touches \`state\` beyond
-- its own key.

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
        id = { type = "string" }, what = { type = "string" }, turn = { type = "integer" } }, required = { "id", "what", "turn" } },
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
function M.exec(name, args, now)
  now = now or getNow()
  if name == "promise" then
    local id = tostring(args.id or ""):sub(1, 30)
    local what = tostring(args.what or ""):sub(1, 120)
    local turn = tonumber(args.turn)
    -- The critical validation: a concrete due anchor. No "later".
    if id == "" or what == "" or turn == nil then
      return "rejected: id, what, and a concrete due turn are required"
    end
    turn = math.max(now + 1, math.min(math.floor(turn), now + 50))
    for _, p in ipairs(promises()) do
      if p.id == id and not p.status then return "already pending: " .. id end
    end
    local list = promises()
    list[#list + 1] = { id = id, what = what, turn = turn }
    return json.encode({ promised = id, turn = turn })
  end
  if name == "resolve_promise" then
    local id = tostring(args.id or "")
    for _, p in ipairs(promises()) do
      if p.id == id and not p.status then
        p.status = args.outcome == "failed" and "failed" or "kept"
        return json.encode({ resolved = id, outcome = p.status })
      end
    end
    return "no pending promise: " .. id
  end
  return nil
end

--- The briefing is the memory: pending debts with due-ness computed by Lua.
function M.briefing(now)
  now = now or getNow()
  local lines = {}
  for _, p in ipairs(promises()) do
    if not p.status then
      local tag = "pending"
      if now >= p.turn then tag = "DUE NOW"
      elseif now == p.turn - 1 then tag = "due next turn" end
      lines[#lines + 1] = string.format("- [%s] %s (turn %d): %s", tag, p.id, p.turn, p.what)
    end
  end
  if #lines == 0 then return "" end
  return "\\nPLOT LEDGER (canon — honor it, resolve with resolve_promise when due):\\n" .. table.concat(lines, "\\n")
end

return M
\`\`\`

### lib/toolset.lua

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

local M = {}

function M.new()
  local schemas = {}
  local execs = {}
  local ts = {}

  local function addSchemas(list)
    if type(list) == "table" then
      for _, s in ipairs(list) do schemas[#schemas + 1] = s end
    end
  end

  --- Compose a module (anything with tools()/exec()).
  function ts:use(mod)
    addSchemas(mod.tools())
    execs[#execs + 1] = function(name, args) return mod.exec(name, args) end
    return ts
  end

  --- Add a raw tool schema with no handler (the model may call it; exec
  --- answers "unknown tool" — pair with :handle when it should do something).
  function ts:schema(s)
    addSchemas({ s })
    return ts
  end

  --- Add an ad-hoc tool: name, handler(args) -> string, optional schema.
  function ts:handle(name, fn, schema)
    if schema then addSchemas({ schema }) end
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

### lib/todo.lua

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
        local text = tostring(item):sub(1, 120)
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

### lib/registry.lua

\`\`\`lua
-- lib/registry.lua — ThingRegistry: declare "a registry of something" and get
-- a full tool (plus an optional query tool) that OWNS the Fact-lane
-- rules: validate on entry, clamp to budgets, closed lists, id assignment,
-- canonical tool result, swipe-stability through \`state\`.
--
-- The model invents; Lua files. The tool result is the canonical record —
-- what was ACTUALLY filed, clamps and dropped entries included — so the
-- model's continuing narration matches fact. Re-registering an existing id
-- returns the EXISTING record instead of overwriting: on regenerate, state
-- has rolled back and re-filing converges to the same record — swipe-stable
-- by construction.
--
-- Storage is a plain array of records at state[key] (branch-aware), each
-- record carrying its assigned \`id\`. Planning mode: pass store.get to file
-- into a draft table instead of \`state\`.
--
--   local enemies = registry.new({
--     tool = "register_enemy",
--     description = "Register an enemy design. Lua clamps stats to the power budget.",
--     key = "enemies",
--     id_from = "name",
--     query_tool = "get_enemy",        -- optional; omit for no query tool
--     cap = 8,                          -- optional max records
--     fields = {                        -- ARRAY: order is preserved in the schema
--       { name = "name", type = "string", required = true, max = 40 },
--       { name = "hp",   type = "integer", min = 1, max = 20, default = 6 },
--       -- min/max may be zero-arg functions (depth-scaled budgets):
--       { name = "atk",  type = "integer", min = 1, max = function() return 1 + depth() end, default = 2 },
--       { name = "tags", type = "array", closed = { "flying", "reflect_magic" } },
--       { name = "lines", type = "table" },   -- passthrough; shape it in on_register
--     },
--     on_register = function(rec) ... end,  -- optional: reshape/side effects
--   })
--
-- Instance surface (conforms to the lib module contract — plain dot calls.
-- get() is colon-tolerant; the composed contract (tools/exec, via toolset)
-- is dot-only, so make dots the habit):
--   enemies.tools() -> array            enemies.exec(name, args) -> string|nil
--   enemies.get(id) -> record|nil       enemies.all() -> array
--   enemies.briefing() -> string

local M = {}

local function slugify(s)
  local slug = tostring(s or ""):lower():gsub("[^%w]+", "-"):gsub("^-+", ""):gsub("-+$", ""):sub(1, 30)
  if slug == "" then slug = "thing" end
  return slug
end

local function bound(v)
  if type(v) == "function" then return v() end
  return v
end

--- Coerce args per the field specs. Returns rec, dropped, missing.
local function coerce(fields, args)
  local rec, dropped, missing = {}, {}, {}
  for _, f in ipairs(fields) do
    local v = args[f.name]
    if f.type == "integer" then
      local n = tonumber(v)
      if n == nil then n = f.default end
      if n ~= nil then
        n = math.floor(n)
        local lo, hi = bound(f.min), bound(f.max)
        if lo ~= nil and n < lo then n = lo end
        if hi ~= nil and n > hi then n = hi end
        rec[f.name] = n
      end
    elseif f.type == "array" then
      local arr = {}
      if type(v) == "table" then
        for _, item in ipairs(v) do
          local s = tostring(item)
          if f.closed then
            local ok = false
            for _, allowed in ipairs(f.closed) do
              if s == allowed then ok = true break end
            end
            if ok then arr[#arr + 1] = s else dropped[#dropped + 1] = s end
          else
            arr[#arr + 1] = s
          end
        end
      end
      rec[f.name] = arr
    elseif f.type == "table" then
      if type(v) == "table" then rec[f.name] = v end
    else -- string
      local s = v ~= nil and tostring(v) or (f.default ~= nil and tostring(f.default) or "")
      if f.max then s = s:sub(1, f.max) end
      rec[f.name] = s
    end
    if f.required and (rec[f.name] == nil or rec[f.name] == "") then
      missing[#missing + 1] = f.name
    end
  end
  return rec, dropped, missing
end

local function fieldSchema(f)
  if f.type == "integer" then return { type = "integer" } end
  if f.type == "array" then return { type = "array", items = { type = "string" } } end
  if f.type == "table" then return { type = "object" } end
  return { type = "string" }
end

function M.new(def)
  local R = {}

  local function records()
    if def.store and def.store.get then return def.store.get() end
    if type(state) ~= "table" then state = {} end
    state[def.key] = state[def.key] or {}
    return state[def.key]
  end

  local function findRecord(idOrName)
    local needle = tostring(idOrName or ""):lower()
    for _, rec in ipairs(records()) do
      if rec.id == needle then return rec end
      if def.id_from and tostring(rec[def.id_from] or ""):lower() == needle then return rec end
    end
    return nil
  end

  local function register(args)
    local rec, dropped, missing = coerce(def.fields, args)
    if #missing > 0 then
      return "rejected: " .. table.concat(missing, ", ") .. " required"
    end
    local id = slugify(def.id_from and rec[def.id_from] or nil)
    -- Idempotent: an existing id returns the filed record, never an overwrite.
    local existing = findRecord(id)
    if existing then
      return json.encode({ already_registered = id, record = existing })
    end
    local list = records()
    if def.cap and #list >= def.cap then
      return "rejected: registry full (" .. def.cap .. " " .. tostring(def.key or "records") .. " max)"
    end
    rec.id = id
    if def.on_register then def.on_register(rec) end
    list[#list + 1] = rec
    local result = { registered = id, record = rec }
    if #dropped > 0 then result.dropped = dropped end
    return json.encode(result)
  end

  local function query(args)
    local rec = findRecord(args.id)
    if not rec then return "unknown " .. tostring(def.key or "record") .. ": " .. tostring(args.id) end
    return json.encode(rec)
  end

  function R.tools()
    local properties, required = {}, {}
    for _, f in ipairs(def.fields) do
      properties[f.name] = fieldSchema(f)
      if f.required then required[#required + 1] = f.name end
    end
    local out = { {
      type = "function",
      ["function"] = {
        name = def.tool,
        description = def.description or ("Register a " .. tostring(def.key or "record") .. "."),
        parameters = { type = "object", properties = properties, required = required },
      },
    } }
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
    return out
  end

  function R.exec(name, args)
    if name == def.tool then return register(args or {}) end
    if def.query_tool and name == def.query_tool then return query(args or {}) end
    return nil
  end

  -- Colon-tolerant: a colon call (enemies:get(id)) passes the instance as the
  -- first argument — shift it off instead of silently missing every lookup.
  function R.get(a, b) return findRecord(a == R and b or a) end

  function R.all() return records() end

  --- One line per record, for delegate briefings ("" when empty).
  function R.briefing()
    local lines = {}
    for _, rec in ipairs(records()) do
      local label = def.id_from and tostring(rec[def.id_from] or "") or ""
      lines[#lines + 1] = "- " .. tostring(rec.id) .. (label ~= "" and (": " .. label) or "")
    end
    if #lines == 0 then return "" end
    return "\\n" .. tostring(def.key or "REGISTRY") .. ":\\n" .. table.concat(lines, "\\n")
  end

  return R
end

return M
\`\`\`


### lib/summarize.lua

\`\`\`lua
-- lib/summarize.lua — the PRODUCTION half of compaction: authoring
-- summary-tagged blocks, and turning a mechanical span into a model-written
-- gist. (collapse.blocks, the consumption half, reads these tags.)
--
-- The flow: the script opens a block when a span starts (a fight, a shopping
-- trip, an exploration), serves the mechanical turns plainly, and at the
-- boundary asks the delegate for the ONE line that survives — "the player
-- kinda struggled and had to use all of his potions against a zubat lol" —
-- then splices it into the close tag. Stored history keeps the full span;
-- delegates see the gist (collapse.blocks), so the mechanical detail costs
-- no context but the OUTCOME is never paraphrased away.
--
-- The summarize sub-gen reads the span from prompt.messages: the open-tag
-- message itself (tag stripped — the encounter intro is part of the story)
-- plus everything after it. The open must be VISIBLE to be summarized — if
-- it scrolled out of the script's own prompt, summarize() returns nil and
-- the caller closes with a fallback gist or strips the tag. One honest
-- bound: the gist is only as good as what the span shows — chrome the
-- delegate never sees (a [sys]-wrapped hp loss) can't make it into the
-- summary.

local M = {}

local function escapePat(s) return (s:gsub("(%W)", "%%%1")) end

--- "[dungeon exploration 5]"
function M.open(name)
  return "[" .. name .. "]"
end

--- "[/dungeon exploration 5 summary=\\"...\\"]" — the script owns the format:
--- summaries never carry double quotes, newlines, or excess length.
function M.close(name, summary)
  local s = tostring(summary or ""):gsub('"', "'"):gsub("%s+", " "):gsub("^%s*(.-)%s*$", "%1"):sub(1, 200)
  return "[/" .. name .. " summary=\\"" .. s .. "\\"]"
end

--- The span to summarize: the open-tag message itself (tag stripped — the
--- encounter intro IS part of the story) plus everything after it. Returns
--- nil when the open isn't visible.
function M.sinceOpen(prompt, name)
  local pat = "%[" .. escapePat(name) .. "%]"
  local openIdx
  for i = #prompt.messages, 1, -1 do
    local m = prompt.messages[i]
    if type(m.content) == "string" and m.content:find(pat) then openIdx = i break end
  end
  if not openIdx then return nil end
  local span = {}
  for i = openIdx, #prompt.messages do
    local m = prompt.messages[i]
    if type(m.content) == "string" then
      local content = i == openIdx and (m.content:gsub(pat, ""):gsub("^%s*(.-)%s*$", "%1")) or m.content
      if content:match("%S") then span[#span + 1] = { role = m.role, content = content } end
    end
  end
  return span
end

--- Run the summarize sub-gen over the span: one gist line for close().
--- Returns nil when there is nothing to summarize (open not visible, empty
--- span, or an empty delegate answer) — the caller picks the fallback.
--- opts.instructions: extra guidance appended to the summarizer's prompt.
function M.summarize(name, prompt, opts)
  opts = opts or {}
  local span = M.sinceOpen(prompt, name)
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

--- Repair a model-freelanced close tag in outgoing text: a bare "[/name]"
--- (no summary) becomes a proper close with the given summary — or is
--- stripped entirely when no summary is available. Never leak a bare close.
function M.fixClose(text, name, summary)
  local bare = "%[/" .. escapePat(name) .. "%s*%]"
  if summary then return (text:gsub(bare, M.close(name, summary))) end
  return (text:gsub(bare, ""))
end

return M
\`\`\`


### lib/maptag.lua

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
-- The companion display rule (Crypt map) renders any tag of this shape;
-- its source is in topic \`game_cards_factory\` and the \`regexes\` recipe.

local M = {}

local function clean(s)
  return (tostring(s):gsub("[|;>%[%]=<'\\"&]", " "):gsub("%s+", " "):gsub("^%s*(.-)%s*$", "%1"):sub(1, 18))
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
        if to ~= "down" and rooms[to] and visible[to] then
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


### lib/events.lua

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
--     MODE. The [event ...] tags in the log are renderings of it, never the
--     source of truth.
--   * the cast: a character registry (lib/registry) plus the casting tools.
--     The character FIELDS are the card's (declared in the def); the
--     validate-file-query pipeline is the lib's.
--   * dossiers: per-character memory, state.dossiers[id] = { digest, takes }.
--     close_event files one take per participant — what THAT character
--     carried away, so knowledge asymmetry is structural. get_character
--     serves the file with FOLD-ON-READ digestion: when the backlog outgrows
--     the recent window, one cheap sub-gen folds the oldest takes into the
--     running digest and drops them. Fail-soft: a delegate error never eats
--     memory — cap-and-count is served and the fold retries next read.
--   * the tags: [event kind], [chat featuring="..."], [/event kind
--     summary="..."]. Structural markup — visible to the model, rendered for
--     the player, emitted ONLY by the script (strip removes freelanced tags
--     from delegate text).
--   * the append-only span: span(prompt) is the event's messages verbatim,
--     deterministically cleaned, never capped — the scene-runner's
--     frozen-prefix view (turn N is a strict prefix of turn N+1).
--
-- Two contract views, for toolset composition:
--   ev.tools() / ev.exec(name, args)   -- the scene-runner's toolset
--   ev.dm()                            -- the DM's slice: open_event only
--
--   local ev = events.new({
--     roster = myRoster,   -- inject the card's own registry instance…
--     fields = {...},      -- …or declare fields and the engine creates it
--     key = "characters",  -- state key for the roster (default)
--     recent = 3,          -- dossier takes served verbatim (default 3)
--     backlog = 3,         -- fold when takes exceed recent + backlog (default 3)
--   })
--
-- INJECT the roster when anything else needs the cast: the same instance
-- can ride another toolset (a battle-summarizer marking someone dead), and
-- records are plain tables in state[key], so roster.get(id) returns the
-- LIVE record — an ad-hoc tool mutates it (rec.dead = true) and every
-- consumer sees it: get_character copies all record fields into its result.
-- The instance is always available as ev.roster, whichever path built it.
--
-- Instance surface beyond the contract (PLAIN DOT CALLS):
--   ev.isOpen()  ev.kind()  ev.eventLine()  ev.participants()  ev.clear()
--   ev.strip(text)  ev.chatWrap(text)  ev.closeTag()  ev.span(prompt)
--   ev.finalize(prompt)  -- the /leave path: best-effort close, always closes
--   ev.roster            -- the character registry (shared, live)
--   ev.bindPrompt(prompt)  -- once per generate(), like ledger.bind: the
--     fold's digest sub-gen inherits the turn's token budget (a bare
--     { messages } prompt would break real adapters, which read
--     prompt.tokenUsage). Unbound = digestion stays dormant.

local registry = require("lib/registry")
local toolset = require("lib/toolset")
local loop = require("lib/loop")

local M = {}

function M.new(def)
  -- The roster: injected (shared with the card's other subsystems) or
  -- created from the declared fields. Either way, public as E.roster.
  local roster = def.roster or registry.new({
    tool = "register_character",
    description = "File a NEW character (check list_characters first — re-filing an existing name returns the existing record).",
    key = def.key or "characters",
    id_from = "name",
    fields = def.fields,
  })
  local RECENT = def.recent or 3
  local BACKLOG = def.backlog or 3

  local E = { roster = roster }

  -- ---------- state ----------

  local function dossier(id)
    if type(state) ~= "table" then state = {} end
    state.dossiers = state.dossiers or {}
    local d = state.dossiers[id]
    if type(d) ~= "table" or type(d.takes) ~= "table" then
      d = { digest = "", takes = {} }
      state.dossiers[id] = d
    end
    if type(d.digest) ~= "string" then d.digest = "" end
    return d
  end

  function E.isOpen() return type(state) == "table" and state.event ~= nil end

  function E.kind() return (state.event and state.event.kind) or nil end

  --- "kind — context": the card appends this to its frozen scene-runner
  --- system block. Frozen for the event's lifetime by construction.
  function E.eventLine()
    if not state.event then return "" end
    return state.event.kind .. " — " .. state.event.context
  end

  function E.participants()
    return (state.event and state.event.participants) or {}
  end

  function E.clear() state.event = nil end

  -- ---------- tags (script-owned) ----------

  -- The model never types a bracket: freelanced structural tags in delegate
  -- text are stripped; the script emits every tag.
  function E.strip(text)
    return (tostring(text or ""):gsub("%[/?event [^%]]*%]", ""):gsub("%[/?chat[^%]]*%]", ""))
  end

  --- Wrap one scene-runner response in this turn's chat block.
  function E.chatWrap(text)
    return '[chat featuring="' .. table.concat(E.participants(), ",") .. '"]\\n' .. text .. "\\n[/chat]"
  end

  --- The spliced close tag ("" when the event isn't closing).
  function E.closeTag()
    if not (state.event and state.event.closed) then return "" end
    return "[/event " .. state.event.kind .. ' summary="' .. state.event.closed.gist .. '"]'
  end

  -- ---------- the append-only span ----------

  -- The event's messages verbatim, deterministically cleaned, NEVER capped.
  -- [sys], buttons, and HUD are stripped; the structural markup STAYS (the
  -- scene-runner needs to see who is on stage). Deterministic cleaning plus
  -- a stable span start is what makes turn N a strict prefix of turn N+1.
  function E.span(prompt)
    local startIdx
    for i = #prompt.messages, 1, -1 do
      local m = prompt.messages[i]
      if type(m.content) == "string" and m.content:find("%[event ") then startIdx = i break end
    end
    local msgs = {}
    if startIdx then
      for i = startIdx, #prompt.messages do
        local m = prompt.messages[i]
        if type(m.content) == "string" then
          local cleaned = m.content
            :gsub("%s*%[sys%].-%[/sys%]%s*", "\\n\\n")
            :gsub("%s*<button.-</button>", "")
            :gsub("%[HUD[^%]]*%]", "")
            :gsub("^%s*(.-)%s*$", "%1")
          if cleaned ~= "" then msgs[#msgs + 1] = { role = m.role, content = cleaned } end
        end
      end
    end
    return msgs
  end

  -- ---------- dossiers (fold-on-read digestion) ----------

  -- The turn's incoming prompt, bound once per generate() by the card: the
  -- digest sub-gen copies it (like every other sub-prompt in the lib) so the
  -- delegate gets a complete prompt table — real adapters read
  -- prompt.tokenUsage, and a bare { messages } table throws in production.
  local boundPrompt = nil

  --- Bind the turn's prompt (once per generate, next to ledger.bind).
  function E.bindPrompt(prompt) boundPrompt = prompt end

  -- One cheap, tool-less sub-gen folds the oldest takes into the running
  -- digest, then drops them — the digest is bounded, raw takes are not.
  -- Fail-soft: any error leaves the dossier untouched and the caller serves
  -- cap-and-count; memory is never lost to a delegate error.
  local function fold(d)
    if not boundPrompt then return end -- dormant until the card binds
    local cut = #d.takes - RECENT
    if cut <= 0 then return end
    local folding = {}
    for i = 1, cut do folding[#folding + 1] = d.takes[i].take end
    local sub = {}
    for k, v in pairs(boundPrompt) do sub[k] = v end
    sub.tools = nil
    sub.messages = {
      { role = "system", content = "Compress a character's history with the player into ONE short paragraph, "
        .. "third person. Keep the specifics that would matter later — names, debts, slights, promises, "
        .. "impressions. No double quotes. If a prior digest is given, fold the new entries INTO it." },
      { role = "user", content =
        (d.digest ~= "" and ("PRIOR DIGEST:\\n" .. d.digest .. "\\n\\n") or "")
        .. "NEW ENTRIES (oldest first):\\n- " .. table.concat(folding, "\\n- ") },
    }
    local ok, res = pcall(function() return backends.generate(sub):await() end)
    if not ok or type(res) ~= "table" or type(res.text) ~= "string" then return end
    local digest = res.text:gsub("%s+", " "):gsub('"', "'"):gsub("^%s*(.-)%s*$", "%1"):sub(1, 400)
    if digest == "" then return end
    d.digest = digest
    for _ = 1, cut do table.remove(d.takes, 1) end
  end

  --- A character's file: the registry record plus their dossier (digest +
  --- recent takes). Triggers the fold when the backlog outgrows the window.
  --- Returns nil when no such character.
  function E.file(id)
    local rec = roster.get(id)
    if not rec then return nil end
    local d = dossier(rec.id)
    if #d.takes > RECENT + BACKLOG then fold(d) end
    local recent = {}
    local start = math.max(1, #d.takes - RECENT + 1)
    for i = start, #d.takes do recent[#recent + 1] = d.takes[i].take end
    return rec, { digest = d.digest, takes = recent, older = #d.takes - #recent }
  end

  -- ---------- opening and closing ----------

  local function openEvent(args)
    if state.event then return "rejected: an event is already open" end
    local kind = tostring(args.kind or ""):lower():sub(1, 30)
    local context = tostring(args.context or ""):sub(1, 400)
    if kind == "" or context == "" then
      return "rejected: kind and context required — the scene-runner needs framing (who the player is, what they want)"
    end
    state.eventSeq = (state.eventSeq or 0) + 1 -- lib-owned: cards without a turn counter still get unique ids
    state.event = { id = "e" .. state.eventSeq, kind = kind, context = context, participants = {} }
    return json.encode({ opened = state.event.id, kind = kind,
      note = "the scene-runner takes over now — cast no characters yourself" })
  end

  -- The gist is NEUTRAL (it rides the close tag, for compaction and the
  -- plot log); the takes are TARGETED (what each participant carries away).
  -- Keys are validated against the participant list — strangers are dropped
  -- and reported, per the canonical-record rule.
  local function closeEvent(args)
    if not state.event then return "rejected: no event is open" end
    if state.event.closed then return "already closing: " .. state.event.id end
    local gist = tostring(args.gist or ""):gsub('"', "'"):gsub("%s+", " "):gsub("^%s*(.-)%s*$", "%1"):sub(1, 200)
    if gist == "" then gist = "The " .. state.event.kind .. " breaks off." end
    local filed, dropped = {}, {}
    if type(args.takes) == "table" then
      for id, take in pairs(args.takes) do
        local present = false
        for _, p in ipairs(state.event.participants) do
          if p == id then present = true break end
        end
        if present then
          local d = dossier(id)
          d.takes[#d.takes + 1] = { event = state.event.kind, take = tostring(take):sub(1, 200) }
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

  local OPEN_EVENT_SCHEMA = {
    type = "function",
    ["function"] = { name = "open_event", description = "Open an event (a conversation or scene) and hand it to the scene-runner. context: who the player is and what they are after. NO character list — casting is the scene-runner's job.",
      parameters = { type = "object", properties = { kind = { type = "string" }, context = { type = "string" } }, required = { "kind", "context" } } },
  }

  --- The /leave path: the exit never depends on the delegate. One
  --- best-effort finalize gen writes the gist and takes; on any failure the
  --- event still closes with a script-composed fallback gist. Returns the
  --- spliced close tag.
  function E.finalize(prompt)
    if not state.event then return "" end
    pcall(function()
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
      for _, m in ipairs(E.span(prompt)) do sub.messages[#sub.messages + 1] = m end
      local res = backends.generate(sub):await()
      loop.run(sub, res, ts:exec(), 4)
    end)
    if not state.event.closed then
      state.event.closed = { gist = "The " .. state.event.kind .. " breaks off." }
    end
    return E.closeTag()
  end

  -- ---------- the tool contract (the scene-runner's toolset) ----------

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
      local rec, file = E.file(args and args.id)
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
    if name == "close_event" then return closeEvent(args or {}) end
    return nil
  end

  --- The DM's slice of the contract: open_event, nothing else. Casting is
  --- the scene-runner's job; the DM's toolset shouldn't even have it.
  function E.dm()
    return {
      tools = function() return { OPEN_EVENT_SCHEMA } end,
      exec = function(name, args)
        if name == "open_event" then return openEvent(args or {}) end
        return nil
      end,
    }
  end

  return E
end

return M
\`\`\`
`;
