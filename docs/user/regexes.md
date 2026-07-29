# Regex Scripts

Regex scripts are find/replace rules that tamari applies to text at two points: **Prompt** rules rewrite what the AI sees when the prompt is built, and **Display** rules rewrite what you see when a message is rendered. They never modify stored messages — the same saved text is re-processed on every generation and every render, so you can edit, disable, or delete a rule at any time and the chat reverts.

Use them for typography cleanup, stripping scaffolding tags, hiding spoilers, rendering status panels, and any other mechanical text transformation you don't want to trust the model with.

## Where Rules Live

Regex rules come in two scopes, and both are always merged together:

- **Global rules** apply to every chat. Manage them in the **Settings** modal (sidebar → **Settings**, gear icon) under the **Regex Rules** section.
- **Character-scoped rules** apply only when that character is active, and they live on the card itself (in `extensions.regexScripts`), so they travel with it. Manage them in the **Character Editor**, on the **Logic & Rules** tab, under **Regex Scripts (this character)**. See [Characters](./characters.md).

Both editors work the same way: click **New Regex Rule**, fill in the form, **Save Rule**. Each rule row shows its pattern, replacement, and active placements at a glance.

> **Note:** When you import a SillyTavern v1 character card, scoped scripts stored at `extensions.regex_scripts` are converted to tamari rules automatically at import time. RisuAI module regexes are *not* converted — modules stay attached as a read-only porting reference; see [The Workbench](./workbench.md) for the porting workflow.

## Rule Fields

| Field | UI label | What it does |
|-------|----------|--------------|
| `name` | **Name** | A label for you; required. |
| `findRegex` | **Find Regex** | The pattern to match — must be in `/pattern/flags` form (see below). |
| `replaceString` | **Replace With** (Text) | The replacement text, with `$1`-style back-references. |
| `replaceLua` | **Replace With (Lua)** | A Lua replacement function — takes precedence over the text replacement when set. See [Lua Replacements](#lua-replacements). |
| `prompt` | **Prompt** checkbox | Apply when building the prompt (what the model sees). |
| `display` | **Display** checkbox | Apply when rendering messages (what you see). |
| `userInput` | **User Input** checkbox | Restrict the rule to your messages. |
| `aiOutput` | **AI Output** checkbox | Restrict the rule to the character's messages. |
| `disabled` | **Disabled** checkbox | Keep the rule but turn it off. |

### Find Regex format

Patterns must be delimited, JavaScript-style:

```
/foo/      → matches all occurrences (the default flag is g)
/foo/gi    → same, plus case-insensitive
/\*{2,}/g  → two or more asterisks
```

A bare pattern like `foo` (no slashes) is **rejected** — the rule simply never matches.

### Replacement back-references

The text replacement supports standard JavaScript back-references:

- `$1`, `$2`, … — capture groups
- `$&` — the whole match
- `$$` — a literal `$`

### Placement and role filters

The **Prompt** / **Display** checkboxes choose *where* the rule runs; **User Input** / **AI Output** optionally narrow it to one role:

- Neither role checkbox set → the rule applies to both user and assistant messages.
- **User Input** set → only your messages. **AI Output** set → only the character's.
- `system` and `tool` role messages never match a rule that has either role filter set.

> **Warning:** A rule with neither **Prompt** nor **Display** checked does nothing — the list shows "No placement selected". Also note the editors' defaults differ: a new *character-scoped* rule starts with both placements on (apply everywhere), while a new *global* rule starts with both off. Set the placements deliberately every time.

## Lua Replacements

Flip the replacement type from **Text** to **Lua** in the rule editor and the replacement becomes a script. The JavaScript regex still finds the matches; each match is then replaced by the return value of a `replace` function you define:

```lua
function replace(match, captures)
  -- match:    the full matched text
  -- captures: 1-indexed array of capture groups
  --           (nil for unmatched optional groups)
  return string.format('<span class="hp">%s</span>', captures[1])
end
```

The contract:

- **A non-empty `replaceLua` takes precedence over `replaceString`** — the text replacement is ignored while a Lua script is set. Flip back to **Text** to clear it.
- Returning a non-string (or `nil`) keeps the original match — useful for "only rewrite some matches" logic.
- The script runs in a sandboxed Lua VM with a **5-second** budget: no `io`, `os`, or network access; `json` and `base64` are available.
- A script that errors, times out, or doesn't define `replace` is skipped — the rule leaves the text unchanged, same as a failed plain rule.

> **Note:** Lua replacements run server-side only — the editor's **Test Output** preview can't run them and says so. Use the workbench's `test_regex` verb (below) to preview Lua rules.

## Where Rules Run

### Prompt rules

Prompt rules run on the server during prompt assembly, as the **first** stage that touches chat history — before the Author's Note splice, at-depth World Info entries, and runtime injections. Each message is processed independently, with role filtering applied per message, and only text parts are rewritten (images, tool results, and other part types pass through).

The rewrite is ephemeral: it's built fresh for that generation and never written back to the chat. Prompt rules also run on your *outgoing* message as it enters the history being sent — a **Prompt** + **User Input** rule can rewrite what the model sees of your own text while your displayed message stays as typed.

### Display rules

Display rules run on the server whenever a message's HTML is computed — when a chat loads and whenever messages are broadcast (new generations, swipes, edits) — on the raw text **before** markdown rendering. Consequences:

- A display rule can inject markdown (it will be rendered) or HTML.
- Injected HTML still goes through sanitization, so scripts and event handlers are stripped — a rule can't smuggle in XSS. The default (permissive) sanitization keeps `class` and `style` attributes, so styling hooks survive; enabling **Strict HTML sanitization** (Settings → **Display**) narrows allowed tags to basic formatting.
- Because rendering always re-runs from the stored text, editing a display rule changes how existing messages look the next time they're rendered — no migration needed.

### Safety limits

- Every plain-regex rule executes in a separate worker thread with a **1-second** timeout — a catastrophic-backtracking pattern can't freeze the server; the rule is skipped and the text passes through unchanged.
- Input is truncated at **100,000 characters** per text part.
- Malformed patterns, Lua errors, and timeouts are all handled the same way: skip the rule, keep the text, log a server-side warning.

## Testing Rules

The rule editor has **Test Input** / **Test Output** fields for a quick check of text replacements (Lua replacements can't be previewed there).

For the full picture — merged global + character rules, both placements, Lua included — use the workbench's `test_regex` verb, which the AI can run for you when a **Workbench** toolset is enabled:

```
run {"verb": "test_regex", "args": {"characterId": "<id>", "text": "HP: 7/10", "role": "assistant"}}
```

It returns the sample text after `prompt` rules and after `display` rules separately, so you can verify each placement before saving. Omit `characterId` to test global rules alone; `role` defaults to `assistant`. The AI can also author rules directly via `/characters/<id>/regex/` files — see [The Workbench](./workbench.md).

## Ordering and Merge Semantics

- Rules apply **in list order**, top to bottom, and each rule sees the output of the ones before it.
- When a character is active, the merged list is **global rules first, character-scoped rules after** — so character rules see the global rules' output and win on overlapping patterns.
- **Disabled** rules are skipped entirely but stay in place, so prefer disabling over deleting while you iterate.
- Prompt and display passes are independent: a rule with both placements checked runs twice, once in each pass.

## Examples

### Typography cleanup (display)

Straighten the model's dashes and collapse stray asterisks for reading, without touching stored text:

| Field | Value |
|-------|-------|
| Name | `Collapse asterisk runs` |
| Find Regex | `/\*{2,}/g` |
| Replace With | `*` |
| Placement | **Display** |

### Spoiler hiding (display)

Render `||spoiler||` markup as a hidden span:

| Field | Value |
|-------|-------|
| Name | `Spoilers` |
| Find Regex | `/\|\|(.+?)\|\|/g` |
| Replace With | `<span class="spoiler">$1</span>` |
| Placement | **Display** |

Then style the class in Settings → **Theme** → **Custom CSS** (see [UI Customization](./ui-customization.md)):

```css
.spoiler { background: #000; color: #000; border-radius: 3px; }
.spoiler:hover { color: #fff; }
```

### HUD stripping (prompt)

If your card emits status tags like `[HUD|hp=7|mp=3]` that you don't want echoing in the model's next context:

| Field | Value |
|-------|-------|
| Name | `Strip HUD tags` |
| Find Regex | `/\[HUD\|[^\]]+\]/g` |
| Replace With | *(empty)* |
| Placement | **Prompt**, **AI Output** |

The stored message keeps the tag (so a display rule can still render it as a panel for you), but the model never sees it again.

> **Note:** Think twice before stripping state from the prompt — a compact tag the model can see is often *useful*, updatable state. A common pattern is the opposite split: keep the tag in the prompt, and use a **Display** rule with a Lua replacement to render it as a nice panel for yourself.

### HUD panel (display, Lua)

The display half of that pattern — turn the tag into markup:

| Field | Value |
|-------|-------|
| Name | `Render HUD` |
| Find Regex | `/\[HUD\|([^\]]+)\]/g` |
| Replace With (Lua) | see below |
| Placement | **Display**, **AI Output** |

```lua
function replace(match, captures)
  local fields = {}
  for pair in captures[1]:gmatch("[^|]+") do
    local k, v = pair:match("^(%w+)=(.+)$")
    if k then fields[k] = v end
  end
  return string.format(
    '<div class="hud"><span class="hp">HP %s</span> <span class="mp">MP %s</span></div>',
    fields.hp or "?", fields.mp or "?")
end
```

## Tips & Gotchas

- **Forgetting the slashes is the #1 mistake.** `foo` never matches; `/foo/` does. The editor validates this on save.
- **The default flag is `g`.** `/foo/` already replaces every occurrence — you only add flags for things like case-insensitivity (`/foo/gi`).
- **Rules compose through order.** A character-scoped rule can post-process what a global rule produced — or undo it, since character rules run last.
- **Prompt rules don't change what you see; display rules don't change what the model sees.** If a rule seems to do nothing, check which placement you actually checked.
- **A skipped rule fails silently in the UI.** If nothing happens, test with `test_regex` and check the server log for `regex rule failed, skipped` warnings — usually a bad pattern, a timeout, or a Lua error.
- **Keep state out of display rules.** Display rules re-render old messages every time they load, so a replacement that depends on *current* state would rewrite history. Carry the values in the message text itself (like the HUD tag above) instead.
- **For logic too rich for one regex**, move the transformation into a [Lua script](./lua-scripting.md) or do conditional text with [macros](./macros.md) instead of stacking rules.
