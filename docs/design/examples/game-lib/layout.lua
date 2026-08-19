-- lib/layout.lua — the floor LAYOUT generator: the model never decides
-- topology, Lua does.
--
-- NOT deterministic — math.random drives growth and shuffles, and equal
-- candidates fall to pairs() hash order, so nothing here is reproducible.
-- What is guaranteed is structural: Lua grows a connected blob of cells on
-- an integer grid (passages only between orthogonal neighbors → the map is
-- planar BY CONSTRUCTION, no planarity check anywhere), partitions it into
-- contiguous labeled SECTIONS via balanced multi-source BFS, builds a
-- spanning tree of passages plus a knob-count of loop edges, and picks the
-- entrance (a quiet border cell) and the stairs (the BFS-farthest room).
--
-- Knobs (all optional):
--   rooms    — cell count (default 8)
--   sections — labeled subgraph count (default 2, max 4)
--   loops    — extra non-tree passages (default 1)
--   sprawl   — 0..1 growth bias: 0 snakes corridors, 1 clumps blobs
--              (default 0.5); per-floor randomness here is the anti-monotony
--   terminal — no stairs (the bottom floor; the relic is the way out)
--
-- Output (ids are r1..rN in BFS order from the entrance, so r1 = entrance):
--   {
--     order      = { "r1", "r2", ... },
--     rooms      = { r1 = { x, y, section = "A", exits = { north = "r3", ... } } },
--                  -- exits are compass-labeled from edge geometry and SYMMETRIC
--     edges      = { { a = "r1", b = "r3" }, ... },  -- undirected, deduped
--     entrance   = "r1",
--     stairsDown = "r7" | nil,                      -- nil on terminal floors;
--                  -- the stairs room also gets exits.down = "down" (the serve
--                  -- path's descent trigger)
--     sections   = { { id = "A", rooms = { "r1", ... } }, ... },
--     deadEnds   = { "r5", ... },                   -- degree-1 rooms, sorted
--   }
--
-- M.skeleton(lay) renders the layout as the text block the planning sub-gen
-- sees: a section-letter grid plus per-section room lists, dead ends, and
-- the stairs — the model authors AGAINST this shape, never past it.

local M = {}

local DIRS = {
  { dx = 0, dy = -1, dir = "north" },
  { dx = 1, dy = 0, dir = "east" },
  { dx = 0, dy = 1, dir = "south" },
  { dx = -1, dy = 0, dir = "west" },
}
local OPP = { north = "south", south = "north", east = "west", west = "east" }
local LETTERS = "ABCD"

local function shuffle(t)
  for i = #t, 2, -1 do
    local j = math.random(i)
    t[i], t[j] = t[j], t[i]
  end
  return t
end

local function key(x, y) return x .. "," .. y end

-- Claim one free orthogonal neighbor of some cell; prefer neighbors inside
-- the soft radius so the blob stays map-shaped instead of hiking into a
-- corner. preferNewest = corridor bias (try the newest cell first).
local function growOne(cells, occupied, radius, preferNewest)
  local parents = {}
  for _, c in ipairs(cells) do parents[#parents + 1] = c end
  shuffle(parents)
  if preferNewest then
    local newest = cells[#cells]
    local ordered = { newest }
    for _, c in ipairs(parents) do
      if c ~= newest then ordered[#ordered + 1] = c end
    end
    parents = ordered
  end
  for _, p in ipairs(parents) do
    local cand = {}
    for _, d in ipairs(DIRS) do
      local nx, ny = p.x + d.dx, p.y + d.dy
      if not occupied[key(nx, ny)] then
        cand[#cand + 1] = { x = nx, y = ny, inside = math.max(math.abs(nx), math.abs(ny)) <= radius }
      end
    end
    shuffle(cand)
    local pick = nil
    for _, c in ipairs(cand) do
      if c.inside then pick = c break end
    end
    if not pick and #cand > 0 then pick = cand[1] end
    if pick then
      local cell = { x = pick.x, y = pick.y }
      occupied[key(cell.x, cell.y)] = true
      cells[#cells + 1] = cell
      return cell
    end
  end
  return nil -- fully boxed in (cannot happen on an open grid, but stay honest)
end

-- Multi-hop BFS distances; `adjacent(node)` returns neighbor nodes.
local function bfs(start, adjacent)
  local dist = { [start] = 0 }
  local queue = { start }
  local qi = 1
  while qi <= #queue do
    local cur = queue[qi]
    qi = qi + 1
    for _, nxt in ipairs(adjacent(cur)) do
      if dist[nxt] == nil then
        dist[nxt] = dist[cur] + 1
        queue[#queue + 1] = nxt
      end
    end
  end
  return dist
end

function M.generate(opts)
  opts = opts or {}
  local n = math.max(4, math.min(24, math.floor(tonumber(opts.rooms) or 8)))
  local k = math.max(1, math.min(4, math.floor(tonumber(opts.sections) or 2)))
  local loops = math.max(0, math.min(6, math.floor(tonumber(opts.loops) or 1)))
  local sprawl = math.min(1, math.max(0, tonumber(opts.sprawl) or 0.5))
  local terminal = opts.terminal == true
  if n < k * 2 then k = math.max(1, math.floor(n / 2)) end

  -- 1. Grow the blob.
  local radius = 2 + math.ceil(n / 3)
  local cells = { { x = 0, y = 0 } }
  local occupied = { ["0,0"] = true }
  while #cells < n do
    local preferNewest = math.random() >= sprawl
    if not growOne(cells, occupied, radius, preferNewest) then break end
  end
  n = #cells

  local byKey = {}
  for i, c in ipairs(cells) do byKey[key(c.x, c.y)] = i end
  local function cellAdj(cell)
    local out = {}
    for _, d in ipairs(DIRS) do
      local j = byKey[key(cell.x + d.dx, cell.y + d.dy)]
      if j then out[#out + 1] = j end
    end
    return out
  end

  -- 2. Entrance: prefer a degree-1 border cell (a quiet corner); a ring-shaped
  -- blob has none, so the fallback really is ANY cell. Ids r1..rN follow BFS
  -- order from it, so r1 = entrance.
  local anyCell, quiet = {}, {}
  for i, c in ipairs(cells) do
    anyCell[#anyCell + 1] = i
    if #cellAdj(c) == 1 then quiet[#quiet + 1] = i end
  end
  local entranceIdx = quiet[#quiet] or anyCell[math.random(#anyCell)]

  local idOf, cellOf, order = {}, {}, {}
  do
    local dist = bfs(entranceIdx, function(i) return cellAdj(cells[i]) end)
    local sorted = {}
    for i in pairs(dist) do sorted[#sorted + 1] = i end
    table.sort(sorted, function(a, b)
      if dist[a] ~= dist[b] then return dist[a] < dist[b] end
      local ca, cb = cells[a], cells[b]
      if ca.x ~= cb.x then return ca.x < cb.x end
      return ca.y < cb.y
    end)
    for rank, i in ipairs(sorted) do
      local id = "r" .. rank
      idOf[i] = id
      cellOf[id] = cells[i]
      order[#order + 1] = id
    end
  end

  -- 3. Sections: farthest-first seeds, then balanced multi-source BFS. A
  -- section only ever claims cells adjacent to its own claim set, so every
  -- section is contiguous by construction.
  local sectionOf = {}
  local sections = {}
  local seeds = { entranceIdx }
  local isSeed = { [entranceIdx] = true }
  while #seeds < k do
    local best, bestD = nil, -1
    for _, i in pairs(byKey) do
      if not isSeed[i] then
        local nearest = math.huge
        for _, s in ipairs(seeds) do
          local d = math.abs(cells[i].x - cells[s].x) + math.abs(cells[i].y - cells[s].y)
          if d < nearest then nearest = d end
        end
        if nearest > bestD then best, bestD = i, nearest end
      end
    end
    -- No unclaimed cell left (only possible if a caller bypasses the n >= k*2
    -- clamp above): stop rather than seed a duplicate.
    if best == nil then break end
    seeds[#seeds + 1] = best
    isSeed[best] = true
  end
  for si = 1, k do sections[si] = { id = LETTERS:sub(si, si), rooms = {} } end
  local cap = math.ceil(n / k)
  local queues = {}
  for si, s in ipairs(seeds) do
    local id = idOf[s]
    sectionOf[id] = si
    sections[si].rooms[#sections[si].rooms + 1] = id
    queues[si] = { s }
  end
  local progress = true
  while progress do
    progress = false
    for si = 1, k do
      if #sections[si].rooms < cap and queues[si] and #queues[si] > 0 then
        local front = table.remove(queues[si], 1)
        for _, j in ipairs(cellAdj(cells[front])) do
          local id = idOf[j]
          if sectionOf[id] == nil and #sections[si].rooms < cap then
            sectionOf[id] = si
            sections[si].rooms[#sections[si].rooms + 1] = id
            queues[si][#queues[si] + 1] = j
            progress = true
          end
        end
      end
    end
  end
  -- Leftovers (sections boxed out at cap): join any adjacent section.
  local leftovers = {}
  for _, id in ipairs(order) do
    if sectionOf[id] == nil then leftovers[#leftovers + 1] = id end
  end
  while #leftovers > 0 do
    local placed = false
    for li = #leftovers, 1, -1 do
      local id = leftovers[li]
      local c = cellOf[id]
      for _, d in ipairs(DIRS) do
        local j = byKey[key(c.x + d.dx, c.y + d.dy)]
        if j and sectionOf[idOf[j]] then
          local si = sectionOf[idOf[j]]
          sectionOf[id] = si
          sections[si].rooms[#sections[si].rooms + 1] = id
          table.remove(leftovers, li)
          placed = true
          break
        end
      end
    end
    if not placed then -- pathological isolate (cannot happen on a grown blob): park it in section 1
      local id = table.remove(leftovers)
      sectionOf[id] = 1
      sections[1].rooms[#sections[1].rooms + 1] = id
    end
  end
  -- Compact empty sections (defensive; seeds guarantee non-empty) and remap.
  do
    local dense, remap = {}, {}
    for si = 1, #sections do
      if #sections[si].rooms > 0 then
        remap[si] = #dense + 1
        dense[#dense + 1] = sections[si]
      end
    end
    sections = dense
    for id, si in pairs(sectionOf) do sectionOf[id] = remap[si] end
  end

  -- 4. Passages: a union-find spanning tree that keeps every section walkable
  -- INTERNALLY (intra-section edges first), then joins the sections with the
  -- minimum cross-section doorways; up to `loops` extra edges on top. Real
  -- dead ends fall out of the tree structure.
  local rooms, edges, edgeSeen = {}, {}, {}
  local function addEdge(a, b)
    local ka = a < b and (a .. "|" .. b) or (b .. "|" .. a)
    if edgeSeen[ka] then return end
    edgeSeen[ka] = true
    edges[#edges + 1] = { a = a, b = b }
  end
  for _, id in ipairs(order) do
    local c = cellOf[id]
    rooms[id] = { x = c.x, y = c.y, section = sections[sectionOf[id]].id, exits = {} }
  end
  local function link(a, b)
    local ca, cb = cellOf[a], cellOf[b]
    local dir
    if cb.x == ca.x + 1 then dir = "east"
    elseif cb.x == ca.x - 1 then dir = "west"
    elseif cb.y == ca.y + 1 then dir = "south"
    else dir = "north" end
    rooms[a].exits[dir] = b
    rooms[b].exits[OPP[dir]] = a
    addEdge(a, b)
  end
  do
    -- Enumerate each grid adjacency once (east + south).
    local intra, cross = {}, {}
    for _, id in ipairs(order) do
      local c = cellOf[id]
      for _, d in ipairs(DIRS) do
        if d.dir == "east" or d.dir == "south" then
          local j = byKey[key(c.x + d.dx, c.y + d.dy)]
          if j then
            local other = idOf[j]
            local list = sectionOf[id] == sectionOf[other] and intra or cross
            list[#list + 1] = { a = id, b = other }
          end
        end
      end
    end
    shuffle(intra)
    shuffle(cross)
    local parent = {}
    for _, id in ipairs(order) do parent[id] = id end
    local function find(x)
      while parent[x] ~= x do
        parent[x] = parent[parent[x]]
        x = parent[x]
      end
      return x
    end
    local function join(e)
      local ra, rb = find(e.a), find(e.b)
      if ra == rb then return false end
      parent[ra] = rb
      link(e.a, e.b)
      return true
    end
    for _, e in ipairs(intra) do join(e) end -- per-section spanning trees
    for _, e in ipairs(cross) do join(e) end -- then the doorways between them
    local extra = {}
    for _, e in ipairs(intra) do
      if find(e.a) ~= find(e.b) then extra[#extra + 1] = e end
    end
    for _, e in ipairs(cross) do
      if find(e.a) ~= find(e.b) then extra[#extra + 1] = e end
    end
    shuffle(extra)
    for i = 1, math.min(loops, #extra) do link(extra[i].a, extra[i].b) end
  end

  -- 5. Stairs: the BFS-farthest room from the entrance (the descent is earned).
  local stairsDown = nil
  if not terminal then
    local dist = bfs(order[1], function(id)
      local out = {}
      for _, to in pairs(rooms[id].exits) do out[#out + 1] = to end
      return out
    end)
    local far, farD = order[1], 0
    for id, d in pairs(dist) do
      if d > farD then far, farD = id, d end
    end
    stairsDown = far
    -- The stairs are an EXIT like any other: serve() descends on
    -- exits.down == "down" and the button row renders Descend from it. The
    -- map tag skips it (the target "down" is no room), so this is invisible
    -- to the graph — but without it the stairs are drawn and can never be
    -- taken (the card's own serve loop once shipped exactly that bug).
    rooms[far].exits.down = "down"
  end

  local deadEnds = {}
  for _, id in ipairs(order) do
    local deg = 0
    for _, to in pairs(rooms[id].exits) do
      if rooms[to] then deg = deg + 1 end -- the down pseudo-exit is no room
    end
    if deg == 1 then deadEnds[#deadEnds + 1] = id end
  end
  table.sort(deadEnds)

  return {
    order = order,
    rooms = rooms,
    edges = edges,
    entrance = order[1],
    stairsDown = stairsDown,
    sections = sections,
    deadEnds = deadEnds,
  }
end

-- The text block the planning sub-gen sees: section-letter grid, per-section
-- room lists, passages, dead ends, and the stairs position.
function M.skeleton(lay)
  local minX, minY, maxX, maxY = math.huge, math.huge, -math.huge, -math.huge
  local grid = {}
  for _, id in ipairs(lay.order) do
    local c = lay.rooms[id]
    grid[key(c.x, c.y)] = c.section
    if c.x < minX then minX = c.x end
    if c.x > maxX then maxX = c.x end
    if c.y < minY then minY = c.y end
    if c.y > maxY then maxY = c.y end
  end
  local rows = {}
  for y = minY, maxY do
    local row = {}
    for x = minX, maxX do
      row[#row + 1] = grid[key(x, y)] or "."
    end
    rows[#rows + 1] = table.concat(row, " ")
  end

  local marks = { [lay.entrance] = "entrance" }
  if lay.stairsDown then marks[lay.stairsDown] = "stairs down" end
  local lines = {
    "THE LAYOUT (already built, FIXED — do not add rooms or passages):",
    "",
    table.concat(rows, "\n"),
    "(the top of the map is north)",
    "",
    "Sections (one letter each — theme every one):",
  }
  for _, sec in ipairs(lay.sections) do
    -- Sorted so the prompt reads stable across runs of the same layout.
    local ids = {}
    for _, id in ipairs(sec.rooms) do ids[#ids + 1] = id end
    table.sort(ids)
    local parts = {}
    for _, id in ipairs(ids) do
      parts[#parts + 1] = id .. (marks[id] and (" (" .. marks[id] .. ")") or "")
    end
    lines[#lines + 1] = "  " .. sec.id .. ": " .. table.concat(parts, ", ")
  end
  local passages = {}
  for _, e in ipairs(lay.edges) do passages[#passages + 1] = e.a .. "-" .. e.b end
  table.sort(passages)
  lines[#lines + 1] = "Passages: " .. table.concat(passages, ", ")
  -- The entrance is safe by card rule (no encounters — see main.lua's
  -- prompt), so it must not sit in the "hide the best rewards" list even
  -- when it is a degree-1 room; say so explicitly instead.
  local rewardEnds = {}
  for _, id in ipairs(lay.deadEnds) do
    if id ~= lay.entrance then rewardEnds[#rewardEnds + 1] = id end
  end
  if #rewardEnds > 0 then
    lines[#lines + 1] = "Dead ends (hide the best rewards here): " .. table.concat(rewardEnds, ", ")
  end
  lines[#lines + 1] = "The entrance (" .. lay.entrance .. ") is safe: no encounters there."
  if not lay.stairsDown then
    lines[#lines + 1] = "NO stairs down on this floor — it is the bottom; the relic is what ends the delve here."
  end
  return table.concat(lines, "\n")
end

return M
