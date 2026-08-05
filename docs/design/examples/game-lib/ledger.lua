-- lib/ledger.lua — the plot ledger: long-term commitments the delegate files
-- for its future self (foreshadowing, scheduled events, threats that mature).
--
-- Prose cannot carry these: rolling summaries paraphrase foreshadowing away.
-- The ledger is the compaction-proof channel — what's registered is INTENT.
-- Storage is state.promises, so it is branch-aware: a promise filed in a
-- swiped-away turn vanishes with the branch; once persisted, it is canon.
--
-- The ledger rides in every delegate prompt (ledger.briefing); Lua computes
-- due-ness from `now` and escalates to DUE NOW. Lifecycle includes failure:
-- pending → kept / failed, and failure is canon too.
--
-- `now` is the card's current turn counter; bind it once per turn with
-- ledger.bind(fn). A filed due date is clamped to now+1 … now+50 — a promise
-- can never be filed for the same turn, nor further than 50 turns out. The
-- lib never touches `state` beyond its own key.

local M = {}

local getNow = function() return 0 end

--- Bind the card's turn counter: ledger.bind(function() return state.turn end)
function M.bind(fn) getNow = fn end

local function promises()
  if type(state) ~= "table" then state = {} end
  state.promises = state.promises or {}
  return state.promises
end

function M.tools()
  return { {
    type = "function",
    ["function"] = {
      name = "promise",
      description = "File a plot debt for your future self: something that MUST happen at a later turn (foreshadowing, a scheduled event, a threat that matures).",
      parameters = { type = "object", properties = {
        id = { type = "string" }, what = { type = "string" }, due = { type = "integer" } }, required = { "id", "what", "due" } },
    },
  }, {
    type = "function",
    ["function"] = {
      name = "resolve_promise",
      description = "Mark a plot-ledger entry as kept or failed once it comes due.",
      parameters = { type = "object", properties = {
        id = { type = "string" }, outcome = { type = "string" } }, required = { "id" } },
    },
  } }
end

--- Answers promise/resolve_promise; returns nil when the name is not a ledger
--- tool (so toolset composition can try the next module).
function M.exec(name, args)
  local now = getNow()
  if name == "promise" then
    local id = tostring(args.id or ""):sub(1, 30)
    local what = tostring(args.what or ""):sub(1, 120)
    local due = tonumber(args.due)
    -- The critical validation: a concrete due anchor. No "later".
    if id == "" or what == "" or due == nil then
      return "rejected: id, what, and a concrete due are required"
    end
    due = math.max(now + 1, math.min(math.floor(due), now + 50))
    for _, p in ipairs(promises()) do
      if p.id == id and not p.status then return "already pending: " .. id end
    end
    local list = promises()
    list[#list + 1] = { id = id, what = what, due = due }
    return json.encode({ promised = id, due = due })
  end
  if name == "resolve_promise" then
    local id = tostring(args.id or ""):sub(1, 30)
    for _, p in ipairs(promises()) do
      if p.id == id and not p.status then
        p.status = args.outcome == "failed" and "failed" or "kept"
        return json.encode({ resolved = id, outcome = p.status })
      end
    end
    return "no pending promise: " .. id
  end
  return nil
end

--- The briefing is the memory: pending debts with due-ness computed by Lua.
function M.briefing()
  local now = getNow()
  local lines = {}
  for _, p in ipairs(promises()) do
    if p.status == "failed" then
      -- Failure is canon: it stays on screen so the model honors the consequence
      -- (a closed route, a broken oath) instead of forgetting it ever happened.
      lines[#lines + 1] = string.format("- [FAILED — canon] %s: %s", p.id, p.what)
    elseif not p.status then
      local tag = "pending"
      if now >= p.due then tag = "DUE NOW"
      elseif now == p.due - 1 then tag = "due next turn" end
      lines[#lines + 1] = string.format("- [%s] %s (due %d): %s", tag, p.id, p.due, p.what)
    end
  end
  if #lines == 0 then return "" end
  return "\nPLOT LEDGER (canon — honor it, resolve with resolve_promise when due):\n" .. table.concat(lines, "\n")
end

return M
