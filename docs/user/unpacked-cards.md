# Unpacked Cards (On-Disk Card Folders)

An **unpacked card** is a character card that lives as a plain folder on disk instead of inside tamari's database. You edit it with your own tools — a text editor, git, an LLM agent like Kimi Code or Claude Code — and tamari picks the files up live. In the app, unpacked cards appear in the character list like any other card (marked with a disk badge), but they are **read-only in the UI**: the folder is the source of truth.

## Enabling

Set **`unpackedCards.enabled`** to `true` in settings, then restart. When the flag is off, tamari never even looks at the folder. Cards land in:

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
- `regex/<ruleId>.json` patterns use the delimited form (`/pattern/flags`), exactly like the in-app regex editor.
- `backend_logic/main.lua` is load-validated on scan and must define `generate`, same as in the app.
- Edits apply **live**: tamari watches the folder and re-reads changed cards; the next message uses the new content immediately.
- Deleting the folder deletes the card (with the same cleanup as deleting a card in the UI).
- Cards with parse problems still appear (last good version) and show the errors in a banner in the editor.
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
| `test_card` | Headless chat simulation: `{ characterId? \| folderPath?, turns: string[], keepChat? }` creates a temporary chat, sends each scripted user turn against the **active backend config**, and returns the transcript plus generation ids. The temp chat is deleted unless `keepChat`. |
| `test_backend_logic` | Dry-run a card's `backend_logic/main.lua` against a recording delegate. |
| `test_regex` | Preview merged regex rules (global + card) against sample text. |
| `test_luatool` | Run a Lua tool from a stored template or ad-hoc code. |
| `test_custom_backend` | Dry-run a custom-backend script. |
| `test_backend` | Dry-run or live-test a backend config. |
| `read_generation` | Read a generation debug trace (`meta.json`, `error.txt`, `prompt.json`) — `test_card` turns on prompt capture for its runs, so `prompt.json` shows the exact prompt each turn sent. |

`test_card` uses whatever backend config is active. For deterministic runs, point the active config at a mock LLM first (in the UI or settings); the MCP server intentionally cannot change configs itself.
