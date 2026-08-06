-- lib/todo.lua — delegate self-planning: a scratch checklist the model files
-- before and while it works, so multi-step jobs (design a floor, write a
-- content pack) survive the tool loop's amnesia.
--
-- Storage is state.todos — branch-aware: a swiped-away plan vanishes with its
-- branch, and a task spanning turns can resume. Distinct from the ledger:
-- todos are the delegate's own scratch plan; the ledger is canon commitments.
--
-- Every todo tool result echoes the REMAINING list, so the plan rides the
-- tool loop for free — the model sees its own checklist on every round
-- without spending prompt. todo.briefing() puts the same list in the
-- delegate's system prompt for cross-turn tasks.

local M = {}

local function todos()
  if type(state) ~= "table" then state = {} end
  state.todos = state.todos or {}
  return state.todos
end

local function remaining()
  local out = {}
  for i, t in ipairs(todos()) do
    if not t.done then out[#out + 1] = i .. ". " .. t.text end
  end
  if #out == 0 then return "none" end
  return table.concat(out, "; ")
end

function M.tools()
  return { {
    type = "function",
    ["function"] = {
      name = "set_todo",
      description = "Set your plan: a short ordered checklist for the task at hand. REPLACES the current list — restate it each time. Work the items, then mark them done with todo_done.",
      parameters = { type = "object", properties = {
        items = { type = "array", items = { type = "string" } } }, required = { "items" } },
    },
  }, {
    type = "function",
    ["function"] = {
      name = "todo_done",
      description = "Mark one plan item done by its 1-based index.",
      parameters = { type = "object", properties = {
        index = { type = "integer" } }, required = { "index" } },
    },
  } }
end

function M.exec(name, args)
  if name == "set_todo" then
    local list = todos()
    while #list > 0 do table.remove(list) end
    if type(args.items) == "table" then
      for _, item in ipairs(args.items) do
        local text = tostring(item)
        if text ~= "" then list[#list + 1] = { text = text, done = false } end
      end
    end
    return "plan set (" .. #list .. " items). remaining: " .. remaining()
  end
  if name == "todo_done" then
    local i = tonumber(args.index)
    local list = todos()
    if not i or not list[i] then return "rejected: no item " .. tostring(args.index) .. " — remaining: " .. remaining() end
    list[i].done = true
    return "done: " .. list[i].text .. ". remaining: " .. remaining()
  end
  return nil
end

--- The remaining items as a prompt block ("" when there is no plan).
function M.briefing()
  local out = {}
  for _, t in ipairs(todos()) do
    if not t.done then out[#out + 1] = "- " .. t.text end
  end
  if #out == 0 then return "" end
  return "\nYOUR PLAN (work it; mark items done with todo_done):\n" .. table.concat(out, "\n")
end

return M
