-- lib/toolset.lua — compose modules and ad-hoc handlers into ONE toolset:
-- a single schemas array for sub.tools and a single exec for the tool loop.
--
-- Every lib module conforms to the same mini-contract (plain dot calls;
-- registry instances are closures, so the same call shape works for both):
--   mod.tools()            -> array of tool schemas (may be {})
--   mod.exec(name, args)   -> string | nil   (nil = "not mine", try the next)
--
-- Order is explicit and matters: the FIRST non-nil answer wins, and it ends
-- with "unknown tool: X". Replaces hand-rolled try-chains of if-statements.

local M = {}

function M.new()
  local schemas = {}
  local execs = {}
  local ts = {}

  local function addSchemas(list)
    if type(list) == "table" then
      for _, s in ipairs(list) do schemas[#schemas + 1] = s end
    end
  end

  --- Compose a module (anything with tools()/exec()).
  function ts:use(mod)
    addSchemas(mod.tools())
    execs[#execs + 1] = function(name, args) return mod.exec(name, args) end
    return ts
  end

  --- Add a raw tool schema with no handler (the model may call it; exec
  --- answers "unknown tool" — pair with :handle when it should do something).
  function ts:schema(s)
    addSchemas({ s })
    return ts
  end

  --- Add an ad-hoc tool: name, handler(args) -> string, optional schema.
  function ts:handle(name, fn, schema)
    if schema then addSchemas({ schema }) end
    execs[#execs + 1] = function(n, args)
      if n == name then return fn(args or {}) end
      return nil
    end
    return ts
  end

  --- The concatenated schemas, for sub.tools.
  function ts:schemas() return schemas end

  --- The composed exec, for loop.run.
  function ts:exec()
    return function(name, args)
      for _, e in ipairs(execs) do
        local r = e(name, args)
        if r ~= nil then return r end
      end
      return "unknown tool: " .. tostring(name)
    end
  end

  return ts
end

return M
