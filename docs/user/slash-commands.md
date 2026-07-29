# Slash Commands

Slash commands are shortcuts you type into the message composer to control the chat: send messages as the system, steer generation, edit history, switch characters and personas, manage World Info, and more. Type `/` and an autocomplete list appears; every command is listed below with its arguments and exact behavior.

## Using Slash Commands

1. Click into the message composer (the **Type a message...** box at the bottom of the chat).
2. Type `/`. A suggestion list appears above the input, filtered as you keep typing — each entry shows the command name and a short description.
3. Click a suggestion (or just finish typing the command yourself), add any arguments separated by spaces, and press **Enter** or click **Send**.

Everything after the command name becomes its arguments, so `/sys The rain stops.` passes `The rain stops.` as one piece of text. A command runs through the same path as pressing **Send**, so it respects the **Send on Enter** setting — if that's off, use the **Send** button.

> **Warning:** Unknown commands are **not** errors — the whole line is sent to the chat as a regular message. `/swpie left` becomes a message literally reading "/swpie left" and triggers a generation. Watch the autocomplete list; if your command isn't in it, it doesn't exist.

The composer also autocompletes **macros**: typing `{{` opens a second suggestion list. See [Macro System](./macros.md).

## Command Reference

### Chat Actions

| Command | Arguments | What it does |
|---------|-----------|--------------|
| `/send` | `[text]` | Appends `text` as your message and immediately generates a reply — the same as typing a message and pressing **Send**. |
| `/sys` | `<text>` | Appends `text` as a **system** (narrator-style) message. No generation is triggered. |
| `/reset` | — | Deletes **every** message in the chat. |
| `/cut` | `[count]` | Removes the last `count` messages (default `1`). |
| `/swipe` | `left` \| `right` | Moves to the previous/next swipe of the last message. |

> **Warning:** `/reset` has no confirmation and no undo — the entire chat history is deleted immediately.

> **Warning:** `/swipe` accepts only `left` and `right`. Any other argument (or none) fails silently client-side, and the line falls through and is sent as a regular chat message.

### Generation Control

| Command | Arguments | What it does |
|---------|-----------|--------------|
| `/continue` | — | Continues the last assistant message. Fails with an error if the last message isn't from the assistant. |
| `/regenerate` | — | Regenerates the last message, producing a new swipe. |
| `/regen` | — | Alias for `/regenerate`. |
| `/impersonate` | — | Generates a draft **user** message and drops it into the composer — nothing is sent until you press **Send**. Same as the **Impersonate** (person icon) button next to the composer. |
| `/gen` | `<prompt>` | Quiet generation **with** chat context: no user message is appended, and the result is appended to the chat as a system message. |
| `/sysgen` | `<text>` | Currently identical to `/gen`. |
| `/genraw` | `<prompt>` | Truly raw generation: the prompt text goes to the model as a single user message — no chat history, no character card, no World Info. The result is appended as a system message. |
| `/ask` | `<character> <message>` | Posts `<message>` as you, then generates a reply as the named character (exact name match). Does not switch chats — the reply lands in the current one. |
| `/inject` | `<text>` | Queues `text` for the **next** generation: it is macro-resolved and spliced into the prompt as a synthetic system message at the end of context (depth 0). One-shot — consumed by the next generation. A toast confirms the injection. |
| `/flushinject` | — | Discards all pending `/inject` entries. A toast reports how many were cleared. |

`/inject` is the way to slip an instruction into a single generation without touching your preset or Author's Note — for example `/inject ({{char}} notices the storm outside)` before your next message. Because injections are macro-resolved, `{{char}}`, `{{user}}`, variables, and randomization all work inside them.

> **Note:** Pending injections merge with any queued by Lua `st.inject` — one does not wipe the other. See [Lua Scripting](./lua-scripting.md).

### Settings & Appearance

| Command | Arguments | What it does |
|---------|-----------|--------------|
| `/name` | `<name>` | Sets your display name (the `userName` setting). With no argument, does nothing. |
| `/persona` | `<name>` | Switches the current chat's persona. Name match is case-insensitive, exact first, then substring. Shows an error toast if no persona matches. |
| `/theme` | `<preset>` or `<css>` | Applies a theme preset — `dark` (the default), `light`, `high-contrast`, or `none`. Anything that isn't a preset name is stored verbatim as custom CSS (the `themeCustomCss` setting). |
| `/bg` | `[url]` | Sets the chat background image URL (the `backgroundImageUrl` setting). No argument clears it. |

Themes and backgrounds are covered in depth in [UI Customization](./ui-customization.md); personas in [Personas](./personas.md).

### World Info (`/wi`)

`/wi` is a family of shortcuts for the **lorebook linked to the current chat's character**. If the character has no linked book, every subcommand fails with the toast `No lorebook linked to this chat`. See [World Info](./world-info.md) for linking and the full editor.

| Command | Arguments | What it does |
|---------|-----------|--------------|
| `/wi list` | — | Posts a numbered list of all entries (`[keys] content preview…`) into the chat as a system message. |
| `/wi get` | `<key>` | Posts the full content of the first entry whose keys include `<key>` (case-insensitive) as a system message. |
| `/wi add` | `<keys> <content...>` | Creates an entry. `<keys>` is a comma-separated list with no spaces; everything after it is the content. |
| `/wi del` | `<key>` | Deletes the first entry whose keys include `<key>` (case-insensitive). |

```
/wi add obsidian,order The Obsidian Order is a secret cabal of archivists.
/wi get obsidian
/wi del order
```

Entries created with `/wi add` get fixed defaults: position **Before Character**, insertion order `0`, probability `100%`, role **system**, keyword retrieval, not constant, no secondary keys. To tune any of that, open the entry in the World Info editor afterward.

> **Note:** `/wi list` and `/wi get` write their output **into the chat** as system messages — they become part of the history the model sees. `/cut 1` removes the listing afterward if you don't want it in context.

### Navigation & Input

| Command | Arguments | What it does |
|---------|-----------|--------------|
| `/char` | `<name>` | Switches to a chat with the named character (same fuzzy match as `/persona`): opens their most recently updated chat, or creates a new one named `<Character> - <date>` if none exists. Shows an error toast if no character matches. |
| `/lock` | — | Locks the composer — the input is disabled and its placeholder changes to *"Input is locked. Type /unlock to enable."* |
| `/unlock` | — | Unlocks the composer. |

> **Note:** The input lock is client-side and not persisted — reloading the page unlocks it.

### Utility

| Command | Arguments | What it does |
|---------|-----------|--------------|
| `/listvar` | — | Shows a toast listing all macro variables: global variables as `{{$name}} = value` and chat-local ones as `{{.name}} = value`, or `No variables set` when empty. |

Variables are set by `{{setvar}}` macros and Lua scripts — see [Macro System](./macros.md).

## Slash Commands vs Quick Replies

These are different systems that are easy to confuse:

- **Slash commands** are typed by *you*, one at a time, in the composer. They are a fixed, built-in list — you can't add your own.
- **Quick replies** are buttons (global, per-character, or per-chat) that run **Lua scripts** against the `st` API — not slash commands. A quick reply can do anything the `st` API can do, including multi-step logic slash commands can't express.

If you find yourself wanting a custom slash command, a quick reply with a Lua script is the answer. See [Lua Scripting](./lua-scripting.md).

## Lua `st` API Parity

Many slash commands wrap the same server operations as `st` functions, so anything you can do with a command you can also script:

| Slash command | Lua equivalent |
|---------------|----------------|
| `/continue` | `st.continue()` |
| `/impersonate` | `st.impersonate()` |
| `/regenerate` | `st.regenerate()` |
| `/swipe left` | `st.swipe("left")` |
| `/cut 3` | `st.cut(3)` |
| `/reset` | `st.reset_chat()` |
| `/inject text` | `st.inject("text")` |
| `/flushinject` | `st.flush_inject()` |
| `/gen prompt` | `st.generate("prompt")` — returns the text instead of appending it |
| `/genraw prompt` | `st.genraw("prompt")` |
| `/ask Name msg` | `st.ask("Name", "msg")` |
| `/sysgen text` | `st.sysgen("text")` |
| `/wi list` / `get` / `add` / `del` | `st.wi_list()` / `st.wi_get(key)` / `st.wi_add(keys, content)` / `st.wi_remove(key)` |
| `/persona` | `st.set_persona(personaId)` — takes an ID, not a name |
| `/char` | `st.set_character(characterId)` — takes an ID, not a name |

> **Note:** `st.send(text)` is **not** the same as `/send` — it appends your message without triggering a generation. Pair it with `st.trigger()` if you want the reply too.

## Tips & Gotchas

- **Trust the autocomplete.** It shows every command that exists — if yours isn't there, it will be sent as a chat message (see the warning above).
- **`/impersonate` is a draft, not a send.** The generated text lands in the composer so you can edit it first. It never reaches the chat until you press **Send**.
- **`/gen` vs `/genraw`.** `/gen` sees the whole chat (character card, World Info, history) and just skips appending a user message; `/genraw` sees nothing but the prompt text. Use `/genraw` to ask the model something completely out of character.
- **`/sysgen` is a synonym today.** It currently does exactly what `/gen` does; it exists as a separate entry point in case its behavior diverges later.
- **Injections are one-shot.** A queued `/inject` rides along on the very next generation — whether you send a message, regenerate, or continue — and is then gone. `/flushinject` clears the queue if you change your mind.
- **`/wi` edits are permanent.** `/wi add` and `/wi del` modify the linked lorebook itself, not just the current chat — other chats with the same character see the change too.
- **The composer has a few markdown hotkeys** worth knowing alongside commands: `Ctrl+B` bold, `Ctrl+I` italic, `Ctrl+U` underline, `Ctrl+K` inline code, `Ctrl+Shift+` backtick` strikethrough (all wrap the current selection).

## See Also

- [Macro System](./macros.md) — `{{...}}` placeholders, variables, and the macro autocomplete
- [Lua Scripting](./lua-scripting.md) — quick replies and the full `st` API
- [World Info](./world-info.md) — lorebooks and the linked book behind `/wi`
- [Personas](./personas.md) — what `/persona` switches
- [UI Customization](./ui-customization.md) — themes and backgrounds behind `/theme` and `/bg`
- [Getting Started](./getting-started.md) — the composer and basic chat flow
