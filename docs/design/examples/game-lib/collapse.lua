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

local CLOSE_PAT = "%[/([%w][%w%s_%-]-)%s*summary=\"(.-)\"%s*%]"

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
