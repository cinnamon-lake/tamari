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
-- Grid layouts (rooms carry numeric x/y — lib/layout) emit coordinates so
-- the display rule can draw a real 2D map: rooms as `id=x,y,Name` and
-- passages as undirected `a-b` pairs (coordinates are normalized over the
-- WHOLE graph, not the visible part, so the map never drifts as fog lifts).
-- Rooms without coordinates fall back to the legacy direction-labeled shape,
-- which the rule renders as the old room list.
--
--   local tag = maptag.tag(pack.rooms, {
--     cur = "r2",            -- current room (always shown, highlighted)
--     entrance = pack.entrance,
--     stairs = pack.stairsDown,
--     seen = { r1 = true, r2 = true },   -- nil = reveal the whole graph
--   })

local M = {}

local function clean(s)
  return (tostring(s):gsub("[|;>%[%]=<'\"&,%-]", " "):gsub("%s+", " "):gsub("^%s*(.-)%s*$", "%1"))
end

--- rooms: { id = { name = string, x = number?, y = number?, exits = { dir -> to } } }
--- opts: { cur, entrance, stairs, seen? } — see above.
function M.tag(rooms, opts)
  opts = opts or {}
  local seen = opts.seen
  local ids = {}
  for id in pairs(rooms) do ids[#ids + 1] = id end
  table.sort(ids)

  -- Grid mode when every room carries coordinates.
  local grid = true
  local minX, minY = math.huge, math.huge
  for _, id in ipairs(ids) do
    local r = rooms[id]
    if type(r.x) == "number" and type(r.y) == "number" then
      if r.x < minX then minX = r.x end
      if r.y < minY then minY = r.y end
    else
      grid = false
    end
  end

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
      local label = known and clean(rooms[id].name) or "?"
      if grid then
        roomParts[#roomParts + 1] = id .. "=" .. (rooms[id].x - minX) .. "," .. (rooms[id].y - minY) .. "," .. label
      else
        roomParts[#roomParts + 1] = id .. "=" .. label
      end
      for d, to in pairs(rooms[id].exits or {}) do
        if rooms[to] and visible[to] then
          local ekey = id < to and (id .. "|" .. to) or (to .. "|" .. id)
          if not edgeSeen[ekey] then
            edgeSeen[ekey] = true
            if grid then
              edgeParts[#edgeParts + 1] = id .. "-" .. to
            else
              edgeParts[#edgeParts + 1] = id .. ">" .. clean(d) .. ">" .. to
            end
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
