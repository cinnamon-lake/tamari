/** Reference doc for the `game_cards_events` topic, served by the Docs tool. */
export const GAME_CARDS_EVENTS_DOC = `# The Guildhall (event-engine worked example)

A complete, TESTED event-engine card: \`backend_logic/main.lua\` plus its vendored game lib (\`backend_logic/lib/*.lua\`) — an idle menu, a DM who frames scenes, a scene-runner who casts and writes them, and characters who remember you by what THEY carried away. Theory lives in topic \`game_cards\` (The event engine); this topic is the steal-able file. (Repo copy \`docs/design/examples/guildhall/main.lua\`, validated end-to-end through the real adapter by \`server/src/backends/guildhall.example.test.ts\`; install as a playable card with \`server/scripts/add-guildhall.ts\`.) Decisions worth noticing:

- **The machinery is \`lib/events\`; the card is what's left.** The card creates the character registry itself (\`registry.new\` with ITS fields — a raising game declares different ones) and INJECTS it: \`events.new({ roster })\`. The engine owns event state, the cast tools, dossiers, the script-owned tags, the append-only span, and the \`/leave\` finalize; what remains in main.lua is the menu, the two prompts, the HUD, the suggest economy, the turn routing. Injection keeps the cast SHARED, not opaque: the same instance can ride another toolset (a battle-summarizer gets \`mark_dead\`), and records are plain tables in \`state.characters\` — \`roster.get(id)\` returns the LIVE record, so an ad-hoc tool mutates it and \`get_character\` reports it (all record fields flow through). Two contract views: \`ts:use(ev)\` for the scene-runner's full toolset, \`ts:use(ev.dm())\` for the DM's \`open_event\`-only slice.
- **Two delegates, split by prompt shape.** The DM (idle escalation) adjudicates and FRAMES: \`open_event({ kind, context })\` — its toolset has no \`register_character\` at all; casting is not the DM's job. The scene-runner takes over in the SAME turn and owns the event until it closes: it casts from the registry (\`list_characters\` → \`register_character\` → \`add_to_chat\`) and writes EVERY participant in one gen — per-character sub-gens are a cost trap, and the current chat always goes in whole.
- **The scene-runner's prompt is append-only within an event — the test proves it.** Frozen system block (instructions + the DM's context, via \`ev.eventLine()\`), \`ev.span(prompt)\` verbatim, deterministic cleaning, never capped. Turn N is a strict prefix of turn N+1, so the delegate's prefix cache hits. Volatile state rides in the tail; character files and dossiers arrive as READ-tool results (\`get_character\`) instead of prefix injections. The one seam is the boundary turn — the DM's transition and the first chat block land in history combined.
- **Events are modes.** \`state.event\` owns the mode: menu verbs are gated ("Finish your business here first"), the button row swaps to Leave + pending suggestions, ONE event at a time. The \`[event ...]\` / \`[chat featuring="..."]\` tags in the log are renderings — visible to the model, hidden from the player, parsed by the script only to build delegate VIEWS, never to learn what happened.
- **\`close_event({ gist, takes })\` — two memory channels.** The NEUTRAL gist rides the script-spliced \`[/event kind summary="..."]\` tag (\`collapse.blocks\` zooms it; the plot-log display rule renders it). Each participant's TAKE — what THAT character carries away — lands in \`state.dossiers[charId].takes\`. Take keys are validated against the participant list; strangers are dropped and the canonical result says so. Knowledge asymmetry is structural: no take filed, no knowledge. {{user}} gets no take.
- **Dossier digestion is FOLD-ON-READ.** \`get_character\` serves the file plus the dossier — the digest plus the recent few takes. When the backlog outgrows the window (\`recent + backlog\` knobs), ONE cheap tool-less sub-gen folds the oldest takes into the running digest and drops them. On READ, so one-off NPCs never cost a token; fail-soft, so a delegate error serves cap-and-count with every take intact (the fold retries next read). The digest is bounded; raw takes are not. Exact facts still belong in registries and flags, not prose memory. (The card binds the turn's prompt once per \`generate()\` — \`ev.bindPrompt(prompt)\`, like \`ledger.bind\` — so the fold's sub-gen inherits the token budget; a bare \`{ messages }\` prompt breaks real adapters.)
- **\`suggest\` is the confirmed write.** The button posts \`/accept sN\`; acceptance is serve-land — gold deducted, party updated, zero delegate calls. The suggestion may re-roll on swipes; the decision is \`state\`. (Deliberately CARD-side: the lib owns events, the card owns its economy.)
- **\`/leave\` is a deterministic exit.** \`ev.finalize(prompt)\` runs ONE best-effort finalize gen over the chat for the gist and takes, with a script-composed fallback when the delegate fails (the Crypt's \`endFight\` pattern) — then closes regardless. Freedom never depends on the delegate succeeding.
- **The model never types a bracket.** \`ev.strip\` removes freelanced \`[event]\`/\`[chat]\` tags from delegate text; the script emits every tag.
- **Lib instances take DOT calls.** \`roster.get(id)\`, \`roster.all()\` — the composed contract (\`tools()\`/\`exec()\`, via toolset) is dot-only. \`registry.get\` itself is colon-tolerant — added after a colon call silently missed every lookup in testing.
- **Button stripping is \`<button.-</button>\`** — lazy up to the CLOSE tag. The \`<button.-></button>\` form only matches EMPTY buttons and leaves labeled ones in the delegate's view.
- **\`continue\` never resolves** — an ambient line only, so nothing double-applies.

Companion character-scoped regex rules (installed by the script): the universal \`[sys]\` hider, a HUD panel for \`[HUD|gold=..|party=..]\`, hide \`/[event [\\w ]+]/g\` (event open is structural), plot-log \`/[\\/event (\\w[\\w ]*) summary="([^"]*)"\\]/g\` (the gist), hide \`/[\\/?chat[^\\]]*\\]/g\` (chat markup).

The lib modules this card vendors (\`loop\`, \`collapse\`, \`transcript\`, \`chrome\`, \`ledger\`, \`toolset\`, \`registry\`, \`events\`) are documented in topic \`game_cards\` (The game lib) with full sources at the end of topic \`game_cards_factory\`.

\`\`\`lua
-- The Guildhall — an EVENT-ENGINE card backend (Type B: backend_logic/main.lua)
--
-- The player idles in a guild hall with a deterministic menu (delve, store,
-- blacksmith) until they do something nobody planned for. Then TWO delegates
-- split the work: the DM adjudicates the action and FRAMES the resulting
-- event (open_event with a kind and a context — NO character list; casting
-- is not the DM's job), and a scene-runner takes over the event itself —
-- checking the registry for existing characters, filing new ones, writing
-- every participant at once. The scene-runner's prompt is APPEND-ONLY within
-- an event (frozen system + the event span verbatim, never capped) so the
-- delegate's prefix cache actually hits; volatile state rides in the tail,
-- character files and dossiers arrive as READ-tool results.
--
-- Events are MODES: while one is open the menu is gated, free text goes to
-- the scene-runner, and /leave is a deterministic exit — closing writes
-- memory, it never gates freedom. An event closes into TWO memory channels:
-- a neutral gist spliced by the SCRIPT into the [/event kind summary="..."]
-- tag (compaction and plot-log display consume it), and a per-participant
-- TAKE filed in state.dossiers — what THAT character carries away. Knowledge
-- asymmetry is structural: no take filed, no knowledge. When a character's
-- backlog outgrows the recent window, get_character FOLDS the oldest takes
-- into a running digest (one cheap sub-gen, fail-soft).
--
-- The machinery is lib/events (event state, cast, dossiers, tags, the
-- append-only span, the /leave finalize). What remains here is the CARD:
-- the menu, the prompts, the HUD, the suggest economy, the turn routing.
-- The character FIELDS are declared below; a raising game or a tycoon game
-- declares different fields and keeps the whole engine.
--
-- Also built on the game lib: loop (tool loops), transcript + collapse (the
-- DM's compressed view), chrome (buttons/acks/unwrap), ledger (story debts),
-- toolset (composition), registry (the character registry, via lib/events).
--
-- Companion display rules:
--   /\\s*\\[sys\\].*?\\[\\/sys\\]\\s*/gis → "\\n\\n" (hide [sys] acks — universal
--   prompt+display rule; in-fiction results stay VISIBLE served text)
--   /\\[event [\\w ]+\\]/g → "" (event open is structural; hide it)
--   /\\[\\/event (\\w[\\w ]*) summary="([^"]*)"\\]/g → plot-log div (the gist)
--   /\\[\\/?chat[^\\]]*\\]/g → "" (chat markup is structural; hide it)
--   /\\[HUD\\|([^\\]]+)\\]/g → panel HTML (HUD recipe, topic \`regexes\`)

local loop = require("lib/loop")
local transcript = require("lib/transcript")
local chrome = require("lib/chrome")
local ledger = require("lib/ledger")
local toolset = require("lib/toolset")
local registry = require("lib/registry")
local events = require("lib/events")

-- The cast, created by the CARD and injected into the engine: the same
-- instance can ride another toolset (a battle-summarizer marking someone
-- dead), and records are plain tables in state.characters — roster.get(id)
-- returns the LIVE record, so an ad-hoc tool mutates it and every consumer
-- sees it. The fields are the card's; the pipeline is the lib's.
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

-- The event engine over the injected roster.
local ev = events.new({
  roster = roster,
  recent = 3,  -- dossier takes served verbatim
  backlog = 3, -- fold when takes exceed recent + backlog
})

-- ---------- state (hot only — dossiers and the event are the lib's) ----------

local function ensureState()
  if type(state) ~= "table" then state = {} end
  state.gold = state.gold or 30
  state.party = state.party or {}       -- array of character ids
  state.flags = state.flags or {}
  state.pending = state.pending or {}   -- suggestion id -> { label, gold?, party? }
  state.suggestN = state.suggestN or 0
  state.turn = state.turn or 0
end

-- ---------- small helpers ----------

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

local function hud()
  local party = #state.party > 0 and table.concat(state.party, ",") or "none"
  return string.format("[HUD|gold=%d|party=%s]", state.gold, party)
end

-- Every message ends with its button row, and the row matches the MODE:
-- the menu in idle, Leave + pending suggestions inside an event.
local function buttonsHtml()
  if ev.isOpen() then
    local out = {}
    local ids = {}
    for sid in pairs(state.pending) do ids[#ids + 1] = sid end
    table.sort(ids)
    for _, sid in ipairs(ids) do
      out[#out + 1] = chrome.btn("accept " .. sid, state.pending[sid].label)
    end
    out[#out + 1] = chrome.btn("leave", "Leave")
    return table.concat(out, " ")
  end
  return chrome.btn("delve", "Delve into the dungeon") .. " "
    .. chrome.btn("shop", "Visit the store") .. " "
    .. chrome.btn("smith", "See the blacksmith")
end

-- ---------- the DM toolset (idle escalation: adjudicate, then frame) ----------

local DM_PROMPT = "You are the guildhall's dungeon master, adjudicating ONE player action in the idle hall. "
  .. "If the action opens a conversation or scene, call open_event with a kind and a CONTEXT: who the player "
  .. "is and what they are after, framed for the scene-runner who takes over — NO character list; casting is "
  .. "the scene-runner's job. Use attempt() for anything risky — the ENGINE rolls and decides. set_flag for "
  .. "lasting facts, recall for what was actually said. Then narrate the transition in 1-2 terse sentences, "
  .. "second person."

local function dmToolset()
  local ts = toolset.new()
  ts:use(ledger)
  ts:use(ev.dm()) -- open_event, nothing else — casting is the scene-runner's

  ts:handle("attempt", function(args)
    local difficulty = math.max(5, math.min(20, tonumber(args.difficulty) or 10))
    local roll = math.random(1, 20)
    local outcome = roll >= difficulty and "success" or "failure"
    return json.encode({ outcome = outcome, roll = roll, difficulty = difficulty,
      note = "the dice are the engine's, not yours — narrate THIS result" })
  end, {
    type = "function",
    ["function"] = { name = "attempt", description = "Resolve a risky action. The ENGINE rolls (d20 vs difficulty) and decides — narrate the result it returns.",
      parameters = { type = "object", properties = { action = { type = "string" }, difficulty = { type = "integer" } }, required = { "action" } } },
  })

  ts:handle("set_flag", function(args)
    local key = tostring(args.key or ""):sub(1, 30)
    if key == "" then return "rejected: key required" end
    state.flags[key] = args.value == nil and true or args.value
    return "ok: " .. key
  end, {
    type = "function",
    ["function"] = { name = "set_flag", description = "Set a lasting world fact.",
      parameters = { type = "object", properties = { key = { type = "string" }, value = { type = "boolean" } }, required = { "key" } } },
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
    ["function"] = { name = "recall", description = "Search the FULL chat history for exact past text — what was actually said or done earlier.",
      parameters = { type = "object", properties = { query = { type = "string" } }, required = { "query" } } },
  })

  return ts
end

-- ---------- the chat toolset (the scene-runner's economy) ----------

local CHAT_PROMPT = "You are the scene-runner for one event in a guild-hall RPG. You write EVERY participant "
  .. "except the player — all of them, in one response. Cast the scene from the registry: list_characters "
  .. "before inventing anyone, get_character for a character's file and their history with the player, "
  .. "register_character to file someone NEW, add_to_chat to bring them on stage. Never speak for the player. "
  .. "Anything the player must accept goes through suggest — the button makes the offer, not your prose. "
  .. "When the scene is spent, close_event with a gist and one take PER PARTICIPANT. "
  .. "Terse, concrete, in character.\\n\\nEVENT: "

local function chatToolset()
  local ts = toolset.new()
  ts:use(ev) -- register/list/get/add_to_chat/close_event, from the lib

  -- The confirmed write: the model proposes, the PLAYER disposes. The
  -- suggestion is flavor until the button is clicked; the decision is state.
  -- (Card-specific: the lib owns events, the card owns its economy.)
  ts:handle("suggest", function(args)
    local label = tostring(args.label or ""):sub(1, 60)
    if label == "" then return "rejected: label required" end
    state.suggestN = state.suggestN + 1
    local sid = "s" .. state.suggestN
    local s = { label = label }
    if tonumber(args.gold) then s.gold = math.max(0, math.floor(tonumber(args.gold))) end
    if type(args.party) == "string" then
      local rec = ev.file(args.party)
      if rec then s.party = rec.id end
    end
    state.pending[sid] = s
    return json.encode({ suggestion = sid,
      note = "the PLAYER decides — the button is posted; do not treat this as accepted" })
  end, {
    type = "function",
    ["function"] = { name = "suggest", description = "Post an offer the player must accept: a button with a label, an optional gold cost, an optional character who joins the party.",
      parameters = { type = "object", properties = {
        label = { type = "string" }, gold = { type = "integer" }, party = { type = "string" } },
        required = { "label" } } },
  })

  return ts
end

-- ---------- turns ----------

-- Idle serve: the menu is deterministic and FREE. The dungeon is a stub —
-- the event engine is the point of this card.
local function serveIdle(cmd)
  if cmd == "delve" then
    local loot = math.random(1, 6)
    state.gold = state.gold + loot
    return "You descend past the old gate, take what the dark will give up, and climb back out. (+" .. loot .. " gold)"
  end
  if cmd == "shop" then
    return "The quartermaster grunts from behind the counter. Shelves of rope, rations, and rust."
  end
  if cmd == "smith" then
    return "The blacksmith does not look up. 'Arms and armor. Coin first.'"
  end
  return nil
end

-- One scene-runner call: frozen system + the append-only event span, the
-- tool loop, then the script wraps the result in this turn's [chat] block.
-- \`first\` marks the boundary turn: the event opened THIS turn, so there is
-- no span for it in history yet (an older event's tags may be back there —
-- never mistake them for this one). The player's action is the whole tail.
local function chatTurn(prompt, cmd, first)
  local ts = chatToolset()
  local sub = {}
  for k, v in pairs(prompt) do sub[k] = v end
  sub.tools = ts:schemas()
  sub.messages = {
    { role = "system", content = CHAT_PROMPT .. ev.eventLine() },
  }
  if first then
    sub.messages[#sub.messages + 1] = { role = "user", content = cmd }
  else
    for _, m in ipairs(ev.span(prompt)) do sub.messages[#sub.messages + 1] = m end
  end
  local res = backends.generate(sub):await()
  res = loop.run(sub, res, ts:exec())
  local text = trim(ev.strip(res.text or ""))
  if text == "" then text = "The moment stretches." end
  return ev.chatWrap(text)
end

-- The idle turn: serve the menu, or escalate to the DM — and if the DM
-- framed an event, the scene-runner takes over in the SAME turn.
local function idleTurn(prompt, cmd)
  local served = serveIdle(cmd)
  if served then
    return served .. "\\n\\n" .. hud() .. "\\n" .. buttonsHtml()
  end
  if cmd == "" then
    return "Say something." .. "\\n\\n" .. hud() .. "\\n" .. buttonsHtml()
  end

  local ts = dmToolset()
  local sub = {}
  for k, v in pairs(prompt) do sub[k] = v end
  sub.tools = ts:schemas()
  sub.messages = {
    { role = "system", content = DM_PROMPT .. "\\n\\nPLAYER: gold " .. state.gold
      .. ", party: " .. (#state.party > 0 and table.concat(state.party, ", ") or "none")
      .. ledger.briefing()
      .. "\\n\\nRECENT TURNS:\\n" .. transcript.recent(prompt, 6) },
    { role = "user", content = 'The player: "' .. cmd .. '"' },
  }
  local res = backends.generate(sub):await()
  res = loop.run(sub, res, ts:exec())
  local text = trim(ev.strip(res.text or ""))

  if ev.isOpen() then
    -- The DM framed a scene: emit the event open, the DM's transition, and
    -- the scene-runner's first chat block — one message, boundary turn.
    local chatBlock = chatTurn(prompt, cmd, true)
    if text == "" then text = "The hall shifts around you." end
    return "[event " .. ev.kind() .. "]\\n\\n" .. text .. "\\n\\n" .. chatBlock
      .. "\\n\\n" .. hud() .. "\\n" .. buttonsHtml()
  end
  if text == "" then text = "Nothing comes of it." end
  return text .. "\\n\\n" .. hud() .. "\\n" .. buttonsHtml()
end

-- The event turn: the menu is GATED (events are modes), Leave and the
-- suggestion buttons are serve-land, everything else is the scene-runner's.
local function eventTurn(prompt, cmd)
  if cmd == "delve" or cmd == "shop" or cmd == "smith" then
    return "Finish your business here first." .. "\\n\\n" .. hud() .. "\\n" .. buttonsHtml()
  end
  if cmd == "leave" then
    -- The deterministic exit: freedom never depends on the delegate. The
    -- lib writes the close's memory best-effort and always closes.
    local tag = ev.finalize(prompt)
    ev.clear()
    state.pending = {}
    return tag .. "\\n\\nYou step away; the hall's noise fills the space you left."
      .. "\\n\\n" .. hud() .. "\\n" .. buttonsHtml()
  end
  local acceptId = cmd:match("^accept (%w+)$")
  if acceptId then
    local s = state.pending[acceptId]
    if not s then
      return chrome.ack("Nothing pending by that name.") .. "\\n" .. buttonsHtml()
    end
    if s.gold and state.gold < s.gold then
      return "You can't cover that. (" .. s.gold .. " gold needed)" .. "\\n\\n" .. hud() .. "\\n" .. buttonsHtml()
    end
    state.pending[acceptId] = nil
    local notes = {}
    if s.gold then
      state.gold = state.gold - s.gold
      notes[#notes + 1] = "-" .. s.gold .. " gold"
    end
    if s.party then
      state.party[#state.party + 1] = s.party
      notes[#notes + 1] = s.party .. " joins you"
    end
    local suffix = #notes > 0 and (" (" .. table.concat(notes, ", ") .. ")") or ""
    return "Deal struck." .. suffix .. "\\n\\n" .. hud() .. "\\n" .. buttonsHtml()
  end
  local declineId = cmd:match("^decline (%w+)$")
  if declineId then
    state.pending[declineId] = nil
    return "Passed." .. "\\n\\n" .. hud() .. "\\n" .. buttonsHtml()
  end

  local out = chatTurn(prompt, cmd)
  local closeTag = ev.closeTag()
  if closeTag ~= "" then
    -- The scene-runner closed the event: splice the close tag, drop the
    -- pending offers, and return to the idle menu.
    out = out .. "\\n\\n" .. closeTag
    ev.clear()
    state.pending = {}
    out = out .. "\\n\\nThe hall offers its usual business."
  end
  return out .. "\\n\\n" .. hud() .. "\\n" .. buttonsHtml()
end

-- ---------- the turn ----------

function generate(prompt, ctx)
  ensureState()
  ledger.bind(function() return state.turn end)
  ev.bindPrompt(prompt) -- the fold's digest sub-gen inherits the turn's token budget

  -- continue never resolves: an ambient line only, so nothing double-applies.
  if ctx and ctx.generationType == "continue" then
    return "The hall murmurs on." .. "\\n\\n" .. hud() .. "\\n" .. buttonsHtml()
  end

  local input = lastUserText(prompt)
  local cmd = chrome.unwrap(input)
  state.turn = state.turn + 1

  if ev.isOpen() then
    return eventTurn(prompt, cmd)
  end
  return idleTurn(prompt, cmd)
end

function list_models()
  return { { id = "the-guildhall", name = "The Guildhall" } }
end
\`\`\`
`;
