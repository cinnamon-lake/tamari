# Tools & Lua Templates

Tools let the AI take actions during a generation: roll dice, generate images, speak text, query memory, edit character cards, and more. tamari ships a catalog of built-in tool templates, and you can write your own in Lua. You manage everything from the **Tools** modal (sidebar → **Tools**).

Two concepts to keep apart:

- **Template** — a definition of one or more tools, plus a config schema. Built-in templates are written in TypeScript; your own templates are written in Lua.
- **Toolset** — an instance of a template with its own config values, per-tool overrides, and an on/off switch. Only tools from **enabled** toolsets reach the model.

## How Tool Calling Works

During a generation, the model receives the definitions of every enabled tool. If it answers with tool calls instead of (or alongside) text, tamari runs a loop:

1. Each tool call executes.
2. The results are appended as `tool_result` parts on the same assistant message.
3. The prompt is rebuilt with the results included.
4. The model generates again — and may call more tools.

The loop runs up to **100 rounds** per generation by default (the `MAX_TOOL_ROUNDS` environment variable on the server), then stops.

- **Errors don't abort the turn.** A failing tool returns an `isError` result the model can see and retry — the loop continues.
- **`endsTurn`.** A tool defined with `endsTurn: true` ends the whole turn after it executes *successfully* — no follow-up round runs. On error the flag is ignored, so the model gets a chance to retry. The seeded `present_choices` tool works this way: it asks you a question and waits for your answer instead of rambling on.
- **Interactive widgets.** Tool results normally render as plain text blocks in the chat. When a result carries an `extra.renderType`, the chat hydrates an interactive widget instead. Registered render types are `dice`, `choices`, `npc_roster`, `scene`, and `map`; anything else falls back to the plain block.

> **Note:** Enablement and tool changes apply on the **next** generation — tools are collected when a generation starts, so toggling a toolset mid-generation has no effect on the one in flight.

## Toolsets

Open the **Tools** modal (sidebar → **Tools**). The left panel, **Toolsets**, lists your toolsets; click **New Toolset** to create one. Expand a toolset's card (the chevron) to edit it. All edits save automatically.

Each toolset has:

- **Name** — a label for you; the model never sees it.
- **Template** — a dropdown of every registered template, built-in and Lua. You can switch a toolset to a different template at any time.
- **Enabled** — the checkbox on the card. Only enabled toolsets advertise tools. Prefer disabling over deleting: your config and overrides are preserved.
- **Sub-agents** — the second checkbox on the card. When on (and the toolset is enabled), the toolset's tools are also advertised to sub-agents spawned by `run_agent`. Default off: sub-agents only get the tools you explicitly allow. At the maximum agent nesting depth (`MAX_AGENT_DEPTH`, default 4) the spawn tool itself is hidden from the sub-agent, so recursion always bottoms out.
- **Configuration** — a form generated from the template's `configSchema`, shown only when the template declares options (for example, the Speak template's provider settings).
- **Tools Available** — the template's tools, each with optional per-tool **overrides**:
  - `name` — rename the tool. **The renamed name is what the model calls.**
  - `description` — replace the model-facing description.
  - `parameterDescriptions` — replace the description of individual parameters.

Overrides are how you shape what the model sees without touching the template itself — rewording a description is often enough to fix a model that misuses a tool.

> **Warning:** If two enabled toolsets expose the same effective tool name, nothing dedupes them — both definitions are advertised, and when the model calls the name, the **first matching toolset wins**. Rename one of the colliding tools with an override to keep things predictable.

Deleting a toolset (trash icon, with confirmation) removes it permanently; there is no undo.

## Built-in Template Catalog

These templates ship with the server. Create a toolset from one, configure it, and enable it.

### Agent (`agent`)

Delegates a task to a sub-agent: a separate, autonomous generation loop with its own tool access, so long reasoning, research, drafting, or multi-step tool work doesn't pollute the main chat history. Sub-agents can themselves call tools (including spawning further agents, capped by depth) and each run writes a traceable generation record linked to its parent.

| Tool | Description |
|------|-------------|
| `run_agent` | Run a sub-agent on a task and return its final text. Args: `prompt` (required — the task), `system` (optional — override the system prompt for this call), `backend` (optional — backend config id for this call). |

Config options (defaults; per-call args override them):

| Option | Description |
|--------|-------------|
| `backendConfigId` | Backend config to use for agent calls. Empty = the main chat backend. |
| `systemPrompt` | System prompt for the agent. Empty = a concise default. |

> **Note:** Nesting is capped by the `MAX_AGENT_DEPTH` env var (default 4) — an agent at the cap gets an error result instead of spawning further agents.

**State sharing.** A sub-agent reads the parent chat's context (branch history and tool state), so stateful tools continue from where the main chat left off. When the sub-agent finishes, the newest state snapshot of each tool it used is written back onto the parent branch as part of the `run_agent` tool result — so the sub-agent's changes to tool state (scene, map, Lua tool state, …) persist in the main chat, and swiping to another version of the spawning message undoes them. Macro variables (`{{setvar}}`) are the exception: they stay isolated per generation and never cross the boundary.

### Asset Lister (`assets`)

| Tool | Description |
|------|-------------|
| `list_assets` | List image assets of the current character (optional `limit`, default 10, max 50). |

No config options.

### Chat Workbench (`chat_workbench`)

Inspect and edit group-chat membership.

| Tool | Description |
|------|-------------|
| `chat_list_members` | List members of a group chat (defaults to the current chat). |
| `chat_add_member` | Add a character to a group chat. |
| `chat_remove_member` | Remove a character from a group chat. |

No config options.

### Docs (`docs`)

Serves tamari's built-in feature references to the model.

| Tool | Description |
|------|-------------|
| `docs` | Fetch the markdown reference for a topic: `characters`, `backends`, `workbench`, `custom_backends`, `request_scripts`, `macros`, `regexes`, `lorebooks`, `prompt_lists`, `toolsets`, `quick_replies`, `chats`. |

No config options. Enable this when you want the model to check the real field names and contracts before editing configs or writing Lua.

### Forge Image Generator (`forge_image`)

Generates images with a local Stable Diffusion WebUI Forge instance.

| Tool | Description |
|------|-------------|
| `generate_image` | Generate an image from a text prompt (`orientation`: `square`/`portrait`/`landscape`; optional `negative_prompt`). The result includes an `{{attachment::ID}}` reference the model can embed to display the image. |

Config options:

| Option | Description |
|--------|-------------|
| `url` | Forge API base URL (default `http://localhost:7860`). |
| `files` | Optional reference images (img2img, ControlNet), passed to the request script as base64. |
| `requestScript` | Lua script that mutates the outgoing HTTP request — see [Request Scripts](./request-scripts.md). |

### Lua Runner (`lua_runner`)

| Tool | Description |
|------|-------------|
| `run_lua` | Execute a one-off Lua script and return its result. Runs fully sandboxed, without the `st` API — see [Lua Scripting](./lua-scripting.md). |

No config options.

### Memory (`memory`)

Works with tamari's rolling memory summaries.

| Tool | Description |
|------|-------------|
| `memory_get_raw` | Retrieve the raw text of past messages by their IDs. |
| `memory_summarize_range` | Get a focused summary of a contiguous range of past messages (optional `focus`). |

No config options.

### Scene (`scene`)

Drives the visual stage: background, character sprites with emotions, and a caption. Results render as an interactive `scene` widget, and the state is branch-aware (see [Branch-aware state](#branch-aware-state)).

| Tool | Description |
|------|-------------|
| `scene_set` | Replace the whole scene — background (an attachment ID or a character asset), sprite roster (`character`, optional `emotion`, `position`: `left`/`center`/`right`), and caption. Anything omitted is cleared. |
| `scene_get` | Get the current scene as text. |

No config options.

### Speak (`speak`)

Text-to-speech. The result includes an `{{attachment::ID}}` audio reference the model can embed so you can play it.

| Tool | Description |
|------|-------------|
| `speak` | Convert text to speech, including natural-language prosody tags the provider supports. |

Config options:

| Option | Description |
|--------|-------------|
| `provider` | **Required.** One of `fishaudio`, `kokoro`, `elevenlabs`, `openai`, `azure`, `minimax`, `volcengine`, `alltalk`, `vits`, `silero`, `gptsovits`. |
| `voiceId` | Voice ID (optional; provider default if empty). For Azure, the voice ShortName (e.g. `en-US-JennyNeural`). |
| `baseUrl` | API base URL (optional). For Azure, the regional host. |
| `apiKey` | API key or a vault reference (`secret:<key>`). Stored as a secret field. |
| `model` | Model ID for OpenAI / ElevenLabs / MiniMax (optional). |
| `appId` | App ID for VolcEngine (optional). |
| `referenceAudio` | Reference audio file for voice cloning (optional). |
| `referenceText` | Transcript of the reference audio — required when `referenceAudio` is set. |
| `requestScript` | Lua script that mutates the outgoing HTTP request — see [Request Scripts](./request-scripts.md). |

### Workbench (`workbench`)

The model-facing filesystem over your characters, backends, toolsets, quick replies, and Lua tool templates (`ls`, `read`, `grep`, `write`, `edit`, `rm`, `run`) — the surface the AI uses to author and test things, including Lua tool templates themselves. See [The Workbench](./workbench.md).

## Seeded Lua Templates

A fresh install also seeds nine Lua templates (editable copies — they're real Lua templates, not built-ins). They appear in the modal's **Lua Templates** panel and in the template dropdown. Enable them by creating a toolset, and read their code for working examples of the contract below.

| Template | Tools | Notes |
|----------|-------|-------|
| `lua_memory` | `set_memory`, `recall_memory`, `forget_memory` | Key-value memories with branch-aware state. |
| `lua_todo` | `add_todo`, `list_todos`, `remove_todo`, `clear_todos` | A shared todo list. |
| `lua_dice` | `roll_dice` | Renders an interactive `dice` widget. |
| `lua_choices` | `present_choices` | Presents 2–6 clickable choices; uses `endsTurn`. |
| `lua_time` | `get_time` | Current date and time. |
| `lua_encouragement` | `encourage` | A random encouraging message. |
| `lua_npc_registry` | `npc_register`, `npc_update`, `npc_get`, `npc_list`, `npc_forget` | Durable NPCs per story branch; renders the `npc_roster` widget. |
| `lua_map` | `map_create`, `map_set_tile`, `map_move`, `map_teleport`, `map_get` | Tile-map exploration with fog of war; renders the `map` widget. |
| `lua_forge_image` | `generate_image_lua` | A Lua port of the Forge image generator; enables `allowNet` + `allowFiles` and is the reference for media results. |

## Authoring Lua Tool Templates

Create a template in the **Lua Templates** panel of the Tools modal (**New Lua Template**), or let the AI write one through the workbench. A template is a Lua script that returns a global `Tool` table.

### The `Tool` table contract

```lua
Tool = {}
Tool.state = {}   -- your persistent state (any JSON-encodable shape)

-- Required. Returns the template definition.
function Tool.getDefinition()
  return {
    stateKey = "my_template_state",  -- namespace for this template's saved state
    configSchema = {},               -- JSON Schema; rendered as the toolset's Configuration form
    tools = {
      {
        name = "my_tool",
        description = "What the model should use this tool for.",
        parameters = {               -- JSON Schema for the tool's arguments
          type = "object",
          properties = {
            input = { type = "string", description = "Input parameter" }
          },
          required = { "input" }
        },
        endsTurn = false             -- optional; true ends the turn after successful execution
      }
    }
  }
end

-- Required. Runs one tool call. Return a string, or a table { content, extra? }.
function Tool.execute(args, context, toolName)
  -- args:    the model's arguments, validated by nothing — check them yourself
  -- context: { chatId, config }  (config = the toolset's Configuration values)
  return { content = "Result: " .. tostring(args.input) }
end

-- Optional. Persist/restore state as a string. json.encode/json.decode are always available.
function Tool.serialize() return json.encode(Tool.state) end
function Tool.deserialize(raw) Tool.state = json.decode(raw) end

return Tool
```

- `getDefinition` and `execute` are required; `serialize`/`deserialize` are optional (omit them for a stateless tool).
- `execute` may also return a plain string — it becomes the result content.
- All tools in one template share the same `stateKey` namespace and the same `Tool.state`.

> **Note:** `context` exposes only `chatId` and `config`. The message history is used internally for state restore but is not passed to your script.

### Branch-aware state

After each execution, tamari calls `serialize()` and stores the string on the tool result's `extra._toolState[stateKey]`. Before the next execution, it scans the **current branch's** message history backwards, finds the newest snapshot for your `stateKey`, and calls `deserialize(raw)` with it. Consequences:

- Forking a chat branch gives each fork independent state.
- Regenerating a swipe doesn't lose state — the snapshot from the surviving branch is the one restored.
- State lives in the chat, not in the template: two chats using the same toolset don't share state.

### Media results

`execute` may return `content` as an **array of inline parts** mixing text and media, and embed attachment references in the text:

```lua
return {
  content = {
    { type = "text",  text = "Here is the image: {{attachment::" .. att.id .. "}}" },
    { type = "image", source = att.url, mimeType = "image/png" },
  },
  extra = { attachmentId = att.id },
}
```

The model is expected to copy the `{{attachment::ID}}` reference into its response to display the media (the built-in and seeded image/audio tools instruct it to do exactly that in their tool descriptions — do the same in yours). Creating attachments from Lua requires the `allowFiles` sandbox flag. See [Lua Scripting](./lua-scripting.md) for the full media contract.

### Sandbox flags

Each Lua template has sandbox checkboxes in its editor (the **Sandbox** section). All off means fully sandboxed.

| Flag | Unlocks |
|------|---------|
| `allowIo` | The `io` library (in-memory, per-execution filesystem — nothing persists). |
| `allowOs` | The `os` library. `os.execute` and `os.exit` always stay blocked. |
| `allowDebug` | The `debug` library. |
| `allowRequire` | `require` / `package` (only modules the script itself registers). |
| `allowNet` | Async, SSRF-guarded `fetch(url, opts)`. |
| `allowFiles` | `attachments.create(base64, mimeType)` for saving media. |
| `allowSt` | A curated subset of the `st` API (queries, entity writes, variables, quiet generation — chat-history mutations and generation flow excluded). |

The flags exist so *you* can empower *your own* templates — the model cannot set them, and `run_lua` always runs fully sandboxed. Details and examples: [Lua Scripting](./lua-scripting.md).

### Broken templates are warn-only

If `getDefinition` throws or returns garbage, the template's tools are silently left out of prompts (the server logs a warning). Nothing crashes — the model just doesn't see the tools. When a toolset seems to do nothing, test the template (below) before assuming the model is at fault.

### Testing with the workbench

With a **Workbench** toolset enabled, ask the model to run your tool: the `run` verb `test_luatool` executes one tool from a stored template or from raw unsaved code, with fresh state — the fastest iterate-fix-retest loop, and the AI can drive it for you. Verb arguments: `{ id? | code?, sandbox?, toolName, args?, config? }`. See [The Workbench](./workbench.md).

## Example: A Complete Lua Template

A minimal mood tracker with two tools, a config option, and branch-aware state:

```lua
Tool = {}
Tool.state = { mood = nil, history = {} }

function Tool.getDefinition()
  return {
    stateKey = "mood_tracker",
    configSchema = {
      type = "object",
      properties = {
        defaultMood = {
          type = "string",
          description = "Mood to report before one has been set.",
          default = "neutral"
        }
      }
    },
    tools = {
      {
        name = "set_mood",
        description = "Record the character's current mood. Use whenever the mood clearly changes.",
        parameters = {
          type = "object",
          properties = {
            mood = { type = "string", description = "One or two words, e.g. 'wary' or 'cautiously hopeful'." }
          },
          required = { "mood" }
        }
      },
      {
        name = "get_mood",
        description = "Get the character's current mood and how often it changed.",
        parameters = { type = "object", properties = {} }
      }
    }
  }
end

function Tool.execute(args, context, toolName)
  local defaultMood = (context.config and context.config.defaultMood) or "neutral"

  if toolName == "set_mood" then
    if type(args.mood) ~= "string" or args.mood == "" then
      return "Error: mood is required"
    end
    Tool.state.mood = args.mood
    table.insert(Tool.state.history, args.mood)
    return { content = "Mood set to: " .. args.mood }
  end

  return {
    content = "Current mood: " .. (Tool.state.mood or defaultMood)
      .. " (" .. #Tool.state.history .. " changes recorded)"
  }
end

function Tool.serialize()
  return json.encode(Tool.state)
end

function Tool.deserialize(raw)
  Tool.state = json.decode(raw)
end

return Tool
```

To use it: create the template in the **Lua Templates** panel, then click **New Toolset**, switch its **Template** dropdown to your template, set **Configuration** if you want a different `defaultMood`, and make sure the toolset's checkbox is enabled. The tools reach the model on the next generation.

## Tips & Gotchas

- **Reword before you rewrite.** If the model misuses a tool, a better `description` override in the toolset often fixes it without touching any code.
- **Renaming has a cost.** A `name` override changes what the model calls — if your character card or preset prompts mention the old name, update them too.
- **Watch for collisions.** Two enabled toolsets exposing the same tool name: first match wins, silently. Use overrides to disambiguate.
- **`get_mood` never changes state — and that's fine.** `serialize()` runs after every execution, so read-only tools simply re-store the same snapshot.
- **Keep state JSON-shaped.** `serialize()` output must be a string, and it round-trips through the message history — stick to plain tables, strings, and numbers via `json.encode`.
- **Sandbox flags are per template.** The seeded `lua_forge_image` is a working example of `allowNet` + `allowFiles` — open it in the Lua Templates panel and read it.
- **The loop has a ceiling.** A tool that always fails can burn all 100 rounds (`MAX_TOOL_ROUNDS`) retrying. Return clear error messages so the model gives up gracefully instead.
