# Lua Scripting

tamari uses Lua 5.4 (via WebAssembly) for scripting. Scripts run server-side in a sandboxed environment with a 5-second execution timeout.

There are three ways to use Lua scripts:

1. **Quick Reply Scripts** — Run when you click a Quick Reply button. Have full access to the `st` API.
2. **Backend Request Scripts** — Transform HTTP requests before they are sent to the AI provider.
3. **Tool Scripts (`run_lua`)** — The AI can call the `run_lua` tool to execute Lua during generation. These run in the same sandbox but **do not** have access to the `st` API — only `math`, `string`, `table`, and basic functions are available.

## Security Model

Lua scripts run in an isolated sandbox with the following restrictions:

- Dangerous standard libraries are removed: `io`, `os`, `debug`, `package`, `require`, `loadfile`, `dofile`, `load`, `loadstring`
- Proxy access is disabled
- Execution timeout: **5 seconds**
- Request scripts have additional SSRF protection (cannot request private IPs or non-HTTP(S) URLs; loopback is allowed when the configured backend is itself loopback, e.g. a local llama.cpp)

**Per-template sandbox flags:** DB-stored *Lua Tool Templates* (not `run_lua`, not Quick Replies) can individually re-enable `io`, `os`, `debug`, and `require`/`package` via the checkboxes in the template editor. Two further flags unlock media/API tooling:

- **`allowNet`** — exposes an async `fetch(url, opts?)` global (`opts`: `method`, `headers`, `body`). Await it with wasmoon's promise support: `local res = fetch(url):await()`. Returns `{ status, headers, body, bodyBase64 }` — `body` is the UTF-8 text (or `null` for binary), `bodyBase64` always holds the raw bytes. Requests are SSRF-guarded: loopback is allowed (local media servers like Forge/Silero are the point), other private/LAN ranges are blocked. 30s timeout, 25MB body cap.
- **`allowFiles`** — exposes `attachments.create(base64Data, mimeType)`, awaited the same way: `local att = attachments.create(b64, "image/png"):await()` → `{ id, url, mimeType }`. Saves the file under `files/attachments/` and registers it as a chat attachment.
- **`allowSt`** — exposes a **curated subset of the `st` API** (the same API Quick Reply scripts get) as the global `st`. One rule: *queries, entity writes, variables/state, settings, quiet generation, and utilities are in; chat actions are out.* Concretely: `st.get_messages`, `st.create_character`, `st.update_character`, `st.setvar`/`st.getvar`, `st.set_state`/`st.get_state`, `st.wi_add`/`st.wi_list`/`st.wi_get`/`st.wi_remove`, `st.get_setting`/`st.set_setting`, `st.get_model`/`st.set_model`, `st.generate`/`st.genraw`/`st.ask`/`st.sysgen` (quiet one-shot generation), `st.toast`, `st.token_count`, `st.substitute_macros`, and the string/math helpers are available. Excluded: anything that mutates the running chat's message history or drives generation flow (`st.send`, `st.trigger`, `st.regenerate`, `st.continue`, `st.impersonate`, `st.stop`, `st.edit`, `st.cut`, `st.swipe`, `st.add_swipe`, `st.comment`, `st.send_as`, `st.send_narrator`, …) and chat lifecycle (`st.branch`, `st.checkpoint`, `st.hard_fork`, `st.new_chat`, `st.delete_chat`, `st.reset_chat`) — a tool runs *inside* an active generation, which owns the chat during its turn. Async functions return promises — await them with `st.await(...)` (or `promise:await()`); `st.sleep` and `st.generate` are pre-wrapped. `st` is only available when the tool executes in a real chat context — which includes `luatool_test`, so you can iterate on st-enabled templates live.

Notes on what you get (wasmoon, not native Lua):

- `io` works on an **in-memory filesystem that only exists for one execution** — `io.open` write→read round-trips within a single run, but nothing persists between runs, and there is no stdin.
- `os` provides `time`, `clock`, `date`, `getenv` (a fake WASM env), etc. **`os.execute` and `os.exit` always stay blocked** — they abort the WASM engine in ways Lua's `pcall` cannot catch.
- `require` can only load modules the script itself registered in `package.preload` (or wrote to the ephemeral FS) during the same execution.
- `base64.encode` / `base64.decode` are always available (no flag needed), like `json` — Lua strings are byte strings, so binary round-trips safely.
- `json.encode(value)` / `json.decode(text)` are always available. `json.decode` throws on invalid input; `json.parse_result(text)` is the non-throwing variant — it returns `{ value = <decoded> }` on success and `{ error = <message> }` on failure, so scripts can pattern-match instead of `pcall`ing (handy when consuming structured LLM output, which is often malformed).
- One exception to the stripped `require`: **card-coupled backend scripts** (Type B custom backends) get a sandboxed `require` that resolves against the card's own virtual filesystem (`backend_logic/` in the workbench) — see [Custom Backends](./custom-backends.md). Everywhere else `require` stays removed.
- These flags exist so *you* can give *your own* templates more power. The AI cannot set them; `run_lua` (where the AI writes the code) always runs fully sandboxed.

### Returning media from a tool

A tool's `execute` may return a table whose `content` is an **array of inline parts**, combining text with the attachment convention (`{{attachment::ID}}`) and media parts:

```lua
function Tool.execute(args, context, toolName)
  local res = fetch(config.url .. "/v1/audio/speech", { method = "POST", body = json.encode({ input = args.text }) }):await()
  local att = attachments.create(res.bodyBase64, "audio/mpeg"):await()
  return {
    content = {
      { type = "text",  text = "Generated speech: {{attachment::" .. att.id .. "}}" },
      { type = "audio", source = att.url, mimeType = "audio/mpeg" },
    },
    extra = { attachmentId = att.id },
  }
end
```

The seeded `lua_forge_image` template is a complete reference implementation (a Lua port of the built-in Forge image generator).

## Quick Reply Scripts

Quick Replies are buttons that execute Lua scripts. They are defined per-character or globally and can manipulate the chat, trigger generations, modify settings, and more.

### How to Create a Quick Reply

1. Open a character's settings or global Quick Replies
2. Create a new Quick Reply button
3. Write your script in the editor — Quick Replies are always Lua, there is no language selection

### Basic Example

```lua
-- Send a message and trigger the AI to respond
st.send("*looks around nervously*")
st.trigger()
```

### Script Context

Quick Reply scripts run within the context of the **current chat**. All `st` API functions operate on this chat automatically.

Only **one script or generation** can run on a chat at a time. If you click a Quick Reply while a generation is in progress, the script will wait until the chat is free.

## Backend Request Scripts

Every backend adapter (OpenAI, Claude, Gemini, Llama.cpp, etc.) supports an optional Lua script that transforms the outgoing HTTP request before it is sent.

### Use Cases

- Adding custom authentication headers
- Modifying the request body for provider-specific features
- Rewriting the URL for proxy services
- Injecting dynamic parameters

### The `request` Table

The script receives a global `request` table with these fields:

| Field | Type | Description |
|-------|------|-------------|
| `request.url` | string | The full request URL |
| `request.method` | string | HTTP method (usually `POST`) |
| `request.headers` | table | Request headers |
| `request.body` | table | The JSON body as a Lua table |

### Example: Custom Header

```lua
request.headers["X-Custom-Auth"] = "my-secret-token"
```

### Example: Azure OpenAI Body Transformation

```lua
-- Azure OpenAI requires 'api-version' in the URL and a different body shape
request.url = request.url .. "?api-version=2024-06-01"
request.body["data_sources"] = {
  {
    type = "azure_search",
    parameters = {
      endpoint = "https://my-search.search.windows.net",
      index_name = "my-index",
      authentication = {
        type = "api_key",
        key = "..."
      }
    }
  }
}
```

> **Note:** The `request.body` is a Lua table. Modify it directly — it will be serialized back to JSON automatically.

> **Timeout:** Request scripts run with a 5-second execution limit. A runaway script (e.g. an accidental `while true do end` loop) fails the generation with a request-script error instead of hanging the server.

### Testing Scripts with the Workbench

The **workbench** built-in tool template (see [Tools & Lua Templates](./tools.md) and [The Workbench](./workbench.md)) lets the AI edit and test backend configs — including request scripts — on its own, through a filesystem-style surface. Two things to know up front:

- **Enable the `docs` toolset alongside it.** The workbench can edit anything, but the model only knows field names and contracts if it can fetch the feature references — the `docs` tool is what provides them.
- **Collections can't be listed.** The workbench has no way to enumerate backend configs, characters, or toolsets — you must provide the ID yourself (paste it into chat, or name the entity so the model can get the id from chat context). See [The Workbench — No-Discovery Rule](./workbench.md).

The intended loop is:

1. `read /backends/<id>.json` — read the current config (`apiKey` is redacted to `hasApiKey`).
2. `run {"verb":"test_backend","args":{"mode":"dry","patch":{...}}}` — builds the exact HTTP request the adapter would send and applies the request script, returning the `before`/`after` URL, headers, and body (credentials scrubbed) without sending anything.
3. `run {"verb":"test_backend","args":{"mode":"live",...}}` — fires a minimal real request (30s timeout) and returns the model's reply or the upstream error.
4. `write /backends/<id>.json` — persist the patch once the test is green.

The `patch` in `test_backend` is applied **in memory only**, so iterating on a broken script never dirties the saved config. In both `test_backend` patches and `write`, `providerParams` is shallow-merged into the existing record — editing `requestScript` does not clobber sampler keys.

## The `st` API Reference

All Quick Reply scripts have access to the global `st` table. Functions are categorized below.

> **Naming convention:** snake_case is the canonical form (`st.get_character_id`, `st.set_system_prompt`). A handful of older camelCase hybrids — `get_characterId`, `get_personaId`, `get_characterName`, `set_systemPrompt`, `get_systemPrompt` — still work as deprecated aliases so existing scripts keep running; prefer the snake_case names in new scripts.

> **Async note:** Functions marked with ⏳ return Promises. In Lua, you can call them with `await` (provided by wasmoon) or they will auto-resolve in most contexts.

### Chat Actions

| Function | Description |
|----------|-------------|
| `st.send(text)` ⏳ | Send a user message in the current chat |
| `st.continue()` ⏳ | Continue the last assistant message |
| `st.impersonate()` ⏳ | Generate text as the user |
| `st.regenerate()` ⏳ | Regenerate the last assistant message |
| `st.swipe("left" \| "right")` ⏳ | Switch to previous/next swipe |
| `st.cut(count)` ⏳ | Delete the last N messages |
| `st.stop()` ⏳ | Stop the active generation |
| `st.reset_chat()` ⏳ | Delete all messages in the current chat |
| `st.trigger()` ⏳ | Trigger the AI to generate a response |
| `st.delay(ms)` ⏳ | Wait for N milliseconds |
| `st.rename_chat(name)` ⏳ | Rename the current chat |
| `st.delete_chat()` ⏳ | Delete the current chat |
| `st.new_chat(name?)` ⏳ | Create a new chat with the same character |
| `st.temp_chat(name?)` ⏳ | Create a temporary empty chat |
| `st.branch(messageId, name?)` ⏳ | Soft-fork the chat at a message (new chat, shared history) |
| `st.checkpoint(name?)` ⏳ | Soft-fork at the current head |
| `st.hard_fork(messageId, name?)` ⏳ | Hard-fork the chat (copies history) |

### Sending Messages As Other Roles

| Function | Description |
|----------|-------------|
| `st.send_as(name, content)` ⏳ | Send a message as a specific character |
| `st.send_narrator(name, content)` ⏳ | Send a narrator/system message |
| `st.send_narrator(content)` ⏳ | Send as "Narrator" |
| `st.comment(content)` ⏳ | Add a hidden comment message |

### Message Editing

| Function | Description |
|----------|-------------|
| `st.edit(messageId, content)` ⏳ | Edit a message's content |
| `st.delete(messageId)` ⏳ | Delete a message |
| `st.hide(messageId)` ⏳ | Hide a message from the UI |
| `st.unhide(messageId)` ⏳ | Unhide a message |
| `st.set_message_role(messageId, role)` ⏳ | Change role (`user`, `assistant`, `system`) |
| `st.add_swipe(content, switchTo?)` ⏳ | Add a swipe to the active assistant message |
| `st.set_active_child(messageId)` ⏳ | Switch to a different swipe |
| `st.set_message_extra(messageId, key, value)` ⏳ | Set a key in message.extra |
| `st.get_message_extra(messageId, key)` ⏳ | Get a value from message.extra |

### Queries

| Function | Returns | Description |
|----------|---------|-------------|
| `st.get_messages(limit?)` ⏳ | `Message[]` | Get messages in the active branch |
| `st.get_chat()` ⏳ | `Chat` | Get current chat info |
| `st.get_chat_name()` ⏳ | `string` | Get chat name |
| `st.get_message_by_id(id)` ⏳ | `Message \| null` | Get a specific message |
| `st.get_message_count()` ⏳ | `number` | Total messages in active branch |
| `st.get_last_message()` ⏳ | `Message \| null` | The most recent message |
| `st.get_head()` ⏳ | `Message \| null` | The root message |
| `st.get_active_child()` ⏳ | `Message \| null` | The current active message (swipe) |
| `st.get_children(messageId)` ⏳ | `Message[]` | Child messages (swipes/alternatives) |
| `st.get_siblings(messageId)` ⏳ | `Message[]` | Sibling messages |
| `st.get_message_chain(messageId)` ⏳ | `Message[]` | Full parent chain up to root |
| `st.get_swipes()` ⏳ | `Message[]` | All swipes for the current head |
| `st.get_message_at(index)` ⏳ | `Message \| null` | Message by index (negative = from end) |
| `st.get_message_index(messageId)` ⏳ | `number \| null` | Index of a message |
| `st.find_message_by_content(search)` ⏳ | `Message \| null` | Find first matching message |
| `st.find_messages_by_role(role)` ⏳ | `Message[]` | All messages with role |
| `st.messages_as_text(separator?)` ⏳ | `string` | All messages formatted as text |
| `st.get_message_texts()` ⏳ | `string[]` | Just the content strings |

**Message object shape:**
```lua
{
  id = 123,
  parentId = 122,      -- null for root message
  role = "assistant",  -- "user", "assistant", or "system"
  content = "Hello!",
  extra = {},          -- table with reasoning, characterId, etc.
  createdAt = 1715097600
}
```

### Character & Persona

| Function | Description |
|----------|-------------|
| `st.get_characters()` ⏳ | List all characters |
| `st.find_character(name)` ⏳ | Find a character by name |
| `st.get_character(id)` ⏳ | Get full character data |
| `st.get_character_id()` ⏳ | Current chat's character ID (`st.get_characterId()` is a deprecated alias) |
| `st.get_character_name()` ⏳ | Current chat's character name (`st.get_characterName()` is a deprecated alias) |
| `st.set_character(id)` ⏳ | Change the chat's character |
| `st.get_personas()` ⏳ | List all personas |
| `st.get_persona(id)` ⏳ | Get a persona |
| `st.set_persona(id)` ⏳ | Change the active persona |
| `st.get_persona_id()` ⏳ | Current chat's persona ID (`st.get_personaId()` is a deprecated alias) |
| `st.set_system_prompt(characterId, text)` ⏳ | Set a character's system prompt (`st.set_systemPrompt()` is a deprecated alias) |
| `st.get_system_prompt(characterId)` ⏳ | Get a character's system prompt (`st.get_systemPrompt()` is a deprecated alias) |
| `st.create_character(data)` ⏳ | Create a character. `data.name` required; optional fields: `description`, `personality`, `scenario`, `firstMes`, `mesExample`, `tags`, `systemPrompt`, `postHistoryInstructions`, `creatorNotes`. Throws if the name already exists. Returns `{ id, name }` |
| `st.update_character(characterId, patch)` ⏳ | Patch a character (same field whitelist as `create_character`, plus `name` to rename — fails if another character already has that name) |
| `st.add_chat_member(characterId)` ⏳ | Add a character to the current group chat (throws in a single-character chat) |
| `st.remove_chat_member(characterId)` ⏳ | Remove a character from the current group chat |

**Character object shape:**
```lua
{
  id = "uuid",
  name = "Seraphina",
  description = "...",
  personality = "...",
  scenario = "...",
  firstMes = "...",
  mesExample = "...",
  creatorNotes = "...",
  systemPrompt = "...",
  postHistoryInstructions = "...",
  extensions = {}
}
```

### Tags

| Function | Description |
|----------|-------------|
| `st.tag_add(characterId, tag)` ⏳ | Add a tag to a character |
| `st.tag_remove(characterId, tag)` ⏳ | Remove a tag |
| `st.tag_list(characterId)` ⏳ | Get all tags for a character |

### Settings & Presets

| Function | Description |
|----------|-------------|
| `st.get_setting(key)` ⏳ | Get a setting value |
| `st.set_setting(key, value)` ⏳ | Set a setting value |
| `st.get_settings()` ⏳ | Get all settings as a table |
| `st.get_presets()` ⏳ | List all presets |
| `st.get_preset(id)` ⏳ | Get preset details |
| `st.set_preset(id)` ⏳ | Activate a preset |
| `st.get_model()` ⏳ | Get current model name |
| `st.set_model(name)` ⏳ | Set model name |
| `st.get_apiUrl()` ⏳ | Get API URL |
| `st.set_apiUrl(url)` ⏳ | Set API URL |
| `st.get_temperature()` ⏳ | Get temperature of the active backend config (falls back to the legacy `temperature` setting when no config is active) |
| `st.set_temperature(value)` ⏳ | Set temperature on the active backend config (writes the legacy `temperature` setting only when no config is active) |
| `st.get_maxTokens()` ⏳ | Get max tokens |
| `st.set_maxTokens(value)` ⏳ | Set max tokens |
| `st.get_contextLength()` ⏳ | Get context length |
| `st.set_contextLength(value)` ⏳ | Set context length |
| `st.get_backend()` ⏳ | Get backend provider ID |
| `st.set_backend(provider)` ⏳ | Set backend provider |

### Variables

Variables are chat-scoped and persisted in the database.

| Function | Description |
|----------|-------------|
| `st.setvar(name, value)` ⏳ | Set a variable |
| `st.getvar(name)` ⏳ | Get a variable (returns `nil` if not set) |
| `st.clear_variables()` ⏳ | Delete all variables for this chat |
| `st.get_variables()` ⏳ | Get all variables as a table |

#### Meta state

Meta state is **out-of-fiction** storage backed by the `extension_data` table. Unlike `setvar`/`getvar` and tool `_toolState` — which live in the message tree and **fork with branches/swipes** — meta state does *not* fork: it is scoped to the chat (or globally) and is shared by every branch of that chat. Use it only for out-of-fiction data (UI preferences, cross-route unlocks, bookkeeping), never for world state that should follow the parallel-universe semantics of swipes and branches. No broadcasts are sent on mutation (no client consumes it); scripts needing reactivity should use `st.set_chat_metadata` instead.

| Function | Description |
|----------|-------------|
| `st.set_state(namespace, data)` ⏳ | Store a table under a namespace (non-empty string, max 100 chars), scoped to the current chat. Max 64 KB serialized |
| `st.get_state(namespace)` ⏳ | Get chat-scoped meta state (returns `nil` if not set) |
| `st.delete_state(namespace)` ⏳ | Delete chat-scoped meta state |
| `st.set_global_state(namespace, data)` ⏳ | Store meta state globally (shared across all chats) |
| `st.get_global_state(namespace)` ⏳ | Get global meta state (returns `nil` if not set) |

### Author's Note

| Function | Description |
|----------|-------------|
| `st.set_author_note(content, opts?)` ⏳ | Set Author's Note |
| `st.get_author_note()` ⏳ | Get Author's Note config |

`opts` is optional and can contain:
- `depth` (number, default 4) — how many messages back to inject
- `interval` (number, default 1) — how often to inject (1 = every turn)
- `position` (string, default `"in_chat"`) — `"before_prompt"`, `"after_prompt"`, or `"in_chat"`
- `role` (string, default `"system"`) — `"system"`, `"user"`, or `"assistant"`

### Chat Metadata

| Function | Description |
|----------|-------------|
| `st.set_chat_metadata(key, value)` ⏳ | Store arbitrary data on the chat |
| `st.get_chat_metadata(key)` ⏳ | Retrieve chat metadata |
| `st.get_chats(characterId?)` ⏳ | List chats (optionally filtered by character) |

### Reasoning

| Function | Description |
|----------|-------------|
| `st.get_reasoning(messageId)` ⏳ | Get reasoning text for a message |
| `st.set_reasoning(messageId, text)` ⏳ | Set reasoning text |
| `st.clear_reasoning(messageId)` ⏳ | Remove reasoning |
| `st.get_generation_info(messageId)` ⏳ | Get model, token count, generation time. Returns `{ model, token_count, generation_time, api }` plus camelCase duplicates `tokenCount` and `generationTime` |

### World Info

Operates on the lorebook linked to the current chat's character.

| Function | Description |
|----------|-------------|
| `st.wi_list()` ⏳ | List all entries |
| `st.wi_get(key)` ⏳ | Find entry by key (case-insensitive) |
| `st.wi_add(keys, content)` ⏳ | Add a new entry (`keys` is comma-separated) |
| `st.wi_remove(key)` ⏳ | Remove entry by key |

### Macros

| Function | Description |
|----------|-------------|
| `st.substitute_macros(text)` ⏳ | Resolve `{{...}}` macros in a string using current chat context |

Example:
```lua
local greeting = st.substitute_macros("Hello {{user}}, I am {{char}}!")
-- greeting == "Hello Alice, I am Seraphina!"
```

### UI

| Function | Description |
|----------|-------------|
| `st.toast(message, level?)` | Show a toast notification |

Levels: `info`, `success`, `error`, `warning`. Default is `info`.

Example:
```lua
st.toast("Script finished!", "success")
```

### Text Utilities

| Function | Description |
|----------|-------------|
| `st.token_count(text)` | Count tokens in text |
| `st.count_tokens(text)` | Alias for `token_count` |
| `st.trim_tokens(text, limit)` | Trim text to fit within token limit |
| `st.upper(text)` | Uppercase |
| `st.lower(text)` | Lowercase |
| `st.replace(text, search, replacement)` | String replacement |
| `st.replace_regex(text, pattern, replacement)` | Regex replacement (global) |
| `st.match(text, pattern)` | Regex match, returns array of matches |
| `st.test(text, pattern)` | Regex test, returns boolean |
| `st.substring(text, start, end?)` | Substring extraction |
| `st.trim_start(text)` | Trim to first sentence-ending punctuation |
| `st.trim_end(text)` | Trim after last sentence-ending punctuation |
| `st.random(min?, max?)` | Random integer (default 0–100) |
| `st.now()` | Current Unix timestamp |
| `st.join(array, separator?)` | Join array (default `,`) |
| `st.split(text, separator?)` | Split string (default `,`) |
| `st.includes(text, search)` | Contains check |
| `st.starts_with(text, prefix)` | Starts with check |
| `st.ends_with(text, suffix)` | Ends with check |
| `st.json_encode(value)` | JSON encode |
| `st.json_decode(text)` | JSON decode |
| `st.abs(n)` | Absolute value |
| `st.floor(n)` | Floor |
| `st.ceil(n)` | Ceiling |
| `st.round(n)` | Round |
| `st.clamp(n, min, max)` | Clamp between min and max |
| `st.array_wrap(value)` | Wrap value in array `{value}` |
| `st.array_unwrap(array)` | Get first element |
| `st.pass(value)` | Identity function |
| `st.is_empty(value)` | Check if nil, empty string, empty array, or empty object |
| `st.len(value)` | Length of string or array |

## Examples

### Dynamic Greeting Based on Time

```lua
local hour = tonumber(os.date("%H"))
local greeting

if hour < 12 then
  greeting = "Good morning"
elseif hour < 18 then
  greeting = "Good afternoon"
else
  greeting = "Good evening"
end

st.send(greeting .. ", {{char}}!")
```

### Roll for Initiative

```lua
local roll = st.random(1, 20)
st.send("*rolls a d20* " .. roll)

if roll >= 15 then
  st.toast("Critical success!", "success")
else
  st.toast("Better luck next time", "info")
end
```

### Branching Story Based on Variable

```lua
local choice = st.getvar("story_branch")

if choice == nil then
  st.send("You stand at a crossroads. Left or right?")
  st.setvar("story_branch", "pending")
elseif choice == "pending" then
  st.send("You haven't decided yet...")
elseif choice == "left" then
  st.send("You take the left path into the dark forest.")
  st.setvar("story_branch", "forest")
elseif choice == "right" then
  st.send("You take the right path toward the castle.")
  st.setvar("story_branch", "castle")
end
```

### Switch Model Mid-Chat

```lua
st.set_model("claude-opus-4")
st.set_temperature(0.8)
st.toast("Switched to Claude Opus", "success")
st.trigger()
```

### Export Chat to File (via metadata)

```lua
local msgs = st.get_messages(100)
local texts = {}
for i, msg in ipairs(msgs) do
  table.insert(texts, msg.role .. ": " .. msg.content)
end
local export = st.join(texts, "\n\n")

st.set_chat_metadata("last_export", export)
st.toast("Chat exported to metadata!", "success")
```

### Repair Broken Chat Tree

```lua
st.repair_active_child()
st.toast("Chat tree repaired", "success")
```

## Lua Tool Templates

In addition to Quick Reply scripts, you can write **Lua Tool Templates** that define multiple related tools sharing persistent state. These are managed in the **Tools** modal (sidebar → Tools).

### Template Structure

A Lua tool template returns a `Tool` table with three required functions:

```lua
Tool = {}
Tool.state = {}

function Tool.getDefinition()
  return {
    stateKey = "my_template_state",
    configSchema = {},
    tools = {
      {
        name = "remember",
        description = "Store a fact in memory.",
        parameters = {
          type = "object",
          properties = {
            fact = { type = "string", description = "The fact to remember" }
          },
          required = {"fact"}
        }
      },
      {
        name = "recall",
        description = "Recall a stored fact.",
        parameters = {
          type = "object",
          properties = {},
          required = {}
        }
      }
    }
  }
end

function Tool.execute(args, context, toolName)
  if toolName == "remember" then
    table.insert(Tool.state, args.fact)
    return { content = "Got it." }
  elseif toolName == "recall" then
    return { content = table.concat(Tool.state, ", ") }
  end
end

function Tool.serialize()
  return json.encode(Tool.state)
end

function Tool.deserialize(raw)
  Tool.state = json.decode(raw)
end

return Tool
```

### Key Concepts

| Concept | Description |
|---------|-------------|
| `stateKey` | A unique identifier for this template's shared state. All tools in the same template share the same state object. |
| `configSchema` | JSON Schema for global configuration (e.g., API keys, default values). Shown as a form when creating a toolset. |
| `tools` | Array of tool definitions. Each has `name`, `description`, and optional `parameters` (JSON Schema). Each may also set `endsTurn = true` to end the generation turn after that tool executes successfully — no follow-up generation round runs, so the tool result (e.g. the `lua_choices` choice buttons) is the last word of the turn. The result is still saved and rendered normally. |
| `execute(args, context, toolName)` | Called when the AI invokes any tool in this template. `toolName` tells you which one. |
| `serialize()` / `deserialize(raw)` | Persist/restore `Tool.state` across invocations. State is stored in message history, so it's branch-aware. |

### `context` Table

The `context` argument passed to `execute()` contains:

| Field | Type | Description |
|-------|------|-------------|
| `context.chatId` | `string` | The current chat ID |
| `context.config` | `table` | The toolset's global config values (from `configSchema`) |
| `context.messages` | `table` | Recent message history (for state scanning) |

### State Persistence

State is automatically saved after each tool execution into the `tool_result` message's `extra._toolState`. On the next execution, the runtime calls `deserialize()` with the most recent state from the current chat branch. This means:

- **Forking a chat** creates independent state — the new branch starts with whatever state existed at the fork point.
- **Swiping** does not lose state — the state is tied to the message history, not the chat head.

### Built-in Templates

tamari ships with built-in tool templates that don't require Lua — the **workbench** (filesystem-style editing of characters, backends, toolsets, quick replies, and Lua tools), **docs**, **assets**, **scene**, **agent**, **lua_runner**, **speak**, **forge_image**, **memory**, and **chat_workbench** — plus a set of seeded Lua templates (dice, time, map, choices, and more) that serve as reference implementations.

For the full catalog with every tool name and config option, see [Tools & Lua Templates](./tools.md). For the workbench's path layout and `run` verbs, see [The Workbench](./workbench.md).

Built-in templates are hardcoded in TypeScript and cannot be edited, but you can create toolsets from them with custom config and overrides.

---

## Tool Scripts (`run_lua`)

When the AI is given access to the `run_lua` tool (via **Tools** in the sidebar), it can execute Lua scripts during generation. This is useful for:

- Performing calculations (e.g., complex dice rolls, math)
- Transforming or formatting text
- Generating structured data

`run_lua` is a single built-in tool that executes arbitrary Lua. It is **not** the same as a Lua Tool Template:

| | Lua Tool Template | `run_lua` tool |
|---|---|---|
| **Purpose** | Define a reusable set of related tools with shared state | One-off arbitrary script execution |
| **Defines tools** | Yes (`getDefinition().tools`) | No — it's a single tool |
| **Shared state** | Yes (`serialize()` / `deserialize()`) | No — stateless |
| **`st` API** | ❌ Not available | ❌ Not available |
| `math`, `string`, `table` | ✅ | ✅ |
| `io`, `os`, `debug` | ⚠️ Stripped by default; per-template opt-in via sandbox flags | ❌ Stripped |
| `fetch` (network) | ⚠️ Per-template opt-in (`allowNet`), SSRF-guarded | ❌ Not available |
| `attachments.create` (files) | ⚠️ Per-template opt-in (`allowFiles`) | ❌ Not available |
| `st` API | ⚠️ Per-template opt-in (`allowSt`) — curated subset, chat actions excluded | ❌ Not available |
| Timeout | 5 seconds | 5 seconds |
| Trigger | AI calls any tool from the template | AI calls `run_lua` specifically |

### Example: What the AI Might Send

```json
{
  "name": "run_lua",
  "arguments": {
    "script": "return math.random(1, 20)"
  }
}
```

The tool returns the string representation of the last expression. Tables are JSON-serialized.

---

## Error Handling

If a script throws an error, you'll see a toast notification with the error message. Common errors:

- `"Chat is busy"` — Another script or generation is running on this chat
- `"Script aborted"` — The stop button was pressed
- `"Expected string"` / `"Expected number"` — Wrong argument type passed to an API function
- `"SSRF blocked"` — Request script tried to access an unsafe URL

## Legacy STScript

tamari **only supports Lua** for scripting. If you have existing Quick Replies using the old STScript syntax, they will not execute. Convert them to Lua using the `st` API.
