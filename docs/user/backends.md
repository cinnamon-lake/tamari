# Backend Configs

A backend config is a named, reusable connection profile: which provider to talk to, which model, how to authenticate, and how to sample the output. You manage them in the **Backend Config** modal (sidebar → **Backend Config**, the sliders icon). All edits auto-save after a short pause — the **Saving…** indicator in the title bar confirms it.

One config is **active** at a time. The active config (the `activeBackendConfigId` setting) is global and shared by all chats — there is no per-chat backend binding. Per-character behavior comes from [custom backends](./custom-backends.md) and card scripts instead.

## Creating and Switching Configs

The **Active Backend Config** section at the top of the modal has a **Config** dropdown listing every config you have. Picking one does two things: it makes that config the active one, and it loads it into the editor below.

- **Duplicate Config** copies the current config (including samplers and connection fields) under a "(Copy)" name — the fastest way to fork a setup before experimenting.
- **Delete Config** removes it after a confirmation. The last remaining config can't be deleted, and deleting the active config automatically falls back to another one.

> **Note:** Switching configs flushes any pending edits on the old one first — nothing you typed is lost.

## Providers

Set **Generation Mode** first — it decides which providers the **Provider** dropdown offers and how your prompt is sent:

- **Chat Completion** sends a message list (system/user/assistant turns). Providers: **OpenAI**, **OpenRouter**, **Claude**, **Gemini**, **Custom (Lua)**.
- **Text Completion** flattens everything into one story string through an instruct template. Providers: **OpenAI** (any OpenAI-compatible server), **llama.cpp**, **TabbyAPI**, **KoboldCPP**.

> **Note:** Text Completion mode forces the text-completion adapter regardless of provider — so **OpenAI** in text mode is how you point at any OpenAI-compatible `/completions` endpoint (Ollama, LM Studio, text-generation-webui, a reverse proxy, …).

### Connection Fields

| Field | Notes |
|-------|-------|
| **API URL** (`apiUrl`) | Empty = the canonical provider URL (e.g. `https://api.openai.com/v1`, `http://localhost:8080` for llama.cpp, `http://localhost:5000` for TabbyAPI, `http://localhost:5001` for KoboldCPP). Point it at any compatible endpoint or reverse proxy. |
| **API Key** (`apiKey`) | Raw key or a vault reference (`secret:<key>`) — see [API Keys & Secrets](#api-keys--secrets). Never validated, so proxy and local setups with unusual keys work. Local providers (llama.cpp, TabbyAPI, KoboldCPP) need no key. |
| **Model** (`model`) | Model id. Never validated — anything goes, which is what you want for proxies and fine-tunes. See [Listing Models](#listing-models). |

### Provider Quirks

- **OpenRouter.** When the model list is loaded, an **OpenRouter Provider** dropdown appears, built from the vendor prefixes of the model ids (`anthropic/…`, `google/…`, …). Choosing one sets the routing provider order to that vendor and filters the model list to match. The **OpenRouter Reasoning** section below the editor sets **Reasoning Effort** and **Reasoning Summary**; these two are *global* settings, not per-config.
- **Claude.** Prompt caching is controlled globally by **Settings → Generation → Claude Prompt Caching** (Off / Auto / Manual — off by default). When caching is on, tamari disables it automatically for any generation whose inputs contain non-deterministic macros (`{{random}}`, `{{pick}}`, `{{roll}}`, time/date macros — see [Macro System](./macros.md)). The same applies to Claude models routed through OpenRouter.
- **Custom (Lua).** No API URL or key — instead you pick a custom-backend script and an optional delegate backend config. See [Custom Backends](./custom-backends.md).
- **Media Support.** The **Images / Audio / Video** checkboxes (all on by default) declare what the provider can consume. Media it can't consume is dropped from the prompt — or replaced with `[Attached image]`-style placeholders when **Settings → Display → Verbose media mode** is on.

## API Keys & Secrets

You can paste a raw key into **API Key**, but it is then stored in plaintext in the database. The better option is the **vault**: an AES-256-GCM-encrypted store keyed by the `TAMARI_SECRET` environment variable.

1. Open **Secrets** from the sidebar (the key icon) and click **Add Secret**.
2. Give it a **Key** (e.g. `openai-key`), an optional **Label**, and the **Value**.
3. In the backend config, either type `secret:openai-key` into **API Key**, or click the **Use vault secret** button next to the field and pick the entry.

References resolve on the server just before a request is built. They never reach Lua scripts, tool results, or logs, and the workbench redacts saved keys to `hasApiKey` (see [The Workbench](./workbench.md)).

> **Warning:** Resolution is best-effort. If a `secret:<key>` reference can't be resolved, the literal string `secret:<key>` is sent as the key — the provider's 401 is your signal that the vault entry is missing or unreadable, not a config error.

## Sampling

The **Sampling** section holds the typed knobs: **Temperature**, **Max Tokens**, **Top P**, **Top K**, **Min P**, **Top A**, **Repetition Penalty**, **Frequency Penalty**, and **Presence Penalty**.

Two rules govern what actually reaches the provider:

- **Empty means "don't send".** Every knob except Temperature, Max Tokens, and Top P is nullable — clear the field and the parameter is omitted from the request entirely.
- **Per-knob kill switch.** Each knob has a **Send this parameter** checkbox. Unchecking keeps your value on the config but omits the parameter from the wire — for models that reject a sampler (for example, a model that dropped `top_k`). Stored internally as the sparse `samplerDisabled` record in `providerParams`.

### Context & Limits

- **Context Length** (`contextLength`) — the total prompt budget. Chat history is trimmed oldest-first to fit it; preset prompts and World Info entries always render in full (see [World Info](./world-info.md)).
- **Prompt History Limit** (`promptHistoryLimit`) — cap on messages pulled into context.
- **Stop Strings** (`stopStrings`) — custom stop sequences, one per line. Macros inside them are resolved when **Settings → Generation → Resolve macros in custom stopping strings** is enabled.
- **Logit Bias** (`logitBias`) — a `token: bias` map, one per line (e.g. `12345:5` or `word:-10`). Sent to OpenAI-family and text-completion providers.

### Advanced Sampling

The collapsible **Advanced Sampling** section exposes provider-native knobs, gated by which adapter your provider and mode select. Chat providers (OpenAI, OpenRouter, Claude, Gemini) see only **Seed**; local and text-completion providers get the full set, grouped as:

| Group | Knobs |
|-------|-------|
| Mirostat | Mode, Tau, Eta |
| Alternative Samplers | Typical P, Tail Free Sampling, Penalty Alpha |
| DRY | Multiplier, Base, Allowed Length, Penalty Last N, Sequence Breakers |
| XTC | Threshold, Probability |
| Smoothing | Factor, Curve |
| Dynamic Temperature | Dynatemp, Min/Max Temp, Dynatemp Exponent |
| Decoding | Seed, Ban EOS Token, Skip Special Tokens, Add BOS Token, Banned Tokens |
| Structured Output | Grammar (GBNF) |

Values are stored in `providerParams` under their **wire names** — the exact key the provider's API expects — and sent verbatim. Wire names differ per provider for the same knob: Tail Free Sampling is `tfs_z` on llama.cpp but `tfs` elsewhere, Typical P is `typical` on KoboldCPP but `typical_p` elsewhere, Seed is `sampler_seed` on KoboldCPP, and Grammar is `grammar_string` in text-completion mode but `grammar` on llama.cpp/KoboldCPP. You never need to know these to use the UI — they matter when you edit configs through the workbench or read a config JSON.

- **Checkbox knobs are tri-state.** Boolean knobs (Dynatemp, Ban EOS Token, …) offer **Omit field / On / Off** radios — "Omit field" sends nothing, so the provider's own default applies.
- **New knobs start unset.** A knob you never touched shows a neutral default value but is disabled (not sent) until you enable its checkbox.
- **Only declared keys survive.** `providerParams` is a closed contract — undeclared keys (including legacy settings dumps on migrated configs) are silently dropped on write and never reach the request body.

> **Note:** The niche samplers tamari doesn't expose (sampler order, rep-pen range, CFG, …) stay reachable through the [request transformer](#request-transformer), which can set any field on the request body.

## Instruct Templates (Text Completion)

In **Text Completion** mode, the **Instruct Template** dropdown picks how the flattened prompt is wrapped: BOS/EOS tokens, system/user/assistant prefixes and suffixes, the response prefix that primes the model's reply, and — for the "(Thinking)" variants — how reasoning blocks are extracted and reconstructed.

The built-in library covers: Alpaca, ChatML, DeepSeek V4 Pro, Gemma 4, GLM 5.1, IBM Granite 4.0/4.1, Kimi K2.6, Llama 2/3/4, MiniMax Text-01, Mistral (v0.1, v0.3, v3, Nemo, Large 2411), NVIDIA Nemotron 3, Phi-4 Mini, Phi-4 Reasoning Plus, and Qwen 3 / 3.5 — most in plain and thinking variants. **None (plain)** sends the story string with no wrapping.

You can write your own in **Settings → Custom Instruct Templates** (**New Template**): set an ID, a display name, and the wrapper fields. Custom templates appear in the same dropdown. Built-in template IDs are reserved — you can't override one; an unknown template ID silently falls back to **None (plain)**.

## Listing Models

tamari asks the provider for its model list (`GET /api/models` on your server) whenever you open the modal or change provider, and shows the result as the **Model** dropdown, with context-length badges where the provider reports them. The circular-arrow button (**Refresh model list**) re-fetches on demand.

Model discovery is adapter-specific:

- **OpenAI, Claude, OpenRouter** fetch their listing endpoint live; a failure surfaces as an error.
- **Gemini** and **Moonshot** fall back to curated static lists, so the dropdown stays usable with a bad key.
- **llama.cpp, TabbyAPI, KoboldCPP** often expose no listing route and simply return nothing.

> **Note:** When listing fails or returns nothing, the dropdown becomes a plain text field — type the model id manually. Nothing about the model id is validated at save time.

## Request Transformer

The **Request Transformer (Lua)** textarea holds a small Lua script that rewrites the outgoing HTTP request — headers, body, URL — after the adapter builds it and before it is sent. It is stored per config, so two configs on the same provider can mutate requests differently. Full contract and examples: [Request Scripts](./request-scripts.md).

To see exactly what your config sends (request script included, credentials scrubbed, nothing actually transmitted), ask the model to dry-run it with the workbench's `test_backend` verb — see [The Workbench](./workbench.md).

## Tips & Gotchas

- **Duplicate before you experiment.** **Duplicate Config** copies everything, including advanced samplers and the request script — break the copy, not your working setup.
- **A knob that "does nothing" is probably disabled or empty.** Check the **Send this parameter** checkbox first, then that the field isn't blank — both states mean "not sent".
- **Sampler changes apply on the next generation.** Auto-save is debounced by about half a second; a generation started in that window uses the previous values.
- **Switching provider doesn't remap samplers.** Advanced knobs are stored per wire name — a value set for llama.cpp (`tfs_z`) stays on the config and keeps being sent if you switch to KoboldCPP (whose wire name is `tfs`), but it no longer shows in the UI. Recheck the Advanced Sampling section after switching, and clear leftovers through the workbench if a provider complains.
- **Text-mode OpenAI is the universal adapter.** Any OpenAI-compatible server works via Generation Mode → Text Completion, Provider → OpenAI, and your server's URL — with the right instruct template for the model you loaded.
- **OpenRouter reasoning settings are global.** Reasoning Effort/Summary appear in the modal but apply to every config, not just the one you're editing.

## See Also

- [Custom Backends](./custom-backends.md) — Lua-driven backends behind the Custom (Lua) provider
- [Request Scripts](./request-scripts.md) — the request transformer contract
- [The Workbench](./workbench.md) — editing and dry-testing backend configs through the AI
- [Macro System](./macros.md) — macros in stop strings; non-deterministic macros and prompt caching
- [World Info](./world-info.md) — lorebooks and keyword-triggered injection
- [Getting Started](./getting-started.md) — first-run setup
