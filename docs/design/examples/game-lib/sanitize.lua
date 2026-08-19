-- lib/sanitize.lua — decoded-JSON hygiene.
--
-- json.decode maps JSON null to a truthy js_null userdata, NOT Lua nil —
-- `if pack.encounter then` would take the wrong branch and `..` on it errors.
-- sanitize.data strips anything that isn't plain data before use.
--
-- ALIASING CONTRACT (mixed by necessity): an ARRAY argument is REBUILT — the
-- return value is a fresh table and the input is untouched (nil-ing a null
-- element in place would punch a sequence hole and break #/ipairs). A MAP
-- argument is MUTATED IN PLACE — the same table comes back, cleaned, and
-- every alias sees the cleaning. So always use the return value, and never
-- assume the input survived unchanged.

local M = {}

function M.data(t)
  if type(t) ~= "table" then return t end
  -- A JSON array may hold null (a truthy js_null sentinel); nil-ing an integer
  -- key would punch a sequence hole and break #/ipairs downstream. So arrays
  -- are rebuilt without holes; maps are cleaned in place.
  local isSeq = true
  for k, _ in pairs(t) do if type(k) ~= "number" then isSeq = false break end end
  if isSeq then
    local out = {}
    for _, v in ipairs(t) do
      local tv = type(v)
      if tv == "table" then out[#out + 1] = M.data(v)
      elseif tv == "string" or tv == "number" or tv == "boolean" then out[#out + 1] = v end
    end
    return out
  end
  for k, v in pairs(t) do
    local tv = type(v)
    if tv == "table" then t[k] = M.data(v)
    elseif tv ~= "string" and tv ~= "number" and tv ~= "boolean" then t[k] = nil end
  end
  return t
end

return M
