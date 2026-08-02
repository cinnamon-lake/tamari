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
    return '[chat featuring="' .. table.concat(E.participants(), ",") .. '"]\n' .. text .. "\n[/chat]"
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
            :gsub("%s*%[sys%].-%[/sys%]%s*", "\n\n")
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
        (d.digest ~= "" and ("PRIOR DIGEST:\n" .. d.digest .. "\n\n") or "")
        .. "NEW ENTRIES (oldest first):\n- " .. table.concat(folding, "\n- ") },
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
