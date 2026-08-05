-- lib/registry.lua — ThingRegistry: declare "a registry of something" and get
-- a full tool (plus an optional query tool) that OWNS the Fact-lane
-- rules: validate on entry, clamp to budgets, closed lists, id assignment,
-- canonical tool result, swipe-stability through `state`.
--
-- The model invents; Lua files. The tool result is the canonical record —
-- what was ACTUALLY filed, clamps and dropped entries included — so the
-- model's continuing narration matches fact. Re-registering an existing id
-- returns the EXISTING record instead of overwriting: on regenerate, state
-- has rolled back and re-filing converges to the same record — swipe-stable
-- by construction.
--
-- Storage is a plain array of records at state[key] (branch-aware), each
-- record carrying its assigned `id`. Planning mode: pass store.get to file
-- into a draft table instead of `state`.
--
--   local enemies = registry.new({
--     tool = "register_enemy",
--     description = "Register an enemy design. Lua clamps stats to the power budget.",
--     key = "enemies",
--     id_from = "name",
--     query_tool = "get_enemy",        -- optional; omit for no query tool
--     cap = 8,                          -- optional max records
--     fields = {                        -- ARRAY: order is preserved in the schema
--       { name = "name", type = "string", required = true, max = 40 },
--       { name = "hp",   type = "integer", min = 1, max = 20, default = 6 },
--       -- min/max may be zero-arg functions (depth-scaled budgets):
--       { name = "atk",  type = "integer", min = 1, max = function() return 1 + depth() end, default = 2 },
--       { name = "tags", type = "array", closed = { "flying", "reflect_magic" } },
--       { name = "lines", type = "table" },   -- passthrough; shape it in on_register
--     },
--     on_register = function(rec) ... end,  -- optional: reshape/side effects
--   })
--
-- Instance surface (conforms to the lib module contract — plain dot calls):
--   enemies.tools() -> array            enemies.exec(name, args) -> string|nil
--   enemies.get(id) -> record|nil       enemies.all() -> array (LIVE — mutate
--     records in place and every consumer sees it; don't reorder or remove)
--   enemies.briefing() -> string        -- one line per record, for delegate
--     briefings ("" when empty); lib/events builds list_characters on it

local M = {}

local function slugify(s)
  local slug = tostring(s or ""):lower():gsub("[^%w]+", "-"):gsub("^-+", ""):gsub("-+$", ""):sub(1, 30)
  if slug == "" then slug = "thing" end
  return slug
end

local function bound(v)
  if type(v) == "function" then return v() end
  return v
end

--- Coerce args per the field specs. Returns rec, dropped, missing.
local function coerce(fields, args)
  local rec, dropped, missing = {}, {}, {}
  for _, f in ipairs(fields) do
    local v = args[f.name]
    if f.type == "integer" then
      local n = tonumber(v)
      if n == nil then n = f.default end
      if n ~= nil then
        n = math.floor(n)
        local lo, hi = bound(f.min), bound(f.max)
        if lo ~= nil and n < lo then n = lo end
        if hi ~= nil and n > hi then n = hi end
        rec[f.name] = n
      end
    elseif f.type == "array" then
      if type(v) == "table" then
        local arr = {}
        for _, item in ipairs(v) do
          local s = tostring(item)
          if f.closed then
            local ok = false
            for _, allowed in ipairs(f.closed) do
              if s == allowed then ok = true break end
            end
            if ok then arr[#arr + 1] = s else dropped[#dropped + 1] = s end
          else
            arr[#arr + 1] = s
          end
        end
        rec[f.name] = arr
      elseif not f.required then
        rec[f.name] = {}
      end
      -- a required array passed as a non-table stays nil → reported missing
    elseif f.type == "table" then
      if type(v) == "table" then rec[f.name] = v end
    else -- string
      local s = v ~= nil and tostring(v) or (f.default ~= nil and tostring(f.default) or "")
      if f.max then s = s:sub(1, f.max) end
      rec[f.name] = s
    end
    if f.required and (rec[f.name] == nil or rec[f.name] == "") then
      missing[#missing + 1] = f.name
    end
  end
  return rec, dropped, missing
end

local function fieldSchema(f)
  if f.type == "integer" then return { type = "integer" } end
  if f.type == "array" then return { type = "array", items = { type = "string" } } end
  if f.type == "table" then return { type = "object" } end
  return { type = "string" }
end

function M.new(def)
  local R = {}

  local function records()
    if def.store and def.store.get then return def.store.get() end
    if type(state) ~= "table" then state = {} end
    state[def.key] = state[def.key] or {}
    return state[def.key]
  end

  local function findRecord(idOrName)
    local needle = tostring(idOrName or ""):lower()
    for _, rec in ipairs(records()) do
      if rec.id == needle then return rec end
      if def.id_from and tostring(rec[def.id_from] or ""):lower() == needle then return rec end
    end
    return nil
  end

  local function register(args)
    local rec, dropped, missing = coerce(def.fields, args)
    if #missing > 0 then
      return "rejected: " .. table.concat(missing, ", ") .. " required"
    end
    local id = slugify(def.id_from and rec[def.id_from] or nil)
    -- Idempotent: an existing id returns the filed record, never an overwrite.
    local existing = findRecord(id)
    if existing then
      return json.encode({ already_registered = id, record = existing })
    end
    local list = records()
    if def.cap and #list >= def.cap then
      return "rejected: registry full (" .. def.cap .. " " .. tostring(def.key or "records") .. " max)"
    end
    rec.id = id
    if def.on_register then def.on_register(rec) end
    list[#list + 1] = rec
    local result = { registered = id, record = rec }
    if #dropped > 0 then result.dropped = dropped end
    return json.encode(result)
  end

  local function query(args)
    local rec = findRecord(args.id)
    if not rec then return "unknown " .. tostring(def.key or "record") .. ": " .. tostring(args.id) end
    return json.encode(rec)
  end

  function R.tools()
    local properties, required = {}, {}
    for _, f in ipairs(def.fields) do
      properties[f.name] = fieldSchema(f)
      if f.required then required[#required + 1] = f.name end
    end
    local out = { {
      type = "function",
      ["function"] = {
        name = def.tool,
        description = def.description or ("Register a " .. tostring(def.key or "record") .. "."),
        parameters = { type = "object", properties = properties, required = required },
      },
    } }
    if def.query_tool then
      out[#out + 1] = {
        type = "function",
        ["function"] = {
          name = def.query_tool,
          description = "Look up a filed " .. tostring(def.key or "record") .. " by id or name. The answer is canonical.",
          parameters = { type = "object", properties = { id = { type = "string" } }, required = { "id" } },
        },
      }
    end
    return out
  end

  function R.exec(name, args)
    if name == def.tool then return register(args or {}) end
    if def.query_tool and name == def.query_tool then return query(args or {}) end
    return nil
  end

  function R.get(id) return findRecord(id) end

  function R.all() return records() end

  --- One line per record, for delegate briefings ("" when empty).
  function R.briefing()
    local lines = {}
    for _, rec in ipairs(records()) do
      local label = def.id_from and tostring(rec[def.id_from] or "") or ""
      lines[#lines + 1] = "- " .. tostring(rec.id) .. (label ~= "" and (": " .. label) or "")
    end
    if #lines == 0 then return "" end
    return "\n" .. tostring(def.key or "REGISTRY") .. ":\n" .. table.concat(lines, "\n")
  end

  return R
end

return M
