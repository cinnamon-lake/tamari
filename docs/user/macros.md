# Macro System

Macros are dynamic placeholders that get replaced with real values when tamari builds the prompt sent to the AI. They work in character cards, preset prompts, World Info entries, Author's Note, and anywhere else text is resolved before generation.

## Basic Syntax

Macros are wrapped in double curly braces:

```
{{user}}        → Your persona name
{{char}}        → The character's name
{{model}}       → The active model name
```

### Arguments

Some macros accept arguments separated by `::`:

```
{{random::1::100}}           → A random number between 1 and 100
{{pick::red::blue::green}}   → Randomly picks one of the options
{{roll::2d6}}                → Rolls 2 six-sided dice
{{getvar::mood}}             → Reads the variable named "mood"
{{setvar::mood::happy}}      → Sets the variable "mood" to "happy"
```

Arguments can contain nested macros:

```
{{setvar::greeting::Hello {{user}}!}}
```

### Block Syntax

Conditional blocks use `{%` and `%}`:

```
{% if {{? {{equal::{{user}}::Alice}} }} %}
  Special greeting for Alice
{% else %}
  Generic greeting
{% endif %}
```

Loop blocks iterate over values:

```
{% for item::sword::shield::potion %}
  - You have a {{item}}
{% endfor %}
```

Inside a `for` loop, the loop variable (here `item`) and `forIndex` (0-based index) are available as macros.

## Resolution Model

Macros are resolved by a multi-pass engine, and a few of its behaviors are worth understanding before you build anything complex:

- **Multi-pass, order-independent.** Resolution loops (up to 10 passes) until everything settles. A `{{setvar}}` anywhere in the prompt can feed a `{{getvar}}` that appears *earlier* in the text — order doesn't matter:

  ```
  {{getvar::mood}} / {{setvar::mood::happy}}   → happy /
  ```

- **Unknown macros pass through unchanged.** `{{madeup::a::b}}` stays as literal text in the output — useful for spotting typos. The same applies to unknown or unterminated `{% %}` blocks: they are left in the text as-is rather than producing an error.

- **Unset variables.** Reading a variable that was never set behaves differently per syntax: `{{getvar::nosuch}}` passes through literally (it waits for a `setvar` that never comes), while the shorthands `{{.nosuch}}` and `{{$nosuch}}` resolve to an empty string.

- **Non-deterministic macros disable prompt caching.** `{{random}}`, `{{pick}}`, `{{roll}}`, and all time/date macros change on every build, so tamari automatically turns off Claude prompt caching for any generation whose inputs contain them. See [Preventing Cache Issues](#preventing-cache-issues).

- **Append-only prompt layout disables macros wholesale.** When Settings → Generation → **Append-only prompt layout** is on, no macro is resolved anywhere — `{{char}}` renders literally in history, card fields, and every prompt. Cards that depend on macros are incompatible with the mode.

- **Write-time vs build-time resolution.** Chat messages are resolved **once, when they are written** (sent, edited, or generated) and stored already resolved — a `{{random}}` in a message is frozen forever. Prompts, character card fields, World Info, and Author's Note are resolved **fresh on every generation**, so they re-roll each time. Each message also stores a snapshot of its variables, so swipes and branches keep their own variable state.

## Macro Reference

### Identity

| Macro | Description | Example Output |
|-------|-------------|--------------|
| `{{user}}` | Your persona / user name | `Alice` |
| `{{char}}` | Character name | `Seraphina` |
| `{{character}}` | Same as `{{char}}` | `Seraphina` |
| `{{charIfNotGroup}}` | Character name (card-compat alias) | `Seraphina` |
| `{{group}}` | Character name (card-compat alias) | `Seraphina` |
| `{{groupNotMuted}}` | Character name (card-compat alias) | `Seraphina` |

> **Note:** `{{charIfNotGroup}}`, `{{group}}`, and `{{groupNotMuted}}` are accepted for SillyTavern card compatibility, but group-aware behavior is not implemented yet — all three currently resolve to the character name.

### Character Fields

| Macro | Description |
|-------|-------------|
| `{{description}}` | Character description |
| `{{charDescription}}` | Same as `{{description}}` |
| `{{personality}}` | Character personality field |
| `{{charPersonality}}` | Same as `{{personality}}` |
| `{{scenario}}` | Character scenario field |
| `{{charScenario}}` | Same as `{{scenario}}` |
| `{{persona}}` | Active persona description |

### Model & Tokens

| Macro | Description | Example |
|-------|-------------|---------|
| `{{model}}` | Active model name | `claude-sonnet-4-20250514` |
| `{{maxContext}}` | Max context length | `8192` |
| `{{maxResponse}}` | Max response tokens | `512` |
| `{{maxPrompt}}` | Alias for `{{maxContext}}` | `8192` |

### Time & Date (UTC)

| Macro | Description | Example |
|-------|-------------|---------|
| `{{time}}` | Current time `HH:mm` | `14:32` |
| `{{time::YYYY/MM/DD}}` | Custom format | `2026/05/07` |
| `{{date}}` | Current date (long format) | `May 7, 2026` |
| `{{weekday}}` | Current weekday | `Thursday` |
| `{{isotime}}` | ISO time `HH:mm` | `14:32` |
| `{{isodate}}` | ISO date `YYYY-MM-DD` | `2026-05-07` |
| `{{datetimeformat::YYYY-MM-DD HH:mm}}` | Custom format | `2026-05-07 14:32` |

Format tokens for `time` (with an argument) and `datetimeformat`: `YYYY`, `MM`, `DD`, `HH`, `mm`, `ss`. `{{datetimeformat}}` with no argument returns the full ISO timestamp.

> **Note:** Time macros are **non-deterministic** — they change every time the prompt is built. This disables Claude prompt caching automatically.

### Chat Inspection

These macros inspect the chat history that is currently being sent to the model:

| Macro | Description |
|-------|-------------|
| `{{lastMessage}}` | Content of the last message in context |
| `{{lastMessageId}}` | ID of the last message |
| `{{lastUserMessage}}` | Content of the last user message |
| `{{lastCharMessage}}` | Content of the last assistant message |
| `{{firstIncludedMessageId}}` | ID of the first message in the context window |
| `{{currentSwipeId}}` | ID of the last message in context (the active swipe) |

### State

| Macro | Description |
|-------|-------------|
| `{{lastGenerationType}}` | Type of the last generation (`send`, `regenerate`, `continue`, `impersonate`, `quiet`) |
| `{{hasExtension::name}}` | Returns `true` if the named extension is active, empty otherwise |

### Randomization

> **Note:** These are **non-deterministic** and disable Claude prompt caching.

| Macro | Description | Examples |
|-------|-------------|----------|
| `{{random}}` | Random float 0–1 | `0.742` |
| `{{random::100}}` | Random integer 1–100 | `42` |
| `{{random::1::6}}` | Random integer in range | `4` |
| `{{pick::A::B::C}}` | Randomly picks one option | `B` |
| `{{roll}}` | Rolls 1d20 | `17` |
| `{{roll::2d6}}` | Rolls dice (`NdM` syntax) | `7` |

### Variables

Variables let you store and retrieve text across messages.

| Macro | Description |
|-------|-------------|
| `{{setvar::key::value}}` | Sets a chat-local variable |
| `{{getvar::key}}` | Gets a variable (local first, then global) |
| `{{.key}}` | Shorthand for chat-local variable |
| `{{$key}}` | Shorthand for global variable |

Resolution is **order-independent**: a `getvar` whose key isn't set yet simply waits for a later pass, so you can set a variable in one part of the prompt and read it anywhere else — even earlier in the text. See [Resolution Model](#resolution-model).

Example:
```
{{setvar::mood::brooding}}
{{char}} seems {{getvar::mood}} today.
```

### Comparison & Logic

| Macro | Description | Example |
|-------|-------------|---------|
| `{{equal::A::B}}` | Returns `true` if A equals B, empty otherwise | `true` or empty |
| `{{? expr}}` | Truthiness evaluator with `&&` / `||` | `true` or empty |

`{{equal}}` is the **only** comparison macro. To test equality, nest it inside `{{? }}`:

```
{{? {{equal::{{user}}::Alice}} }}                          → true or empty
{{? {{equal::{{getvar::mood}}::happy}} || {{equal::{{char}}::Bob}} }}
```

The `{{? ...}}` macro splits its input on `||` (OR) and `&&` (AND), then checks whether each part is truthy:

Truthy values: any non-empty string except `"false"` and `"0"`.  
Falsy values: empty string, `"false"`, `"0"`.

> **Warning:** `{{? ...}}` does **not** understand comparison operators. `{{? {{user}} == Alice }}` compares nothing — after `{{user}}` resolves, the whole string `Alice == Alice` is simply a non-empty (truthy) value, so it is **always** `true`, even for `{{? {{user}} == Bob }}`. There are also no `<`, `>`, or `!=` operators anywhere in the macro system. Always route comparisons through `{{equal}}`, and use [Lua scripting](./lua-scripting.md) for range checks or richer logic.

### Images

These macros only resolve at **display time** (when a message is rendered in the chat view). In prompts they pass through as literal text.

| Macro | Description |
|-------|-------------|
| `{{img::asset.png}}` | Inserts a character asset as markdown image |
| `{{attachment::id}}` | Inserts a chat attachment as inline media (image, audio, or video HTML) |

Character assets uploaded with a character can be referenced by filename. The name is sanitized (spaces become underscores) if the exact match fails.

Example:
```
{{img::portrait.png}}   → ![portrait.png](/api/characters/.../assets/portrait.png)
```

### Utility

| Macro | Description | Example |
|-------|-------------|---------|
| `{{noop}}` | Produces no output | (empty) |
| `{{newline}}` | Line break | `\n` |
| `{{trim::  hello  }}` | Trims whitespace | `hello` |
| `{{reverse::hello}}` | Reverses the text | `olleh` |

### Card-Compatibility No-Ops

These macros are recognized so that imported character cards don't leak raw markup into prompts. They all resolve to an empty string:

| Macro | Purpose |
|-------|---------|
| `{{//}}` | Comment — produces no output |
| `{{comment}}` | Comment — produces no output |
| `{{hidden_key}}` | SillyTavern hidden key — produces no output |

## Conditional Blocks

### `{% if %}` / `{% else %}` / `{% endif %}`

```
{% if {{? {{equal::{{user}}::Alice}} }} %}
  Alice's special greeting
{% else %}
  Hello stranger
{% endif %}
```

The condition is any text — the block runs when it is truthy (non-empty, not `false`, not `0`), so a bare `{{? ...}}` or even a plain macro like `{{getvar::flag}}` works.

`{% elsif %}`, `{% elif %}`, and `{% otherwise %}` are also recognized as branch separators, but with an important limitation:

> **Warning:** Middle-branch conditions are **not evaluated**. `{% elsif ... %}` and `{% elif ... %}` behave exactly like `{% else %}` — the condition you write is discarded, and only the first two branches are ever used (`if` picks branch 1 when true, branch 2 when false). For real multi-branch logic, nest `if` blocks inside the `else` branch:

```
{% if {{? {{equal::{{user}}::Alice}} }} %}
  Hi Alice!
{% else %}
  {% if {{? {{equal::{{user}}::Bob}} }} %}
    Hi Bob!
  {% else %}
    Who are you?
  {% endif %}
{% endif %}
```

### `{% unless %}` / `{% endunless %}`

Inverse of `if` — runs the block if the condition is **false**:

```
{% unless {{? {{equal::{{user}}::Alice}} }} %}
  You are not Alice.
{% endunless %}
```

### `{% for %}` / `{% endfor %}`

Iterates over a list of values:

```
{% for item::apple::banana::cherry %}
  - {{item}} (index {{forIndex}})
{% endfor %}
```

Output:
```
  - apple (index 0)
  - banana (index 1)
  - cherry (index 2)
```

## Porting from RisuAI CBS

If you're bringing cards or presets over from RisuAI, here's how the CBS features map:

- **`{{getvar}}` / `{{setvar}}` work the same way** — chat-local, branch-aware variables readable from card fields, World Info, and prompts — plus the `{{.var}}` / `{{$var}}` shorthands for chat-local and global variables.
- **`{{#if}}…{{else}}…{{/if}}` blocks in card fields are converted automatically at import** to `{% if %}` / `{% else %}` / `{% endif %}` syntax.

  > **Warning:** Risu `{{elsif}}` / `{{elif}}` chains are converted syntactically, but tamari does not evaluate middle-branch conditions (see [Conditional Blocks](#conditional-blocks)). After importing a card that uses them, flatten the chain into nested `{% if %}` blocks.
- **No direct equivalents:** `{{chat_index}}`, `{{lastmessageid}}`, `{{greater_equal}}`, and the other comparison helpers. `{{equal}}` is the only comparison macro — for anything richer, move the logic into a regex script's `replaceLua` or a [Lua script](./lua-scripting.md).
- **Comment macros** `{{//}}`, `{{comment}}`, and `{{hidden_key}}` are recognized and silently produce no output.
- **`{{? expr}}` exists but is truthiness-only** — no comparison operators, same caveat as above.

## Where Macros Work

Macros are resolved in the following places, in order:

1. **Chat history** (for World Info keyword scanning — see [World Info](./world-info.md))
2. **Author's Note** content
3. **World Info entries** injected at depth
4. **Preset prompts**
5. **Character card fields**: Description, Personality, Scenario, First Message, Mes Example, System Prompt, Post-history Instructions, Creator's Notes
6. **Dialogue examples** (the character's Mes Example field)
7. **Custom stopping strings** — only when *Settings → Generation → "Resolve macros in custom stopping strings"* is enabled

Separately, chat **messages** are resolved once at write time and stored resolved (see [Resolution Model](#resolution-model)), and `{{img}}` / `{{attachment}}` resolve at display time when a message is rendered.

## Tips & Common Patterns

### Randomizing Personality Traits

```
{{setvar::trait::{{pick::cheerful::grumpy::mysterious}}}}
{{char}} is feeling {{getvar::trait}} today.
```

### Day-Aware Greetings

```
{% if {{? {{equal::{{weekday}}::Friday}} }} %}
  Happy Friday, {{user}}!
{% else %}
  Hello, {{user}}!
{% endif %}
```

> **Note:** There are no `<` / `>` operators, so "before noon" style range checks aren't possible with macros alone — only exact matches via `{{equal}}` (e.g. `{{equal::{{time::HH}}::09}}` for the 9 o'clock hour). Use [Lua scripting](./lua-scripting.md) for real range logic.

### Conditional Scenario Injection

```
{% if {{? {{equal::{{lastGenerationType}}::continue}} }} %}
  (Continuing from previous thought...)
{% endif %}
```

### Dice Roll Results

```
You rolled {{roll::1d20}} on your persuasion check.
```

### Preventing Cache Issues

If you use `{{random}}`, `{{pick}}`, `{{roll}}`, or time/date macros anywhere in your character card, persona, World Info, or preset prompts, Claude's prompt caching is automatically disabled for that generation. This prevents paying cache write costs for prompts that will never be identical.

If you want caching but also want randomness, consider using Lua scripts via Quick Replies instead, which can modify the chat after generation — see [Lua Scripting](./lua-scripting.md).
