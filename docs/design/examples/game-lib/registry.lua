-- lib/registry.lua — ThingRegistry: declare "a registry of something" and get
-- a full tool (plus optional query/update/custom tools) that OWNS the
-- Fact-lane rules: validate on entry, clamp numbers to budgets, closed lists,
-- id assignment, the canonical tool result, swipe-stability through `state`.
--
-- The model invents; Lua files. The tool result is the canonical record —
-- what was ACTUALLY filed, numeric clamps and dropped entries included — so
-- the model's continuing narration matches fact. Text is filed verbatim:
-- truncating prose would fill the registry with cut-off natural language, so
-- string fields take any length. Re-registering an existing id returns the
-- EXISTING record instead of overwriting: on regenerate, state has rolled
-- back and re-filing converges to the same record — swipe-stable by
-- construction. The fallback slug "thing" is never a real id: id_from must
-- name a DECLARED field (checked at construction) and a missing routing
-- value rejects the file — otherwise every record would converge on one
-- slug and the registry would silently cap at a single record.
--
-- STORAGE, two shapes:
--   * Unpartitioned (default): a plain array of records at state[key]
--     (branch-aware), each record carrying its assigned `id`. Planning mode:
--     pass store.get to file into a draft table instead of `state`.
--   * Partitioned (partition_by declared): records live in PACKS — one store
--     blob per partition, shared by every partitioned registry using the same
--     packs_key (default state.packIds). state carries only the pointer
--     table: state[packs_key] maps each partition name to that partition's
--     pack blob id ({ f1 = "pack#7", craft = "pack#3", … }). The partition is
--     a property OF THE RECORD, read at file time (a monster's partition is
--     the floor it spawns on). Declare partition_by as a FIELD NAME
--     ("floor") whenever the routing field is a real record field: the
--     model-facing query/update tools then ask for it by its DOMAIN name
--     ("the floor the monster is on" — never the word "partition") and every
--     lookup lands in exactly one partition. A function-form partition_by
--     routes the same but leaves the field anonymous, so model-facing
--     lookups must scan all partitions — and an id filed in several
--     partitions is a loud rejection, never a silent guess.
--
-- WRITES (partitioned): a write updates nothing on disk immediately — it
-- queues a mutation record in state._regq (branch-aware) and every READ
-- resolves base blob + queue, so the in-memory view is live at once. The
-- card calls registry.flush() ONCE at the end of generate(): flush groups
-- the queue by partition, applies each group to its pack, does ONE new
-- store.putJson per touched pack, and updates state.packIds[pk] for the
-- flushed partitions only. A forgotten flush is a state-size issue, never a
-- correctness one — the queue rides state, so the next flush (even next
-- turn) compacts it. Swipe correctness falls out: a flush is a NEW put plus
-- a pointer move, so old branches keep their old blob.
--
-- MUTABLE FIELDS (set semantics): registry records are non-compacting
-- information — some fields legitimately EVOLVE (appearance, status).
-- Declare mutable = { "appearance", … } and the registry emits an update
-- tool that OVERWRITES the listed fields on the existing record (same
-- validation and clamps, id stable, latest value canon).
--
-- CUSTOM QUERIES: queries = { { name, args = {...}, run = fn } } adds a read
-- tool (schema built from args) AND a card-side method of the same name.
-- run(records, args) receives the full cross-partition record list.
--
--   local enemies = registry.new({
--     tool = "register_enemy",
--     description = "Register an enemy design. Lua clamps stats to the power budget.",
--     key = "enemies",
--     id_from = "name",
--     partition_by = "floor",               -- optional: packs; a FIELD NAME routes
--                                           --   and names the lookup argument
--     packs_key = "packIds",                -- optional; shared pointer table
--     mutable = { "hp" },                   -- optional: emits update_enemy
--     update_tool = "update_enemy",         -- optional; derived by default
--     query_tool = "get_enemy",             -- optional; omit for no query tool
--     cap = 8,                              -- optional max records (per partition when partitioned)
--     fields = {                            -- ARRAY: order is preserved in the schema
--       { name = "name", type = "string", required = true },
--       { name = "hp",   type = "integer", min = 1, max = 20, default = 6 },
--       -- min/max may be zero-arg functions (depth-scaled budgets):
--       { name = "atk",  type = "integer", min = 1, max = function() return 1 + depth() end, default = 2 },
--       { name = "tags", type = "array", closed = { "flying", "reflect_magic" } },
--       { name = "lines", type = "table" },   -- passthrough; shape it in on_register
--     },
--     queries = {                           -- optional custom read tools
--       { name = "recipes_with_item",
--         args = { { name = "item", type = "string", required = true } },
--         run = function(records, args) … return matching end },
--     },
--     on_register = function(rec) ... end,  -- optional: reshape/side effects
--   })
--
-- Instance surface (conforms to the lib module contract — plain dot calls):
--   R.tools() -> array              R.exec(name, args) -> string|nil
--   Unpartitioned:   R.list()  R.get(id)      R.create(fields)  R.update(id, fields)
--   Partitioned:     R.list(pk)  R.get(pk, id) R.create(fields) R.update(pk, id, fields)
--     (create derives the partition from the record via partition_by)
--   R.all() -> array  (cross-partition when partitioned) — LIVE records when
--     unpartitioned (mutate in place, every consumer sees it); RESOLVED
--     copies when partitioned — mutate those via R.update, not in place.
--   R.briefing(pk?) -> string       -- one line per record, for delegate
--     briefings ("" when empty); lib/events builds list_characters on it
--
-- Module level: registry.flush() — see WRITES above.

local sanitize = require("lib/sanitize")

local M = {}

-- Pack blob bodies are IMMUTABLE (a flush is a new put plus a pointer move),
-- so fetched bodies are memoized module-wide by pointer id — every
-- partitioned registry sharing a packs_key shares the cache, and one serve
-- turn's repeated floorPack() calls cost ONE store round-trip per pack
-- instead of four-plus. The DECODE still runs per call on purpose:
-- resolvePartition mutates records in place while applying the queue, and a
-- shared decoded table would let those mutations leak between resolves.
local packBodies = {} -- pid -> raw body string

local function slugify(s)
  local slug = tostring(s or ""):lower():gsub("[^%w]+", "-"):gsub("^-+", ""):gsub("-+$", "")
  if slug == "" then slug = "thing" end
  return slug
end

local function bound(v)
  if type(v) == "function" then return v() end
  return v
end

--- Coerce ONE field value per its spec. Returns value, dropped (array of
--- closed-list rejections; nil otherwise).
local function coerceOne(f, v)
  if f.type == "integer" then
    local n = tonumber(v)
    if n == nil then n = f.default end
    if n ~= nil then
      n = math.floor(n)
      local lo, hi = bound(f.min), bound(f.max)
      if lo ~= nil and n < lo then n = lo end
      if hi ~= nil and n > hi then n = hi end
      return n
    end
    return nil
  elseif f.type == "array" then
    if type(v) == "table" then
      local arr, dropped = {}, nil
      for _, item in ipairs(v) do
        local s = tostring(item)
        if f.closed then
          local ok = false
          for _, allowed in ipairs(f.closed) do
            if s == allowed then ok = true break end
          end
          if ok then arr[#arr + 1] = s else
            dropped = dropped or {}
            dropped[#dropped + 1] = s
          end
        else
          arr[#arr + 1] = s
        end
      end
      return arr, dropped
    end
    return nil -- a non-table array arg stays nil → missing (full coerce) or skipped (partial)
  elseif f.type == "table" then
    if type(v) == "table" then return v end
    return nil
  else -- string
    if v ~= nil then return tostring(v) end
    if f.default ~= nil then return tostring(f.default) end
    return ""
  end
end

--- Coerce args per the field specs (a full file). Returns rec, dropped, missing.
local function coerce(fields, args)
  local rec, dropped, missing = {}, {}, {}
  for _, f in ipairs(fields) do
    local v, d = coerceOne(f, args[f.name])
    if f.type == "array" and v == nil and not f.required then
      v = {}
    end
    rec[f.name] = v
    if d then for _, s in ipairs(d) do dropped[#dropped + 1] = s end end
    if f.required and (rec[f.name] == nil or rec[f.name] == "") then
      missing[#missing + 1] = f.name
    end
  end
  return rec, dropped, missing
end

--- Coerce only the listed mutable fields PRESENT in args (an update).
--- Returns partial, dropped.
local function coercePartial(fields, args, mutableSet)
  local partial, dropped = {}, {}
  for _, f in ipairs(fields) do
    if mutableSet[f.name] and args[f.name] ~= nil then
      local v, d = coerceOne(f, args[f.name])
      if v ~= nil then partial[f.name] = v end
      if d then for _, s in ipairs(d) do dropped[#dropped + 1] = s end end
    end
  end
  return partial, dropped
end

local function fieldSchema(f)
  if f.type == "integer" then return { type = "integer" } end
  if f.type == "array" then return { type = "array", items = { type = "string" } } end
  if f.type == "table" then return { type = "object" } end
  return { type = "string" }
end

local RESERVED_METHODS = {
  tools = true, exec = true, get = true, all = true, list = true,
  create = true, update = true, briefing = true, fieldNames = true,
}

function M.new(def)
  -- partition_by: a field NAME ("floor") or a function(rec). The string form
  -- is preferred — it names the routing field, so model-facing query/update
  -- tools can ask for it by its domain name ("the floor the monster is on").
  -- A bare function routes fine but leaves the routing field anonymous, and
  -- the model-facing lookups can only scan (see findAll/ambiguity).
  local partitionField = def.partition_field
  local partition_by = def.partition_by
  if type(partition_by) == "string" then
    partitionField = partition_by
    local f = partition_by
    partition_by = function(rec) return rec[f] end
  end
  local partitioned = partition_by ~= nil
  local packsKey = def.packs_key or "packIds"
  if partitioned and def.store then
    error("registry.new: store (draft mode) and partition_by don't combine — "
      .. "partitioned writes ARE the commit path; drop one", 2)
  end
  local known = {}
  for _, f in ipairs(def.fields or {}) do known[f.name] = true end
  -- The routing field must be a real field — the model can't name a floor the
  -- record doesn't carry.
  if partitionField and not known[partitionField] then
    error("registry.new: partition field '" .. tostring(partitionField) .. "' is not a declared field", 2)
  end
  local mutableSet = {}
  if def.mutable then
    for _, name in ipairs(def.mutable) do
      if not known[name] then
        error("registry.new: mutable field '" .. tostring(name) .. "' is not a declared field", 2)
      end
      mutableSet[name] = true
    end
  end
  -- id_from routes the record to its slug; an undeclared field would file
  -- every record under the same fallback slug, capping the registry at one.
  if def.id_from and not known[def.id_from] then
    error("registry.new: id_from '" .. tostring(def.id_from) .. "' is not a declared field", 2)
  end
  local updateTool = def.update_tool
  if not updateTool and def.mutable then
    updateTool = (def.tool or ""):gsub("^register_", "update_")
    if updateTool == def.tool or updateTool == "" then updateTool = "update_" .. tostring(def.key) end
  end
  local queries = def.queries or {}
  for _, q in ipairs(queries) do
    if RESERVED_METHODS[q.name] or q.name == def.tool or q.name == def.query_tool or q.name == updateTool then
      error("registry.new: query name '" .. tostring(q.name) .. "' collides with a built-in", 2)
    end
  end

  local R = {}
  -- Shape marker for consumers whose call conventions differ by partitioning
  -- (lib/events needs an UNPARTITIONED roster: it looks members up one-arg).
  R.partitioned = partitioned

  -- ---------- storage ----------

  -- Unpartitioned records (or the draft table in planning mode).
  local function records()
    if def.store and def.store.get then return def.store.get() end
    if type(state) ~= "table" then state = {} end
    state[def.key] = state[def.key] or {}
    return state[def.key]
  end

  local function mutationQueue()
    if type(state) ~= "table" then state = {} end
    state._regq = state._regq or {}
    return state._regq
  end

  local function loadPackBlob(pks, pk)
    local pid = type(state) == "table" and state[pks] and state[pks][pk] or nil
    if not pid then return {} end
    local body = packBodies[pid]
    if not body then
      body = store.getJson(pid):await()
      if not body then
        error("registry: pack blob missing for partition " .. tostring(pk) .. " (" .. tostring(pid)
          .. ") — blobs are script-written, this is a bug", 3)
      end
      packBodies[pid] = body
    end
    return sanitize.data(json.decode(body))
  end

  --- The live view of one partition for THIS registry: base blob records
  --- plus this registry's queued mutations, in order. Returns array, byId.
  local function resolvePartition(pk)
    local base = loadPackBlob(packsKey, pk)
    local recs, byId = {}, {}
    for _, rec in ipairs(base[def.key] or {}) do
      recs[#recs + 1] = rec
      byId[rec.id] = rec
    end
    for _, m in ipairs(mutationQueue()) do
      if m.pks == packsKey and m.pk == pk and m.reg == def.key then
        if m.op == "set" then
          if byId[m.id] then
            local old = byId[m.id]
            for k in pairs(old) do old[k] = nil end
            for k, v in pairs(m.rec) do old[k] = v end
          else
            recs[#recs + 1] = m.rec
            byId[m.id] = m.rec
          end
        else -- update
          local old = byId[m.id]
          if old then for k, v in pairs(m.fields) do old[k] = v end end
        end
      end
    end
    return recs, byId
  end

  --- Every partition key this registry has records in (pointer table +
  --- queue), sorted for determinism.
  local function partitionKeys()
    local seen, out = {}, {}
    if type(state) == "table" and type(state[packsKey]) == "table" then
      for pk in pairs(state[packsKey]) do
        if not seen[pk] then seen[pk] = true out[#out + 1] = pk end
      end
    end
    for _, m in ipairs(mutationQueue()) do
      if m.pks == packsKey and m.reg == def.key and not seen[m.pk] then
        seen[m.pk] = true
        out[#out + 1] = m.pk
      end
    end
    table.sort(out)
    return out
  end

  local function allRecords()
    if not partitioned then return records() end
    local out = {}
    for _, pk in ipairs(partitionKeys()) do
      for _, rec in ipairs(resolvePartition(pk)) do out[#out + 1] = rec end
    end
    return out
  end

  --- Find by id or id_from value. Partitioned: scans all partitions and also
  --- returns the partition the record lives in (nil when not found).
  local function findRecord(idOrName)
    local needle = tostring(idOrName or ""):lower()
    if not partitioned then
      for _, rec in ipairs(records()) do
        if rec.id == needle then return rec end
        if def.id_from and tostring(rec[def.id_from] or ""):lower() == needle then return rec end
      end
      return nil
    end
    for _, pk in ipairs(partitionKeys()) do
      local recs = resolvePartition(pk)
      for _, rec in ipairs(recs) do
        if rec.id == needle then return rec, pk end
        if def.id_from and tostring(rec[def.id_from] or ""):lower() == needle then return rec, pk end
      end
    end
    return nil
  end

  --- Find within ONE named partition (ids are stored slugified; normalize the
  --- needle so this exact lookup agrees with the case-insensitive scan).
  local function findInPartition(pk, idOrName)
    local recs, byId = resolvePartition(tostring(pk))
    local rec = byId[slugify(idOrName)]
    if rec then return rec end
    local needle = tostring(idOrName or ""):lower()
    for _, r in ipairs(recs) do
      if def.id_from and tostring(r[def.id_from] or ""):lower() == needle then return r end
    end
    return nil
  end

  --- The partition a model-facing call named, or nil plus a rejection string.
  --- The routing field is REQUIRED on partitioned lookups: "the floor the
  --- monster is on" is a domain fact the model knows, not hidden machinery.
  local function namedPartition(args)
    local pk = args and args[partitionField]
    if pk == nil or pk == "" then
      return nil, "rejected: " .. partitionField .. " is required"
    end
    return tostring(pk)
  end

  --- ALL (rec, pk) matches across partitions — the fallback for a partitioned
  --- registry whose routing field is ANONYMOUS (function-form partition_by):
  --- the model-facing execs can't ask for the partition by name, so an id
  --- living in several partitions is an ambiguity they must REPORT — not a
  --- coin flip in sorted-key order (findRecord returns the f1 goblin even
  --- when the player is on f2).
  local function findAll(idOrName)
    local needle = tostring(idOrName or ""):lower()
    local out = {}
    local function match(rec, pk)
      if rec.id == needle then return true end
      return def.id_from and tostring(rec[def.id_from] or ""):lower() == needle
    end
    if not partitioned then
      for _, rec in ipairs(records()) do
        if match(rec) then out[#out + 1] = { rec = rec } end
      end
      return out
    end
    for _, pk in ipairs(partitionKeys()) do
      for _, rec in ipairs(resolvePartition(pk)) do
        if match(rec, pk) then out[#out + 1] = { rec = rec, pk = pk } end
      end
    end
    return out
  end

  --- Rejection text when a model-facing lookup hits an id in >1 partition and
  --- no routing field is nameable (function-form partition_by). String-form
  --- partition_by asks for the field up front, so this never fires there.
  local function ambiguity(id, matches)
    local pks = {}
    for _, m in ipairs(matches) do pks[#pks + 1] = m.pk end
    return "rejected: '" .. id .. "' exists in multiple partitions (" .. table.concat(pks, ", ")
      .. ") and this lookup can't name one — disambiguate card-side with the partition key"
  end

  -- ---------- filing ----------

  --- The shared write path. Returns id, status, record, dropped where status
  --- is "filed" | "already"; or nil, reason on rejection.
  local function file(args)
    local rec, dropped, missing = coerce(def.fields, args)
    if #missing > 0 then
      return nil, "rejected: " .. table.concat(missing, ", ") .. " required"
    end
    -- A missing routing value would slugify to the "thing" fallback, filing
    -- every such record under one slug — reject it like a nil partition.
    if def.id_from and (rec[def.id_from] == nil or rec[def.id_from] == "") then
      return nil, "rejected: " .. def.id_from .. " is required"
    end
    local id = slugify(def.id_from and rec[def.id_from] or nil)
    if partitioned then
      local pk = partition_by(rec)
      if pk == nil then
        error("registry: partition_by returned nil for '" .. id .. "' — the record lacks its routing field", 3)
      end
      pk = tostring(pk)
      local recs = resolvePartition(pk)
      for _, existing in ipairs(recs) do
        if existing.id == id
          or (def.id_from and tostring(existing[def.id_from] or ""):lower() == id) then
          return id, "already", existing
        end
      end
      if def.cap and #recs >= def.cap then
        return nil, "rejected: registry full (" .. def.cap .. " " .. tostring(def.key or "records")
          .. " max in " .. pk .. ")"
      end
      rec.id = id
      if def.on_register then def.on_register(rec) end
      rec.id = id -- reassert the assigned slug: the hook may have clobbered it
      local q = mutationQueue()
      q[#q + 1] = { pks = packsKey, pk = pk, reg = def.key, op = "set", id = id, rec = rec }
      return id, "filed", rec, dropped
    end
    -- Unpartitioned: idempotent dup-check, cap, append to the live array.
    local existing = findRecord(id)
    if existing then return id, "already", existing end
    local list = records()
    if def.cap and #list >= def.cap then
      return nil, "rejected: registry full (" .. def.cap .. " " .. tostring(def.key or "records") .. " max)"
    end
    rec.id = id
    if def.on_register then def.on_register(rec) end
    rec.id = id -- reassert the assigned slug: the hook may have clobbered it
    list[#list + 1] = rec
    return id, "filed", rec, dropped
  end

  local function register(args)
    local id, status, rec, dropped = file(args)
    if not id then return status end -- status carries the rejection reason
    if status == "already" then
      return json.encode({ already_registered = id, record = rec })
    end
    local result = { registered = id, record = rec }
    if dropped and #dropped > 0 then result.dropped = dropped end
    return json.encode(result)
  end

  local function query(args)
    local id = args and args.id
    if partitioned and partitionField then
      -- The routing field is a domain fact ("the floor the monster is on") —
      -- the model names it, the lookup stays inside that partition.
      local pk, err = namedPartition(args)
      if not pk then return err end
      local rec = findInPartition(pk, id)
      if not rec then return "unknown " .. tostring(def.key or "record") .. ": " .. tostring(id) .. " in " .. pk end
      return json.encode(rec)
    end
    if partitioned then
      -- function-form partition_by: no field to ask for — scan, but loudly
      local matches = findAll(id)
      if #matches > 1 then return ambiguity(tostring(id), matches) end
      if #matches == 0 then return "unknown " .. tostring(def.key or "record") .. ": " .. tostring(id) end
      return json.encode(matches[1].rec)
    end
    local rec = findRecord(id)
    if not rec then return "unknown " .. tostring(def.key or "record") .. ": " .. tostring(id) end
    return json.encode(rec)
  end

  --- The shared update path. Partitioned takes pk explicitly (nil pk = scan).
  --- Returns true, dropped | nil, reason.
  local function applyUpdate(pk, id, fields)
    local partial, dropped = coercePartial(def.fields, fields, mutableSet)
    if not next(partial) then
      if not def.mutable then
        return nil, "rejected: no mutable fields declared"
      end
      return nil, "rejected: nothing to update (mutable: " .. table.concat(def.mutable, ", ") .. ")"
    end
    if partitioned then
      local rec, foundPk
      if pk ~= nil then
        foundPk = tostring(pk)
        rec = findInPartition(foundPk, id)
      else
        rec, foundPk = findRecord(id)
      end
      if not rec then return nil, "unknown " .. tostring(def.key or "record") .. ": " .. tostring(id) end
      local q = mutationQueue()
      q[#q + 1] = { pks = packsKey, pk = foundPk, reg = def.key, op = "update", id = rec.id, fields = partial }
      return true, dropped
    end
    local rec = findRecord(id)
    if not rec then return nil, "unknown " .. tostring(def.key or "record") .. ": " .. tostring(id) end
    for k, v in pairs(partial) do rec[k] = v end
    return true, dropped
  end

  local function updateExec(args)
    local id = tostring(args and args.id or "")
    if id == "" then return "rejected: id required" end
    local pk = nil
    if partitioned and partitionField then
      -- The routing field is part of the call ("the floor the monster is
      -- on"), so the update lands in exactly one partition.
      local err
      pk, err = namedPartition(args)
      if not pk then return err end
    elseif partitioned then
      -- function-form partition_by: the model can't name a partition — an id
      -- filed on several floors would silently update whichever sorts first.
      local matches = findAll(id)
      if #matches > 1 then return ambiguity(id, matches) end
    end
    local ok, droppedOrErr = applyUpdate(pk, id, args)
    if not ok then return droppedOrErr end
    local rec = pk and findInPartition(pk, id) or findRecord(id)
    local result = { updated = rec.id, record = rec }
    if pk then result[partitionField] = pk end
    if droppedOrErr and #droppedOrErr > 0 then result.dropped = droppedOrErr end
    return json.encode(result)
  end

  --- The declared field names (validation targets, e.g. lib/events' RESERVED
  --- guard when a roster is INJECTED rather than declared through it).
  function R.fieldNames()
    local out = {}
    for _, f in ipairs(def.fields or {}) do out[#out + 1] = f.name end
    return out
  end

  -- ---------- the tool contract ----------

  -- The routing field rides model-facing lookups under its DOMAIN name — the
  -- model says "the floor the monster is on", never the word "partition".
  local function partitionProp()
    if not (partitioned and partitionField) then return nil end
    return { type = "string",
      description = "The " .. partitionField .. " the " .. tostring(def.key or "record") .. " is in — required; records are filed per " .. partitionField }
  end

  function R.tools()
    local out = {}
    local properties, required = {}, {}
    for _, f in ipairs(def.fields) do
      properties[f.name] = fieldSchema(f)
      if f.required then required[#required + 1] = f.name end
    end
    out[#out + 1] = {
      type = "function",
      ["function"] = {
        name = def.tool,
        description = def.description or ("Register a " .. tostring(def.key or "record") .. "."),
        parameters = { type = "object", properties = properties, required = required },
      },
    }
    if def.query_tool then
      local qprops = { id = { type = "string" } }
      local qreq = { "id" }
      if partitionProp() then
        qprops[partitionField] = partitionProp()
        qreq[#qreq + 1] = partitionField
      end
      out[#out + 1] = {
        type = "function",
        ["function"] = {
          name = def.query_tool,
          description = "Look up a filed " .. tostring(def.key or "record") .. " by id or name. The answer is canonical.",
          parameters = { type = "object", properties = qprops, required = qreq },
        },
      }
    end
    if updateTool then
      local uprops = { id = { type = "string" } }
      local ureq = { "id" }
      if partitionProp() then
        uprops[partitionField] = partitionProp()
        ureq[#ureq + 1] = partitionField
      end
      for _, f in ipairs(def.fields) do
        if mutableSet[f.name] then uprops[f.name] = fieldSchema(f) end
      end
      out[#out + 1] = {
        type = "function",
        ["function"] = {
          name = updateTool,
          description = "Update an existing " .. tostring(def.key or "record")
            .. ": OVERWRITES the given fields (latest value is canon). Only these fields may change: "
            .. table.concat(def.mutable, ", ") .. ".",
          parameters = { type = "object", properties = uprops, required = ureq },
        },
      }
    end
    for _, q in ipairs(queries) do
      local qprops, qreq = {}, {}
      for _, a in ipairs(q.args or {}) do
        qprops[a.name] = fieldSchema(a)
        if a.required then qreq[#qreq + 1] = a.name end
      end
      out[#out + 1] = {
        type = "function",
        ["function"] = {
          name = q.name,
          description = q.description or ("Query " .. tostring(def.key or "records") .. "."),
          parameters = { type = "object", properties = qprops, required = qreq },
        },
      }
    end
    return out
  end

  function R.exec(name, args)
    if name == def.tool then return register(args or {}) end
    if def.query_tool and name == def.query_tool then return query(args or {}) end
    if updateTool and name == updateTool then return updateExec(args or {}) end
    for _, q in ipairs(queries) do
      if name == q.name then
        local res = q.run(allRecords(), args or {})
        if type(res) == "string" then return res end
        return json.encode(res)
      end
    end
    return nil
  end

  -- ---------- the card-side surface ----------

  --- Look up one record. Partitioned: R.get(pk, id). Unpartitioned: R.get(id).
  function R.get(a, b)
    if not partitioned then return findRecord(a) end
    return findInPartition(a, b)
  end

  --- The records of one partition (or the whole registry, unpartitioned).
  function R.list(pk)
    if not partitioned then return records() end
    -- nil used to read as the literal "nil" partition and return {} — a
    -- forgotten argument looked like an empty floor. Loud instead; R.all()
    -- is the cross-partition read.
    if pk == nil then
      error("registry: list() on a partitioned registry needs a partition key (use R.all() for cross-partition)", 2)
    end
    return (resolvePartition(tostring(pk)))
  end

  --- All records — cross-partition when partitioned.
  function R.all() return allRecords() end

  --- File a record from the card. Returns id on success (id, "already_registered"
  --- when the id converges to an existing record), or nil, reason.
  function R.create(fields)
    local id, status = file(fields or {})
    if not id then return nil, status end
    if status == "already" then return id, "already_registered" end
    return id
  end

  --- Overwrite mutable fields on an existing record.
  --- Partitioned: R.update(pk, id, fields). Unpartitioned: R.update(id, fields).
  function R.update(a, b, c)
    if not partitioned then return applyUpdate(nil, a, b or {}) end
    return applyUpdate(a, b, c or {})
  end

  --- One line per record, for delegate briefings ("" when empty).
  --- Partitioned: pass a pk to brief one partition, omit for all.
  function R.briefing(pk)
    local recs
    if not partitioned then
      recs = records()
    elseif pk ~= nil then
      recs = resolvePartition(tostring(pk))
    else
      recs = allRecords()
    end
    local lines = {}
    for _, rec in ipairs(recs) do
      local label = def.id_from and tostring(rec[def.id_from] or "") or ""
      lines[#lines + 1] = "- " .. tostring(rec.id) .. (label ~= "" and (": " .. label) or "")
    end
    if #lines == 0 then return "" end
    return "\n" .. tostring(def.key or "REGISTRY") .. ":\n" .. table.concat(lines, "\n")
  end

  -- Custom queries double as card-side methods (raw return, not encoded).
  for _, q in ipairs(queries) do
    R[q.name] = function(args) return q.run(allRecords(), args or {}) end
  end

  return R
end

--- Flush every queued registry mutation into the packs: one new store.put
--- per touched partition, then the pointer table updates. Call ONCE at the
--- end of generate() — reads resolve base + queue, so timing never affects
--- correctness, only state size. No-op when nothing is queued.
function M.flush()
  if type(state) ~= "table" then return end
  local q = state._regq
  if type(q) ~= "table" or #q == 0 then return end
  local groups, order = {}, {}
  for _, m in ipairs(q) do
    local gk = tostring(m.pks) .. "\31" .. tostring(m.pk)
    if not groups[gk] then
      groups[gk] = { pks = m.pks, pk = m.pk, mutations = {} }
      order[#order + 1] = gk
    end
    table.insert(groups[gk].mutations, m)
  end
  for _, gk in ipairs(order) do
    local g = groups[gk]
    state[g.pks] = state[g.pks] or {}
    local pid = state[g.pks][g.pk]
    local blob = {}
    if pid then
      local body = packBodies[pid] or store.getJson(pid):await()
      if not body then
        error("registry.flush: pack blob missing for partition " .. tostring(g.pk)
          .. " (" .. tostring(pid) .. ") — blobs are script-written, this is a bug", 2)
      end
      blob = sanitize.data(json.decode(body))
    end
    for _, m in ipairs(g.mutations) do
      local section = blob[m.reg]
      if type(section) ~= "table" then
        section = {}
        blob[m.reg] = section
      end
      if m.op == "set" then
        local found = false
        for i, rec in ipairs(section) do
          if rec.id == m.id then section[i] = m.rec found = true break end
        end
        if not found then section[#section + 1] = m.rec end
      else -- update
        local found = false
        for _, rec in ipairs(section) do
          if rec.id == m.id then
            for k, v in pairs(m.fields) do rec[k] = v end
            found = true
            break
          end
        end
        if not found then
          error("registry.flush: update for unknown id '" .. tostring(m.id)
            .. "' in partition " .. tostring(g.pk), 2)
        end
      end
    end
    local newPid = store.putJson("pack", blob):await()
    -- Seed the memo with the body just written: the next read of this pack
    -- would otherwise pay a store round-trip for bytes already in hand.
    packBodies[newPid] = json.encode(blob)
    state[g.pks][g.pk] = newPid
  end
  state._regq = {}
end

return M
