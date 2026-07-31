# Append-Only Prompt Layout — Design Proposal

**Status:** proposed (not yet implemented).
**Motivation:** coding-plan APIs with automatic prompt caching (discounted input tokens on cache hits) are becoming a primary backend for power users. Their caching is only profitable when the rendered request grows strictly by appends — and several Tamari prompt features violate that every single turn.

## Provider cache models

Two families exist in the wild; from the outside they are indistinguishable (same `cached_tokens` usage fields), so we design for the worse one.

**Lenient — block/radix prefix caches.** vLLM APC (16-token blocks, `hash(parent, tokens)` chaining), SGLang RadixAttention (radix tree, longest-prefix walk), DeepSeek disk cache (64-token units), OpenAI automatic caching (≥1024 tokens). Every computed block is indexed, so a request that diverges mid-history still gets credit for the prefix *above* the divergence. Floating injections cost only what's below their position (~1 exchange/turn for a depth-1 note). No write premium — misses are free.

**Antagonistic — snapshot caches.** Explicit-breakpoint systems (Anthropic `cache_control`: reads resolve only at markers, writes cost 1.25×) and per-request stores (hit = a stored full-context snapshot is a *verbatim prefix* of the request; the rational minimal implementation for append-only coding traffic). Here, content that moves position between turns poisons every snapshot it appears in: **a floating injection at any depth yields zero reads, every turn, while still paying write premiums where those exist.**

The purist append-only layout is optimal under both families, so it is the target.

## Existing machinery (do not duplicate)

- `claudeCacheMode` global setting (`off`/`auto`/`manual`, `packages/types/src/schemas.ts:348`) → `BuildOptions.caching` → `computeCacheDepth` (`PromptBuilder.ts:334`) → explicit `cache_control` breakpoints in the Claude/OpenRouter adapters.
- `computeCacheDepth` already bails on non-deterministic macros (`hasNondeterministicMacros`) and non-constant WI in static positions. Both guards are reused as-is.
- This machinery places breakpoints; it does **not** shape the request. That is the gap.

## Config

One new global setting in the existing cache cluster (Settings → Behavior, next to the Claude cache mode radios):

```
appendOnlyPromptLayout: boolean   // default off
```

Orthogonal to `claudeCacheMode`, deliberately: layout shaping benefits explicit-breakpoint users too (their breakpoints stop needing the floating-injection margin). A new enum value on `claudeCacheMode` was considered and rejected — layout and breakpoint placement are independent axes, and that enum is Claude-specific by name.

Per-backend-config was also considered and rejected for v1: the setting is global like its siblings, and "quick, simple configuration" was the brief.

## Rendering rules when enabled

**Invariant:** the rendered request is a pure function of *(static head, verbatim message log)* and grows strictly by appends. Equivalently: given an append-only message log and unchanged inputs, turn N's render is a byte-prefix of turn N+1's.

1. **History renders verbatim.** No author's-note splice, no WI atDepth entries, no absolute-depth preset prompts injected mid-history. (Depth-scoped regex does not exist in Tamari; per-message regex that rewrites a given message identically every turn is safe and stays.)
2. **Volatile content hoists to one pinned block at the top of history** (after the system prompt, before message 1), in deterministic order: author's note text → triggered atDepth WI entries → absolute-position preset prompts. The block changes only when its *inputs* change (note edit, WI keyword-set change) — an occasional full re-warm, documented, instead of a per-turn bleed.
3. **Hoist-and-trace** (decided): relocation is silent in the UI; each hoist is recorded in the generation's debug trace (`generations.meta`). The user opted into the mode; per-entry warnings would just nag.
4. **Non-deterministic macros:** the existing scan runs; findings are trace-noted (the layout still applies — it is harmless — but the cache will miss).
5. **Memory summary** stays prepended where it is (near-top already; changes only on a summarization cycle — same re-warm class as WI changes).

## Accepted losses (documented, not fixed here)

- **Front truncation at the context cap** — the sliding window shifts the prefix and zeroes every snapshot, every turn, exactly when contexts are big. This is the largest remaining leak and is *deliberately parked*: stable-cut/chunked truncation belongs to the summarization conversation.
- **Message edits / regenerates** — the user's own purchase; swipes keep the prefix up to the fork.
- **Continue** is safe: the partial message is a prefix of the prior snapshot (one caveat: whether a provider's snapshot end-token serialization matches a re-sent message is empirical per provider — docs note, not a blocker).
- **Group chats** — head content (active character card) changes per speaker; append-only is unattainable. Out of scope; the mode simply degrades there.

## Where it plugs in

- `PromptStages`: `authorsNoteSplice` and `worldInfoAtDepth` collect into `ctx.volatileBlock` instead of splicing when the flag is on; same for absolute prompts in the render stage. The stage list is unchanged — stages branch on the flag.
- Renderers (`ChatCompletionRenderer`, `TextCompletionRenderer`): emit `volatileBlock` at the pinned position, deterministic order.
- `packages/types/src/schemas.ts`: the setting, next to `claudeCacheMode`; `SettingsModal.tsx`: a checkbox with a plain-language tooltip ("for coding-plan APIs with automatic caching; disables in-chat depth placement of Author's Note / World Info / injections").
- `generations.meta`: hoisted entries recorded per generation.

Interaction with `computeCacheDepth`: no change needed — with nothing floating, its `maxInjectionDepth + 2` margin is simply conservative.

## Testing

- **The property test:** append a message to the log, re-render, assert turn N's serialized request is a prefix of turn N+1's (with unchanged inputs). This *is* the feature; test it directly in `PromptBuilder.test.ts` / golden snapshots (appendOnly on vs off).
- Unit: hoist ordering determinism; note/WI/absolute-prompt collection; verbatim history.
- E2E (Playwright): setting persists across reload (settings-behavior pattern); a generation with an author's note at depth renders the note in the top block (mock-LLM request capture, assert message order).

## Open questions

- Volatile block as one synthetic message vs. merged into the system prompt — renderer-level detail, decide at implementation.
- Should hoisted WI entries keep their decorators (they may carry position-dependent semantics)? Default: render content only.
