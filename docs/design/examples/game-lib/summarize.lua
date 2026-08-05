-- lib/summarize.lua — the PRODUCTION half of compaction: authoring
-- summary-tagged blocks, and turning a mechanical span into a model-written
-- gist. (The tags are PLAYER-facing: a display rule hides the open and
-- plot-logs the close's gist. The model's memory of the span is the rolling
-- story channel — lib/rolling — not a folded view of history.)
--
-- The flow: the script opens a block when a span starts (a fight, a shopping
-- trip, an exploration), serves the mechanical turns plainly, and at the
-- boundary asks the delegate for the ONE line that survives — "the player
-- kinda struggled and had to use all of his potions against a zubat lol" —
-- then splices it into the close tag. Stored history keeps the full span;
-- the player sees the plot-log line and the story channel carries the gist
-- (lib/rolling), so the mechanical detail costs no context but the OUTCOME
-- is never paraphrased away.
--
-- The gist sub-gen reads the span from prompt.messages: the open-tag
-- message itself (tag stripped — the encounter intro is part of the story)
-- plus everything after it — OR takes it directly via opts.span, for cards
-- that track the span mechanically (a fight log in state) instead of the
-- open-tag scan. The open must be VISIBLE to be summarized — if it scrolled
-- out of the script's own prompt, gist() returns nil and the caller closes
-- with a fallback gist or strips the tag. A nil is ONLY "there was nothing
-- to summarize": a delegate ERROR propagates and fails the turn — failed
-- turns never overwrite the last good state snapshot, so the user sees the
-- real error and a swipe/regenerate retries the turn from a clean world.
-- One honest bound: the gist is only as good as what the span shows —
-- anything kept out of the delegate's view can't make it into the summary.

local chrome = require("lib/chrome")

local M = {}

local function escapePat(s) return (s:gsub("(%W)", "%%%1")) end

--- "[dungeon exploration 5]"
function M.open(name)
  return "[" .. name .. "]"
end

--- "[/dungeon exploration 5 summary=\"...\"]" — the script owns the format:
--- summaries never carry double quotes, newlines, or excess length.
function M.close(name, summary)
  return "[/" .. name .. " summary=\"" .. chrome.oneline(summary, 200) .. "\"]"
end

--- The span since a block's open tag: the open-tag message itself (tag
--- stripped — the encounter intro IS part of the story) plus everything after
--- it. Returns nil when the open isn't visible. gist() consumes this; cards
--- also use it to file the span as a rolling summary's content (lib/rolling).
function M.span(prompt, name)
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

--- Run the gist sub-gen over the span: one line for close().
--- Returns nil when there is nothing to summarize (no span, empty
--- span, or an empty delegate answer) — the caller picks the fallback. A
--- delegate error THROWS (fails the turn; state rolls back, swipe retries).
--- opts.instructions: extra guidance appended to the summarizer's prompt.
--- opts.maxSpanChars: span budget (default 6000).
--- opts.span: an explicit span (message-shaped entries) — for spans the card
--- tracks mechanically instead of the open-tag scan (lib/rolling content).
function M.gist(name, prompt, opts)
  opts = opts or {}
  local span = opts.span or M.span(prompt, name)
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
    { role = "user", content = table.concat(lines, "\n") },
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
  if summary then
    -- Function replacement, not a string: a gist containing '%' (e.g. "lost 50%
    -- HP") would otherwise throw "invalid use of '%' in replacement string".
    local close = M.close(name, summary)
    return (text:gsub(bare, function() return close end))
  end
  return (text:gsub(bare, ""))
end

return M
