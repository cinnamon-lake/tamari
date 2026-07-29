/** Reference doc for the `custom_backends` topic, served by the Docs tool. */
export const CUSTOM_BACKENDS_DOC = `# Custom Backends (Lua)

A custom backend is a Lua script that owns the prompt. It runs instead of a built-in adapter and may delegate generation to real backends.

## Two kinds

- **Type A — registry (global).** Named scripts in the \`custom_backends\` registry, selected on a backend config via \`backendProvider: "custom"\` + \`providerParams.customBackendId\`, with \`providerParams.delegateConfigId\` as the default delegate. Author/test via the Workbench fs: \`/custom-backends/<id>/source.lua\` (+ \`meta.json\`) and \`run {"verb":"test_custom_backend",...}\` (topic \`workbench\`).
- **Type B — contextual (card-coupled).** \`character.extensions.contextualBackend = { enabled, luaSource }\`; travels with card export. Wraps the user's active adapter as its default delegate. Ignored when the active config is itself \`custom\` (explicit Type A wins). \`enabled\` is opt-in — never activate silently. Author/test via the Workbench fs: \`/characters/<id>/backend_logic.lua\` and \`run {"verb":"test_backend_logic",...}\` (topic \`workbench\`).

## Script contract

The script defines \`generate(prompt, ctx)\` and optionally \`list_models()\`. \`prompt\` is the fully-built prompt (a mutable copy: \`prompt.messages\`, \`prompt.tools\`, …); \`ctx\` is \`{ chatId, characterId, generationType }\` where generationType is \`'normal' | 'regenerate' | 'continue' | 'impersonate' | 'quiet' | 'genraw'\`. Available globals: \`prompt\`, \`ctx\`, \`backends\`, \`json\`, \`base64\`, \`fetch\`. The \`st\` API is NOT injected.

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

A second pattern — a **middleware** backend that mostly passes the chat through to the delegate, but intercepts \`/command\` messages: it answers them locally (no delegation), reflects the new state in the system prompt, and filters command messages out of all future delegations so the writer model never sees them:

\`\`\`lua
local DIFFICULTIES = { easy = "Easy", hard = "Hard", nightmare = "Nightmare" }
local ACK_PREFIX = "[sys] " -- marks our own acknowledgement messages

local function ensureState()
  if type(state) ~= "table" then state = {} end
  state.difficulty = state.difficulty or "Normal"
end

-- "/hard" → "hard"; anything else → nil
local function parseCommand(text)
  if type(text) ~= "string" then return nil end
  return text:match("^/(%a+)%s*$")
end

-- Rebuild the prompt for delegation: drop command messages AND our own tagged
-- acknowledgements from history (the writer model never sees the chrome)
-- and make the system prompt state-aware.
local function buildDelegatedPrompt(prompt)
  local sub = {}
  for k, v in pairs(prompt) do sub[k] = v end
  sub.tools = nil
  sub.messages = {}
  for _, m in ipairs(prompt.messages) do
    local isCommand = m.role == "user" and parseCommand(m.content)
    local isAck = m.role == "assistant" and type(m.content) == "string"
      and m.content:sub(1, #ACK_PREFIX) == ACK_PREFIX
    if not isCommand and not isAck then
      sub.messages[#sub.messages + 1] = m
    end
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

  -- Intercept: answer locally, no delegation. The returned text is stored
  -- as the assistant message like any other reply.
  local cmd = parseCommand(input)
  if cmd then
    if DIFFICULTIES[cmd] then
      state.difficulty = DIFFICULTIES[cmd]
      return ACK_PREFIX .. "Difficulty set to **" .. state.difficulty .. "**."
    end
    return ACK_PREFIX .. "Unknown command: /" .. cmd
  end

  -- Normal turn: delegate with the filtered, state-aware prompt.
  local res = backends.generate(buildDelegatedPrompt(prompt)):await()
  return res.text
end
\`\`\`

What it demonstrates:

- **Intercepting without delegating** — a command turn returns a locally-computed acknowledgement, stored as the assistant message like any reply. Acks carry a marker prefix (\`[sys] \`) and \`buildDelegatedPrompt\` filters them along with the commands, so the writer model sees neither side of the chrome. The marker is visible text to the user (honest UI); a one-line display regex (\`/\\[sys\\] /g\` → \`""\`) hides it if you'd rather show clean text.
- **Rebuilding history every turn** — \`buildDelegatedPrompt\` drops command messages and rewrites the system message, so the writer model always sees a clean, state-aware prompt. Because this happens per turn, changing state mid-chat retroactively reshapes the *whole* prompt.
- **This is the answer to "interactive greeting" / setup screens.** A greeting containing \`<button data-post-response="/hard">Hard mode</button>\` posts \`/hard\` as the user's next message when clicked — the backend intercepts it exactly like a typed command. Language toggles, feature flags, difficulty, "Start" buttons: all of them are just commands arriving as user messages. No modal dialogs needed; the chat log is the UI.
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
- Exportable cards should delegate by default (\`backends.generate(prompt)\`); explicit ids are local-install only.

## Tools from a custom backend

No tool schemas are advertised while a custom backend is active (the script decides everything), but a blocking return of \`{ toolCalls = { { name = "speak", arguments = {...} } } }\` is honored: calls execute through the normal tool registry, results become \`tool_result\` content parts on the latest assistant message, and the follow-up round re-enters \`generate()\`. Optional per-call \`id\` (defaults to \`lua_call_<n>\`); \`text\` may accompany the calls. Round-capped like any backend.

## Porting event-driven scripts (RisuAI triggers)

RisuAI triggers are event-driven (\`onOutput\`, \`onInput\`, \`onButtonClick\`, \`editDisplay\` hooks); a v2 custom backend is request-driven — ONE \`generate(prompt, ctx)\` call that owns both sides of the turn. The mapping is direct once you see the script sits **before and after** the delegated model:

| RisuAI pattern | v2 equivalent |
|---|---|
| \`onOutput\` post-processing | Delegate, then post-process: \`local res = backends.generate(prompt):await()\` — parse game-state tags out of \`res.text\`, update \`state\`, rewrite or append, and return the final text. The script owns the reply; this is where a game loop lives. |
| \`onInput\` / input rewriting | Read the incoming user message from \`prompt.messages\` (last \`role == "user"\` entry), parse commands, and transform it before assembling the delegated prompt. |
| \`risu-btn\` / \`risu-trigger\` buttons | Emit \`<button data-post-response="command">Label</button>\` in the reply text (directly, or via a display regex rule). A click posts \`command\` as the user's next message and triggers generation — recognize your own protocol strings (\`choice__3\`, \`lb-reroll__12\`) in the incoming user message, act on them, and strip them from the delegated prompt. Check \`ctx.generationType\`: a \`regenerate\`/\`continue\` must NOT re-fire a captured command. The seeded \`present_choices\` tool offers model-generated clickable choices through the same channel. Buttons survive the default (permissive) sanitization; the strict-sanitization setting strips them. |
| Save/load blobs in chat text | The script controls its own output: append a \`<SaveData>…</SaveData>\` blob to the returned text and parse it back out of \`prompt.messages\` on later turns (the branch history — branch-aware by construction). For hidden state, prefer the \`state\` global (see Branch-aware state). |
| \`getChatVar\` / \`setChatVar\` | Use the \`state\` global for engine state. For values that lorebook entries and prompts must read via \`{{getvar}}\`, emit \`{{setvar::key::value}}\` in the returned text — assistant messages are macro-resolved at write time and the vars are stored on the message. |
| \`getFullChat\` / history scanning | \`prompt.messages\` is the current branch's history as assembled for the model (context-window bound). Scan it the same way. |
| Rewriting stored messages | Not possible — displayed history is immutable by design. Append corrections or new state in your own output instead. |
| \`editDisplay\` HUD / status panel | A character-scoped DISPLAY regex rule (topic \`regexes\`) that expands a compact state tag in the reply (e.g. \`[HP:7\\|MP:3]\`) into a styled HTML panel — \`replaceLua\` covers conditional logic. The raw tag stays in the text for the model and your parser; the panel is presentation-only. |
| \`os.time()\` / \`os.clock()\` | Not available in the sandbox. Game logic almost never needs wall-clock time — derive turn counts from \`state\`. For RNG seeding specifically: Lua 5.4 auto-seeds \`math.random\` per VM (and each turn gets a fresh VM), so no \`randomseed(os.time())\` is needed — only seed explicitly (\`math.randomseed(n)\`) when you WANT determinism, e.g. the same shuffle on regenerate. |

The porting insight: a trigger's "events" are all the same moment in v2 — the turn. Input handling, generation, and output post-processing are sequential steps inside one \`generate()\`, and UI interaction arrives as the next turn's user message.

## Branch-aware state

Before \`generate()\`, the newest \`message.extra._toolState[backend.id]\` snapshot from the current branch is restored into the Lua \`state\` global (via your \`deserialize(raw)\` if defined, else \`json.decode\`). After a successful turn, \`state\` is captured (via your \`serialize()\` or \`json.encode(state)\`) and persisted. Failed turns never overwrite the last good snapshot. Swipes/branches restore state as of that point — store game/sim state here, not in globals that outlive the turn.

## Timeouts

\`generate()\` 10 minutes (simulator backends run long); \`list_models()\` 10 seconds. Abort relies on the timeout inside the VM.
`;
