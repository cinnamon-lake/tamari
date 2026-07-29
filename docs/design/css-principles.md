# CSS Design Principles

> **Goal:** One way to do things. Predictable spacing. No guesswork.

---

## 1. Layout: Flex for Component Shells

**Use `display: flex` when a component distributes space or aligns children.**

- Card shells (header + body + footer) → `flex-direction: column` + `gap`
- Toolbars / button rows → `flex-direction: row` + `align-items: center`
- Lists of items → `flex-direction: column` + `gap`
- Anything that needs `justify-content: space-between` or `margin-left: auto`

**Use `display: block` for:**
- Plain text flow (paragraphs, headings, articles)
- Single elements that don't align siblings

**Avoid:**
- `float`
- `inline-block` alignment hacks
- Absolute positioning unless genuinely overlaying (modals, popups, drag indicators)

**Grid is allowed for:**
- Character lists (auto-fill cards)
- Dashboards / multi-column layouts
- Anywhere 2D placement is semantically correct

---

## 2. Spacing: `gap` > Margins

**Always reach for `gap` on the parent before adding margins to children.**

```css
/* Good */
.toolbar {
  display: flex;
  gap: var(--space-sm);
}

/* Bad */
.toolbar button {
  margin-right: var(--space-sm);
}
.toolbar button:last-child {
  margin-right: 0;
}
```

**Margins are only for:**
- Pushing a single element away from its siblings (e.g., `margin-left: auto` to right-align)
- Collapsing space between unrelated sections (rare)

**Never use `margin: 0 auto` for centering.** Use `justify-content: center` or `place-items: center` on the parent.

---

## 3. Margins: Top-Only

**If you must use margin, use `margin-top` only.**

```css
/* Good */
.section + .section {
  margin-top: var(--space-lg);
}

/* Bad */
.section {
  margin-bottom: var(--space-lg);
}
```

**Why:** Top margins compose predictably. First child has no predecessor → no extra space. Last child doesn't leak space out of its container.

**The reset:**

```css
*:first-child {
  margin-top: 0;
}

*:last-child {
  margin-bottom: 0;
}
```

This lives in the global reset and means you never need `&:first-child { margin-top: 0 }` overrides.

---

## 4. Padding: Axis-Explicit

**Write `padding-top`, `padding-bottom`, `padding-left`, `padding-right` instead of shorthand.**

```css
/* Good */
.card {
  padding-top: var(--space-md);
  padding-bottom: var(--space-md);
  padding-left: var(--space-lg);
  padding-right: var(--space-lg);
}

/* Bad */
.card {
  padding: var(--space-md) var(--space-lg);
}
```

**Why:** You can read it at a glance without memorizing TRBL order. It's slightly more verbose but eliminates the "wait, which value is left?" pause.

**Exception:** `padding: 0` to nuke all padding is fine.

---

## 5. Sizing: Content-Driven

**Let content decide height.** Avoid fixed heights.

```css
/* Good */
.button {
  padding-top: var(--space-sm);
  padding-bottom: var(--space-sm);
  min-height: 36px; /* only when a minimum is semantically required */
}

/* Bad */
.button {
  height: 36px;
}
```

**Allowed fixed sizes:**
- Avatars (`--avatar-size`)
- Icons in buttons (`36px` touch targets)
- Modals (`max-width`, `max-height`)
- The app shell (`height: 100vh` or `height: 100%` on `#root`)

---

## 6. Colors: Tokens Only

**No raw hex, rgb, or hsl in component CSS.**

```css
/* Good */
background: var(--color-bg-secondary);
color: var(--color-text-primary);
border: 1px solid var(--color-border-subtle);

/* Bad */
background: #1a1a2e;
color: #e0e0e0;
```

**Allowed exceptions:**
- `rgba(...)` for backdrops / overlays where opacity is part of the effect
- `transparent` and `currentColor`
- `url(...)` gradients in theme tokens (if defined in `tokens.css`)

---

## 7. Border Radius: Token Only

```css
/* Good */
border-radius: var(--radius-sm);

/* Bad */
border-radius: 4px;
border-radius: 9999px; /* use var(--radius-full) */
```

---

## 8. Shadows: Token Only

```css
/* Good */
box-shadow: var(--shadow-md);

/* Bad */
box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
```

---

## 9. Typography: Token Only

```css
/* Good */
font-size: var(--text-sm);
line-height: var(--leading-relaxed);

/* Bad */
font-size: 14px;
line-height: 1.6;
```

---

## 10. Z-Index: Named Layers

**No magic numbers.** Use the token scale:

| Token | Use |
|-------|-----|
| `z-dropdown` | Menus, select popovers |
| `z-sticky` | Sticky headers |
| `z-modal` | Modals, dialogs |
| `z-popover` | Tooltips, toasts |
| `z-overlay` | Backdrop scrims |

```css
/* Good */
z-index: var(--z-modal);

/* Bad */
z-index: 9999;
z-index: 1050;
```

---

## 11. Selectors: Flat and Boring

**Prefer single classes. Avoid nesting beyond one level.**

```css
/* Good */
.message-bubble {
  padding-top: var(--space-md);
  padding-bottom: var(--space-md);
}

.message-bubble .avatar {
  border-radius: var(--radius-full);
}

/* Bad */
.chat-view .messages .message-bubble > .content .avatar {
  ...
}
```

**Why:** Flat selectors are faster, don't break when DOM structure changes, and are easier to grep.

---

## 12. Component Modifiers: Explicit Classes

**App-state changes get a class. No attribute selectors or `:has()` to reflect *application* state.**

```css
/* Good — app state is a modifier class toggled by the component */
<button class={`icon-btn ${active() ? 'active' : ''}`}>

.icon-btn.active {
  background: var(--color-accent);
}

/* Bad — app state hidden in an attribute the component must keep in sync */
button[aria-pressed="true"] {
  background: var(--color-accent);
}
```

**Exception — native widget state.** Selectors that read a *native* control's own state are permitted, because that state is the element's own (not app state duplicated into markup) and cannot drift from it:

- `details[open]`, `summary` — the native disclosure widget.
- `:has(input:checked)`, `:has(input:disabled)` — a container reflecting a nested native control's real state.
- `input:checked`, `input:disabled`, `:focus-within` — native pseudo-states.

The ban is on `[data-active="true"]` / `[aria-pressed]`-style selectors that duplicate app state the component already tracks — reach for a modifier class there.

---

## 13. Responsive: Co-Located Breakpoints

**Prefer container queries for components that appear in multiple contexts.**

**If using breakpoints, only two:**
- `768px` — mobile / tablet flip
- `1200px` — wide desktop adjustments

No intermediate breakpoints. If a layout breaks at 943px, the design is wrong, not the breakpoint.

**Mobile overrides live in the same component CSS file as their base styles.**

When a class moves from `global.css` into a dedicated component CSS file (e.g. `Sidebar.css`, `ChatView.css`), any `@media` rules that override that class must move to the same file. Do not leave mobile overrides in `global.css` while the base style lives in a component file — Vite loads component CSS after global CSS, so the base style will win on mobile and break the layout.

```css
/* Sidebar.css */
.mobile-menu-btn {
  display: none;
}

@media (max-width: 768px) {
  .mobile-menu-btn {
    display: inline-flex;
  }
}

/* Bad: base in Sidebar.css, override still in global.css */
/* The later-loaded base "display: none" overrides the media query */
```

---

## 14. Minimal DOM — Divs Only for Semantics or Flexbox

**Add a wrapper `div` only when:**
- You need a flex/grid container to distribute/align children
- The element carries semantic meaning (`<button>`, `<label>`, `<nav>`)
- ARIA requires a specific role container

**Don't add a div just to:**
- Hang a class on it when the parent could handle it
- Create a "layout shim" that `gap` or `padding` on the parent would solve
- Apply `margin` that could be `gap` on the parent instead

```css
/* Good: one div, flex parent handles spacing */
<ul class="chat-list">
  <li>...</li>
</ul>

.chat-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

/* Bad: wrapper exists only for spacing */
<div class="chat-list-wrapper">
  <ul class="chat-list">
    <li>...</li>
  </ul>
</div>
```

## 15. No Inline Styles

**Inline styles are banned except for:**
- Dynamic positioning (`top`, `left`, `transform`) for drag/resize/virtual-scroll
- Dynamic sizing (`width`, `height`) for progress bars, charts, virtual lists
- User-defined colors (`background-color: ${qr.color}`) where the value is data, not design

Everything else — spacing, layout, typography, colors — belongs in CSS.

---

## 16. Hookable Elements: Every Element Needs a Class or Fixed ID

Since we allow users to write custom CSS, **every element in the HTML must have either a class or a fixed ID.** This gives users a stable, non-fragile hook for their styles without forcing them to rely on positional selectors (`:nth-child`) or deep descendant chains that break whenever the DOM structure changes.

```html
<!-- Good: user can target this reliably -->
<div class="chat-toolbar">
  <button class="chat-toolbar-btn">Send</button>
</div>

<!-- Bad: user has to guess or use :nth-child -->
<div>
  <button>Send</button>
</div>
```

- **Prefer classes** over IDs for styling hooks.
- IDs are acceptable for truly unique landmarks (e.g., `#app-root`), but avoid them for repeated components.
- **Never remove a class or ID once shipped** — treat them as part of the public API.

---

## 17. Animation: Token Durations

```css
/* Good */
transition: transform var(--transition-fast);

/* Bad */
transition: transform 0.15s ease;
```

| Token | Duration | Use |
|-------|----------|-----|
| `--transition-fast` | 100ms | Hover states, micro-interactions |
| `--transition-base` | 200ms | Toggles, dropdowns |
| `--transition-slow` | 300ms | Modals, page transitions |

---

## 18. No `!important`

**`!important` is banned in application stylesheets.**

Since users can write custom CSS, `!important` in our code starts an irreversible specificity arms race. If a user needs to override a style, they should be able to do so with a selector of equal or greater specificity — not by fighting `!important`.

```css
/* Bad */
.hidden {
  display: none !important;
}

/* Good */
.hidden {
  display: none;
}
```

**Exception:** Accessibility overrides that must win against user CSS, such as reduced-motion preferences:

```css
.reduced-motion *,
.reduced-motion *::before,
.reduced-motion *::after {
  animation-duration: 0.01ms !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0.01ms !important;
  scroll-behavior: auto !important;
}
```

If you find yourself reaching for `!important`, the real problem is usually:
- A selector with too much specificity elsewhere
- Inline styles that should be classes
- A missing modifier class

---

## 19. Variable Scope: Global Tokens vs. Component Scopes

**Global design tokens live on `:root`. Component-scoped variables live on the component class.**

```css
/* Global tokens — :root only */
:root {
  --color-bg-primary: #0f0f23;
  --radius-md: 8px;
}

/* Component-scoped — defined on the component */
.chat-bubble {
  --chat-bubble-bg: var(--color-bg-primary);
  --bubble-radius: var(--radius-md);

  background: var(--chat-bubble-bg);
  border-radius: var(--bubble-radius);
}

.chat-bubble.mentioned {
  /* Override the scoped variable for a modifier */
  --chat-bubble-bg: var(--color-mention);
}
```

**Why:** Component-scoped variables keep the `:root` namespace clean and are self-documenting. You can override them for modifiers without repeating property declarations.

**Rules:**
- Global tokens (colors, spacing, radii, shadows, typography, z-index) → `:root`
- Component internals (layout math, local overrides, computed values) → component class
- Never define `--my-component-*` variables on `:root`
- Name component-scoped variables `--<component>-<property>` (`--chat-bubble-bg`, not `--bg`) — greppable and collision-free, same reasoning as class names (§25).

---

## 20. Specificity Ceiling

**Keep specificity low and predictable.**

```css
/* Good — one class */
.btn { ... }

/* Good — two simple selectors max */
.card .btn { ... }

/* Bad — ID in component CSS */
#send-button { ... }

/* Bad — way too specific */
.chat-view .messages .message-bubble > .content .btn { ... }
```

**Rules:**
- No IDs in component CSS (`#submit` is a specificity landmine)
- Max two simple selectors per rule
- Never use `!important` (see §18)
- If you need more specificity to win, the architecture is wrong — add a modifier class or fix the conflicting rule instead

---

## 21. Base Classes: One Per Element Kind

Every element of a given kind carries a **base class**. The base holds the *structure* every instance wants — display model, cursor, font, focus ring, min-size. The *skin* (color, background, border) lives in modifier classes applied **alongside** the base.

**Canonical bases:**

| Base | Covers |
|------|--------|
| `.btn` | Buttons of every kind |
| `.text-input` | Text fields, `<textarea>`, `<select>` (one base for all text-entry controls) |
| `.section-heading` | Section/page headings |

**Rules:**

- **One base per kind.** Do not create parallel bases. `.primary-btn`, `.icon-btn` as a standalone, and `.auth-submit` are all forbidden — they fork a new base instead of varying the existing one.
- **A modifier is meaningless without its base.** Apply both in the markup (`class="btn btn-primary"`), never the modifier alone. The CSS rule `.btn-primary` styles the variant; it does not stand on its own.
- **Modifiers are prefixed with their base.** `.btn-primary`, not `.primary-btn`. The base name comes first so the is-a relationship is visible in the class string and `rg '\bbtn-'` finds every variant.
- **Bases live in the shared atoms stylesheet**, never inside a component file. A `.text-xl` defined in `PersonaManager.css` is a leak.

```css
/* Good — structure in the base, skin in the variant */
.btn {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  font-family: inherit;
  min-height: var(--touch-target);
}
.btn-primary {
  background: var(--color-accent);
  color: var(--color-text-inverse);
}

/* Bad — a parallel base that re-implements .btn from scratch */
.primary-btn {
  display: inline-flex;
  cursor: pointer;
  /* …all of .btn again, drifted… */
  background: var(--color-accent);
}
```

**The signal that `.btn` is carrying too much skin is "I want a button but not `.btn`."** Push the unwanted property into a variant; do not fork a new base. If every button genuinely wants your base's properties, the rule is self-correcting — there is no button that opts out.

**Why:** one base per kind is what makes the design system greppable, makes "change every button" a one-rule edit, and is the only structural constraint that prevents the multi-generation button sprawl this codebase already suffers from.

---

## 22. Element Selectors: Only for HTML You Don't Control

Do not style HTML elements by tag name. Use a class. The sole exception is HTML the application does **not** generate and therefore cannot class — rendered markdown, sanitized AI/user content, stack traces.

- **Global element selectors** (`button {}`, `input {}`) → banned, except the `html` / `body` / `#root` reset.
- **Scoped element selectors for reusable atoms** (`.modal input`, `.edit-actions button`) → **discouraged but permitted as a single canonical definition**. One rule, in the atom's home, scoped to its semantic container — e.g. `.modal input` defining the modal-input atom once. **Re-implementing** that atom per-component (`.instance-field input`, `.entry-editor input`, `.persona-editor input`) is **banned** — that is the duplication that causes the `.modal-content`-loses-styling bug. If the atom appears outside its container, promote it to a class (`.text-input`).
- **Scoped element selectors for uncontrolled HTML** (`.message-content img`, `.reasoning-content pre`, `.app-error pre`) → **allowed**. This is the only place descendant tag selectors belong.

```css
/* Good — atom gets a class; works anywhere it's placed */
.text-input {
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-subtle);
}
.modal .text-input { /* only if a genuine modal-specific override is needed */ }

/* Bad — input styling coupled to being inside .modal.
   .modal-content (not .modal) silently loses it and gets re-implemented. */
.modal input {
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border-subtle);
}

/* Good — element selector on HTML the app doesn't generate */
.message-content pre {
  background: var(--color-bg-tertiary);
}
```

**Why:** reaching through an ancestor to style an `<input>` is how the same form-field styling got re-implemented in four component files, and how `.modal-content` lost its input styling and had to be duplicated. Naming the atom once kills the duplication at the source.

---

## 23. State Modifiers: Compound with Their Base

**A state class (`.active`, `.open`, `.selected`, `.disabled`) is never styled on its own — always as a compound with the base it modifies.**

```css
/* Good — the selector answers "active what?" */
.btn.active {
  background: var(--color-accent);
}

/* Bad — global, ungreppable, leaks into every component that toggles the class */
.active {
  background: var(--color-accent);
}
```

**Why:** a bare `.active` rule applies to every element in the app that carries the class, and `rg '\.active'` finds nothing useful. `.btn.active` scopes the state to exactly one component — the class string and the stylesheet both say *what* is active.

---

## 24. Media Queries: `max-width` Only

**Base rules are the desktop layout. `@media (max-width: ...)` overrides it downward. Never `@media (min-width: ...)`.**

```css
/* Good — one direction: desktop base, mobile override */
.tools-panels {
  grid-template-columns: 1fr 1fr;
}

@media (max-width: 768px) {
  .tools-panels {
    grid-template-columns: 1fr;
  }
}

/* Bad — mobile base with a min-width override; two directions make source order load-bearing */
.tools-panels {
  grid-template-columns: 1fr;
}

@media (min-width: 768px) {
  .tools-panels {
    grid-template-columns: 1fr 1fr;
  }
}
```

**Why:** with a single override direction, "what applies at width W" is answerable by reading the file top-to-bottom — later rules only ever *remove* desktop behavior. Mixed directions reintroduce the parsing-order fragility that §13's co-location rule exists to prevent. Combined with §13, exactly two legal queries exist: `@media (max-width: 768px)` and `@media (max-width: 1200px)`.

---

## 25. Class Names: kebab-case with an Owning Domain

**Every class is `kebab-case` and starts with the domain that owns it** — the component or shared atom it belongs to.

```html
<!-- Good — rg 'message-' finds the whole feature: markup, CSS, tests -->
<div class="chat-view">
  <div class="message-bubble">
    <div class="message-content">...</div>
  </div>
</div>

<!-- Bad — unprefixed generics collide across components and grep for nothing -->
<div class="view">
  <div class="bubble">
    <div class="content">...</div>
  </div>
</div>
```

- Shared atoms keep their base names (`.btn`, `.text-input`) — their domain is the design system itself (§21).
- One-word component classes are fine when the word *is* the domain (`.sidebar`, `.chat-view`).
- **Applies to new classes.** Existing classes are user-facing CSS API (§16) — rename only by adding the new class alongside the old one, never by removing the old one.

**Why:** prefixed names make every feature greppable end-to-end and make cross-component collisions impossible — no two components can both accidentally ship a bare `.list`.

---

## Summary Cheat Sheet

| Decision | Rule |
|----------|------|
| Layout | `display: flex` + `gap` (for shells that align/distribute) |
| Space between children | `gap` on parent |
| Space before a section | `margin-top` |
| Space inside a box | `padding-top/bottom/left/right` (explicit) |
| Centering | `justify-content` / `align-items` on parent |
| DOM wrappers | Only for flex containers or semantics |
| Colors | `--color-*` tokens |
| Variable scope | Global tokens on `:root`; component vars on component class |
| Specificity | Max two simple selectors; no IDs in component CSS |
| Sizing | `min-height` / `padding` over fixed `height` |
| First/last child margins | Global reset handles it |
| Selectors | One class, max one descendant |
| Inline styles | Only for dynamic positioning/sizing |
| Hookable elements | Every element has a class or fixed ID |
| Base classes | One base per element kind (`.btn`, `.text-input`, `.section-heading`); variants applied alongside the base |
| Element selectors | Only for HTML you don't control (markdown/sanitized); atoms get a class |
| `!important` | Banned |
| State modifiers | Compound with base (`.btn.active`), never a bare `.active` rule |
| Media queries | `max-width` only; base rules are the desktop layout |
| Class names | kebab-case + domain prefix (`.message-*`); binding for new classes |
