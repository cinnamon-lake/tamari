# Unpacked Cards (On-Disk Card Folders)

An **unpacked card** is a character card that lives as a plain folder on disk instead of inside tamari's database. You edit it with your own tools — a text editor, git, an LLM agent like Kimi Code or Claude Code — and tamari picks the files up live. In the app, unpacked cards appear in the character list like any other card (marked with a disk badge), but they are **read-only in the UI**: the folder is the source of truth.

## Enabling

Set **`unpackedCards.enabled`** to `true` in settings, then restart. When the flag is off, tamari never even looks at the folder. Cards that were loaded while the flag was on stay in the character list (as leftover database rows) and can be deleted from the UI while the flag is off. Cards land in:

```
<dataDir>/unpacked-cards/<folderName>/
```

## Folder format

The layout mirrors the [workbench](./workbench.md) virtual filesystem one-for-one:

```
<folderName>/
  meta.json                  # required: { "name": "..." }; optional: id, tags, alternateGreetings
  description                # optional plain-text files, one per card field:
  personality                #
  scenario                   #
  first_mes                  #
  mes_example                #
  system_prompt              #
  post_history_instructions  #
  creator_notes              #
  nickname                   #
  avatar.png                 # optional avatar
  lorebook/<entryId>.json    # world-info entries (same shape as the workbench's lorebook files)
  regex/<ruleId>.json        # regex rules (same shape as the workbench's regex files)
  backend_logic/main.lua     # optional contextual backend script (+ module files it require()s)
```

Notes:

- Only `meta.json` with a `name` is required; everything else is optional.
- The card's id is `unpacked/<id-or-folderName>` — that's what you pass to APIs and tools.
- `regex/<ruleId>.json` patterns use the delimited form (`/pattern/flags`), exactly like the in-app regex editor. Patterns are validated on scan: an invalid `findRegex` (bare pattern, bad regex, bad flags) skips that rule and shows an error in the card's banner.
- `backend_logic/main.lua` is load-validated on scan and must define `generate`, same as in the app.
- Edits apply **live**: tamari watches the folder and re-reads changed cards; the next message uses the new content immediately.
- Deleting the folder deletes the card (with the same cleanup as deleting a card in the UI).
- Cards with parse problems still appear (last good version) and show the errors in a banner in the editor.
- `meta.id` must be unique across folders: when two folders claim the same id, the first folder loaded wins, the other is ignored, and the card shows a duplicate-id error in its banner.
- Risu `modules/` are not supported in unpacked folders yet.

## Why read-only in the UI?

Disk is always right. If the app also wrote to these cards, edits could silently diverge or be lost. So the editor shows a banner ("edit the files directly") and blocks saving; any attempt to mutate an unpacked card through the API is rejected with an explicit error.

## Testing cards with an LLM agent

If you run a coding agent on your tamari data directory, it can edit unpacked card files directly. To let it *test* cards, enable the built-in **MCP server**:

- Set **`mcp.enabled`** to `true` (restart required).
- The endpoint is `POST /api/mcp` (MCP Streamable HTTP, stateless), authenticated with the same bearer token as the rest of the API (`TAMARI_SECRET`).

The MCP surface is deliberately **read/test-only** — no tool on it can mutate your data:

| Tool | What it does |
|---|---|
| `test_card` | Scripted multi-turn card test: `{ characterId? \| folderPath?, turns: string[], keepChat?, backendConfigId? }` sends each scripted user turn through the real generation path in an **in-memory test session** — no real chat is created, nothing lands in the DB. Returns the transcript plus generation ids. The session is **kept** by default (returns `sessionId`) so the agent can continue it interactively or inspect its traces via `test_session_state`; pass `keepChat: false` to end it immediately. Uses the **active backend config** unless `backendConfigId` pins another (e.g. a mock config). |
| `test_session_start` | Open an interactive card-testing session: `{ characterId? \| folderPath?, personaId?, greetingIndex?, backendConfigId? }` → `{ sessionId, greeting }`. Sessions run the real generation path (prompt assembly, scripted-card layer, tool loop) against in-memory state and expire after **30 min idle**. |
| `test_session_message` | Send one user message and run one generation: `{ sessionId, content, timeoutMs? }` → `{ reply, generationId, finishReason, scriptState?, debug? }` (`scriptState` = the card's Lua state; `debug` = backend script `print()` output). |
| `test_session_state` | Inspect a session: message chain (role + text), generations (ids, status, meta **without** prompts), latest `scriptState`. Pass `generationId` for that generation's full meta **including** every captured round prompt (big — hence opt-in). |
| `test_session_end` | End a session early (aborts any in-flight generation, drops all in-memory state). |
| `test_backend_logic` | Dry-run a card's `backend_logic/main.lua` against a recording delegate. |
| `test_regex` | Preview merged regex rules (global + card) against sample text. |
| `test_luatool` | Run a Lua tool from a stored template or ad-hoc code. |
| `test_custom_backend` | Dry-run a custom-backend script. |
| `test_backend` | Dry-run or live-test a backend config. |
| `read_generation` | Read a generation debug trace (`meta.json`, `error.txt`, `prompt.json`, `prompts.json`) for DB-backed generations. Test sessions keep their records in memory instead — use `test_session_state` with a `generationId` for those. |

A typical session flow: `test_session_start` → read the greeting → `test_session_message` per turn → `test_session_state` to inspect the chain, script state, or captured prompts → `test_session_end` (or let it expire).

`test_card` and the session tools use whatever backend config is active unless `backendConfigId` is passed. For **deterministic runs**, create a backend config with provider **`mock`** once (in the UI: no API key needed) and put a canned-response script in its `mockScript` provider param — one directive per line: `respond:<text>` (default reply), `seq:<n>:<text>` (reply for the nth call), `tool:<name>:<json>` (emit a tool call; a sequence of `tool:` lines is walked as tool results accumulate). Then pass that config's id as `backendConfigId` to `test_session_start` or `test_card`. The active config is never touched.
