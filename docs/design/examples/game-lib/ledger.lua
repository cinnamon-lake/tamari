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
-- `now` is the card's current turn counter. Bind it once per turn with
-- ledger.bind(fn) (toolset composition calls exec without a `now`), or pass
-- `now` explicitly to exec/briefing. The lib never touches `state` beyond
-- its own key.

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
        id = { type = "string" }, what = { type = "string" }, turn = { type = "integer" } }, required = { "id", "what", "turn" } },
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
function M.exec(name, args, now)
  now = now or getNow()
  if name == "promise" then
    local id = tostring(args.id or ""):sub(1, 30)
    local what = tostring(args.what or ""):sub(1, 120)
    local turn = tonumber(args.turn)
    -- The critical validation: a concrete due anchor. No "later".
    if id == "" or what == "" or turn == nil then
      return "rejected: id, what, and a concrete due turn are required"
    end
    turn = math.max(now + 1, math.min(math.floor(turn), now + 50))
    for _, p in ipairs(promises()) do
      if p.id == id and not p.status then return "already pending: " .. id end
    end
    local list = promises()
    list[#list + 1] = { id = id, what = what, turn = turn }
    return json.encode({ promised = id, turn = turn })
  end
  if name == "resolve_promise" then
    local id = tostring(args.id or "")
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
function M.briefing(now)
  now = now or getNow()
  local lines = {}
  for _, p in ipairs(promises()) do
    if not p.status then
      local tag = "pending"
      if now >= p.turn then tag = "DUE NOW"
      elseif now == p.turn - 1 then tag = "due next turn" end
      lines[#lines + 1] = string.format("- [%s] %s (turn %d): %s", tag, p.id, p.turn, p.what)
    end
  end
  if #lines == 0 then return "" end
  return "\nPLOT LEDGER (canon — honor it, resolve with resolve_promise when due):\n" .. table.concat(lines, "\n")
end

return M
