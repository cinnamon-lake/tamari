-- lib/chrome.lua — player-facing chrome helpers and text hygiene.
--
-- Acks are plain VISIBLE text: the model sees what the player sees, and a
-- capable model needs nothing hidden from it — so game cards have no [sys]
-- tag. (unwrap and clean still tolerate legacy [sys]-wrapped text on the way
-- in.) In-fiction results of player actions are the game's feedback loop;
-- serve them as visible text.

local M = {}

-- Bare command payloads — never wrapped in any tag a display rule hides:
-- display regexes are structure-blind and would mangle the attribute,
-- killing the button.
function M.btn(cmd, label)
  return '<button data-post-response="/' .. cmd .. '">' .. label .. "</button>"
end

-- "[sys]/go north[/sys]" (legacy) or "go north" / "/go north" → "go north"
function M.unwrap(text)
  local inner = text:match("^%s*%[sys%](.-)%[/sys%]%s*$") or text
  inner = inner:gsub("^%s*(.-)%s*$", "%1")
  return (inner:gsub("^/", ""))
end

-- The deterministic cleaning every delegate view shares: strip legacy
-- [sys]…[/sys], <button>…</button>, and [HUD…]; trim. Transcript and the
-- event span BOTH use this — the frozen-prefix property of the event span
-- depends on the cleaning never diverging between views.
function M.clean(text)
  return (tostring(text or "")
    :gsub("%s*%[sys%].-%[/sys%]%s*", "\n\n")
    :gsub("%s*<button.-</button>", "")
    :gsub("%[HUD[^%]]*%]", "")
    :gsub("^%s*(.-)%s*$", "%1"))
end

-- One safe line: double quotes become single (so the result can ride a
-- summary="…" attribute), whitespace collapses, ends trim. The text itself is
-- never cut — max is opt-in and used for previews/excerpts only (the zoom
-- chain's inspect rendering); filing channels call this WITHOUT a max.
function M.oneline(text, max)
  local s = tostring(text or "")
    :gsub('"', "'")
    :gsub("%s+", " ")
    :gsub("^%s*(.-)%s*$", "%1")
  if max then s = s:sub(1, max) end
  return s
end

return M
