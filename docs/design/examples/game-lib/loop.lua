-- lib/loop.lua — the delegate tool loop.
--
-- Drives backends.generate rounds while the delegate keeps calling tools,
-- appending paired tool_use/tool_result messages to sub.messages. The exec
-- callback (name, args) -> string answers each call; loop.run knows nothing
-- about which tools exist.
--
-- Default cap is 16, not 8: a delegate with set_todo spends rounds planning
-- (set list → work → mark done → work…) on top of its real tool calls.
-- maxRounds overrides per call. If the cap is hit with tool calls still
-- pending, loop.run THROWS — a wedged delegate fails the turn loudly (the
-- user sees which tools it was stuck on; a swipe retries) instead of
-- silently dropping the model's pending work.

local M = {}

function M.run(sub, res, exec, maxRounds)
  local rounds = 0
  local cap = maxRounds or 16
  while res.toolCalls and #res.toolCalls > 0 and rounds < cap do
    rounds = rounds + 1
    local content = {}
    for _, call in ipairs(res.toolCalls) do
      content[#content + 1] = { type = "tool_use", id = call.id, name = call.name, input = call.arguments }
      content[#content + 1] = { type = "tool_result", toolUseId = call.id, name = call.name, content = exec(call.name, call.arguments) }
    end
    sub.messages[#sub.messages + 1] = { role = "assistant", content = content }
    res = backends.generate(sub):await()
  end
  if res.toolCalls and #res.toolCalls > 0 then
    local names = {}
    for _, call in ipairs(res.toolCalls) do names[#names + 1] = call.name end
    error("tool loop exceeded " .. cap .. " rounds and the delegate is still calling tools ("
      .. table.concat(names, ", ") .. ") — raise maxRounds or fix whatever keeps it looping", 2)
  end
  return res
end

return M
