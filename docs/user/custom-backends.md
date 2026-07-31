# Custom Backends (Lua)

A custom backend is a Lua script that *owns the prompt*. When one is active, tamari runs your script instead of a built-in provider adapter: the script receives the fully-built prompt, does whatever it wants with it — inspect, rewrite, rebuild, answer directly — and optionally delegates generation to a real backend. This is how you build middleware (transform prompts or output on the fly), game engines with hidden state, simulator cards, or whole protocol adapters in Lua.

The design rationale (three scriptable layers, why credentials never enter Lua, why displayed history is immutable) lives in [docs/design/scriptable-layers.md](../design/scriptable-layers.md) — this page is the practical guide.

## Two Kinds of Custom Backend

Same script contract, two ownership models.

### Type A — registry scripts (reusable, global)

Named scripts in tamari's custom-backend registry, independent of any character. Manage them in the **Custom Backends** modal (sidebar → **Custom Backends**): click **Add Custom Backend**, fill in **Name**, **Description**, and **Lua Source**, and **Save**. Edits to an existing entry (the **Edit** button) save through the same form; **Delete** asks for confirmation and is permanent.

To use one, open a backend config and set the provider to **Custom (Lua)**. Two dropdowns appear:

- **Custom Backend** — which registry script to run.
- **Delegate Backend** — the config the script delegates to by default when it calls `backends.generate(prompt)` without an id. Stored as `providerParams.delegateConfigId` on the config.

Because a registry script is selected on a backend config, it applies to every chat that uses that config, with any character.

### Type B — card-coupled backend logic

A Lua script stored **on the character card itself** (`character.extensions.contextualBackend`), so it travels with card export — this is where ported triggerlua and simulator logic belongs. Edit it in the character editor: **Logic & Rules** tab → **Backend Logic (this character)**, with an **Enable backend logic** checkbox and the **Lua Source** field. Changes autosave.

Activation rules:

- When enabled, the script **wraps your active backend** — the active adapter becomes its default delegate, so the "writer model" follows your normal backend selection.
- If the active backend config is itself **Custom (Lua)** (Type A), the explicit Type A selection wins and the card's script is ignored.
- **`enabled` is opt-in.** Imported cards can ship backend logic, but it never activates silently — you tick the checkbox yourself.

### Authoring through the workbench

Both kinds are also files in the [workbench](./workbench.md), so the AI can author and test them for you:

- Type A: `/custom-backends/<id>/source.lua` (+ `meta.json`)
- Type B: `/characters/<id>/backend_logic.lua`

Workbench `write`/`edit` validate Lua before saving — `backend_logic.lua` must load and define `generate`, or the write is rejected unsaved.

## The `generate(prompt, ctx)` Contract

Your script must define one function, and may define a second:

```lua
function generate(prompt, ctx)
  -- inspect / rewrite / rebuild the prompt, delegate, or answer directly
  return "..."
end

function list_models()   -- optional; feeds the config's model dropdown
  return { { id = "my-model", name = "My Model" } }
end
```

- `prompt` — the fully-built prompt, as a **mutable copy**: `prompt.messages` (the current branch's history as assembled for the model), `prompt.tools`, and the other prompt fields. Changes you make affect what you delegate, never the stored chat.
- `ctx` — `{ chatId, characterId, generationType }`, where `generationType` is one of `'normal'`, `'regenerate'`, `'continue'`, `'impersonate'`, `'quiet'`, `'genraw'`.

Available globals: `backends` (delegation, below), `json`, `base64`, and `fetch` (the same SSRF-guarded async fetch Lua tool templates get — see [Lua Scripting](./lua-scripting.md)). The `st` API is **not** injected.

### Multi-file scripts: `require` and the card VFS (Type B)

A card-coupled script doesn't have to live in one blob. The card carries a small virtual filesystem (`extensions.contextualBackend.files`) and `require` resolves against it:

```lua
-- backend_logic/main.lua
local utils = require('lib/utils')   -- resolves backend_logic/lib/utils.lua
function generate(prompt, ctx)
  return utils.reply(prompt)
end
```

**Editing.** The character editor's **Logic & Rules → Backend Logic** section has a file-tab bar above the Lua textarea: `main.lua` first (the entry point — this is the same content as the old single `luaSource` textarea), then each module, then **+** to add one (paths validate: slash-separated `[A-Za-z0-9_-]` segments, `.lua` appended when omitted). The dry-run panel below the editor tests the whole set — main plus every module — exactly as generation will run it. The same files are editable by the model through the workbench's `backend_logic/` directory (see [Workbench](./workbench.md)).

- Path rules: slash-separated segments of `[A-Za-z0-9_-]`, `.lua` appended when omitted, no `..`, no leading `/`. `require('./lib/utils')` also works.
- A module is a plain Lua chunk whose **return value is the module** (top-level `return` is expected). Modules execute **once** per generation (cached); circular requires raise `circular require: <path>`.
- Resolution is against the card's files **only** — the real filesystem is never touched, and anything the card doesn't contain is `module not found: <path>`.
- Both dry-runs (the editor panel and the workbench's `test_backend_logic`) see the same files, so what you test is what generation runs.

### Structured output: `response_format`

`prompt.responseFormat` is readable from Lua as `prompt.response_format` — your script can inspect what structured output was requested. To **request** it on a delegated call, set `response_format` (or `responseFormat`) on the prompt table you hand to `backends.generate` or `__passthrough`:

```lua
function generate(prompt, ctx)
  prompt.response_format = { type = 'json_schema', schema = { type = 'object' } }
  local res = backends.generate(prompt):await()
  local parsed = json.parse_result(res.text)
  if parsed.error then return "The model didn't produce JSON: " .. parsed.error end
  return "Got structured data: " .. json.encode(parsed.value)
end
```

Adapters that support structured output (OpenAI, Claude, Gemini) map it; the rest silently ignore it — it's a hint, never a guarantee, and there is no automatic validation or retry. Parse defensively with `json.parse_result` (returns `{ value = ... }` / `{ error = ... }`; `json.decode` keeps throwing on garbage).

### Return shapes

`generate()` may return:

- **A string** — the reply text.
- **A table** `{ text, reasoning?, usage?, toolCalls? }` — the full result. `usage` overrides token accounting (`{ promptTokens, completionTokens }`); `toolCalls` requests tool execution (see [Requesting Tools from Lua](#requesting-tools-from-lua)).
- `{ error = "..." }` — surfaced as a backend error, like any provider failure.
- `{ __passthrough = true, prompt = prompt }` — the delegate adapter **streams natively** (real token streaming), with your prompt edits applied. Use a config-id string instead of `true` to pick the delegate explicitly. This is the mode for middleware that doesn't post-process output.

> **Warning:** Returning nothing usable is an **error**, never a silent empty reply — the user sees a backend error naming your script. A Lua runtime error is reported the same way.

### Delegating to a real backend

```lua
local res = backends.generate(prompt):await()                 -- default delegate
local aux = backends.generate("<backendConfigId>", prompt):await()  -- explicit target by id
return res.text
```

- The **default delegate** is the config's **Delegate Backend** (Type A) or your active backend (Type B).
- The **by-id escape hatch** targets a specific backend config — for simulator scripts with multiple models (a main model plus an auxiliary). Ids, not names: stable under renames.
- The result is `{ text, reasoning?, finishReason, error?, usage = { promptTokens, completionTokens } }`. Delegated usage is added to your turn's token accounting automatically unless you return your own `usage`.
- Delegation goes through the normal adapter factory — **API keys never enter Lua**; scripts only ever see config ids.
- **A failed delegation with no usable text throws into Lua.** Wrap it in `pcall` if you want to recover or inspect the error:

```lua
local ok, res = pcall(function() return backends.generate(prompt):await() end)
if not ok then return "The writer model is unavailable: " .. tostring(res) end
```

> **Warning (Type A):** if the config's **Delegate Backend** is left unset and the script calls `backends.generate(prompt)` without an id, the delegation fails with *"no delegate configured"*. Set a delegate on the config, or pass explicit config ids in the script.

### A complete example

A middleware backend that intercepts `/command` messages, answers them locally, keeps the setting in hidden state, and filters the command traffic out of everything the writer model sees:

```lua
local DIFFICULTIES = { easy = "Easy", hard = "Hard", nightmare = "Nightmare" }

local function ensureState()
  if type(state) ~= "table" then state = {} end
  state.difficulty = state.difficulty or "Normal"
end

local function parseCommand(text)
  if type(text) ~= "string" then return nil end
  return text:match("^/(%a+)%s*$")
end

function generate(prompt, ctx)
  ensureState()

  -- The last user message is a potential command.
  local input = ""
  for i = #prompt.messages, 1, -1 do
    local m = prompt.messages[i]
    if m.role == "user" and type(m.content) == "string" then input = m.content break end
  end

  local cmd = parseCommand(input)
  if cmd then
    if DIFFICULTIES[cmd] then
      state.difficulty = DIFFICULTIES[cmd]
      return "Difficulty set to **" .. state.difficulty .. "**."
    end
    return "Unknown command: /" .. cmd
  end

  -- Normal turn: rebuild the prompt for the delegate — drop command
  -- messages and make the system prompt state-aware.
  local sub = {}
  for k, v in pairs(prompt) do sub[k] = v end
  sub.tools = nil
  sub.messages = {}
  for _, m in ipairs(prompt.messages) do
    if not (m.role == "user" and parseCommand(m.content)) then
      sub.messages[#sub.messages + 1] = m
    end
  end
  for _, m in ipairs(sub.messages) do
    if m.role == "system" and type(m.content) == "string" then
      m.content = m.content .. "\n\nDifficulty: " .. state.difficulty .. "."
      break
    end
  end

  local res = backends.generate(sub):await()
  return res.text
end
```

Copy the incoming prompt table and swap in your own `messages` (as above) rather than hand-rolling a partial prompt — that keeps token usage and generation params intact. Because the rebuild happens every turn, changing state mid-chat retroactively reshapes the *whole* prompt the writer model sees.

## Recipe: Injecting into the Prompt

"Put some text at a specific position in the prompt" has three homes, in increasing order of machinery — pick the lightest one that fits:

- **Static, position-agnostic text** (a standing instruction): the chat's **Author's Note**, or a `main`/`jailbreak` prompt-list entry. No Lua.
- **Static, positioned text** (at a depth, keyword-triggered): **World Info entries** — `atDepth` entries splice into history at their depth; the `worldInfoBefore`/`worldInfoAfter` markers place book content relative to the card definitions. No Lua.
- **Dynamic or computed text** (depends on state, dice, the last message, another backend's answer): a `backend_logic` script, as below.

Injecting with `backend_logic` is just `prompt.messages` editing before you delegate — `messages` is an ordinary array of `{ role, content }`:

```lua
-- Post-history instruction (after the last real message, before the
-- stream-target placeholder the adapter strips):
table.insert(prompt.messages, { role = 'system', content = 'Stay in the tavern.' })

-- At depth N from the end of history:
table.insert(prompt.messages, #prompt.messages - 1, { role = 'system', content = 'Thunder rumbles.' })

-- Before history (after the assembled system prompts):
table.insert(prompt.messages, 1, { role = 'system', content = 'Era: 1342.' })
```

Then `return { __passthrough = true, prompt = prompt }` to stream natively with your edits, or `backends.generate(prompt):await()` for the blocking path. Injection composes with the rest of the stack: your inserted messages are visible to the writer model, but never persisted to the chat — the displayed history stays untouched.

For computed injections, carry intermediate results in `state` and feed them forward — and when the writer model returns structured output (request it with `response_format`, see above), parse it defensively before injecting it next turn:

```lua
local parsed = json.parse_result(res.text)
if not parsed.error then
  state.weather = parsed.value.weather
end
-- next turn: table.insert(prompt.messages, { role = 'system', content = 'Weather: ' .. (state.weather or 'clear') })
```

> **Note:** there is deliberately no separate "prompt stage" hook. The pipeline's stage list is an internal extension point, and positioned injection for cards is served by the three mechanisms above — see `docs/design/generation-runner.md` for the rationale.

## State: the `state` Global

Custom backends are stateful through the same branch-aware protocol as [Lua tool templates](./tools.md#branch-aware-state):

- **Before** `generate()` runs, tamari scans the **current branch's** message history backwards, finds the newest snapshot stored at `message.extra._toolState[<backend id>]`, and restores it into the Lua `state` global — via your `deserialize(raw)` if you define one, else `json.decode`.
- **After** a successful turn, `state` is captured — via your `serialize()` if defined, else `json.encode(state)` — and persisted under the same key.
- **Failed turns never overwrite the last good snapshot.**

Consequences:

- Forking a chat branch gives each fork independent state; regenerating a swipe restores state as of that branch point.
- State is invisible in the chat text — ideal for hidden game state (decks, scores, flags) the model shouldn't see unless you choose to show it.
- Keep `state` JSON-shaped (plain tables, strings, numbers) so it round-trips cleanly. Scripts that never touch `state` store no snapshot.

The snapshot key is the adapter's id — `custom:<id>` for Type A, `character-backend:<characterId>` for Type B — so a card script's state is namespaced per character.

## Requesting Tools from Lua

While a custom backend is active, **no tool schemas are advertised** — the script owns the turn and decides everything itself. But a blocking return may *request* tool execution:

```lua
return {
  text = "Let me say that out loud.",
  toolCalls = {
    { name = "speak", arguments = { text = "Hello, traveler." } },
    -- id is optional; defaults to lua_call_<n>
  },
}
```

- Calls execute through the **normal tool registry** — built-in tools like `speak` or `generate_image`, and your own enabled toolsets, all work. Results become `tool_result` content parts on the latest assistant message, including media (audio/image attachments) exactly as if the model had called the tool.
- The follow-up round **re-enters `generate()`** with the tool results in the rebuilt prompt. Detect these continuation rounds by inspecting `prompt.messages` for the tool results — your script decides what happens next.
- The tool loop is round-capped like any backend (see [Tools](./tools.md)).

## Group Chats

- **Type B scripts answer only their own character's turns.** Backend resolution happens per speaking character, so the card-coupled script wraps generations for its character and leaves every other member of the group on the plain active config. The script's state is likewise per character.
- **Type A applies to every speaker** — it's the chat's active backend, whoever is talking.
- Use `ctx.characterId` when a script needs to know whose turn it's answering.

## Dry-Run Testing

Both editors embed a **Test (dry run)** panel that runs your current (even unsaved) source against a **recording delegate** — nothing touches the network or a real backend:

- **Sample Input** — a user message, fed to the script as the last prompt message. In the character editor, the character's description and first message are woven into the sample prompt too.
- **State (JSON, optional)** — a canned state snapshot, restored as the `state` global exactly like a real turn.
- **Delegate Response (optional)** — canned text returned by every `backends.generate()` call.

The result shows the script's **Output**, **Reasoning**, token usage, every **Delegation** your script made (target id and the exact prompt it would have sent), and **State Out** — the snapshot a real turn would persist. The **Use as state for next run** button feeds it back into the state field, so you can walk a multi-turn game loop turn by turn.

> **Note:** `__passthrough` is refused in a dry run — there is no real backend to stream from. Test passthrough middleware by dry-running the blocking path, then trying it live.

The same mechanism is available to the AI through the workbench `run` verbs, so you can ask the model to iterate on a script for you:

- `run {"verb": "test_custom_backend", "args": {"id?|luaSource?": ..., "input": ..., "state?": ..., "delegateResponse?": ...}}`
- `run {"verb": "test_backend_logic", "args": {"characterId": ..., "input": ..., "luaSource?": ..., "state?": ..., "delegateResponse?": ...}}`

See [The Workbench](./workbench.md#run-verbs) for the full verb list.

## Portability: Shared Cards and Local Ids

A `delegateConfigId`, and any explicit id passed to `backends.generate("<id>", …)`, refers to a backend config row **on your install** — the id means nothing on anyone else's. Therefore:

- **Cards you plan to share should delegate by default**: `backends.generate(prompt)`. For a Type B card script, the default delegate is the *recipient's own active backend*, so the card works wherever it's imported.
- **Explicit ids are for single-install setups only** — personal simulator rigs with a fixed main + auxiliary model pair.
- Type B scripts travel inside the card (`extensions.contextualBackend`) and export with it; remember that `enabled` stays opt-in on the recipient's side too.

## Limits

- **`generate()` execution timeout: 10 minutes** — simulator backends legitimately run long across sub-generations. Cancelling a generation relies on this timeout inside the VM.
- **`list_models()` timeout: 10 seconds.**
- **Delegation depth cap: 4.** Custom → custom chains (a script delegating to a config that is itself Custom (Lua)) are allowed, but deeper than 4 levels errors out instead of hanging the turn — check for delegation cycles if you hit it.
- Everything else about failure is fail-loud: Lua errors, timeouts, and empty returns all surface as backend errors.

## Tips & Gotchas

- **Check `ctx.generationType` before acting on input.** A `regenerate` or `continue` re-runs your script over the same history — a command handler that doesn't check will re-fire the captured command.
- **`pcall` your delegations** if the script can do anything useful with a backend failure; an unrecovered throw ends the turn with an error.
- **Strip your own chrome.** If your script answers commands locally, filter those command messages (and your acknowledgements) out of the delegated prompt, or the writer model will start imitating the protocol.
- **Interactive greetings need no modals.** Emit `<button data-post-response="/hard">Hard mode</button>` in reply text; a click posts `/hard` as the user's next message, and your script intercepts it like a typed command. Buttons survive the default (permissive) HTML sanitization; the strict sanitization setting strips them.
- **Dry-run before enabling.** The **Test (dry run)** panel shows the exact prompt your script would delegate — most "the model ignores my game rules" bugs are visible there in one run.
- **A dry run restores state exactly like a real turn**, so you can reproduce "state desynced after regenerate" bugs by pasting the snapshot from an earlier **State Out** into the state field.
- **The `docs` tool knows this contract.** Enabling the built-in Docs template lets the model pull the `custom_backends` reference before writing or debugging a script for you — see [Tools](./tools.md).

## See Also

- [The Workbench](./workbench.md) — `/custom-backends/`, `backend_logic.lua`, and the `test_custom_backend` / `test_backend_logic` verbs
- [Tools & Lua Templates](./tools.md) — the tool registry your `toolCalls` execute through, and the shared branch-aware state protocol
- [Request Scripts](./request-scripts.md) — the lighter-weight Lua layer that only rewrites the outgoing HTTP request
- [Lua Scripting](./lua-scripting.md) — sandbox model, `json`/`base64`/`fetch`, and Lua basics
- [Macro System](./macros.md) — `{{getvar}}` / `{{setvar}}` for values prompts and lorebooks must read
