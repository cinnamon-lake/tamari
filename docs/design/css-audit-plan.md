# CSS Principles Audit Plan

> How to check the entire codebase against every rule in `css-principles.md`.

---

## Quick Reference: Automation Level

| Principle | Auto | Script / Command |
|-----------|------|------------------|
| §1 Layout — no `float` / `inline-block` / `absolute` | ✅ | `rg` in `.css` files |
| §2 Spacing — `gap` > margins | ❌ | Manual review |
| §3 Margins — top-only | ✅ | `rg` in `.css` files |
| §4 Padding — axis-explicit | ✅ | `rg` in `.css` files |
| §5 Sizing — no fixed `height` | ✅ | `rg` in `.css` files |
| §6 Colors — tokens only | ✅ | `rg` in `.css` files |
| §7 Border radius — tokens only | ✅ | `rg` in `.css` files |
| §8 Shadows — tokens only | ✅ | `rg` in `.css` files |
| §9 Typography — tokens only | ✅ | `rg` in `.css` files |
| §10 Z-index — named layers | ✅ | `rg` in `.css` files |
| §11 Selectors — flat | ⚠️ | `rg` + manual review |
| §12 Modifiers — explicit classes | ✅ | `rg` in `.css` files |
| §13 Responsive — co-located breakpoints | ⚠️ | `rg` + manual review |
| §14 Minimal DOM | ❌ | Manual review |
| §15 No inline styles | ✅ | `rg` in `.tsx` files |
| §16 Hookable elements | ✅ | `npm run lint:css` |
| §17 Animation — token durations | ✅ | `rg` in `.css` files |
| §18 No `!important` | ✅ | `rg` in `.css` files |
| §19 Variable scope | ⚠️ | `rg` + manual review |
| §20 Specificity ceiling | ✅ | `rg` in `.css` files |
| §21 Base classes | ⚠️ | `rg` in `.css`/`.tsx` + manual review |
| §22 Element selectors | ✅ | `rg` in `.css` files (whitelist) |

---

## Pre-run

Make sure you're in the repo root and `ripgrep` (`rg`) is available.

```bash
cd /home/johnf/SillyTavern
```

All commands below search `client/src/**/*.css` and `client/src/**/*.tsx`.

---

## §1 Layout: Flex for Component Shells

**Violation:** `float`, `inline-block` alignment hacks, or `position: absolute` used for layout (allowed only for genuine overlays: modals, popups, drag indicators).

```bash
# Float
rg 'float:\s*(left|right|none)' client/src -g '*.css' -n

# Inline-block used for alignment
rg 'display:\s*inline-block' client/src -g '*.css' -n

# Absolute positioning — flag for manual review
rg 'position:\s*absolute' client/src -g '*.css' -n
```

**Manual review needed for:** every `position: absolute` hit. Keep only if it's a modal/popup/drag indicator.

---

## §2 Spacing: `gap` > Margins

**Violation:** Children have `margin-right`, `margin-bottom`, etc. to create space between siblings, where `gap` on the parent would work.

**Detection:** No reliable regex. During code review, look for:

```css
/* Suspicious pattern */
.toolbar button {
  margin-right: var(--space-sm);
}
.toolbar button:last-child {
  margin-right: 0;
}
```

**Command (find candidates for review):**

```bash
rg 'margin-(right|bottom)\s*:' client/src -g '*.css' -n
```

Each hit must be manually validated. Allowed cases:
- `margin-left: auto` / `margin-right: auto` for pushing a single element
- Collapsing space between unrelated sections

---

## §3 Margins: Top-Only

**Violation:** `margin-bottom`, `margin-left` (except `auto`), `margin-right` (except `auto`).

```bash
rg 'margin-bottom\s*:' client/src -g '*.css' -n
rg 'margin-left\s*:\s*(?!auto)' client/src -g '*.css' -n
rg 'margin-right\s*:\s*(?!auto)' client/src -g '*.css' -n
```

**Allowed:**
- `margin-top: var(--space-*)`
- `margin-left: auto`
- `margin-right: auto`

---

## §4 Padding: Axis-Explicit

**Violation:** `padding:` shorthand (except `padding: 0`).

```bash
# Find shorthand padding that isn't "padding: 0"
rg '\bpadding:\s+(?!0\b)' client/src -g '*.css' -n
```

**Allowed:**
- `padding: 0`
- `padding-top:`, `padding-bottom:`, `padding-left:`, `padding-right:`

---

## §5 Sizing: Content-Driven

**Violation:** Fixed `height:` (not `min-height`, `max-height`, `height: 100%`, `height: 100vh`, `height: auto`).

```bash
# Find height declarations, then filter out allowed ones manually
rg '\bheight\s*:' client/src -g '*.css' -n | rg -v 'min-height|max-height|100%|100vh|auto'
```

**Allowed fixed sizes:**
- Avatars (`--avatar-size`)
- Icons in buttons (`36px` touch targets)
- Modals (`max-width`, `max-height`)
- App shell (`height: 100vh` or `height: 100%` on `#root`)

---

## §6 Colors: Tokens Only

**Violation:** Raw hex, `rgb(`, `hsl(` in component CSS. `rgba(` is allowed for backdrops/overlays.

```bash
rg '#[0-9a-fA-F]{3,8}\b' client/src -g '*.css' -n
rg '\brgb\(' client/src -g '*.css' -n
rg '\bhsl\(' client/src -g '*.css' -n
```

**Allowed:**
- `rgba(...)` for overlays
- `transparent`, `currentColor`
- `url(...)` gradients defined in `tokens.css`

---

## §7 Border Radius: Token Only

**Violation:** Raw pixel values or `9999px` in `border-radius`.

```bash
rg 'border-radius:\s*\d' client/src -g '*.css' -n
rg 'border-radius:\s*9999px' client/src -g '*.css' -n
```

**Allowed:**
- `border-radius: var(--radius-*)`
- `border-radius: 0`

---

## §8 Shadows: Token Only

**Violation:** Raw `box-shadow` values.

```bash
rg 'box-shadow:' client/src -g '*.css' -n
```

**Allowed:**
- `box-shadow: var(--shadow-*)`
- `box-shadow: none`

---

## §9 Typography: Token Only

**Violation:** Raw `font-size` or `line-height` values.

```bash
rg 'font-size:\s*\d' client/src -g '*.css' -n
rg 'font-size:\s*\d+\.\d+' client/src -g '*.css' -n
rg 'line-height:\s*\d' client/src -g '*.css' -n
rg 'line-height:\s*\d+\.\d+' client/src -g '*.css' -n
```

**Allowed:**
- `font-size: var(--text-*)`
- `line-height: var(--leading-*)`

---

## §10 Z-Index: Named Layers

**Violation:** Magic numbers in `z-index`.

```bash
rg 'z-index:\s*\d' client/src -g '*.css' -n
```

**Allowed:**
- `z-index: var(--z-*)`

---

## §11 Selectors: Flat and Boring

**Violation:** Nesting beyond one level, or selectors with 3+ simple selectors.

```bash
# 3+ class/descendant selectors in one rule
rg '^\s*\.\S+\s+\S+\s+\S+\s+\S+' client/src -g '*.css' -n

# Combinators beyond one descendant
rg '^\s*\.\S+\s+\S+\s*>\s*\S+' client/src -g '*.css' -n
```

**Manual review needed:** SCSS/Sass nesting depth (if used). We currently write flat CSS, so this is mainly a code-review discipline.

---

## §12 Component Modifiers: Explicit Classes

**Violation:** Attribute selectors or `:has()` used for state styling.

```bash
rg '\[.*=.*\]' client/src -g '*.css' -n
rg ':has\(' client/src -g '*.css' -n
```

**Allowed:**
- `[disabled]` on native elements is acceptable for base styles, but state changes should still use explicit classes.
- ARIA attributes in selectors are banned per the principle.

---

## §13 Responsive: Co-Located Breakpoints

**Violation 1:** Breakpoints other than `768px` and `1200px`.

```bash
rg '@media.*\d+px' client/src -g '*.css' -n
```

**Allowed:**
- `@media (min-width: 768px)` / `@media (max-width: 768px)`
- `@media (min-width: 1200px)` / `@media (max-width: 1200px)`
- Container queries (`@container`)

**Action:** Any other pixel value is a violation.

**Violation 2:** A class has its base style in one file (e.g. `ChatView.css`) but its mobile override in another file (e.g. `global.css`).

**Detection:** Manual review during refactors. When splitting CSS into component files, verify that every `@media` rule overriding a component class lives in the same file as the base style.

**Action:** Move the `@media` block into the component CSS file.

---

## §14 Minimal DOM — Divs Only for Semantics or Flexbox

**Violation:** Wrapper `div`s that exist only for spacing/margin when the parent could handle it with `gap` or `padding`.

**Detection:** No reliable regex. During code review, flag:

- `.wrapper` or `.container` classes that only set `margin` or `padding` without `display: flex` / `display: grid`
- A `<div>` around a single `<ul>` / `<ol>` / `<section>` that doesn't add flex/grid semantics

```bash
# Find wrapper-like classes for manual review
rg '\.(wrapper|container)\s*\{' client/src -g '*.css' -n
```

---

## §15 No Inline Styles

**Violation:** `style={` in JSX/TSX, except for:
- Dynamic positioning (`top`, `left`, `transform`)
- Dynamic sizing (`width`, `height`) for progress bars, charts, virtual lists
- User-defined colors where the value is data

```bash
rg 'style=\{' client/src -g '*.tsx' -n
```

**Manual review needed:** every hit. Allowed cases are enumerated in the principle.

---

## §16 Hookable Elements: Every Element Needs a Class or Fixed ID

**Run the dedicated audit script** (enforcing — exits non-zero on violations):

```bash
npm run lint:css        # wired form (repo root); runs in CI
node audit_css_hooks.cjs   # equivalent, direct
```

The script checks every rendered HTML element for a `class`, `classList`, or `id`. It skips test files (`*.test.tsx`/`*.spec.tsx`) and exempts content/native elements the rule was not meant to cover (inline text semantics like `strong`/`em`/`code`, native media, `<option>`, `<input type="radio|checkbox">`). If a violation is a genuine false positive, adjust the checked-tag set in the script — do not suppress per-line. If violations are found, add semantic, component-scoped class names. See the existing patch history for naming conventions.

---

## §17 Animation: Token Durations

**Violation:** Raw duration values in `transition` or `animation`.

```bash
rg 'transition:.*\d+(?:\.\d+)?(?:ms|s)' client/src -g '*.css' -n
rg 'animation:.*\d+(?:\.\d+)?(?:ms|s)' client/src -g '*.css' -n
```

**Allowed:**
- `transition: transform var(--transition-fast)`
- `animation: fade-in var(--transition-base)`

---

## §18 No `!important`

**Violation:** Any `!important` in application stylesheets.

```bash
rg '!important' client/src -g '*.css' -n
```

**Allowed:** None in app CSS. User CSS may use `!important` — that's their prerogative.

---

## §19 Variable Scope: Global Tokens vs. Component Scopes

**Violation:** Component-scoped variables defined on `:root`.

```bash
# Find :root declarations that look component-scoped
rg ':root\s*\{[^}]*--[a-z]+-[a-z]+-' client/src -g '*.css' -n
```

**What to look for:**
- `--chat-bubble-bg` on `:root` → move to `.chat-bubble`
- `--toolbar-height` on `:root` → acceptable if it's a global token

**Manual review needed:** distinguish genuine global tokens (`--color-*`, `--space-*`, `--radius-*`) from component-local ones.

---

## §20 Specificity Ceiling

**Violation:** ID selectors in component CSS, or selectors with 3+ simple selectors.

```bash
# ID selectors
rg '#[a-zA-Z]' client/src -g '*.css' -n

# 3+ simple selectors (approximation)
rg '^\s*\.\S+\s+\S+\s+\S+\s+\S+' client/src -g '*.css' -n
```

**Allowed:**
- `#root` in global/app shell CSS
- Max two simple selectors per rule (e.g. `.card .btn`)

---

## §21 Base Classes: One Per Element Kind

**Violation:** A parallel base for an element kind that already has one (e.g. `.primary-btn` / `.icon-btn` as a standalone alongside `.btn`); a modifier applied without its base in markup; a base defined inside a component file instead of the shared atoms sheet.

```bash
# Parallel button bases (should all be .btn + a modifier)
rg -n '^\s*\.(primary-btn|danger-btn|action-btn|icon-btn|text-btn|back-btn|auth-submit)\b' client/src -g '*.css'

# <button> elements in tsx that do NOT carry the .btn base
rg -n '<button[^>]*class="([^"]*\bbtn\b[^"]*)"' client/src -g '*.tsx'   # carries base — OK
rg -n '<button' client/src -g '*.tsx' | wc -l                            # total <button> count

# Bases accidentally defined inside a component file (should be in styles/)
rg -n '^\s*\.(btn|text-input|section-heading)\b' client/src/components -g '*.css'

# Modifiers whose base name does not come first (e.g. .primary-btn vs .btn-primary)
rg -n '^\s*\.\w+(btn|input|heading)' client/src -g '*.css'
```

**Manual review needed:** every `<button>` in `.tsx` should carry `btn` (plus a variant). A `<button>` without `btn` is either missing its base (bug) or the base is carrying too much skin (refactor signal per §21). This needs judgment — automate the candidate list, review by hand.

---

## §22 Element Selectors: Only for HTML You Don't Control

**Violation:** A tag-name selector outside the whitelist. Allowed whitelist: the reset (`html`, `body`, `#root`) and the uncontrolled-HTML surfaces (`.message-content`, `.reasoning-content`, `.app-error`). Everything else — including scoped atom selectors like `.modal input` or `.edit-actions button` — is a violation.

```bash
# All element selectors (tag name in the selector). Then filter against the whitelist.
rg -n '^\s*\.?[\w-]*\s*(html|body|button|input|textarea|select|a|img|p|h[1-6]|ul|ol|li|table|code|pre|blockquote|details|summary|hr|span|div|i)\b' client/src -g '*.css'

# Global (un-scoped) element selectors — must be only html/body/#root
rg -n '^\s*(html|body|button|input|textarea|select|a|img|p|h[1-6]|ul|ol|li|table|code|pre|details|summary)\s*[,{]' client/src/styles -g '*.css'

# Scoped atom selectors — the real target. Flag any '.some-class tag' that is NOT
# one of the uncontrolled-HTML surfaces.
rg -n '^\s*\.[\w-]+(\.[\w-]+)*\s+(button|input|textarea|select|a|img|h[1-6]|code|pre)\b' client/src -g '*.css'
```

**Manual review needed:** the scoped-atom grep is the high-value one. Distinguish:
- **Allowed:** `.message-content …`, `.reasoning-content …`, `.app-error …` (uncontrolled HTML).
- **Violation:** `.modal input`, `.edit-actions button`, `.stats-modal h3`, `.entry-editor textarea` — these should be `.text-input` / `.btn` / `.section-heading`.

A cross-file `@media` audit pairs with this: any `@media` rule whose base selector is defined in a *different* file is a §13 landmine (see 2026-07-11 audit §B).

```bash
# @media rules — review whether each overridden selector's base lives in the same file
rg -n '@media' client/src -g '*.css'
```

---

## One-Shot Full Audit

Run all automated checks in one go:

```bash
echo "=== §1 Layout ==="
rg 'float:\s*(left|right|none)' client/src -g '*.css' -n
rg 'display:\s*inline-block' client/src -g '*.css' -n
rg 'position:\s*absolute' client/src -g '*.css' -n

echo "=== §3 Margins (top-only) ==="
rg 'margin-bottom\s*:' client/src -g '*.css' -n
rg 'margin-left\s*:\s*(?!auto)' client/src -g '*.css' -n
rg 'margin-right\s*:\s*(?!auto)' client/src -g '*.css' -n

echo "=== §4 Padding shorthand ==="
rg '\bpadding:\s+(?!0\b)' client/src -g '*.css' -n

echo "=== §5 Fixed height ==="
rg '\bheight\s*:' client/src -g '*.css' -n | rg -v 'min-height|max-height|100%|100vh|auto'

echo "=== §6 Raw colors ==="
rg '#[0-9a-fA-F]{3,8}\b' client/src -g '*.css' -n
rg '\brgb\(' client/src -g '*.css' -n
rg '\bhsl\(' client/src -g '*.css' -n

echo "=== §7 Raw border-radius ==="
rg 'border-radius:\s*\d' client/src -g '*.css' -n
rg 'border-radius:\s*9999px' client/src -g '*.css' -n

echo "=== §8 Raw shadows ==="
rg 'box-shadow:' client/src -g '*.css' -n

echo "=== §9 Raw typography ==="
rg 'font-size:\s*\d' client/src -g '*.css' -n
rg 'line-height:\s*\d' client/src -g '*.css' -n

echo "=== §10 Magic z-index ==="
rg 'z-index:\s*\d' client/src -g '*.css' -n

echo "=== §12 Attribute selectors / :has() ==="
rg '\[.*=.*\]' client/src -g '*.css' -n
rg ':has\(' client/src -g '*.css' -n

echo "=== §13 Breakpoints ==="
rg '@media.*\d+px' client/src -g '*.css' -n

echo "=== §15 Inline styles ==="
rg 'style=\{' client/src -g '*.tsx' -n

echo "=== §16 Hookable elements ==="
npm run lint:css

echo "=== §17 Raw durations ==="
rg 'transition:.*\d+(?:\.\d+)?(?:ms|s)' client/src -g '*.css' -n
rg 'animation:.*\d+(?:\.\d+)?(?:ms|s)' client/src -g '*.css' -n

echo "=== §18 !important ==="
rg '!important' client/src -g '*.css' -n

echo "=== §19 Component vars on :root ==="
rg ':root\s*\{[^}]*--[a-z]+-[a-z]+-' client/src -g '*.css' -n

echo "=== §20 IDs / deep selectors ==="
rg '#[a-zA-Z]' client/src -g '*.css' -n
rg '^\s*\.\S+\s+\S+\s+\S+\s+\S+' client/src -g '*.css' -n

echo "=== §21 Parallel button bases ==="
rg -n '^\s*\.(primary-btn|danger-btn|action-btn|icon-btn|text-btn|back-btn|auth-submit)\b' client/src -g '*.css'

echo "=== §22 Scoped atom selectors (exclude uncontrolled-HTML surfaces) ==="
rg -n '^\s*\.[\w-]+(\.[\w-]+)*\s+(button|input|textarea|select|a|img|h[1-6]|code|pre)\b' client/src -g '*.css' \
  | rg -v 'message-content|reasoning-content|app-error'

echo "=== §13 cross-file @media landmines (review each) ==="
rg -n '@media' client/src -g '*.css'
```

---

## Remediation Priority

| Priority | Principle | Reason |
|----------|-----------|--------|
| **P0** | §16 Hookable elements | Breaks user CSS; public API contract |
| **P0** | §18 No `!important` | Irreversible specificity arms race |
| **P1** | §6 Colors, §7 Radius, §8 Shadows, §9 Typography, §10 Z-index | Tokens are the design system; raw values leak inconsistencies |
| **P1** | §20 Specificity ceiling | Hard to fix retroactively without refactoring callers |
| **P1** | §21 Base classes, §22 Element selectors | Root cause of the duplication that breeds bugs (drifted copies, lost `.modal-content` styling); architectural — migrate incrementally, enforce with `lint:css` |
| **P2** | §1 Layout, §3 Margins, §4 Padding, §5 Sizing | Affects maintainability and predictability |
| **P2** | §15 No inline styles | Scatters design logic into JS |
| **P3** | §2 Spacing, §14 Minimal DOM | Architectural debt; fix during refactors |
| **P3** | §11 Selectors, §12 Modifiers, §13 Responsive, §17 Animation, §19 Variable scope | Code-review discipline; catch in PR |

---

## CI Integration

The fully automatable checks (§3–§10, §12, §13, §17–§20) can be turned into a lint script:

```json
// client/package.json
{
  "scripts": {
    "lint:css": "bash ../scripts/css-audit.sh"
  }
}
```

A shell script that runs the `rg` commands above and exits non-zero on any hit would enforce the principles at build time.
