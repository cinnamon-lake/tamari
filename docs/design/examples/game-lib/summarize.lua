-- lib/summarize.lua — the gist engine: turn a mechanical span into the ONE
-- model-written line that survives.
--
-- The flow: the script serves a span's mechanical turns plainly (a fight, a
-- shopping trip, an exploration), and at the boundary asks the delegate for
-- the one line — "the player kinda struggled and had to use all of his
-- potions against a zubat lol". That line goes two places, both TAGLESS: a
-- plain memoir line in the reply (the player reads it like any other prose),
-- and a rolling story entry with the span as its zoomable content
-- (lib/rolling). No tags, no display rules — the memoir is just text.
--
-- The span is the caller's, passed via opts.span (message-shaped entries,
-- usually tracked mechanically in state). gist() returns nil only when there
-- is nothing to summarize (no span, empty span, empty delegate answer) — the
-- caller picks the fallback. A delegate ERROR propagates and fails the turn —
-- failed turns never overwrite the last good state snapshot, so the user sees
-- the real error and a swipe/regenerate retries from a clean world. One
-- honest bound: the gist is only as good as what the span shows — anything
-- kept out of the delegate's view can't make it into the summary.

local M = {}

--- Run the gist sub-gen over opts.span: one line. opts.instructions: extra
--- guidance appended to the summarizer's prompt. opts.maxSpanChars: span
--- budget (default 6000).
function M.gist(prompt, opts)
  opts = opts or {}
  local span = opts.span
  if not span or #span == 0 then return nil end

  local lines = {}
  local budget = opts.maxSpanChars or 6000
  for i = #span, 1, -1 do -- newest-first until the budget is spent
    local line = span[i].role .. ": " .. span[i].content
    if #line > budget then break end
    table.insert(lines, 1, line)
    budget = budget - #line
  end
  if #lines == 0 then return nil end -- no line fit the budget: caller's fallback, not an empty-span sub-gen

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

return M
