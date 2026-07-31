# World Info (Lorebooks)

World Info is tamari's lorebook system: a collection of keyword-triggered text entries that get injected into the prompt when their keys show up in the chat. Use it for world lore, character backstory, faction rules, locations — anything the model should know *only when it's relevant*, without permanently burning context tokens.

You manage books in the **World Info** modal (sidebar → **World Info**). Each book is a named collection of entries; a character links one book, and that book is scanned on every generation in that character's chats.

## Books & Entries

Open the **World Info** modal to see your books. Click **New Lorebook** to create one, click a book to open it, then **Add Entry** to add entries. Entry edits save automatically (a **Saved** indicator flashes); the book name saves when you leave the field. **Delete Lorebook** (with confirmation) removes the whole book — there is no undo.

An entry has these fields:

| Field | Default | What it does |
|-------|---------|--------------|
| **Keys** (`keys`) | `[]` | Trigger keywords, comma-separated. An entry fires when any key matches the chat history. |
| **Content** (`content`) | `""` | The text injected into the prompt. Supports the full [macro system](./macros.md) and `@@` decorators (see below). |
| **Comment** (`comment`) | `""` | A note for you — never injected. (Not editable in the modal; set it through the [workbench](./workbench.md) per-field files.) |
| **Order** (`order`) | `0` | Sort order when entries compete for the token budget — lower numbers are inserted first. New entries created in the modal default to `100` (matching card imports). |
| **Position** (`position`) | `before_char` | Where the content lands — see [Placement](#placement). |
| **Depth** (`depth`) / **Role** (`role`) | — | Only for the **At Depth** position — see [At-Depth Injection](#at-depth-injection). |
| **Probability** (`probability`) | `100` | 0–100; the chance the entry fires when its keys match. Rolled fresh on every generation. (Constant entries skip the roll.) |
| **Constant** (`constant`) | off | Always injected — no key match needed. |
| **Selective** + **Secondary Keys** (`selective`, `secondaryKeys`) | off | Require a primary key **and** a secondary key to both match (AND-logic only). |
| **Regex** (`regex`) | off | Treat *all* keys (primary and secondary) as JavaScript regex patterns. Invalid patterns are silently skipped. |
| **Recursive** (`recursive`) | off | This entry's content becomes the scan text for the next recursion round — see [Recursion](#recursion-and-the-token-budget). |
| **Sticky / Cooldown / Delay** (`sticky`, `cooldown`, `delay`) | `0` | Time-based activation controls, in messages — see below. |
| **Disable** (`disable`) | off | Turn the entry off without deleting it. (Set through the workbench or the API; the modal has no checkbox for it.) |
| **Retrieval mode** (`retrievalMode`) | `keyword` | `keyword`, `semantic` (vector search), or `constant` — see [Semantic World Info](#semantic-world-info-rag). |

### Sticky, Cooldown, Delay

These three are measured in **messages** and are **branch-aware** — tamari records which entries fired on each message (`_wiActivations` in the message extras), so swipes and chat forks each carry their own activation timeline:

- **Sticky** — keep injecting the entry for N messages after its last genuine key match. Sticky carry-over does *not* re-trigger the entry: the window always counts from the last real match and simply expires.
- **Cooldown** — after firing, the entry can't fire again for N messages.
- **Delay** — the entry can't fire at all until the chat is at least N messages long.

## How Activation Works

On every generation, tamari scans the **full chat history** (a macro-resolved copy — `{{char}}` is already expanded to the character's name, and there is no scan-depth limit) and activates entries in this order:

1. **Decorator pre-pass.** `@@` decorators at the top of each entry's content are parsed and applied as field overrides (see [Decorators](#-decorators)).
2. **Sticky pre-evaluation.** Entries still inside their sticky window are force-activated.
3. **Scan rounds.** Constant entries activate; everything else rolls its probability and checks its keys against the scan text. Then up to 3 recursion rounds run (see below).
4. **Budgeting.** Each round's results are sorted by `order` and fill the token budget greedily.

### Matching rules

- Matching is **case-insensitive substring** matching: a key `dragon` matches "Dragon", "dragonfly", and "a DRAGON attacks". Whole-word and case-sensitive modes exist in the engine but are not wired up to generation.
- With **Regex** on, each key is compiled as a JavaScript regex (case-insensitive flag). A key that fails to compile is skipped silently — test regex keys with the **Test Triggers** panel.
- **Selective** entries need one primary key *and* one secondary key to both match somewhere in the scan text.

### Recursion and the token budget

The World Info budget is **25% of the context length** (`maxContext`) of the active generation. Entries sorted by `order` are added until the next one wouldn't fit — and that first oversized entry **ends the round**, so a huge constant entry can starve everything sorted after it.

Entries with **Recursive** enabled feed the next round: their *content* replaces the scan text, so activated lore can trigger further entries (e.g. an entry about a tavern mentions a character, whose own entry then fires). This repeats for up to 3 extra rounds and stops early when a round activates nothing new or no recursive content was added.

> **Note:** Token costs are counted on the raw entry content, before macros are resolved. A content full of `{{getvar}}` placeholders is budgeted as-written, not as-expanded.

### Placement

| Position | Where it goes |
|----------|---------------|
| **Before Character** (`before_char`) | The `worldInfoBefore` prompt marker ("World Info (before)" in prompt lists) — the system-prompt area before the character's description. |
| **After Character** (`after_char`) | The `worldInfoAfter` marker ("World Info (after)") — after the character card fields. |
| **Top** (`top`) | Appended to the *before* content. |
| **Bottom** (`bottom`) | Appended to the *after* content. |
| **At Depth** (`atDepth`) | Spliced into the chat history as a synthetic message — see [At-Depth Injection](#at-depth-injection). |

> **Warning:** Non-constant entries in static positions (everything except **At Depth**) inject into the system prompt, which changes the cache prefix every time a different set of entries fires — so their presence **disables Claude prompt caching for that generation**. If caching matters to you, prefer `constant` entries or **At Depth** placement. (When **Append-only prompt layout** is on, non-constant entries don't render at all; constant **At Depth** entries hoist to a pinned block at the top of history.)

## `@@` Decorators

Decorators are `@@`-prefixed lines at the **very top** of an entry's content (V3 character-card syntax). They're parsed only when the content starts with `@@`, they override the entry's fields for that generation, and they're stripped from the injected text. Parsing stops at the first unknown decorator — everything from there on is content.

```
@@depth 4
@@role user
[Scenario: the festival is in full swing.]
```

| Decorator | Effect |
|-----------|--------|
| `@@activate` | Makes the entry constant (always active). |
| `@@dont_activate` | Disables the entry. |
| `@@depth N` | Sets position to **At Depth** with depth N. |
| `@@role system\|user\|assistant` | Role of the at-depth injected message. |
| `@@keep_activate_after_match` | Sticky "forever" — once triggered, the entry stays active (a sticky value of 1,000,000). |
| `@@dont_activate_after_match` | Fire at most once: if the entry has ever activated on this branch, it never activates again. |
| `@@activate_only_after N` | Sets **Delay** to N messages. |
| `@@activate_only_every N` | Sets **Cooldown** to N messages. |
| `@@additional_keys a, b` | Adds keys to the entry's primary key list (comma-separated). |
| `@@exclude_keys a, b` | Removes keys from the primary and secondary key lists. |

Also recognized but **parsed-then-ignored**: `@@scan_depth`, `@@is_greeting`, `@@ignore_on_max_context` (collected, never applied) and `@@position` (accepted as a no-op — the entry keeps its configured position).

The `@@@` (triple-at) fallback syntax is supported: an `@@@` line is used only when the preceding `@@` decorator was unknown, which lets cards carry alternate spellings for different frontends.

## At-Depth Injection

An **At Depth** entry is spliced into the chat history as a synthetic message N messages from the end (`depth 0` = after the last message), with the role you choose (**System**, **User**, or **Assistant** — default `system`). At-depth content is injected **after the Author's Note**, and — unlike static positions — it is **macro-resolved at injection time**, so `{{getvar}}` and friends produce live values. An entry whose content resolves to an empty string is dropped entirely.

The synthetic message only exists in the prompt; it's never saved to the chat. Because it lands inside the history rather than the system prompt, at-depth entries are also friendly to prompt caching (see the warning under [Placement](#placement)).

## Semantic World Info (RAG)

Entries whose `retrievalMode` is `semantic` skip keyword matching entirely. Instead, tamari keeps a per-book vector index (via vectra, stored under `<data dir>/vectors/wi/<bookId>` — the data dir is the `DATA_DIR` environment variable, defaulting to `data-v2/` in the server root). On each generation:

1. Semantic entries are (re-)indexed from their content.
2. The full chat history is embedded and used as the query.
3. Entries whose similarity score clears the threshold activate — no keyword needs to appear in the chat.

### Setup

Semantic retrieval needs an **OpenAI-compatible embeddings endpoint**, configured with these server settings:

| Setting | Default | Meaning |
|---------|---------|---------|
| `rag.enabled` | `false` | Master switch for RAG. |
| `rag.api_url` | `http://localhost:5000/v1` | Base URL of the embeddings API; tamari POSTs to `<api_url>/embeddings`. |
| `rag.api_key` | — | Optional bearer token. |
| `rag.model` | `text-embedding-3-small` | Embedding model name sent with the request. |
| `rag.top_k` | `5` | Max entries returned per query. |
| `rag.threshold` | `0.7` | Minimum similarity score (0–1) for an entry to count as a match. |

Changes apply at runtime — the embedding client is rebuilt and cached indices are dropped (on-disk index data survives; entries re-index on next use). If the query fails (endpoint down, bad key), the generation continues without semantic matches — the error is only logged.

> **Note:** There is currently **no UI** for either side of this: `rag.*` settings are set through the settings API (`settings.set` messages / server settings), and an entry's `retrievalMode` is set through the [workbench](./workbench.md) (`/characters/<id>/lorebook/<entryId>.json/retrieval_mode`), the API, or by importing a card whose entries are flagged as vectorized — legacy SillyTavern imports map `vectorized` entries to `semantic` and `constant` ones to `constant`. Keyword mode stays the default for everything you create in the modal.

## Linking Books to Characters

Books are standalone — you create them in the **World Info** modal — but world info only reaches the prompt through a character. Open the character editor and pick a book from the **Linked Lorebook** dropdown (options show the book name and entry count; **None** unlinks). Each character links at most one book; the same book can be linked from several characters.

- Only the book linked to the **current chat's character** is scanned. There are no global, persona-level, or chat-level books.
- Importing a character card (V2/V3) with an embedded `character_book` creates a book and links it automatically.
- The AI can manage the linked book through the workbench at `/characters/<id>/lorebook/` — see [The Workbench](./workbench.md).

> **Warning:** Whole-book updates (replacing the entire entry list in one API/workbench write) regenerate every entry's ID, which resets sticky/cooldown history for the book. Per-entry edits (what the modal does) keep IDs stable.

## Testing & Automation

### Test Triggers

At the bottom of the book editor, the **Test Triggers** panel runs your entries against any sample text you paste and lists which would fire, with token counts and positions. It runs with an unlimited budget and no chat history, so it exercises keys, regex, selective logic, and constants — but not sticky/cooldown/delay (those need a message timeline) and not semantic retrieval.

### The `/wi` slash command

Typed into the chat input, `/wi` operates on the book linked to the current chat's character:

- `/wi list` — posts the book's entries (keys + content preview) as a system message in the chat.
- `/wi get <key>` — shows the full content of the first entry with that key.
- `/wi add <keys> <content...>` — adds an entry (comma-separated keys; defaults: position `before_char`, order `0`, keyword mode).
- `/wi del <key>` — deletes the first entry with that key.

Key matching for `get`/`del` is case-insensitive. With no book linked, you get a "No lorebook linked to this chat" toast.

### The Lua `wi_*` API

Quick Replies and Lua tools can read and write the linked book through the `st` API: `st.wi_list()`, `st.wi_get(key)`, `st.wi_add(keys, content)`, and `st.wi_remove(key)` — all asynchronous, all operating on the current chat character's linked book. `wi_add` fails when the character has no book linked. Full details: [Lua Scripting](./lua-scripting.md).

## Tips & Gotchas

- **Keys are substrings, not words.** `art` matches "start" and "artwork". Prefer distinctive keys, or switch the entry to **Regex** and use `\bart\b` yourself.
- **Constants go first in the budget fight.** Set `order` deliberately: low numbers on the entries you can't live without. One oversized low-order entry can starve everything after it in the same round.
- **`{{getvar}}` in entries makes "live state" lore.** Entry content is macro-resolved (at-depth content at injection; static content via the prompt pipeline), so an entry can read variables set by `{{setvar}}` in message text, `st.setvar` from a quick reply, or a custom backend. See [Macro System](./macros.md).
- **Sticky expires from the last *real* trigger.** It doesn't chain: a sticky entry that stays active via carry-over won't extend its own window.
- **Recursion is one-way fuel.** Only content from entries that *activated and fit the budget* in a round becomes the next round's scan text — an entry that lost the budget fight triggers nothing.
- **Regex keys are case-insensitive too.** If you need case sensitivity in a key, bake it into the pattern itself with character classes like `[A-Z]`.
- **Prefer At Depth for dynamic lore.** Static-position entries that toggle on and off disable prompt caching; at-depth entries don't.
- **Deleting a book doesn't warn its characters.** Characters that linked it simply fall back to no world info. Re-link from the character editor's **Linked Lorebook** dropdown after recreating a book.

## See Also

- [Macro System](./macros.md) — macros resolved in entry content and scan text
- [Characters](./characters.md) — the character editor and card imports (including embedded lorebooks)
- [Lua Scripting](./lua-scripting.md) — the full `st` API, including `wi_*`
- [The Workbench](./workbench.md) — AI-managed lorebook editing, including `retrieval_mode`
- [Tools & Toolsets](./tools.md) — the `docs` tool's `lorebooks` topic for the model
- [Slash Commands](./slash-commands.md) — `/wi` and the other chat-input commands
