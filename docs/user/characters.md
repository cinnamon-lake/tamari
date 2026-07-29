# Characters & Group Chats

A character in tamari is a **card**: a set of named text fields (description, personality, scenario, greetings, …), an avatar, optional media assets, and an optional linked lorebook. Cards use the standard character-card formats (V2/V3, CharX), so cards made for SillyTavern or RisuAI import directly. Group chats put several characters in one chat and let an activation strategy decide who speaks.

## What a Character Card Is

Two things to keep apart:

- **The card's text fields have no fixed semantics of their own.** Whether and where each field reaches the model is decided by the active prompt list — the default list places Description, Personality, Scenario, and Message Example in the system prompt, but a custom prompt list can move or drop them.
- **Character-scoped feature data** (regex rules, backend logic, attached RisuAI modules) lives in the card's `extensions` bag and travels with it on export, so a card carries its behavior with it.

All text fields are macro-resolved. Card fields are resolved fresh on every generation (so `{{random}}`, `{{time}}`, `{{user}}` re-roll each time); greetings are resolved once when they materialize into the chat and are stored resolved. See [Macro System](./macros.md).

## Card Fields

Open a character in the editor (sidebar → **Characters** → pencil icon) to edit these. Each field also fills the macro of the same name — `{{description}}`, `{{personality}}`, `{{scenario}}` — so prompt lists and World Info entries can reference them directly.

| Field | What it does |
|-------|--------------|
| **Name** | Display name; fills `{{char}}`. |
| **Nickname** | V3 card field carried for compatibility. Stored and exported, but nothing in the default pipeline sends it to the model. |
| **Description** | The main free-form field — who the character is. Interpolated where the active prompt list places its `charDescription` marker; if the list has no such marker, it is never sent. |
| **Personality** | Short trait summary, interpolated via the `charPersonality` marker. |
| **Scenario** | The situation the chat starts in, interpolated via the `scenario` marker. |
| **First Message** | The opening greeting. Becomes the chat's first message when you start chatting (see [Greetings](#greetings)). |
| **Message Example** | Example dialogue showing the character's voice, interpolated via the `dialogueExamples` marker. |
| **System Prompt** | Card-level override of the prompt list's `main` prompt content. Ignored if that prompt sets `forbidOverrides`. |
| **Post-History Instructions (Jailbreak)** | Card-level override of the prompt list's `jailbreak` prompt content — instructions injected after the chat history. |
| **Creator Notes** | Free-form notes. No built-in marker interpolates them, so they never reach the model unless a custom prompt list references them. |
| **Tags** | Organization/filtering in the sidebar. Never sent to the model. |
| **Creator / Version / Source** | Card metadata (Source is edited one URL per line). Never sent to the model. |

> **Note:** Description, Personality, Scenario, and Message Example only reach the model because the active prompt list contains the matching markers. If a field seems to be ignored, check which prompt list is active before rewriting the card.

### Greetings

The **Greetings** tab holds **Alternate Greetings** and **Group-Only Greetings**.

A new chat starts empty: the First Message plus all Alternate Greetings form a swipeable greeting strip — swipe left/right on the greeting to pick the opener you like. When you send your first message, the selected greeting is macro-resolved **once** and written into the chat as the first message; from then on it's frozen text. If the card has RisuAI `defaultVariables` in its extensions, they seed `{{getvar}}` variables at that moment.

> **Warning:** **Group-Only Greetings** are stored, editable, and exported (V3), but nothing in tamari currently uses them — group chats don't show a greeting at all. Treat the field as card-compatibility data.

## Creating & Editing

The **Characters** section of the sidebar is your card list: search box, tag filter chips, sorting (Recently Updated / Recently Created / Name A-Z), and a list/grid toggle.

- **Create:** click the **+** button (Create character) in the Characters section header. A blank card named "New Character" is created and opened in the editor.
- **Edit:** click the pencil icon (Edit character) on a character, which opens the **Character editor** modal.
- **Delete:** the red **Delete** button at the bottom of the editor. This also deletes all of the character's chats and cannot be undone — you get a confirmation first.

The editor has four tabs:

- **Content** — avatar, Name, Nickname, Description, Personality, Scenario, First Message, Message Example, Tags, and the Linked Lorebook dropdown.
- **Greetings** — Alternate Greetings and Group-Only Greetings.
- **Logic & Rules** — character-scoped Regex Scripts, Backend Logic, and imported RisuAI modules (see [Character-Scoped Extras](#character-scoped-extras)).
- **Advanced** — Creator Notes, System Prompt, Post-History Instructions, Creator, Version, Source, and the asset gallery.

**Auto-save.** There is no save button: every edit is saved automatically after a short debounce, and a "Saved" indicator flashes at the bottom of the modal. Closing the editor flushes any pending change, so you can't lose an edit by closing early.

## Importing & Exporting Cards

### Import

Click the upload button (Import card) in the **Characters** section header and pick a file. Three formats are accepted, detected by content rather than extension:

- **PNG cards** — the classic format: card JSON embedded in the image's `tEXt` chunks. tamari reads the V3 (`ccv3`) chunk first and falls back to the V2 (`chara`) chunk. The PNG image itself becomes the character's avatar.
- **CharX (`.charx`)** — a ZIP containing `card.json`, the card's media assets, and optionally an embedded RisuAI `module.risum`. Assets are extracted as character assets, the icon asset becomes the avatar, and the embedded module is stored raw for porting (see [Porting RisuAI Cards](#porting-risuai-cards)).
- **JSON** — a bare card JSON. Imports fields only: no avatar and no assets.

Two things happen on every import regardless of format:

- **Embedded lorebook.** A card's `character_book` is converted into a tamari lorebook (named after the book, or "&lt;Name&gt; Book") and linked to the character automatically — you'll see it selected in the **Linked Lorebook** dropdown.
- **RisuAI macro conversion.** Card text using RisuAI CBS block syntax (`{{#if …}}`, `{{else}}`, `{{/if}}`) is rewritten to tamari's `{% if %}` block syntax at import. See [Porting from RisuAI CBS](./macros.md#porting-from-risuai-cbs) for what does and doesn't translate.

> **Note:** Import always creates a **new** character — importing a card you already have makes a duplicate rather than updating the existing one.

### Export

At the bottom right of the editor:

- **Export PNG** — downloads a V3 card as a PNG. The image is the character's avatar (a 1×1 placeholder if there is none), with both a `ccv3` chunk and a V2-compatible `chara` chunk embedded, so the file works in older apps too. The linked lorebook is embedded as `character_book`.
- **Export CharX** — shown only when the character has assets. Downloads a `.charx` ZIP with `card.json` plus all assets, for apps that support the RisuAI format.

## Avatars

Click **Change Avatar** in the editor's **Content** tab and pick an image. By default a crop dialog lets you frame the picture before it's stored; the server downsizes avatars to at most 512 px and generates a 96 px square thumbnail for lists.

- To skip the crop step, enable *Settings → "Never resize avatars (skip crop dialog)"*.
- PNG card imports reuse the card image as the avatar automatically; CharX imports use the card's icon asset.
- Avatars are per character. Personas (your own identity) have their own avatars — see [Personas](./personas.md).

## Character-Scoped Extras

Everything on the **Content** tab's lower half and the **Logic & Rules** tab attaches behavior to this one character.

### Linked Lorebook

The **Linked Lorebook** dropdown (Content tab) ties one World Info book to the character — typically the book created from the card's `character_book` on import. Its entries fire whenever you chat with this character. Managing books and entries: [World Info](./world-info.md).

### Regex Scripts (this character)

Find/replace rules stored on the card (`extensions.regexScripts`), edited on the **Logic & Rules** tab. They apply only to this character's chats and run **after** global regex rules; Prompt rules affect what the AI sees, Display rules only affect rendering. SillyTavern-style `extensions.regex_scripts` on imported cards are converted to this format automatically. Full rule reference: [Regexes](./regexes.md).

### Backend Logic (this character)

A Lua script (`extensions.contextualBackend`) that drives generation for this character, edited on the **Logic & Rules** tab with an **Enable backend logic** checkbox. When enabled, the script owns the prompt and your active backend becomes its default delegate — the script must define `generate(prompt, ctx)`. In group chats this applies per speaking character. The full contract: [Custom Backends](./custom-backends.md).

> **Warning:** Cards you create in tamari start with backend logic **disabled** — nothing runs until you tick **Enable backend logic** yourself. But a card's `extensions` travel with it on import, so an imported card can arrive with backend logic already enabled. After importing a card from a source you don't fully trust, check the **Logic & Rules** tab before chatting with it.

### RisuAI Modules (imported)

Also on the **Logic & Rules** tab: the "RisuAI modules (imported)" section lists raw `.risum` modules attached to the card — from a CharX import's embedded module, or attached yourself via **Attach .risum…**. They are a read-only reference for porting (triggers, regex, lorebook, and assets sections are viewable); tamari never executes them. Standalone-module asset payloads are imported as ordinary character assets, and removing a module keeps its assets. See [Porting RisuAI Cards](#porting-risuai-cards).

### Character Assets

Named media files on the card (from CharX imports or module asset payloads), grouped by type (`icon`, `background`, `emotion`, `other`) in the **Assets** gallery on the **Advanced** tab. Reference them in card text with the display-time macro `{{img::filename.png}}`; the Scene tool uses `emotion` assets as sprites and `background` assets as backdrops. Details: [Assets](./assets.md).

## Group Chats

A group chat is a chat with no single owner character — instead, it has a **member list** of characters, and an **activation strategy** decides who responds each turn.

### Creating One

Click the people-icon button (New group chat) in the chats section header of the sidebar, and give the group a name. An empty group has no members and can't generate — add members next.

### Managing Members

Open the group chat and click **Manage Members** in the "Group Chat" toolbar at the top. The **Group Members** panel lets you:

- **Add Member** — pick any character from the dropdown. The dropdown stays open so you can add several in a row.
- **Active** toggle — mute or unmute a member without removing them. Only active members are considered for activation.
- **Talkativeness** slider (0.1–5.0) — the member's selection weight in the Pooled strategy (below).
- **Remove** (trash icon, with confirmation) — takes the character out of the group. The character itself and its other chats are unaffected.

### Activation Strategies

The **Activation Strategy** dropdown at the top of the Group Members panel picks who responds when you send a message:

- **Natural (all active)** — every active member responds, in sequence.
- **List (round-robin)** — one member per turn, cycling through the member list in order. Sending a message advances to the next member.
- **Pooled (random subset)** — a random subset of active members (between 1 and 3 by default) responds each turn, with selection weighted by each member's **Talkativeness**.
- **Manual (selected only)** — only a designated member responds.

> **Warning:** The panel currently has no control for picking the Manual member (or for changing the Pooled min/max). Choosing **Manual (selected only)** therefore activates nobody, and generation fails with "No group members activated". Stick to Natural, List, or Pooled.

Each responding member generates in turn, seeing the messages the previous members just produced, so multi-member turns read as a conversation rather than parallel monologues.

### Backends in Group Chats

All members generate through your **active backend** — there is no per-member backend selection. The one per-speaker mechanism is card Backend Logic: if a member's card has **Enable backend logic** ticked, that script wraps the active backend for that member's turns only (see [Backend Logic](#backend-logic-this-character)).

> **Note:** The group-aware macros from SillyTavern cards (`{{group}}`, `{{groupNotMuted}}`, `{{charIfNotGroup}}`) are accepted for compatibility but all resolve to the character name — group-aware macro behavior isn't implemented. See [Macro System](./macros.md).

## Porting RisuAI Cards

tamari deliberately does **not** execute RisuAI triggerscripts, low-level Lua, or CBS. A RisuAI card (CharX + `.risum` modules) imports cleanly — fields, lorebook, assets, and the raw modules all land on the card — but its dynamic behavior is inert until you port it. Porting means re-expressing each behavior with three native mechanisms:

- **Lorebook entries** — for module lore. Split RisuAI's comma-joined keys into `keys[]`, map `alwaysActive` to constant, `secondkey` to secondary keys + selective.
- **Regex rules** (including `replaceLua`) — for find/replace on prompts and rendered messages. RisuAI stages map roughly as `editprocess` → prompt, `editdisplay`/`editoutput` → display, `editinput` → prompt + user input.
- **Backend logic Lua** — for everything stateful: toggle-gated prompt content, side-channel generations, parsing state writes out of replies. RisuAI buttons and popups have no equivalent; chat commands parsed from the user's message are the usual replacement.

The workflow is workbench-driven: enable a **Workbench** toolset and ask the AI to read the card's modules, clone the character, port the pieces, and dry-run each regex rule and Lua script before enabling anything. The full phased playbook, including a real-world case study and a list of RisuAI features with no tamari equivalent, is in the design doc [character-porting.md](../design/character-porting.md); the workbench verbs it uses (`clone_character`, `test_regex`, `test_backend_logic`, `copy_assets`, …) are documented in [The Workbench](./workbench.md).

## Tips & Gotchas

- **A field that's "ignored" is usually the prompt list, not the card.** Description/Personality/Scenario/Message Example only reach the model where the active prompt list places their markers.
- **Greetings freeze on first send.** Macros in the First Message and Alternate Greetings resolve once when the chat starts; macros in other card fields re-roll every generation. Don't put `{{random}}` in a greeting expecting it to change later.
- **Rename tools with care.** If your card text or Backend Logic references a tool by name and you rename it with a toolset override, update the card too — see [Tools & Toolsets](./tools.md).
- **Character regex runs after global regex.** When a global rule and a card rule both match, order matters — preview the merged result with the workbench's `test_regex` verb before debugging the card.
- **System Prompt can be blocked.** If the active prompt list's `main` prompt sets `forbidOverrides`, the card's System Prompt field is silently ignored — that's the list working as designed.
- **Export CharX for asset-heavy cards.** PNG export embeds the card JSON and lorebook but not the asset binaries; only `.charx` carries them.
- **Deleting a character deletes its chats.** Export the card first if you might want it back.

## See Also

- [Getting Started](./getting-started.md) — first-run setup and your first chat
- [Personas](./personas.md) — your own identity in chats (`{{user}}`)
- [Macro System](./macros.md) — `{{char}}`, `{{description}}`, and the `{% if %}` block syntax used in card fields
- [World Info](./world-info.md) — lorebooks, including the linked character book
- [Regexes](./regexes.md) — global and character-scoped find/replace rules
- [Custom Backends](./custom-backends.md) — the Lua contract behind Backend Logic
- [Assets](./assets.md) — character assets, attachments, and avatars
- [The Workbench](./workbench.md) — AI-driven editing and RisuAI module porting
