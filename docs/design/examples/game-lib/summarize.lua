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

--- "[/dungeon exploration 5 summary=\"...\"]" — the script owns the format:
--- summaries never carry double quotes, newlines, or excess length.
function M.close(name, summary)
  local s = tostring(summary or ""):gsub('"', "'"):gsub("%s+", " "):gsub("^%s*(.-)%s*$", "%1"):sub(1, 200)
  return "[/" .. name .. " summary=\"" .. s .. "\"]"
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
  if summary then return (text:gsub(bare, M.close(name, summary))) end
  return (text:gsub(bare, ""))
end

return M
