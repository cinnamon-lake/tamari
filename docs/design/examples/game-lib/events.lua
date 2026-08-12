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
