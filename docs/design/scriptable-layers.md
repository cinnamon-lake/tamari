# Scriptable Layers: Custom Backends, Display Transforms, Button Protocol

**Status:** Mostly implemented — the three layers, the forms protocol, and the raw-module porting workflow all landed. Remaining open items are collected in §7. Supersedes nothing; extends the Lua scripting story in `docs/user/lua-scripting.md`.

**Context:** Analysis of RisuAI's module system (`.risum` containers, embedded `module.risum` in CharX, TriggerScript) found a monolithic engine — six event types (`start`/`input`/`output`/`display`/`request`/`manual`), ~140 effect types, allowlists per mode, hidden chat-message IPC, render-time code, and retroactive UI mutation. It is powerful and it is a mess. This document defines tamari's alternative: **three single-purpose layers**, each mapped to an interface that already exists or has one obvious home.

Reference points in the current codebase:

- `server/src/backends/BackendAdapter.ts` — the adapter contract (`stream(prompt, signal) → AsyncGenerator<BackendStreamItem, GenerationResult>`).
- `server/src/backends/factory.ts` — adapter construction from backend-config settings; `requestScript` (Lua that mutates the final HTTP request) is the existing, much weaker precedent.
- `server/src/scripting/LuaRuntime.ts`, `StApi.ts` — the wasmoon runtime and the `st.*` API used by Quick Reply.
- `server/src/services/DisplayRenderer.ts` — the marked + DOMPurify render pipeline (server-side; the former client-side `client/src/lib/markdown.ts` mirror was removed as dead code).
- `present_choices` tool (`server/src/db/seeds/toolTemplateSeeds.ts`) — clickable choices whose selection arrives as the user's next message; the existence proof for the button protocol.

---

## 1. Principles

These are load-bearing. Every design decision below follows from them.

1. **Code runs at generation time or at user action, never at render time.**
   There is no `onStart`, no `onChatOpen`, no display-state engine. Anything such a hook could affect is either (a) what the user sees without generating — that's reactive panel UI, which reads state on its own; or (b) the next prompt — computable lazily at generation time, including "first generation after open" (the backend can compare timestamps or keep a var flag). RisuAI's own `start` triggers confirm this: they do variable initialization (subsumed by default-variable fallback), retroactive display refresh (rejected by principle 2), and crash-resume IPC (subsumed by generation-time logic in a custom backend).

2. **Displayed history is immutable.**
   Once a message has been rendered, scripts never change what it showed. Display transforms are computed once, at message-finalize time, from the message text plus a snapshot of the variables they read. State-of-the-world UI (maps, stat boards) lives in panels/overlays or in the *latest* message — never retroactively inside old ones. "Reroll" means appending a new message or a swipe, not editing an old one. Interactive buttons inside old messages still work: content is frozen, click handling is not.

3. **Interaction is honest text.**
   Buttons send visible user messages; the chat log is the IPC channel. No hidden protocol messages, no `data-*` action dispatchers, no script-to-script side channels. A command the user "sent" is visible in history and styled as what it is.

4. **Credentials never enter Lua scope.**
   Scripts delegate generation through the adapter registry by config id (or the calling config's default delegate); the delegated call carries its own API keys internally. There is no API to read another backend's `apiKey`, and custom backends must not be able to reach one indirectly (e.g. via `get_backend_config` — audit the `st.*` surface for credential leakage before shipping).

5. **Each layer has one job.**
   Prompting is the backend's job. Rendering is the display transform's job. Interaction is the button protocol's job. No layer grows an event system "for convenience" — that is how Risu got the way it is.

---

## 2. Layer 1: Custom backends (prompting)

**Status: core landed** (registry + adapter + delegation + WS CRUD; client UI landed — Type A via `CustomBackendsModal` + the `custom` provider in `BackendConfigModal`, Type B via `CharacterBackendEditor`). A **custom backend** is a named, Lua-driven `BackendAdapter`. Despite the earlier working name "fake backend," nothing about it is fake: the same interface supports three tiers.

- **Protocol adapters** — implement a provider the core doesn't ship (NovelAI, Horde, next month's hot API) entirely in Lua. Built-in TS adapters are the fast path; Lua covers the long tail.
- **Middleware backends** — wrap another registered backend: transform the prompt on the way in, the output on the way out (rewrite agents, translation, logging, style filters).
- **Simulator backends** — full ownership of the prompt: assemble a custom system prompt, reserve token budget, run sub-generations, parse structured output, synthesize the final stream (the Lightboard pattern, minus the trigger spaghetti).

### Two kinds of custom backend (Type A / Type B)

The three tiers above share one server-side adapter interface, but they have two different *ownership* models, and the client should treat them as distinctly different things:

- **Type A — provider-style (global).** Protocol adapters and generic middleware. Card-agnostic, user-owned; live in the `custom_backends` registry and are selected on a backend config (`provider: 'custom'` + `providerParams.customBackendId`, optional `delegateConfigId`). Client surface: the backend config modal.
- **Type B — contextual (card-coupled).** Simulator logic that belongs to a specific card (ported triggerlua, Lightboard-style). Stored inline on the character (`character.extensions.contextualBackend = { enabled, luaSource }`) so it **travels with card export**; surfaced in the character editor, never in the global backend dropdown. *(As implemented.)*

Type B activation (implemented in `GenerationService.resolveGenerationBackend`):

- The chat's character ships an **enabled** contextual script and the active config is a normal provider → the script wraps the resolved adapter; its default delegate **is the user's selected backend** (the writer model follows the user's normal selection — the coherent form of "custom backend and regular backend selected at the same time").
- The active config is itself `provider: 'custom'` → explicit Type A selection wins; the character script is ignored.
- Group chats: wrapping applies per speaking character by construction (`resolveGenerationBackend(character)`).
- **`enabled` is opt-in** (default `false`): imports and ports ship logic but never activate it silently — the RisuAI `lowLevelAccess` lesson. The Workbench fs path `/characters/<id>/backend_logic.lua` (write/edit) gives the porting agent the write path; the `enabled` flag is deliberately not writable through the fs.

### Script state (implemented)

Custom backends are stateful via the **same branch-aware protocol as Lua tool templates** (`lua_memory` semantics): before `generate()`, GenerationService scans the branch for the newest `message.extra._toolState[backend.id]` snapshot and the adapter restores it as the Lua `state` global (via the script's `deserialize(raw)` if defined, else `json.decode`); after a successful turn, the adapter captures `state` (via `serialize()` if defined, else `json.encode(state)`) and GenerationService persists it under the same key. Failed turns never overwrite the last good snapshot. State is invisible in the chat text, and swipes/forks restore the game/state as of that branch point. Verified by the blackjack e2e (`GenerationService.contextualBackend.test.ts`): a hidden 52-card deck across turns, zero calls to the underlying backend.

Two hard-won implementation notes:

- **Prompt/ctx injection uses Lua table literals** (`toLuaLiteral`), not `global.set` object proxies — wasmoon proxies misbehave under GC pressure in string-heavy scripts.
- **`LuaRuntime` timeout fix (regression):** wasmoon's `global.setTimeout` takes an *absolute epoch-ms deadline*, and the runtime passed a duration — putting the deadline in 1970, so any script past the first 1000-instruction batch panicked instantly. Fixed to `Date.now() + timeoutMs`; runaway scripts are still hard-killed at the deadline (covered by `LuaRuntime.test.ts`).

### Contract

The adapter factory (`factory.ts`) gains a `custom` adapter kind that instantiates `LuaBackendAdapter` wrapping `LuaRuntime`. The Lua script implements:

```lua
-- Receives the fully-built prompt (mutable copy) and generation context.
function generate(prompt, ctx)
  -- prompt.messages, prompt.tools — inspect, rewrite, rebuild arbitrarily
  -- ctx: { chatId, characterId, generationType ('normal'|'regenerate'|'continue'|
  --        'impersonate'|'quiet'|'genraw') }
  -- Delegation:
  local result = backends.generate(prompt):await()                      -- default delegate
  local aux    = backends.generate("<backendConfigId>", prompt):await() -- explicit target by id
  return result.text
end

function list_models()
  return { { id = "my-model", name = "My Model" } }
end
```

### Delegation model (as implemented)

- **Default delegate, declared on the config.** The `custom`-provider backend config carries `providerParams.delegateConfigId` — "which backend does this script write with" — a dropdown in the config UI. `backends.generate(prompt)` uses it, so the common middleware case keeps backend references out of Lua entirely, and delegation chains are configs referencing configs, visible in one place.
- **By-id escape hatch.** `backends.generate("<backendConfigId>", prompt)` targets a specific config — for simulator backends with multiple targets (main + auxiliary models). Ids, not names: stable under renames, no case-folding ambiguity.
- **Passthrough.** `return { __passthrough = true, prompt = prompt }` (or a config id) streams natively from the delegate — real token streaming for middleware backends that don't need output post-processing.

Rules:

- **Delegation goes through the registry** (`backends.generate(name, prompt)`), which resolves the named backend config, builds its adapter via the normal factory path, and invokes it. API keys never cross into Lua (principle 4). Custom → custom chains are depth-capped at **4** (`MAX_CUSTOM_BACKEND_DEPTH`); exceeding it is an error, not a hang. **As implemented**, a failed delegation with no usable text throws into Lua (scripts can `pcall` to recover) — never a silent empty reply.
- **The custom backend owns the turn, but may request tools.** When active, it replaces the standard tool-call *decision* loop — no tool schemas are advertised in the prompt and the script decides everything itself. But a blocking return of `{ toolCalls = { { name = "speak", arguments = {...} } } }` is honored by `GenerationService`'s tool loop: the calls execute through the normal registry (so `speak`, `forge_image`, user toolsets, etc. all work), and the follow-up round re-enters `generate()` with results visible as `tool_result` content parts on the latest assistant prompt message — the same shape built-in adapters consume. Optional per-call `id` (defaults to `lua_call_<n>`); `text` may accompany the calls. Round-capped by `maxToolRounds` like any backend. *(As implemented — e2e in `GenerationService.contextualBackend.test.ts`.)* The complement: sub-prompts may carry the script's OWN tool schemas (`sub.tools` — nothing filters them; OpenAI/Claude/Gemini adapters send them), and the delegate's calls surface as `res.toolCalls` (`{ id, name, arguments }`), so the script executes them in Lua and continues the loop with `tool_use`/`tool_result` content parts — a tool loop entirely inside one turn, invisible to the chat log. *(As implemented — `runAdapterBlocking` copies `GenerationResult.toolCalls` through; recipe in the `custom_backends` docs topic.)*
- **Errors are first-class.** A Lua error becomes `GenerationResult { finishReason: 'error', error: <message> }`, surfaced like any backend failure. A script that returns nothing is an error, not a silent empty reply.
- **Abort propagation.** `ctx.signal` must be honored by delegation calls; cancelling generation kills the whole chain. *(Implementation note: in-VM abort relies on the Lua timeout for now — 10 minutes for `generate`, 10 seconds for `list_models`.)*
- **`st.*` read APIs are available** (messages, vars, characters, world info, token counting). Chat mutation is append-oriented: `send`, `send_as`, `hide`, swipe operations. Arbitrary rewrite of old messages is deliberately *not* offered (principle 2); the Touhou/Lightboard reroll pattern maps to "append or add a swipe." *(Implementation note: the `st` global is not yet injected into custom-backend states — the available globals are `prompt`, `ctx`, `backends`, `chat`, `json`, `base64`, `fetch`. The `chat` global serves the FULL branch history — unbounded by promptHistoryLimit — via lazy async accessors (`chat.count/get/find`), so scripts can implement recall over messages the model never sees.)*
- **Passthrough mode (as implemented):** see the delegation model above — `{ __passthrough = true }` (default delegate) or a config id, streamed natively.

### Registry and UI

Custom backends are named entities in a new top-level registry (SQLite table + WS CRUD, same pattern as presets): `{ id, name, description, luaSource, createdAt, updatedAt }`. A backend config selects `custom:<id>` as its adapter; the model field maps to `list_models()`. Management lives in its own menu (editor with syntax highlighting + a dry-run "what would you send" panel, the moral equivalent of `buildRequest`). *(Dry-run status: implemented end to end — `backends/customBackendDryRun.ts` runs a script against a recording delegate and returns text/state/delegations; exposed to agents as the Workbench `run test_backend_logic` verb and to users as the `BackendDryRunPanel` in the custom-backends modal and the character editor, over the `custombackend.test` WS pair.)*

### Group chats

The chat's active backend runs, period. Character-specific behavior is expressed as explicit branching inside the script on `ctx.characterId` — one script, visible control flow. (Risu's per-character trigger binding degrades to exactly this in practice: group chats drop per-character triggers in several code paths, and chat script-state is a single shared namespace, so "per-character" was always convention over mechanism.) *(Implementation note: the injected `ctx` carries exactly `chatId`, `characterId`, `generationType` — no `speakerName`; resolve names from the character id if needed.)*

---

## 3. Layer 2: Display transforms (rendering)

The Risu `display` trigger + regex-script (`editdisplay`/`editinput`) use case, rebuilt on immutability.

**Status update:** tamari already has the plain-regex half of this layer — `server/src/services/RegexEngine.ts` (Worker-threaded, ReDoS-guarded) with global rules (`settings.regexRules`) and character-scoped rules (`character.extensions.regexScripts`), each with prompt/display placement and user/assistant role filters, plus SillyTavern `regex_scripts` conversion at import. **(a) Lua replacement functions are now IMPLEMENTED** (below); (b) the finalize-time `displayText` memoization with a `vars` snapshot ctx remains open — the current implementation applies rules at the same points plain regexes already ran (prompt build; server-side display render at snapshot/broadcast), with no var ctx.

A **display rule** extends the existing `RegexRule` with an optional `replaceLua`:

```lua
function replace(match, captures)
  -- captures: 1-indexed array of capture groups (nil for unmatched optional groups)
  return string.format('<span class="hp">%s</span>', captures[1])
end
```

Semantics (as implemented):

- **Contract.** `replace(match, captures)` returns the replacement string; a non-string/nil return keeps the original match. When `replaceLua` is present and non-empty it takes precedence over `replaceString`. Works for both `prompt` and `display` placements — the HUD pattern (backend emits compact state, a character-scoped rule expands it to styled HTML) needs nothing else.
- **Runs server-side only, wherever plain regexes run** — prompt build (`PromptBuilder`) and the server-side display render (`DisplayRenderer`/`ChatBroadcastService`), which happens at message finalize/snapshot time, never in the browser (principle 1 holds).
- **Sandbox.** Scripts run in a fresh wasmoon state (no io/os/debug/require/net; `json`/`base64` available), 5 s timeout, one state shared per `applyRules` call. A script that errors, times out, or lacks `replace()` skips that rule, text unchanged — identical failure semantics to the Worker path.
- **Sanitization still applies.** Transform output feeds the normal `marked` + DOMPurify pipeline in `server/src/services/DisplayRenderer.ts`. Scripts cannot smuggle unsanitized HTML; the XSS posture is identical to author-written HTML.
- **Scoped and ordered.** Rules live where they already live: global (`settings.regexRules`) and character-scoped (`character.extensions.regexScripts`), character rules merged after global ones. The Workbench fs exposes character rules under `/characters/<id>/regex/` (`replace_lua` as a per-field file); `run test_regex` exercises them.
- Buttons (§4) emitted by transforms are inert HTML until clicked — freezing them in old messages is correct.

**Still open:** the `displayText` memoization + var-snapshot ctx (`replace(match, captures, ctx)` with `ctx.vars`) — only needed by cards whose display depends on chat vars. ~~No client UI for editing `replaceLua`~~ — done: both regex editors (character + global settings) have a Text/Lua replacement-type toggle with the Lua field and a Lua badge in the list; the client test preview shows a server-side-only hint for Lua rules.

What this deliberately does not cover: re-rendering old messages when vars change (principle 2), per-keystroke transforms of the input box (YAGNI — revisit if a real card needs `editinput`).

---

## 4. Layer 3: Button protocol (interaction)

SillyTavern Quick Replies, minus the separate button-bar-only limitation, via one convention:

```html
<button data-post-response="option 1">Tell {{char}} you love her</button>
```

- **Render:** `button`/`div` elements and the `data-post-response` attribute are whitelisted in the DOMPurify permissive config (`server/src/services/DisplayRenderer.ts`, with `ALLOW_DATA_ATTR: false` so it is the ONLY surviving `data-*` attribute); button *label* text is macro-resolved server-side as usual. Everything renders as a normal styled button. *(Implemented, incl. click styling in `ChatView.css`.)*
- **Click (as implemented):** posts the attribute value as the user's next message and triggers generation (`action.sendAndGenerate` — same outcome as `present_choices`), handled in `ChatView`'s content-click path. Buttons are live in the read-only virtual greeting too — `first_mes` is exactly where cards put their menus; the click first sends `chat.materialize` (same as `MessageInput.send`) so the greeting becomes real DB messages, and only then posts (read-only there gates editing, not interaction). The result is an ordinary, visible user message (principle 3). *The `data-post-response-fill` fill-without-sending variant is NOT implemented — deferred until a card asks for it.*
- **Custom backends** recognize their own protocol strings (`lb-reroll__12`, `gensonet:post:42`) in the incoming user message and act on them, stripping them from the prompt they assemble for the writer model. Generation type matters: a `regenerate`/`continue` must not re-fire a captured command — the backend sees `ctx.generationType` and behaves accordingly.
- **Graceful degradation:** on a plain backend the click just sends the text — which is frequently fine, because "option 1" is something the user could have typed. Cards remain usable without their coupled backend, merely less clever.
- **No Lua required for static buttons:** card authors can hand-write them in `first_mes`, greetings, or lorebook HTML. `present_choices` remains the LLM-side generator of the same pattern (selection arrives as the user's next message — same channel, same honesty).

### Forms (implemented)

The button protocol generalizes from "click posts a fixed string" to "submit posts user-assembled text," same channel, same honesty. A form in message HTML is ordinary markup; `data-post-response` on the `<form>` is the marker (reusing the ONLY surviving `data-*` attribute — no new whitelist surface):

```html
<form data-post-response="action">
  <label>Target <input name="target" type="text"></label>
  <select name="weapon">
    <option value="sword">Sword</option>
    <option value="bow" selected>Bow</option>
  </select>
  <label><input type="checkbox" name="sneak" value="yes"> Sneak</label>
  <textarea name="flourish" rows="2"></textarea>
  <button type="submit">Attack</button>
</form>
```

- **Wire format: a flat XML profile.** On submit the client serializes filled fields to elements-only XML — the attribute value names the root element (default `response`), each input's `name` becomes a child element, field order is DOM order, values are entity-escaped (`& < > " '`). Form values are prose, and the format is designed for text: newlines ride along untouched, only three characters ever need escaping (JSON was rejected — `json.decode` is already in the Lua sandbox and would win on pure parseability, but prose values become an unreadable `\n`-escape-fest in the log; key:value lines were rejected — multi-line values force a continuation rule and you're reinventing YAML). Models are also extremely well-trained on XML-tagged structure, which helps the graceful-degradation path.
- **Serialization rules (HTML form semantics, deliberately dumb):** `text`/`number`/`range`/`hidden`/`textarea`/`select` emit their current value (empty values emit `<name></name>` — presence is information); `checkbox`/`radio` emit only when checked, using `value` (or `true` if none); repeated `name` → repeated sibling elements; inputs without `name` are skipped; `file`/`password`/button-ish types are ignored; names are coerced to valid XML names (invalid chars → `_`). *(Implemented in `client/src/lib/responseForm.ts`; iteration uses `form.querySelectorAll('input, select, textarea')`, NOT `form.elements` — see the SANITIZE_DOM note below.)*
- **Two invariants make "parseable in Lua" true** rather than a per-author exercise: the serializer ALWAYS escapes, and the profile is flat (one level, no attributes, no nesting). An escaped value can never contain a literal `<`, so a closing tag is unambiguous and this documented recipe is correct, not just usually-correct (ships as a convention here, not as new `st.*` API — each layer has one job):

  ```lua
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
  ```

  (Repeated sibling elements collapse to last-wins in this recipe; cards that need lists can match them directly. Verified end-to-end by `GenerationService.responseForm.test.ts`.)
- **The posted message wraps the XML in a fenced code block** (```` ```xml ````). Raw tags aren't in the sanitizer whitelist, so an unwrapped message would be stripped to invisibility on display — violating principle 3. The fence renders readably in the log and is trivially strippable by a custom backend before the writer model sees the prompt. On a plain backend the block goes to the model as-is: ugly but honest, and models parse simple XML fine.
- **Client mechanics:** delegated `onSubmit` on the same message-content container that carries the button protocol's `onClick` (submit bubbles; catches Enter-key submission, which a click-only handler would miss). Handler does `preventDefault()` (mandatory — otherwise the browser navigates), checks `[data-post-response]`, serializes from the DOM at submit time (inputs live in `innerHTML`, uncontrolled — no client state), then materializes the virtual greeting if needed (`chat.materialize`) and posts via the identical `action.sendAndGenerate` sequence. Forms stay submittable in the read-only virtual greeting, same as buttons; forms in old messages stay submittable too (principle 2's carve-out: content frozen, interaction live); filled-but-unsubmitted state is ephemeral and evaporates on re-render.
- **Sanitizer changes (`server/src/services/DisplayRenderer.ts` permissive config only):** add tags `form`, `input`, `select`, `option`, `optgroup`, `textarea`, `label`, `fieldset`, `legend` and attrs `name`, `type`, `value`, `placeholder`, `checked`, `selected`, `for`, `rows`. Explicitly NOT whitelisted: `action`, `method`, `formaction`, `enctype`, all `on*` — no real navigation or handler smuggling even before DOMPurify's own filtering. Unknown `type` values degrade to text at serialization, so a `<input type="file">` from a card is inert, not broken. Strict config untouched. *(Implemented — with one discovery: DOMPurify's default DOM-clobbering guard strips `name` attributes that collide with HTMLFormElement properties (`target`, `action`, `elements`…), which are exactly the field names an RPG card reaches for. The permissive config therefore sets `SANITIZE_DOM: false` — exposure is acceptable since no scripts survive sanitization, and the serializer avoids clobberable property access by using `querySelectorAll` instead of `form.elements`.)*
- **Non-goals** (same gravity-well defense as §6): no fill-only variant (`data-post-response-fill` stays deferred); no client-side validation (`required` not whitelisted — the model is the validator); no macro substitution inside posted values beyond the existing server-side label resolution; no per-field scripting, conditional fields, or multi-step forms — a card that needs those needs a custom backend, not a bigger protocol.
- **Server side:** nearly nothing — `action.send` is content-agnostic; the mirrored `DisplayRenderer` whitelist keeps forms intact in server-rendered snapshots; custom backends recognize their own root element and `ctx.generationType` semantics carry over unchanged from buttons.

---

## 5. Card coupling and distribution

The layers are user-level named entities; cards couple by reference.

- `character.extensions.customBackend = "<registry id>"` (chat-level override allowed). On CharX/`.risum`/JSON import: if the referenced backend exists, couple it; if not, warn and import as a plain card. Missing coupling never bricks the card (principle: graceful degradation, §4). *(Not implemented, and superseded in practice: Type A coupling lives on the backend config — `providerParams.customBackendId` — selected by the user, not carried by the card. The only card-coupled form is Type B's inline `contextualBackend`. A registry-id reference on the character would still be the way to make Type A travel with export, if a card ever asks for it.)*
- **Delegate portability.** An explicit `delegateConfigId` (or `backends.generate("<configId>", …)`) refers to a LOCAL backend config row — meaningless on anyone else's install. Exportable cards should therefore delegate by default (`backends.generate(prompt)`), which resolves to the recipient's own active backend. If explicit targets ever prove necessary in shared cards, add a delegate-by-name fallback rather than shipping local ids; until then, explicit ids are for single-install presets only.
- `.risum` import mapping (manual port, not automatic conversion):
  - `lorebook[]` → world info (implemented: the CharX `data.character_book` path imports to world info; the module's native lore duplicates it).
  - `regex[]` → tamari regex rules (§3 — global or character-scoped), where the semantics fit.
  - `customModuleToggle` + manual `_Toggle` triggers → a Quick Reply set setting the same vars (lorebook CBS `{{getvar}}` reads them unchanged).
  - `triggerlua` backends → custom backend scripts (§2). This is a human porting job; TriggerScript auto-conversion is a non-goal.

### Raw module import & porting workflow (implemented)

The first slice of the distribution story landed, deliberately ahead of the layers themselves: **raw RisuAI module data is preserved at import and exposed to the Character Workbench**, so porting (human- or agent-driven) has the source material available.

- `server/src/lib/risum.ts` decodes the `.risum` container (magic/version/length-prefixed blocks + RPack byte substitution; map embedded from RisuAI under MIT).
- CharX import (`importCharXCard`) decodes an embedded `module.risum`; standalone `.risum` files attach via `POST /characters/:id/risu-module` (and detach via `DELETE`). A corrupt module never bricks card import.
- Raw module JSON is stored via FileStorage (`character_modules/<charId>/<moduleId>.json`); `character.extensions.risuModules` holds only metadata (name, namespace, source, counts, `hasLua`) so character broadcasts stay light. **Asset payloads land as ordinary character assets** (`storeRisuModuleAssets` — servable at `/characters/:id/assets/:assetId`, re-exported with the card) so ported cards keep their media packs; only CharX-embedded modules skip payloads (the card's own asset section already covers them).
- The Workbench fs gives the porting agent read access to the raw material — `/characters/<id>/modules/<moduleId>.json[/<section>]` (sections: `info`, `triggers`, `trigger/<n>` incl. full Lua source, `regex`, `lorebook`, `assets`; read + rm only) and `/characters/<id>/assets/` for the media — and porting happens through the same fs (`.../lorebook/new.json`, `.../regex/new.json`, the character's text fields, `backend_logic.lua`) plus the `run copy_assets` / `run copy_module_assets` verbs. External modules are attached by the USER, directly to the character (character-editor module viewer → `POST /characters/:id/risu-module`) — modules are card material, so no chat-attachment or filesystem-path detour exists on purpose.
- **Frontend porting surface (implemented):** the same reads are available over REST (`GET /characters/:id/risu-modules`, `GET /characters/:id/risu-modules/:moduleId?section=…&index=…` — section extraction shared with the workbench via `getRisuModuleSection`), and the recording-delegate dry-run is a WS request/response pair (`custombackend.test` → `custombackend.testResult`, resolving ad-hoc `luaSource` > registry `customBackendId` > character `characterId`). The UI builds on these: module viewer + dry-run panels in the character editor and the custom-backends modal.

---

## 6. Non-goals

Stated explicitly so future contributors don't re-add the gravity well:

- No render-time or chat-open code execution (principle 1). No `onStart`, no display-state store.
- No retroactive re-rendering of history (principle 2).
- No hidden IPC messages, no script-driven arbitrary edits of old messages.
- No per-character backends in group chats (single active backend, scripts branch on speaker).
- No TriggerScript/STScript compatibility layer or auto-converter.
- No Lua access to credentials, ever (principle 4).

## 7. Open questions

Still open (the genuinely unimplemented parts):

- **Var-snapshot ctx for display transforms:** `replace(match, captures, ctx)` with `ctx.vars`, plus the finalize-time `displayText` memoization and its exact `message.extra` schema (`displayText`, `displayVars`) and invalidation on edit/regenerate/swipe switch (each swipe finalizes independently). Only needed by cards whose display depends on chat vars; the RegexEngine currently has no ctx support at all.
- **Token-budget helpers:** custom backends receive a budgeted prompt; if they rebuild it, they need the tokenizer (`st.token_count` exists) and possibly the budget params in `ctx`. The injected `ctx` still carries only `chatId`, `characterId`, `generationType`.
- **In-VM abort:** `ctx.signal` is still not wired into the VM — in-flight scripts rely on the Lua timeout (10 min `generate`, 10 s `list_models`).
- **`data-post-response-fill`** (fill-without-sending) — deferred until a card asks for it (§4 non-goals).
- **Registry-id card coupling for Type A** (`character.extensions.customBackend`) — never implemented; see §5 for why config-level selection covers it so far.

Resolved while implementing (kept for the record):

- ~~**Display-rule storage**~~ — settled by not adding a store: rules live where plain regexes already lived (global `settings.regexRules`, character-scoped `character.extensions.regexScripts`); named rule lists never materialized.
- ~~**Lua timeout/memory limits**~~ — settled: 10 min for `generate()`, 10 s for `list_models()`, 5 s for `replaceLua`; wasmoon deadline aborts are mapped to clean "script timed out" errors (`isLuaTimeoutError`). Memory: a 64 MB Lua heap cap per state (`traceAllocations` + `setMemoryMax`) turns memory bombs into catchable "not enough memory" errors. In-VM abort still relies on the timeout rather than `ctx.signal`.
- ~~**Dry-run surface**~~ — settled: `backends/customBackendDryRun.ts` runs a script against a recording delegate and returns text/state/delegations; exposed as the Workbench `run test_backend_logic` verb and the `BackendDryRunPanel` UI (custom-backends modal + character editor).
