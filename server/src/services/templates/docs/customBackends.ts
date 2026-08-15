/** Reference doc for the `custom_backends` topic, served by the Docs tool. */
export const CUSTOM_BACKENDS_DOC = `# Custom Backends (Lua)

A custom backend is a Lua script that owns the prompt. It runs instead of a built-in adapter and may delegate generation to real backends. The spectrum runs from near-passthrough (delegate every turn, maybe post-process the text) to no model at all — a hypothetical ELIZA backend could pattern-match the user's last message and return a canned reflective question, never delegating once. Most real scripts sit in between: some turns handled locally, the rest delegated.

## Two kinds

- **Type A — registry (global).** Named scripts in the \`custom_backends\` registry, selected on a backend config via \`backendProvider: "custom"\` + \`providerParams.customBackendId\`, with \`providerParams.delegateConfigId\` as the default delegate. Author/test via the Workbench fs: \`/custom-backends/<id>/source.lua\` (+ \`meta.json\`) and \`run {"verb":"test_custom_backend",...}\` (topic \`workbench\`).
- **Type B — contextual (card-coupled).** A Lua script stored on the card; travels with card export. Wraps the user's active adapter as its default delegate. Ignored when the active config is itself \`custom\` (explicit Type A wins). Activation is opt-in — never activate silently; the fs authors the script only, it cannot flip the active flag. Lives in the Workbench fs as the \`/characters/<id>/backend_logic/\` directory — \`main.lua\` entry point plus module files behind a sandboxed \`require\` (see Modules); \`backend_logic.lua\` is a legacy alias for \`main.lua\`. Author/test via the fs and \`run {"verb":"test_backend_logic",...}\` (topic \`workbench\`).

## Script contract

The script defines \`generate(prompt, ctx)\` and optionally \`list_models()\`. \`prompt\` is the fully-built prompt (a mutable copy: \`prompt.messages\`, \`prompt.tools\`, …); \`ctx\` is \`{ chatId, characterId, generationType }\` where generationType is \`'send' | 'regenerate' | 'continue' | 'impersonate' | 'quiet' | 'genraw' | 'subagent'\`. Available globals: \`prompt\`, \`ctx\`, \`backends\`, \`chat\`, \`json\`, \`base64\`, \`fetch\`; Type B scripts also get a sandboxed \`require\` (see Modules). The \`st\` API is NOT injected. \`prompt.response_format\` carries the caller's structured-output request, if any (see Structured output).

A complete example — a high-card table where **Lua owns the deck and the score** (hidden, branch-aware state) and the delegate model only writes table-talk flavored by how badly the player is losing:

\`\`\`lua
local RANKS = { "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A" }

local function ensureState()
  if type(state) ~= "table" then state = {} end
  state.score = state.score or 0 -- +1 per win, -1 per loss
end

-- Sub-generation: copy the incoming prompt (keeps tokenUsage/params intact —
-- never hand-roll a partial prompt table) and swap in our own messages.
local function tableTalk(prompt, outcome)
  local mood = "neutral"
  if state.score >= 2 then mood = "gloating, gracious winner"
  elseif state.score <= -2 then mood = "smug, twisting the knife" end

  local sub = {}
  for k, v in pairs(prompt) do sub[k] = v end
  sub.tools = nil -- sub-generations don't need tool schemas
  sub.messages = {
    { role = "system", content = "You are a card-sharp dealer. One short line of table talk, "
      .. mood .. ". No stage directions." },
    { role = "user", content = "The player just " .. outcome
      .. " a hand. Running score: " .. state.score .. "." },
  }
  local res = backends.generate(sub):await() -- default delegate
  return res.text
end

function generate(prompt, ctx)
  ensureState()

  -- The last user message is the command.
  local input = ""
  for i = #prompt.messages, 1, -1 do
    local m = prompt.messages[i]
    if m.role == "user" and type(m.content) == "string" then input = m.content break end
  end
  input = input:gsub("^%s+", ""):gsub("%s+$", ""):lower()

  if input ~= "draw" then
    return "Say **draw** to play a hand. Score: " .. state.score
  end

  local you, house = math.random(#RANKS), math.random(#RANKS)
  local outcome = "tied"
  if you > house then state.score = state.score + 1 outcome = "won"
  elseif you < house then state.score = state.score - 1 outcome = "lost" end

  return "You: **" .. RANKS[you] .. "** — House: **" .. RANKS[house]
    .. "** (score " .. state.score .. ")\\n\\n" .. tableTalk(prompt, outcome)
end

function list_models()
  return { { id = "high-card", name = "High Card Table" } }
end
\`\`\`

What it demonstrates: parsing commands from \`prompt.messages\`; hidden state in the \`state\` global (restored/persisted per branch — see Branch-aware state); delegation with a rebuilt sub-prompt via \`backends.generate(sub):await()\`; combining deterministic Lua output with model text; returning a plain string.

## Middleware example: slash commands (intercept, configure, filter)

A second pattern — a **middleware** backend that mostly passes the chat through to the delegate, but intercepts \`/command\` messages: it answers them locally (no delegation), reflects the new state in the system prompt, and filters BOTH sides of the interaction out of all future delegations. The chrome discipline: **commands go out bare, acks come back wrapped** —

- Commands are plain \`/hard\`, typed or posted by a button: \`<button data-post-response="/hard">Hard mode</button>\`. NEVER put \`[sys]\` inside \`data-post-response\`: display regexes are structure-blind — a \`[sys]\`-hiding rule cannot tell chrome text from the inside of an attribute, and it will mangle the payload and kill the button. Not sometimes-fixable, don't try.
- Acks are wrapped in \`[sys]…[/sys]\` — that tag survives ONLY in text the script fully controls (its own replies, no attributes at stake).

\`\`\`lua
local DIFFICULTIES = { easy = "Easy", hard = "Hard", nightmare = "Nightmare" }

local function ensureState()
  if type(state) ~= "table" then state = {} end
  state.difficulty = state.difficulty or "Normal"
end

-- "/hard" → "hard"; anything else → nil
local function parseCommand(text)
  if type(text) ~= "string" then return nil end
  return text:match("^/(%a+)%s*$")
end

-- Rebuild the prompt for delegation: drop bare command messages AND strip
-- every [sys]...[/sys] block (our acks), trim, drop empties — the writer
-- model never sees either side of the chrome. Then make the system prompt
-- state-aware.
local function buildDelegatedPrompt(prompt)
  local sub = {}
  for k, v in pairs(prompt) do sub[k] = v end
  sub.tools = nil
  sub.messages = {}
  for _, m in ipairs(prompt.messages) do
    local skip = m.role == "user" and parseCommand(m.content) ~= nil
    if not skip and type(m.content) == "string" then
      m.content = m.content:gsub("%s*%[sys%].-%[/sys%]%s*", "\\n\\n"):gsub("^%s*(.-)%s*$", "%1")
      if m.content == "" then skip = true end
    end
    if not skip then sub.messages[#sub.messages + 1] = m end
  end
  for _, m in ipairs(sub.messages) do
    if m.role == "system" and type(m.content) == "string" then
      m.content = m.content .. "\\n\\nDifficulty: " .. state.difficulty .. ". Adjust the challenge accordingly."
      break
    end
  end
  return sub
end

function generate(prompt, ctx)
  ensureState()

  -- The last user message is a potential command.
  local input = ""
  for i = #prompt.messages, 1, -1 do
    local m = prompt.messages[i]
    if m.role == "user" and type(m.content) == "string" then input = m.content break end
  end

  -- Intercept: answer locally, no delegation. The wrapped reply is stored as
  -- the assistant message like any other — and vanishes from future prompts
  -- and (via the display rule) from the user's log.
  local cmd = parseCommand(input)
  if cmd then
    if DIFFICULTIES[cmd] then
      state.difficulty = DIFFICULTIES[cmd]
      return "[sys]Difficulty set to **" .. state.difficulty .. "**.[/sys]"
    end
    return "[sys]Unknown command: /" .. cmd .. "[/sys]"
  end

  -- Normal turn: delegate with the filtered, state-aware prompt.
  local res = backends.generate(buildDelegatedPrompt(prompt)):await()
  return res.text
end
\`\`\`

What it demonstrates:

- **Both sides vanish from the writer model.** \`buildDelegatedPrompt\` drops bare command messages and strips \`[sys]…[/sys]\` acks with one \`gsub\`, trims, and drops messages left empty — ~12 lines and the model never sees either side of the script interaction.
- **Display is two separate rules, one optional.** Acks hide behind \`/\\s*\\[sys\\].*?\\[\\/sys\\]\\s*/gis\` → \`"\\n\\n"\` (always). Commands arrive as honest user text — interaction is honest text, so leaving them visible is a legitimate default; to hide them, a \`userInput\`-scoped whole-message rule (\`/^\\s*\\/\\w+.*$/s\` → \`""\`) is safe precisely because the posted message contains no HTML for the regex to mangle.
- **Rebuilding history every turn** — \`buildDelegatedPrompt\` rewrites the prompt per turn, so changing state mid-chat retroactively reshapes the *whole* prompt.
- **This is the answer to "interactive greeting" / setup screens.** A greeting containing \`<button data-post-response="/hard">Hard mode</button>\` posts a bare command as the user's next message when clicked — intercepted exactly like a typed one. Language toggles, feature flags, difficulty, "Start" buttons: all of them are just commands arriving as user messages. No modal dialogs needed; the chat log is the UI.
- Acknowledgements are idempotent — regenerating a command turn recomputes the same answer from the same state, so \`regenerate\` is safe here.

## Parsing response forms

A \`<form data-post-response="root">\` in message HTML arrives — like button clicks — as the user's next message: an \`\`\`xml fenced block, root named by the attribute, one child element per field \`name\`, values entity-escaped (\`& < > " '\`). Empty fields are empty elements; checkboxes/radios appear only when checked (valueless → \`true\`); repeated names repeat the element. Extract and parse with plain patterns (this recipe is verified by the response-form e2e, \`GenerationService.responseForm.test.ts\`):

\`\`\`lua
local FENCE = string.char(96):rep(3) -- triple backtick

local function parse_fields(xml)
  local t = {}
  -- strip the single root wrapper first — otherwise gmatch's lazy body
  -- for <root> swallows every inner tag in its first match
  local inner = xml:match("^%s*<[%w._%-]+>%s*(.-)%s*</[%w._%-]+>%s*$") or xml
  for tag, body in inner:gmatch("<([%w._%-]+)>(.-)</%1>") do
    t[tag] = body:gsub("&lt;", "<"):gsub("&gt;", ">"):gsub("&quot;", '"')
                 :gsub("&apos;", "'"):gsub("&amp;", "&")
  end
  return t
end

-- in generate(): local block = input:match(FENCE .. "xml\\n(.-)\\n" .. FENCE)
\`\`\`

Repeated siblings collapse to last-wins in this recipe; match them directly if you need lists. Recognize your own root element, and check \`ctx.generationType\` — a \`regenerate\`/\`continue\` must not re-fire a submitted action. On a plain backend the block reaches the model as-is (models parse simple XML fine), so forms degrade gracefully.

## Modules — sandboxed \`require\` (Type B)

A card carries a virtual filesystem: path → Lua source, edited as the \`/characters/<id>/backend_logic/\` directory and traveling with card export. \`require('lib/utils')\` resolves ONLY against that map — the real filesystem is never touched, and Type A registry scripts stay single-blob by design.

- Paths are relative and slash-separated; \`.lua\` is appended when omitted (\`require('lib/utils')\` → \`lib/utils.lua\`). Segments: letters, digits, \`_\`, \`-\` only.
- A module executes once per turn (fresh Lua state per turn) and its result is cached like \`package.loaded\` — return a table, e.g. \`local M = {} ... return M\`.
- Missing modules, circular requires, and load failures raise named Lua errors — the turn fails loudly.
- Only \`main.lua\` must define \`generate()\`; modules just need to load. The dry-run (\`test_backend_logic\` / the editor's test panel) runs the full module set, so use it after editing ANY file, not just \`main.lua\`.

\`\`\`lua
-- /characters/<id>/backend_logic/lib/dice.lua
local M = {}
function M.roll(sides) return math.random(1, sides) end
return M

-- main.lua
local dice = require('lib/dice')
function generate(prompt, ctx)
  return "You rolled " .. dice.roll(20)
end
\`\`\`

## Structured output (\`response_format\`)

\`prompt.response_format\` is the canonical structured-output field, honored by the OpenAI/Claude/Gemini adapters as a json_schema request. Nothing built-in sets it; scripts REQUEST it by setting \`response_format\` on a delegate (or \`__passthrough\`) prompt table — \`{ type = "json_schema", schema = { ... } }\` — and INSPECT it on their own incoming \`prompt\`.

json_schema is a request, not a guarantee — reverse proxies and local backends emit invalid JSON often enough that pattern-matching beats pcall. Consume with \`json.parse_result(text)\` → \`{ value = ... }\` or \`{ error = "..." }\`. There is no adapter-level validation or retry, by design: the script owns the failure semantics.

One decode gotcha: \`json.decode\`/\`parse_result\` map JSON \`null\` to a truthy js_null userdata, NOT Lua nil — \`if result.optional then\` takes the wrong branch and concatenating it errors. Sanitize decoded tables before use (drop any value that isn't a table/string/number/boolean — see \`sanitize.data\` in topic \`game_cards_example\`).

\`\`\`lua
local sub = {}
for k, v in pairs(prompt) do sub[k] = v end
sub.tools = nil
sub.response_format = {
  type = "json_schema",
  schema = { type = "object", properties = { total = { type = "number" } }, required = { "total" } },
}
local res = backends.generate(sub):await()
local parsed = json.parse_result(res.text)
if parsed.error then return "The dice spirits mumbled: " .. parsed.error end
return "You rolled " .. parsed.value.total
\`\`\`

## Return shapes (blocking mode)

- \`string\` — the reply text.
- \`{ text, reasoning?, usage?, toolCalls? }\` — full result.
- \`{ error = "..." }\` — surfaced as a backend error. A Lua error or returning nothing is also an error, never a silent empty reply.
- \`{ __passthrough = true, prompt = prompt }\` — the delegate adapter streams natively (real token streaming), preserving your prompt edits. Use for middleware that doesn't post-process output.

## Delegation rules

- Goes through the normal adapter factory — **API keys never enter Lua**; scripts only see config ids.
- Default delegate: the config's \`delegateConfigId\` (Type A) or the user's active adapter (Type B).
- Custom → custom chains are depth-capped at 4.
- A failed delegation with no usable text **throws into Lua** — wrap in \`pcall\` to recover.
- Delegate results carry \`toolCalls\` when the delegate wants to call tools (\`res.toolCalls\`, \`{ id, name, arguments }\`) — see Giving the delegate tools.
- Always END delegate sub-prompts with a \`user\` message (the \`Narrate: …\` pattern). Some providers reject prompts with no user message or an assistant-final sequence — Zhipu GLM answers HTTP 400 (code 1214, "messages parameter is illegal"); OpenAI tolerates both, so cards that skip this break only when they change hands.
- Exportable cards should delegate by default (\`backends.generate(prompt)\`); explicit ids are local-install only.
- **You own the delegate's prompt — card definition fields do NOT auto-appear.** A card-coupled backend builds each delegate sub-prompt itself (\`sub.messages = { … }\`). The character's \`description\`, \`personality\`, \`persona\`, and other card-definition fields are NOT injected into those sub-prompts — only what you put in \`sub.messages\` reaches the model. (They ARE in the script's *incoming* \`prompt\` if you want to pull them out, but the delegates see only what you forward.) So put worldbuilding, tone, and persona into your prompt constants or the event context — not into the card fields expecting the delegate to read them. This is the single most common surprise for cards that drive their own sub-generations.

## Tools from a custom backend

No tool schemas are advertised while a custom backend is active (the script decides everything), but a blocking return of \`{ toolCalls = { { name = "speak", arguments = {...} } } }\` is honored: calls execute through the normal tool registry, results become \`tool_result\` content parts on the latest assistant message, and the follow-up round re-enters \`generate()\`. Optional per-call \`id\` (defaults to \`lua_call_<n>\`); \`text\` may accompany the calls. Round-capped like any backend.

## Giving the delegate tools (script-owned tool loop)

A sub-prompt can carry tool schemas the SCRIPT defined — set \`sub.tools\` and the delegate adapter sends them (OpenAI/Claude/Gemini honor them; the rest ignore them). When the delegate answers with tool calls instead of text, they arrive as \`res.toolCalls\` (\`{ id, name, arguments }\`) alongside \`res.text\`: execute them in Lua and continue the loop yourself by appending ONE assistant message whose content is an array of parts — the \`tool_use\` part(s), then the matching \`tool_result\` part(s) — and calling \`backends.generate\` again. Part keys are camelCase (\`toolUseId\`, \`isError\`), and \`function\` is a Lua keyword, so tool definitions need bracket indexing:

\`\`\`lua
local sub = {}
for k, v in pairs(prompt) do sub[k] = v end
sub.messages = {
  { role = "system", content = "You are the narrator. Query the game engine with tools whenever you need rules or dice." },
  { role = "user", content = userInput },
}
sub.tools = { {
  type = "function",
  ["function"] = {
    name = "roll_dice",
    description = "Roll NdS dice, return the total",
    parameters = { type = "object", properties = {
      n = { type = "integer" }, sides = { type = "integer" } }, required = { "n", "sides" } },
  },
} }

local res = backends.generate(sub):await()
local rounds = 0
while res.toolCalls and #res.toolCalls > 0 and rounds < 8 do
  rounds = rounds + 1
  local content = {}
  for _, call in ipairs(res.toolCalls) do
    content[#content + 1] = { type = "tool_use", id = call.id, name = call.name, input = call.arguments }
    local total = 0
    for _ = 1, tonumber(call.arguments.n) or 1 do total = total + math.random(1, tonumber(call.arguments.sides) or 6) end
    content[#content + 1] = { type = "tool_result", toolUseId = call.id, name = call.name, content = tostring(total) }
  end
  sub.messages[#sub.messages + 1] = { role = "assistant", content = content }
  res = backends.generate(sub):await()
end
return res.text
\`\`\`

The whole loop is invisible sub-generation inside one turn — the calls and results never touch the chat log, and the writer model gets to *query the game* (dice, inventory, lookup tables) while the script keeps every answer deterministic. Self-cap the rounds: the only hard limit is the 10-minute \`generate()\` budget. This is the complement of the blocking \`{ toolCalls = ... }\` return above: THAT path runs the caller's registered tools through the engine (results land in the chat); THIS path is for script-defined tools that should stay inside the script.

## Full branch history (the \`chat\` global)

\`prompt.messages\` is the capped view — bounded by the \`promptHistoryLimit\` message count, because it is assembled FOR the model. The script itself is not so limited: the \`chat\` global serves the FULL current branch (active swipes resolved), loaded lazily at most once per turn and only when called:

- \`chat.count():await()\` → branch length.
- \`chat.get(index):await()\` → 1-based, chronological: \`{ id, role, content, characterId?, personaId? }\`; out of range → nil.
- \`chat.find(query, limit?):await()\` → newest-first substring matches (case-insensitive) \`{ index, id, role, content }\`; limit defaults to 10, capped at 50.

\`chat\` is NIL outside a live chat generation (dry-runs without canned history, list_models) — always \`if chat then ... end\`. Read-only by construction. It is the raw escape hatch for verbatim history: when a script compresses the delegate's view itself (never with an engine prompt rule — that would blind the script too, since the script's own prompt is regex-processed), \`chat.find\` answers "what was actually said" from the full branch. The STRUCTURED pattern is lib/rolling + \`inspect_summary\` (topic \`game_cards\`) — summaries filed with their content, zoomed by id — but nothing stops a script from querying the raw branch. Dry-run it with the \`history\` option on \`test_backend_logic\` / \`test_custom_backend\` (\`[{ role, content }, ...]\`, oldest first; omit → \`chat\` is nil).

## The blob heap (the \`store\` global)

\`state\` is snapshotted per message, so anything big you put in it is duplicated into every message from then on. Kilobyte-scale script-authored data — generated content packs, big designs — belongs in the \`store\` global instead: a global append-only blob heap.

- \`store.put(name, text):await()\` → the new blob's id, \`"<name>#<seq>"\`. The name is ONLY a debug-readable prefix (it shows up in state dumps and error messages); it is never queryable. Names cap at 60 chars, content at 64KB — over-cap throws.
- \`store.get(id):await()\` → the blob's text, or nil.
- \`store.putJson(name, value):await()\` → id. The value is a Lua table, encoded JS-side — no \`json.encode\` dance.
- \`store.getJson(id):await()\` → the validated JSON string (\`json.decode\` it Lua-side — the decode cannot fail, it was validated; a corrupt blob throws instead). Missing → nil.
- \`store.append(prevId, item):await()\` → the new head id. Persistent linked list: one node \`{ item, prev }\` per call, exactly one item — but the item MAY be an array, and that's the batching idiom (a turn's entries as one node, one await).
- \`store.readArray(id):await()\` → the whole chain as a validated JSON string: nodes oldest-first, array items recursively FLATTENED. \`readArray(nil)\` → \`[]\`.

The recursive-array idiom — a growing, branch-correct log that never copies: \`state.head = store.append(state.head, entries):await()\` per turn (state holds only the head id; old branches still point at their old head), \`json.decode(store.readArray(state.head):await())\` to read it all back. This is what the event engine's scene span is built on (topic \`game_cards\`). Appending to a missing \`prevId\` or reading a chain with a missing node throws — a pointer to nothing is a bug, not bad luck.

No list, no search, no edits — lookup is by exact id only, and there is no way to enumerate the heap. The discipline that keeps swipes correct: **the blob lives in the store, the pointer lives in \`state\`.** Your branch-aware state maps your own logical keys to blob ids (\`state.packIds = { f1 = "pack:f1#3" }\`); a "mutation" is a fresh \`put\` plus moving the pointer — old branches still point at their version, and a swiped-away branch's blobs are simply unreferenced. A pointer whose blob is missing or garbled is a bug (blobs are script-written) — fail loudly, don't "recover" by regenerating. \`store\` is always present; in dry-runs and tests it is an in-memory heap that lives as long as the adapter.

## Porting event-driven scripts (RisuAI triggers)

RisuAI triggers are event-driven (\`onOutput\`, \`onInput\`, \`onButtonClick\`, \`editDisplay\` hooks); a v2 custom backend is request-driven — ONE \`generate(prompt, ctx)\` call that owns both sides of the turn. The mapping is direct once you see the script sits **before and after** the delegated model:

| RisuAI pattern | v2 equivalent |
|---|---|
| \`onOutput\` post-processing | Delegate, then post-process: \`local res = backends.generate(prompt):await()\` — parse game-state tags out of \`res.text\`, update \`state\`, rewrite or append, and return the final text. The script owns the reply; this is where a game loop lives. |
| \`onInput\` / input rewriting | Read the incoming user message from \`prompt.messages\` (last \`role == "user"\` entry), parse commands, and transform it before assembling the delegated prompt. |
| \`risu-btn\` / \`risu-trigger\` buttons | Emit \`<button data-post-response="command">Label</button>\` in the reply text (directly, or via a display regex rule). A click posts \`command\` as the user's next message and triggers generation — recognize your own protocol strings (\`choice__3\`, \`lb-reroll__12\`) in the incoming user message, act on them, and strip them from the delegated prompt. Check \`ctx.generationType\`: a \`regenerate\`/\`continue\` must NOT re-fire a captured command. The seeded \`present_choices\` tool offers model-generated clickable choices through the same channel. Buttons survive the default (permissive) sanitization; the strict-sanitization setting strips them. |
| Save/load blobs in chat text | Don't parse your own data back out of history. Small engine state goes in the \`state\` global (branch-aware — see Branch-aware state); kilobyte-scale blobs go in the \`store\` global (\`store.put(name, text)\` → id, pointer kept in \`state\`, \`store.get(id)\` to read back — see The blob heap). History is the record of what was SAID, not a data channel. |
| \`getChatVar\` / \`setChatVar\` | Use the \`state\` global for engine state. For values that lorebook entries and prompts must read via \`{{getvar}}\`, emit \`{{setvar::key::value}}\` in the returned text — assistant messages are macro-resolved at write time and the vars are stored on the message. |
| \`getFullChat\` / history scanning | \`prompt.messages\` is the current branch's history as assembled for the model (context-window bound). Scan it the same way. |
| Rewriting stored messages | Not possible — displayed history is immutable by design. Append corrections or new state in your own output instead. |
| \`editDisplay\` HUD / status panel | A character-scoped DISPLAY regex rule (topic \`regexes\`) that expands a compact state tag in the reply (e.g. \`[HP:7\\|MP:3]\`) into a styled HTML panel — \`replaceLua\` covers conditional logic. The raw tag stays in the text for the model and your parser; the panel is presentation-only. |
| \`os.time()\` / \`os.clock()\` | Not available in the sandbox. Game logic almost never needs wall-clock time — derive turn counts from \`state\`. For RNG seeding specifically: Lua 5.4 auto-seeds \`math.random\` per VM (and each turn gets a fresh VM), so no \`randomseed(os.time())\` is needed — only seed explicitly (\`math.randomseed(n)\`) when you WANT determinism, e.g. the same shuffle on regenerate. |

The porting insight: a trigger's "events" are all the same moment in v2 — the turn. Input handling, generation, and output post-processing are sequential steps inside one \`generate()\`, and UI interaction arrives as the next turn's user message.

## Branch-aware state

Before \`generate()\`, the newest \`message.extra._toolState[backend.id]\` snapshot from the current branch is restored into the Lua \`state\` global (via your \`deserialize(raw)\` if defined, else \`json.decode\`). After a successful turn, \`state\` is captured (via your \`serialize()\` or \`json.encode(state)\`) and persisted. Failed turns never overwrite the last good snapshot. Swipes/branches restore state as of that point — store game/sim state here, not in globals that outlive the turn.

## Debugging — \`print()\` is captured

\`print(...)\` in a backend script does NOT vanish: every call is captured (real Lua semantics — args are \`tostring\`ed and tab-joined) and streamed as a \`backend_debug\` part on the assistant message. It is never part of the dialogue the model sees; it shows in chat as a collapsed "Backend debug" block, and in dry-run outcomes (\`test_backend_logic\` / \`test_custom_backend\` / the editor's test panel) as the \`debug\` field — including lines printed before the script errored. Use it liberally while developing; it costs nothing in the prompt. Cap: 64 KB per turn, truncated with a marker beyond that.

## Timeouts

\`generate()\` 10 minutes (simulator backends run long); \`list_models()\` 10 seconds. Abort relies on the timeout inside the VM. Memory: each script state is capped at 64 MB of Lua heap — a memory bomb fails the turn with a "not enough memory" error.
`;
