# tamari — Architecture Rules

## Core Principle

**The server is the single source of truth. The client renders data it receives from the server. The client never derives, caches, or mutates shared state on its own.**

---

## 1. Two Kinds of State

### Server State (`serverStore.ts`)

Data that is persisted to SQLite and broadcast over the WebSocket bus. Every client tab sees the same server state.

Examples:
- `characters`, `chats`, `messages`, `personas`, `presets`, `settings`
- `activeChat` — the **full** chat object currently being viewed (not just an ID)
- `activeCharacter`, `activePreset`, etc. (same pattern)
- `chatCharacter` — the character bound to the current chat (separate from `activeCharacter`, which is for the editor)

Rules:
- **Only mutated by server broadcasts.** The client never calls `setState` on server data in response to user actions.
- **Always full objects.** `.updated` events broadcast the complete entity. The client replaces, never merges patches. Per-message updates during streaming/editing arrive as full-object `message.snapshot` events. `chat.updated` always carries the full `Chat` — see §5.
- **Apply list replacements with `reconcile()`.** Solid's `reconcile` makes the store structurally identical to the broadcast payload (absent keys are dropped, so this is still "replace, never merge") while preserving object identity for unchanged items — a plain wholesale swap gives every row a fresh reference, and `<For>` remounts open editors on every own-save echo.
- **Lists are for sidebars.** `state.chats` is a lightweight list. The main view reads from `state.activeChat`, not from `state.chats.find(...)`.

### Local UI State (`uiStore.ts`)

Per-tab, ephemeral chrome state. Each browser tab has its own copy.

Examples:
- `activeChatId` — which chat the user clicked (the server decides what `activeChat` object to send back)
- `showEditor`, `showSettings`, `charSearch`, `chatSearch`
- Form buffers (`CharacterEditor` fields, `SettingsModal` fields)
- Textarea drafts

Rules:
- **Never persisted to the server.**
- **Never broadcast.** Other tabs don't know or care.
- **OK to mutate optimistically.** It's purely local chrome.

---

## 2. Mutation Flow

The only valid flow for changing shared state:

```
User clicks something
    ↓
Client sends WebSocket mutation (e.g., character.update, chat.select)
    ↓
Server persists to SQLite
    ↓
Server broadcasts the result (e.g., character.updated, chat.snapshot)
    ↓
Client renders from the broadcast
```

**Anti-patterns:**
- ❌ Calling `setState('characters', ...)` on the client before the server broadcasts
- ❌ Sending a WS mutation and immediately updating local state "because we know what the server will say"
- ❌ Using `fetch()` for mutations (file uploads are the only exception)
- ❌ Deriving shared state client-side (e.g., computing avatar URLs from heuristics instead of receiving canonical URLs)
- ❌ Deriving view state by looking up entities in sidebar lists (`state.chats.find(...)`, `state.characters.find(...)`)

---

## 3. Active Entity Pattern

When the user opens a specific item for viewing/editing, the server sends a **snapshot** of that item. The client stores it separately from the list.

### Example: Chat

```ts
// ServerState
{
  chats: Chat[]           // sidebar list
  activeChat: Chat | null // full snapshot of current view
}
```

**Selecting a chat:**
```ts
// Sidebar.tsx (local UI action)
setActiveChatId(chatId);                          // local signal
bus.send({ type: 'chat.select', chatId, limit }); // ask server
```

**Server responds:**
```ts
// dispatch/chatHandlers.ts
const chat = await chats.getChatById(chatId);
const messages = await chats.getMessages(chatId, { limit });
const character = chat.character_id ? await characters.getById(chat.character_id) : undefined;
bus.sendTo(client.id, { type: 'chat.snapshot', chat, messages, character });
```

**Client stores it (guarded — snapshots for chats this tab isn't viewing are ignored):**
```ts
// serverStore.ts
bus.on('chat.snapshot', (msg) => {
  if (msg.chat.id !== activeChatId()) return;
  setState('activeChat', msg.chat);
  setState('messages', msg.chat.id, msg.messages);
  setState('chatCharacter', msg.character ?? null);
});
```

**Components render from `activeChat`:**
```ts
// ChatView.tsx, ChatHeader.tsx, etc.
const activeChat = () => state.activeChat;  // NOT state.chats.find(...)
```

### Opening modals from broadcasts (no pending state)

For flows where the user clicks "edit" or "create" and a modal should open, **do not** use intermediate "pending" signals. The server includes `clientId` on broadcasts. The component installs a direct `bus.on` listener and opens itself when it sees its own `clientId`.

**Edit flow:**
```ts
// Sidebar.tsx — edit button ONLY sends the request
const requestCharacterEdit = (charId: string) => {
  setActiveCharacterId(charId);
  bus.send({ type: 'character.select', characterId: charId });
};

// Sidebar.tsx — bus listener opens the modal when the snapshot arrives
onMount(() => {
  const unsub = bus.on('character.snapshot', (msg) => {
    if (msg.character.id !== activeCharacterId()) return;
    if (msg.clientId === state.clientId && !showEditor()) {
      setShowEditor(true);
    }
  });
  onCleanup(unsub);
});
```

**Creation flow:**
```ts
// dispatch/characterHandlers.ts — server broadcasts BOTH events after creation
bus.broadcast({ type: 'character.created', character: withAvatar }, client.id);
const assetList = await characterAssets.listForCharacter(character.id);
bus.broadcast({ type: 'character.snapshot', character: withCharacterAssets(withAvatar, assetList) }, client.id);

// Sidebar.tsx — character.created sets the ID, snapshot opens the modal
onMount(() => {
  const unsubCreated = bus.on('character.created', (msg) => {
    if (msg.clientId === state.clientId) {
      setActiveCharacterId(msg.character.id);
    }
  });
  const unsubSnapshot = bus.on('character.snapshot', (msg) => {
    if (msg.character.id !== activeCharacterId()) return;
    if (msg.clientId === state.clientId && !showEditor()) {
      setShowEditor(true);
    }
  });
  onCleanup(() => { unsubCreated(); unsubSnapshot(); });
});
```

Why this is better:
- No `pendingCharacterEditorId` signal required.
- The modal only appears when the server has actually sent the data.
- Multiple tabs can independently edit/view without conflicting pending state.

### Reuse this pattern for:
- `activeCharacter` (Character Editor)
- `activePreset` (Preset Editor)
- `activeWorldInfo` (World Info Editor)
- Any future "open for editing" flow

---

## 4. HTTP Endpoints vs WebSocket

| What | Protocol | Notes |
|------|----------|-------|
| CRUD mutations | WebSocket | Always persist + broadcast |
| File uploads | HTTP POST | Binary data justifies HTTP, but MUST `bus.broadcast()` after DB write |
| Exports / downloads | HTTP GET | Read-only, no broadcast needed |
| Stats, maid, secrets | HTTP | Intentionally outside the WS sync model |

If an HTTP endpoint mutates shared state, it must call `bus.broadcast()` after the DB write.

---

## 5. Broadcasting Rules

### Server: broadcast everything; the client filters

- Use `bus.sendTo(client.id, ...)` only for the direct response to a specific client's request.
- Use `bus.broadcast(...)` for **all** state changes — including chat-scoped ones (messages, member changes, streaming tokens). This is a single-user app with a handful of clients; sending a message a given client doesn't need is trivially cheap, and a dumb pipe is simpler and less bug-prone than maintaining per-chat subscriptions.
- The client owns filtering (see "Client: silently ignore irrelevant broadcasts" below): ignore anything not being rendered, and match `msg.clientId === state.clientId` for request-scoped flows (modal open, active-entity snapshot).

### Canonical URLs

The server is the source of truth for all resource URLs. Entities that have avatars/images must include a canonical `avatar_url` (or equivalent) field in their broadcast payload. The client must never construct URLs from heuristics like `` `/api/characters/${id}/avatar` ``.

```ts
// Good — server enriches character with avatar_url before broadcast
bus.broadcast({ type: 'character.updated', character: withCharacterAvatar(character) });

// Bad — client derives URL from ID
const url = `/api/characters/${char.id}/avatar`;
```

### Full-list rebroadcast (`*.listed`)

When an entity list changes, prefer rebroadcasting the **entire list** rather than incrementally appending, updating, or removing items. This eliminates an entire class of client-side list-mutation bugs and guarantees every client has exactly the same ordering.

```ts
// Good — server rebroadcasts the full list after any mutation
const list = await characters.listSummaries();
bus.broadcast({
  type: 'character.listed',
  characters: list.items.map(toCharacterSummary),
}, client.id);

// Client replaces the whole list
bus.on('character.listed', (msg) => {
  setState('characters', msg.characters);
});
```

The server still broadcasts `.created`, `.updated`, and `.deleted` events for active-entity and snapshot updates, but the sidebar list is always driven by `.listed`.

### Client: silently ignore irrelevant broadcasts

If the client receives a broadcast for an entity it is not currently tracking, **ignore it**. This caps memory usage and prevents leaking state into inactive tabs.

```ts
// Good — guard before mutating
bus.on('character.updated', (msg) => {
  const hasChar = state.characters.some((c) => c.id === msg.character.id);
  if (!hasChar) return; // not in our sidebar, ignore
  setState('characters', (list) =>
    list.map((c) => (c.id === msg.character.id ? msg.character : c))
  );
});

// Bad — unconditionally mutating state for every broadcast
bus.on('character.updated', (msg) => {
  setState('characters', (list) =>
    list.map((c) => (c.id === msg.character.id ? msg.character : c))
  );
});
```

This rule applies to **all** list handlers: characters, chats, personas, presets, world info, quick replies.

### `.created` events
Always broadcast the **full object**.

```ts
const character = await characters.create(id, data);
bus.broadcast({ type: 'character.created', character });
```

### `.updated` events
Always broadcast the **full object** after the DB update.

```ts
const character = await characters.update(id, patch);
bus.broadcast({ type: 'character.updated', character });
```

### `.deleted` events
Broadcast the ID. Client removes from lists and clears `activeX` if it matches.

### `chat.updated` — full object, never a patch

`chat.updated` always carries the **full** `Chat` object — the row from the `chats` table (metadata and pointers), decoupled from the message list. The client **replaces** the entry in its entirety; it never merges a partial. There is no patch form for `chat.updated`.

The `Chat` object is small — it does not contain messages (those live in `state.messages[chatId]` and arrive via `chat.snapshot` / `message.*` events), so re-broadcasting it on every change is cheap.

When a change is **structural** — it alters the rendered message branch or the resolved greeting — the server follows `chat.updated` with a `chat.snapshot` so messages, swipes, `chatCharacter`, and greeting are refreshed for the active-viewing tab. Structural changes are:
- `headMessageId` (the trunk changed → the bulk message list changed). Examples: `action.cut`, `chat.reset`.
- `characterId` / `personaId` on an empty (un-materialized) chat (the resolved greeting changes). Example: `chat.update` that re-points the character.

Non-structural changes — `name`, `metadata`, or `activeChildId` (a swipe; the bulk and swipe set stay identical) — need only the `chat.updated` full-object broadcast; no snapshot.

```ts
// Good — server re-reads the full chat after the write and broadcasts it
const updated = await chats.update(id, { name });
bus.broadcast({ type: 'chat.updated', chat: updated });

// Client replaces the whole object (projects to ChatSummary for the sidebar)
bus.on('chat.updated', (msg) => {
  if (!state.chats.some((c) => c.id === msg.chat.id)) return;
  setState('chats', (list) => list.map((c) => (c.id === msg.chat.id ? toSummary(msg.chat) : c)));
  setState('activeChat', (chat) => (chat?.id === msg.chat.id ? msg.chat : chat));
});
```

Per-message updates (streaming, edits) are broadcast as full-object `message.snapshot` events — there are no patch-form events.

---

## 6. Snapshot Contract

On WebSocket connect, the server sends a `snapshot` with:
- All lists (`characters`, `chats`, `personas`, `presets`, etc.)
- All settings
- Active generation state (if any)
- **NOT** `activeChat` — that is requested per-tab via `chat.select`

The snapshot does **not** include per-tab UI state.

---

## 7. Tool Architecture

Tools are LLM-callable functions organized into **templates**. A `ToolTemplate` (built-in TypeScript or Lua script) defines one or more related tools, a shared `configSchema`, and `serialize()` / `deserialize()` for branch-aware state. Users create **toolsets** — instances of a template with their own `config` and per-tool `toolOverrides`.

### Template Interface

```ts
interface ToolTemplate {
  id: string;
  name: string;
  source: 'builtin' | 'lua';
  getDefinition(): Promise<ToolTemplateDefinition> | ToolTemplateDefinition;
  execute(toolName: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolExecuteResult>;
  serialize(): string;
  deserialize(raw: string): void;
}
```

- `getDefinition()` returns `{ stateKey, configSchema, tools: [{ name, description, parameters?, endsTurn? }] }`
- `source` records the template's origin (`'builtin'` for TS templates, `'lua'` for Lua-script templates); the registry does not use it for resolution.
- `execute()` receives the specific `toolName` being called as its **first** argument on the TS interface. (On the Lua side, the script's `execute(args, context, toolName)` receives it third — `LuaToolExecutor` maps between the two conventions.)
- `serialize()` / `deserialize()` persist template-level state across invocations

A tool whose definition sets **`endsTurn: true`** ends the generation turn after it executes successfully: the tool result is persisted and rendered as usual, but no follow-up generation round runs (the model does not get to continue past the tool call). On error the flag is ignored so the model can retry. `endsTurn` is a server-internal flag — it never appears in provider-facing tool payloads. Used by `present_choices` in the built-in `lua_choices` template so the choice buttons are the last word of the turn.

### Built-in vs Lua Templates

Both implement the same `ToolTemplate` interface. Built-ins register at startup (`ToolRegistry.registerTemplate()`). Lua templates are stored in the `tool_templates` table and compiled on first use. The `ToolRegistry` looks up templates by ID only — built-ins first, then Lua; the `source` field records the origin but plays no part in resolution.

### Toolsets

A `Toolset` is a user-created instance:
- `templateId` — which template to use
- `config` — values for `configSchema`
- `toolOverrides` — per-tool tweaks to name, description, and parameter descriptions
- `enabled` — whether the toolset is active for generation

Multiple toolsets can reference the same template; each has independent config and overrides.

### Branch-Aware State

Tools within a template share state via `stateKey`. After execution, the executor stores `extra._toolState[stateKey]` on the `tool_result` message. On the next execution, `findLatestStateSnapshot()` scans `context.messages` backwards to find the most recent state. This makes state naturally fork-aware — switching to a different chat branch restores the state from that branch's history.

### Execution Flow

1. The target's prompt assembly calls `toolRegistry.getDefinitionsByToolsets(enabledToolsets)` to build `Prompt.tools`
2. Backend adapter sends tool definitions to the model
3. Model returns `toolCalls` (the runner forwards them to the target, which persists them as `tool_use` parts)
4. `GenerationRunner` calls `toolRegistry.execute(call, context)` for each call the target reports via `pendingToolCalls()`
5. The registry finds the owning toolset, deserializes state from message history, executes the tool, serializes state into the result
6. Tool results are written back to the target, the prompt is rebuilt, and a follow-up round runs (up to `maxToolRounds`, default 100) — **unless** any executed tool's outcome sets `endsTurn`, in which case the loop stops after persisting and broadcasting the tool results and the turn finalizes normally

### Client-Side Rendering (`renderType` contract)

A tool result whose `extra.renderType` is a non-empty string is **omitted from the server-rendered `renderedHtml`** (`DisplayRenderer.renderMessageHtml` skips the generic `tool-result-block` for it) and rendered client-side instead: `ChatView` scans each message's parts via `getRenderableToolParts()` and mounts the matching component from the `toolRenderers` registry in `client/src/components/tool-renderers/` below the message content. Unregistered `renderType`s fall back to the default tool-result block, so they stay visible. Widget components receive `{ content, isError, extra, messageId?, disabled? }` — `disabled` is set when the message is not the branch leaf, which makes interactive widgets (e.g. the `choices` buttons) go stale once the conversation moves past them and re-enable on swipe/branch-back.

The built-in `scene` template (`server/src/services/templates/SceneTemplate.ts`) adds a second consumer of this contract: the client derives the *current* scene by scanning the active branch's messages backwards for the newest `scene` renderType part (`client/src/lib/sceneState.ts`), and `SceneStage` renders it as a stage panel above the chat. Stage-like features should reuse this branch-scan derivation instead of adding new state channels.

### Lua Sandbox Surfaces

Three distinct Lua surfaces exist, with three different `st` exposures: **quick replies** get the full `st` API; **Lua tool templates** get the curated subset (`createToolStApi` — no chat actions or lifecycle); **backend scripts** (registry custom backends and card-coupled `backend_logic`, both `LuaBackendAdapter`) get **no `st` at all** — only `backends` (credential-safe delegation), `json`, `base64`, `fetch`, and the `state` snapshot channel.

Backend scripts additionally get a **sandboxed `require`** (`server/src/scripting/LuaVfs.ts`): a card carries a virtual filesystem at `extensions.contextualBackend.files` (path → Lua source, edited as the workbench's `/characters/<id>/backend_logic/` directory), and `require` resolves against it only — per-state module cache, circular/missing modules raise named errors, the real filesystem is never touched. The entry point stays `luaSource` (`backend_logic/main.lua`); the legacy `backend_logic.lua` workbench path aliases it. Type A registry backends stay single-blob by design.

**Structured output:** `Prompt.responseFormat` is the canonical field (set by nothing built-in; honored by the OpenAI/Claude/Gemini adapters). Lua scripts inspect it as `prompt.response_format` and request it by setting `response_format` on delegate/`__passthrough` prompt tables (normalized to `responseFormat` in `LuaBackendAdapter`). Consuming is the script's job: `json.parse_result` (`{ value }` / `{ error }`) — no adapter-level validation or retries.

### Rules
- The `run_lua` backend tool (for arbitrary Lua execution during generation) uses the same `LuaRuntime` as Quick Replies but **does not** inject the `st` API.
- Lua tool templates are cached for 30s; the cache is invalidated on `toolTemplate.update` / `delete`.
- Tool definitions are sent to the backend adapter in `Prompt.tools`.
- The client `ToolsModal` follows the create → edit auto-save pattern (no explicit Save buttons).

---

## 8. Generation Core (`server/src/generation/`)

Every generation — send, regenerate, continue, impersonate, quiet (`st.generate`), genraw, sub-agents — runs through ONE loop in `GenerationRunner`. The full design (and its rationale) lives in `docs/design/generation-runner.md`; these are the load-bearing rules:

- **`GenerationRunner`** owns only what is uniform across kinds: backend resolution (including the card-coupled contextual backend wrapper), the chat mutex, the tool-call loop, and the streaming engine. It is **kind-blind** — it never branches on `target.kind`.
- **`GenerationTarget`** owns the only two policies that vary by kind: prompt assembly (`prompt(resolved)`) and persistence/broadcasting (`prepare` / `write` / `writeToolOutcome` / `finalize` / `abort`). Three implementations: `AssistantMessageTarget` (send/continue/regenerate), `DraftTarget` (impersonate), `TranscriptTarget` (quiet/genraw/sub-agents). Kind-specific data is constructor input — it never passes through the runner.
- **The target is the source of truth.** The loop consults `target.pendingToolCalls()` — never transient result fields. "Continue on a message with un-executed tool calls" is iteration 1 of the loop, not a special case. There is no second streaming engine; the legacy `runQuietGeneration` path is deleted.
- **Locks are passed, not counted.** Nested runs (group-chat member sequences, sub-agents, auto-continue chains) receive the held `ChatLock`; an absent lock means top-level (acquire + fire lifecycle callbacks). Cross-chat lock passing is forbidden.
- **Sub-agents** (the `run_agent` tool) are `TranscriptTarget` runs inside a tool execution: the tool context carries the parent's `lock`, `depth`, and `generationId`; recursion is capped by `MAX_AGENT_DEPTH` (default 4); sub-agent token streams are not broadcast to clients; every run writes a generation record with `kind` + `parent_id` for traceability.
- **`GenerationService`** is a thin facade: validates input, resolves characters, constructs the right target, delegates to the runner. Do not add generation logic there — it belongs on the runner (uniform) or a target (kind-varying).

---

## 9. Naming Conventions

All tamari domain types, API schemas, and WebSocket messages use **camelCase** (`characterId`, `firstMes`, `avatarPath`).

SQLite columns remain **snake_case** (`character_id`, `first_mes`, `avatar_path`). Repositories are responsible for translating at the DB boundary using `rowToX()` functions.

### Rules
- **Domain types** (`packages/types/src/db.ts`) — camelCase for all property names.
- **Zod schemas** (`packages/types/src/schemas.ts`) — camelCase for all API-facing schemas.
- **DB row schemas** (`packages/types/src/dbSchemas.ts`) — snakeCase to match SQLite columns exactly.
- **Repositories** — parse raw rows with `XRowSchema`, then map to camelCase domain objects in `rowToX()`.
- **Client code** — never constructs snake_case property names; consumes camelCase objects from the server.
- **SQL strings** — always use snake_case column names.

### Example
```ts
// packages/types/src/db.ts
export interface Character {
  id: string;
  firstMes: string;
  avatarPath: string | null;
  createdAt: number;
}

// packages/types/src/dbSchemas.ts
export const CharacterRowSchema = z.object({
  id: z.string(),
  first_mes: z.string().nullable(),
  avatar_path: z.string().nullable(),
  created_at: z.number(),
});

// server/src/repos/CharacterRepository.ts
function rowToCharacter(row: unknown): Character {
  const r = row as Record<string, unknown>;
  return CharacterSchema.parse({
    id: String(r.id ?? ''),
    firstMes: String(r.first_mes ?? ''),
    avatarPath: (r.avatar_path ?? null) as string | null,
    createdAt: Number(r.created_at ?? 0),
  });
}
```

## 10. Checklist for New Features

When adding a new entity type (e.g., `bookmarks`):

- [ ] `.create` → persist → broadcast `.created` with full object + `.listed` with full list
- [ ] `.update` → persist → broadcast `.updated` with full object + `.listed` with full list
- [ ] `.delete` → persist → broadcast `.deleted` with ID + `.listed` with full list
- [ ] Client `serverStore.ts` has handlers for `.listed` (replaces list) and snapshot events
- [ ] List lives in `serverStore` (for sidebars)
- [ ] If there's an "open for editing" view, add `activeBookmark` + `bookmark.select` / `bookmark.snapshot`
- [ ] The component opens the editor modal from a `bus.on` listener checking `msg.clientId === state.clientId`, not from a pending signal
- [ ] If there's an HTTP upload endpoint, it calls `bus.broadcast()` after the DB write
- [ ] No optimistic `setState` calls before server confirmation

---

## 11. Accessibility (a11y) Contract

The client must stay accessible. The a11y gate runs in CI: `e2e/tests/a11y.spec.ts` plus every feature spec's `expectNoAxeViolations(page)` call (`e2e/helpers/a11y.ts`), with the axe **`color-contrast` rule enabled by default**. A contrast or structural regression fails CI. Follow these rules so new code passes the gate without rework. See `docs/design/css-principles.md` for the styling side.

### Modals / dialogs
- Every overlay dialog carries `role="dialog" aria-modal="true"` + an accessible name (`aria-label`, or `aria-labelledby` pointing at its heading `<h2>`) + `trapFocus(e.currentTarget, e)` on `onKeyDown` + `saveFocus()`/`restoreFocus()` around open/close. Pattern: `SettingsModal.tsx`; utilities in `client/src/lib/focusUtils.ts`.
- `restoreFocus()` is rAF-deferred (so it fires after the dialog unmounts and the background is un-inerted) — call it in `close()` before `props.onClose()`; don't reorder.
- The background (`<aside class="sidebar">` + `<main id="main-panel">`) is set `inert` automatically while any `[role="dialog"][aria-modal="true"]` is mounted (a `MutationObserver` in `App.tsx`). Don't add per-modal inert logic; just use the standard dialog attrs.

### Interactive non-button elements
- A clickable `<div>` / `<li>` needs `role="button"` + `tabindex="0"` + `onKeyDown={onEnterActivate}` (Enter and Space activate). Pattern: `Sidebar.tsx` character cards.
- `<nav>` is reserved for navigation landmarks — **never** for action menus or dropdowns. A dropdown of action buttons is a plain `<div>` (its `<button>` children are already semantic; avoid `role="menu"`, which obligates arrow-key navigation).
- Toggle buttons disclose state with `aria-expanded` (and `aria-controls` → the toggled element's `id`).
- Custom widgets with `role="slider"` must implement keyboard seek (Arrow/Home/End/PageUp-Down). See `AudioPlayer.tsx`.

### Forms
- Every input has a `<label for>` or `aria-label`. A placeholder is **not** a label.
- Link help/error text with `aria-describedby`; announce errors via an `aria-live` region or the toast system.

### Dynamic content
- Announce async status a screen-reader user would otherwise miss (generation start/stop) via a visually-hidden `aria-live="polite"` region (the `.sr-only` announcer in `App.tsx`). Errors that route through `ToastContainer` are already announced — don't duplicate.
- `aria-live` regions must exist on initial render (mounted empty, updated in place), never conditionally spawned.

### Contrast & visual cues
- No text/background pair may drop below WCAG AA (4.5:1 normal text, 3:1 large text). Design tokens in `client/src/styles/tokens.css` are tuned to pass; **do not stack `opacity < 1` on a text color** — axe composites it against the backdrop and the pair drops below threshold.
- Focus is drawn globally by `*:focus-visible` (`global.css`); don't remove it. A `@media (forced-colors: active)` block restores a visible `CanvasText` outline for Windows High Contrast Mode. Convey state with more than color alone (border / icon / text), because color-only cues collapse under forced colors.

### Reuse, don't reimplement
- `focusUtils.ts` (`trapFocus` / `saveFocus` / `restoreFocus` / `onEnterActivate` / `focusFirst`) and the `.sr-only` class (`utilities.css`) are the shared tools. The skip-link target is `<main id="main-panel" tabindex="-1">`.

---

## 12. Code Style & Naming

One goal: every symbol has one definition site, one name, and one grep that finds it. These are conventions the codebase already follows — keep it that way.

### Exports and files
- **Named exports only.** No `export default` anywhere (client or server). The definition site and every import site share one identifier, so `rg CharacterEditor` finds both.
- **One component per file**, named after the component: `Component.tsx`, with its co-located `Component.css` and `Component.test.tsx`.
- **No new barrel files** (`index.ts` that only re-exports). Import from the defining module. The existing registry barrels are grandfathered: `components/tool-renderers/index.tsx`, `i18n/`, and server-side `server/src/repos/index.ts`, `server/src/tts/index.ts`.
- **Import extensions follow the workspace:** `.js` in `server/` + `packages/types` (`module: NodeNext`), extensionless in `client/` (Vite bundler resolution).

### Functions and handlers
- Exported components and functions use `export function Name()` declarations. Local helpers may be `const` arrows.
- Event handlers are `const handleX = ...` (`handleDrop`, `handleSwipe`). Callback props are `onX` (`onClose`, `onSelect`) — `handleX` inside the component, `onX` across its boundary.
- Boolean props and state are prefixed `is` / `has` / `show` / `can` (`isLast`, `showEditor`).

### SolidJS JSX
- Use `<Show>`, `<For>`, and `<Switch>` for control flow in JSX — not `&&` chains or ternaries. Solid's control-flow components track reactivity at the right granularity and read one way.

### Type safety
- **No non-null assertions (`!.`) or `as any` in production code.** Narrow with a guard, `?.`, or `??` — `noUncheckedIndexedAccess` is on precisely so the compiler forces this. Tests may bend the rule for fixtures.
- Casts belong at validation boundaries (Zod `.parse()`, `rowToX()`), nowhere else.

