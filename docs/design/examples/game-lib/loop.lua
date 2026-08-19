-- lib/loop.lua — the delegate tool loop.
--
-- Drives backends.generate rounds while the delegate keeps calling tools,
-- appending paired tool_use/tool_result messages to sub.messages. The exec
-- callback (name, args) -> string answers each call; loop.run knows nothing
-- about which tools exist.
--
-- Each round's assistant message is REBUILT as what the model actually
-- produced: its thinking block first (with the signature when the delegate
-- reports one), then any narration text, then the tool calls. Sending the
-- thinking back is not cosmetic — Claude with extended thinking REJECTS a
-- tool_use turn whose thinking block is missing (HTTP 400), and everywhere
-- else the replayed prefix matches the model's own output, so provider
-- prefix caches keep hitting.
--
-- Default cap is 16, not 8: a delegate with set_todo spends rounds planning
-- (set list → work → mark done → work…) on top of its real tool calls.
-- maxRounds overrides per call. If the cap is hit with tool calls still
-- pending, loop.run THROWS — a wedged delegate fails the turn loudly (the
-- user sees which tools it was stuck on; a swipe retries) instead of
-- silently dropping the model's pending work.
--
-- opts (both for "the work may already be done" loops, e.g. an event
-- finalizer whose close_event already landed):
--   done  — zero-arg predicate checked before each round; when true the
--           loop stops early and returns the last res (pending toolCalls
--           cleared). Once the goal state is reached, further rounds are
--           pure downside.
--   soft  — hitting the cap RETURNS the last res instead of throwing. The
--           caller owns the fallback (the tool results already executed
--           are real either way).

local M = {}

function M.run(sub, res, exec, maxRounds, opts)
  opts = opts or {}
  local rounds = 0
  local cap = maxRounds or 16
  while res.toolCalls and #res.toolCalls > 0 and rounds < cap
    and not (opts.done and opts.done()) do
    rounds = rounds + 1
    local content = {}
    if type(res.reasoning) == "string" and res.reasoning ~= "" then
      local thought = { type = "reasoning", text = res.reasoning }
      if type(res.reasoningSignature) == "string" and res.reasoningSignature ~= "" then
        thought.signature = res.reasoningSignature
      end
      content[#content + 1] = thought
    end
    if type(res.text) == "string" and res.text ~= "" then
      content[#content + 1] = { type = "text", text = res.text }
    end
    for _, call in ipairs(res.toolCalls) do
      content[#content + 1] = { type = "tool_use", id = call.id, name = call.name, input = call.arguments }
      content[#content + 1] = { type = "tool_result", toolUseId = call.id, name = call.name, content = exec(call.name, call.arguments) }
    end
    sub.messages[#sub.messages + 1] = { role = "assistant", content = content }
    res = backends.generate(sub):await()
  end
  if res.toolCalls and #res.toolCalls > 0 then
    if opts.soft or (opts.done and opts.done()) then
      res.toolCalls = nil -- the caller's fallback owns what happens next
      return res
    end
    local names = {}
    for _, call in ipairs(res.toolCalls) do names[#names + 1] = call.name end
    error("tool loop exceeded " .. cap .. " rounds and the delegate is still calling tools ("
      .. table.concat(names, ", ") .. ") — raise maxRounds or fix whatever keeps it looping", 2)
  end
  return res
end

return M
