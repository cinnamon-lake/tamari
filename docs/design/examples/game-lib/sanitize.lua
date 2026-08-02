-- lib/sanitize.lua — decoded-JSON hygiene.
--
-- json.decode maps JSON null to a truthy js_null userdata, NOT Lua nil —
-- `if pack.encounter then` would take the wrong branch and `..` on it errors.
-- sanitize.data strips anything that isn't plain data before use.

local M = {}

function M.data(t)
  if type(t) ~= "table" then return t end
  for k, v in pairs(t) do
    local tv = type(v)
    if tv == "table" then M.data(v)
    elseif tv ~= "string" and tv ~= "number" and tv ~= "boolean" then t[k] = nil end
  end
  return t
end

return M
