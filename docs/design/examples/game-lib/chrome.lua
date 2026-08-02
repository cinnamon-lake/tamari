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
