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
    { role = "user", content = table.concat(lines, "\n") },
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
    out[#out + 1] = "\nFACTS:\n" .. table.concat(lines, "\n")
  end
  local ids = ch.ids
  if #ids > RECENT + BACKLOG then fold(ids) end
  if #ids > 0 then
    local lines = {}
    for _, id in ipairs(ids) do
      local e = fetch(id)
      lines[#lines + 1] = "- [" .. id .. ": " .. e.label .. "] " .. e.gist
    end
    out[#out + 1] = "\nSTORY SO FAR:\n" .. table.concat(lines, "\n")
  end
  return table.concat(out, "\n")
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
    return head .. " " .. tostring(entry.gist or "") .. "\n(no recorded content — gist only)"
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
  return table.concat(lines, "\n")
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
