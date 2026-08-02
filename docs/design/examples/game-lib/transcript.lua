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
        :gsub("%s*%[sys%].-%[/sys%]%s*", "\n\n")
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
  return table.concat(lines, "\n")
end

return M
