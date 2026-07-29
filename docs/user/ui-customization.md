# UI Customization

tamari's look is driven by CSS custom properties (design tokens), and every part of it — colors, spacing, chat layout, avatars, background — is yours to change. Simple tweaks live in the **Settings** modal (sidebar → **Settings**, the gear icon); anything beyond that goes in the Custom CSS box. All settings save automatically and apply immediately, with no reload.

## Themes & Design Tokens

Instead of SillyTavern's JSON theme files, tamari themes through **design tokens**: CSS custom properties defined on `:root` in `client/src/styles/tokens.css`. Every component reads colors, spacing, radii, and shadows from these tokens, so overriding a handful of variables re-skins the whole app coherently.

The token categories:

| Category | Examples |
|----------|----------|
| Surface colors | `--color-bg-primary`, `--color-bg-secondary`, `--color-bg-tertiary`, `--color-bg-elevated` |
| Text colors | `--color-text-primary`, `--color-text-secondary`, `--color-text-muted`, `--color-text-inverse` |
| Accent | `--color-accent`, `--color-accent-hover`, `--color-accent-soft`, `--color-accent-border`, `--color-accent-glow` |
| Status | `--color-success`, `--color-warning`, `--color-danger`, `--color-info-soft` |
| Borders & surfaces | `--color-border-subtle`, `--color-border`, `--color-border-focus` |
| Shadows | `--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--shadow-xl`, focus rings like `--shadow-focus` |
| Spacing | `--space-xs` … `--space-2xl` |
| Typography | `--font-sans`, `--font-mono`, `--text-2xs` … `--text-4xl`, `--leading-tight` … `--leading-relaxed` |
| Radii | `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`, `--radius-full`, `--radius-none` |
| Motion | `--transition-fast`, `--transition-base`, `--transition-slow` |
| Z-index layers | `--z-sticky`, `--z-dropdown`, `--z-modal`, `--z-popover`, `--z-overlay` |
| Layout | `--sidebar-width`, `--chat-max-width`, `--header-height`, `--modal-max-width` |
| Component sizing | `--avatar-sm`, `--avatar-md`, `--asset-thumb` |
| Backdrops | `--color-backdrop`, `--color-backdrop-light`, `--color-backdrop-subtle` |
| Map terrain | `--color-terrain-grass`, `--color-terrain-water`, … (the `lua_map` tool widget tiles) |

Names are semantic — you target *what a color means* (`--color-bg-primary`), not a specific hex value. Three tokens exist specifically as override points for the Display settings: `--shadow-opacity`, `--backdrop-blur`, and `--avatar-border-radius` (see [Chat Display & Avatar Styles](#chat-display--avatar-styles)).

> **Note:** SillyTavern's JSON themes targeting the old `--SmartTheme*` variables do **not** apply — tamari's DOM and token names are completely different. Porting an old theme means mapping its colors onto the semantic tokens above and pasting the result into Custom CSS (below).

## Custom CSS

Open the **Settings** modal and scroll to the **Theme** section. The **Custom CSS (overrides design tokens)** textarea takes any CSS; it is saved to the `themeCustomCss` setting and injected into the page as a `<style id="user-theme-css">` element, appended after the app's own stylesheets. Clearing the box removes the style element entirely.

A minimal recolor:

```css
:root {
  --color-bg-primary: #0f0f10;
  --color-accent: #f472b6;
}
```

### The Stability Contract

Custom CSS is a first-class feature, and the stylesheet is written to keep yours working:

- **Every element has a hook.** Each element in the UI carries a class (or a fixed ID for unique landmarks), so you never need `:nth-child` or deep descendant chains.
- **Shipped classes are never removed.** Class names are treated as public API — if a component is refactored, old class names stay alongside new ones. Selectors like `.message-bubble`, `.chat-view`, `.sidebar`, or `.settings-modal` are safe to build on.
- **Selectors stay flat.** App styles use a single class (occasionally one descendant), so a selector of equal specificity in your Custom CSS wins — no specificity arms race.
- **No `!important` in app styles.** The one exception is the reduced-motion accessibility override (see [Chat Display & Avatar Styles](#chat-display--avatar-styles)).

Class names are kebab-case and prefixed by the component that owns them (`.message-*`, `.chat-*`, `.modal-*`), so your browser's devtools inspector doubles as documentation: inspect an element, copy its class, restyle it.

> **Warning:** CSS injection is powerful. Your CSS runs with full control over the page's appearance — it can hide buttons, cover the chat, or render the app unusable, and there is no validation (broken CSS simply fails to apply). Paste only CSS you wrote or trust, and if the UI ever looks broken, clear the Custom CSS box first.

## Backgrounds

Also in **Settings → Theme**:

- **Background Image URL** — any image URL. Applied to the app shell as a centered, cover-fit, non-repeating background. Clear the field to remove it.
- **Background Blur (px)** — a blur radius (0–50) applied over the background. 0 is off.

The [`/bg` command](#the-theme-and-bg-commands) does the same thing from the chat input.

## Chat Display & Avatar Styles

The **Display** section of the Settings modal covers the chat view itself:

| Setting | What it does |
|---------|--------------|
| **Chat Style** | `Default`, `Bubbles` (rounded bubbles; yours tinted with the accent), or `Document` (flat, full-width rows — a manuscript look). Sets a `chat-style-default` / `chat-style-bubbles` / `chat-style-document` class on the messages container, so you can extend any of them in Custom CSS. |
| **Avatar Style** | `Round`, `Rectangular`, `Square`, or `Rounded`. Works by setting `--avatar-border-radius`, which you can also override directly. |
| **Font Scale** | 0.80–1.50×. Scales the root font size; everything sized in `rem` follows. |
| **Chat Width (rem)** | 30–70. Overrides `--chat-max-width`. |
| **Shadow Width** | 0–2× shadow intensity (drives `--shadow-opacity`). |
| **No shadows** | Flattens the UI by forcing shadow opacity to 0. |
| **Hide chat avatars** | Removes avatars from chat messages. |
| **Hide chat names** | Removes sender names from chat messages. |
| **Backdrop Blur** | 0–2× strength for the blur behind modals and overlays (drives `--backdrop-blur`). |
| **Compact input area** | Tighter padding and smaller controls in the message input. |

One related option lives under **Settings → Interaction**: **Reduced motion (disable animations)** kills animations and transitions app-wide (via a `.reduced-motion` class on `<html>`). tamari also honors your operating system's `prefers-reduced-motion` setting independently.

## Language

**Settings → Language → Interface language** picks the UI language. **English is the only shipped locale for now** — the picker is built for more: locales are registered in one place, load lazily, and fall back to English for any untranslated string.

Switching is **hot**: the language is a server-side setting (`language`), and the UI re-renders in the new locale immediately, no reload.

## The /theme and /bg Commands

Two client-side slash commands manage theme and background from the chat input (see [Slash Commands](./slash-commands.md) for the full list):

- `/theme <preset>` — applies a built-in preset: `dark` (the default look), `light`, `high-contrast`, or `none`.
- `/theme <css>` — anything that doesn't match a preset name is stored as raw custom CSS.
- `/theme` with no arguments clears your custom CSS.
- `/bg <url>` — sets the background image URL; `/bg` with no arguments clears it.

A preset is just a CSS snippet: `/theme light` writes the light preset's token overrides into `themeCustomCss`, exactly as if you had pasted them into the Custom CSS box. `dark` and `none` are both empty — they remove your overrides and restore the default theme.

> **Warning:** `/theme` **overwrites** your Custom CSS. Applying a preset replaces whatever you had in the box — copy your custom CSS somewhere safe before trying presets.

## Tips & Gotchas

- **Override tokens before restyling components.** Most "theme" changes are a handful of `--color-*` overrides on `:root` — reach for class selectors only when tokens can't express what you want.
- **`/theme dark` is the factory reset.** It clears `themeCustomCss`, removing the injected style element entirely.
- **Settings are server-side.** Theme, background, and display settings live on the server, so they follow you across browsers and devices connecting to the same tamari instance.
- **Devtools are the class reference.** Every element has a stable class — right-click → Inspect is the fastest way to find the hook you need.
- **Extend chat styles, don't fight them.** The `chat-style-bubbles` / `chat-style-document` classes on the messages container are switchable from the Display section; you can add your own rules scoped under them instead of replacing the built-in styles.
- **Blur has a cost.** Heavy `backdrop-filter` blur (background or backdrop) is GPU-expensive — if the UI feels sluggish, lower Background Blur and Backdrop Blur before blaming anything else.

## See Also

- [Getting Started](./getting-started.md) — the Settings modal and the rest of the UI
- [Slash Commands](./slash-commands.md) — `/theme`, `/bg`, and the other client-side commands
- [Tools & Toolsets](./tools.md) — the `lua_map` widget whose terrain colors are design tokens
