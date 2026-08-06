-- lib/maptag.lua — build a [MAP|...] tag from a room graph: the compact
-- one-line form a display rule renders as a map (HUD recipe, topic `regexes`).
--
-- The tag carries the graph state of THIS moment, so maps are branch- and
-- era-correct for free, stored text stays small, and the model sees the
-- layout as data. Fog-of-war: pass a `seen` set and only visited rooms get
-- names — rooms adjacent to the frontier show as "?" (a place to go), the
-- rest of the graph doesn't exist as far as the player is concerned. The
-- stairs marker is only included once the stairs room is actually seen —
-- never spoil the way down.
--
--   local tag = maptag.tag(pack.rooms, {
--     cur = "r2",            -- current room (always shown, highlighted)
--     entrance = pack.entrance,
--     stairs = pack.stairsDown,
--     seen = { r1 = true, r2 = true },   -- nil = reveal the whole graph
--   })
--
-- The companion display rule (floor map) renders any tag of this shape;
-- its source is in topic `game_cards_example` and the `regexes` recipe.

local M = {}

local function clean(s)
  return (tostring(s):gsub("[|;>%[%]=<'\"&]", " "):gsub("%s+", " "):gsub("^%s*(.-)%s*$", "%1"))
end

--- rooms: { id = { name = string, exits = { dir -> to } } }
--- opts: { cur, entrance, stairs, seen? } — see above.
function M.tag(rooms, opts)
  opts = opts or {}
  local seen = opts.seen
  local ids = {}
  for id in pairs(rooms) do ids[#ids + 1] = id end
  table.sort(ids)

  -- Which rooms exist for the player at all: everything, or seen + frontier.
  local visible = {}
  if not seen then
    for _, id in ipairs(ids) do visible[id] = true end
  else
    for _, id in ipairs(ids) do
      if seen[id] then
        visible[id] = true
        for _, to in pairs(rooms[id].exits or {}) do
          if rooms[to] then visible[to] = true end -- the frontier: adjacent to seen
        end
      end
    end
  end
  if opts.cur and rooms[opts.cur] then visible[opts.cur] = true end

  local roomParts, edgeParts, edgeSeen = {}, {}, {}
  for _, id in ipairs(ids) do
    if visible[id] then
      local known = not seen or seen[id]
      roomParts[#roomParts + 1] = id .. "=" .. (known and clean(rooms[id].name) or "?")
      local dirs = {}
      for d in pairs(rooms[id].exits or {}) do dirs[#dirs + 1] = d end
      table.sort(dirs)
      for _, d in ipairs(dirs) do
        local to = rooms[id].exits[d]
        if rooms[to] and visible[to] then
          local key = id < to and (id .. "|" .. to) or (to .. "|" .. id)
          if not edgeSeen[key] then
            edgeSeen[key] = true
            edgeParts[#edgeParts + 1] = id .. ">" .. clean(d) .. ">" .. to
          end
        end
      end
    end
  end

  -- The stairs marker only once the stairs room is known.
  local stairs = ""
  if opts.stairs and (not seen or seen[opts.stairs]) then stairs = tostring(opts.stairs) end

  return "[MAP|cur=" .. tostring(opts.cur or "")
    .. "|ent=" .. tostring(opts.entrance or "")
    .. "|rooms=" .. table.concat(roomParts, ";")
    .. "|edges=" .. table.concat(edgeParts, ";")
    .. "|stairs=" .. stairs .. "]"
end

return M
