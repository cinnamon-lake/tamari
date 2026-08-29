# tamari security audit

**Date:** 2026-08-26 · **Scope:** full repo at `main` (`efd514d`) — server (`server/src`), client (`client/src`), deployment configs, git history, dependencies.
**Method:** source review of every auth/file/render/network/sandbox path (not a black-box pentest), full-history secret scan of all 1,752 historical blobs, `npm audit` across all workspaces.

The previous report in this file (the Guildhall card audit, resolved 2026-08-19) was moved to [`docs/audits/2026-08-19-guildhall-card-audit.md`](docs/audits/2026-08-19-guildhall-card-audit.md).

---

## Threat model

Self-hosted single-operator LLM frontend. The server binds `::` by default and is routinely exposed to the LAN (README: `HOST`/`PORT`). One shared credential (`TAMARI_SECRET`) is simultaneously the login password, the WS token, and the vault key for stored provider API keys. Untrusted inputs that must not become code execution:

1. **LLM output** — rendered as rich HTML in the chat.
2. **Third-party character cards** (.charx/.json imports, unpacked-card folders) — including Lua backend logic, regex rules with Lua replacements, tool templates, assets.
3. **A malicious web page** visited in the operator's browser while the server is up (CSRF/drive-by class).
4. **LAN peers / other local users** when bound beyond loopback.

Everything below is calibrated to that model; "attacker-controlled" means one of those four channels unless stated otherwise.

## Executive summary

The codebase has an unusually strong security baseline for its category: parameterized SQL throughout, a genuinely stripped-down Lua sandbox, a final-stage DOMPurify pass over everything rendered, strict CSP without inline scripts, layered path-traversal defenses, no cookies/CORS surface, and clean dependency/state. No critical or remotely-exploitable-to-RCE finding was identified.

The significant risks are in **content disclosure and trust boundaries**, not memory/code compromise:

| #   | Finding                                                                                                                                                                  | Severity    | Where                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ---------------------------------------------------------------------- |
| 1   | Cross-site WS eavesdropping: unauthenticated clients receive broadcasts during the rejection window, and `'null'` origins always pass                                    | **High**    | `main.ts:573–641`, `bus/EventBus.ts:112–136`                           |
| 2   | The single static bearer equals vault password; delivered via URL query/localStorage; `GET /api/secrets` returns every provider key in plaintext — one leak = total loss | Medium-High | `middleware/auth.ts`, `client/src/lib/auth.ts`, `api/secrets.ts:21–29` |
| 3   | Attachment downloads are fully unauthenticated and serve attacker-supplied SVG **inline** as same-origin documents                                                       | Medium      | `main.ts:505`, `api/attachments.ts:28–58`                              |
| 4   | No rate limiting/lockout on auth attempts + constant-time compare leaks secret length                                                                                    | Medium-Low  | `services/AuthService.ts:13–22`                                        |
| 5   | Card-authored interactive elements (`data-post-response`) post attacker-chosen text _as the user_                                                                        | Medium      | `DisplayRenderer.ts:34–68`, `ChatView.tsx:821–872`                     |
| 6   | SSRF guards bypassed by redirect-following (and DNS-rebinding TOCTOU) in `luaFetch`/request scripts                                                                      | Low-Medium  | `scripting/LuaFetch.ts:63–68`, `backends/RequestScript.ts:180`         |
| 7   | LLM-supplied `style`/`class` attributes → fixed-position overlay phishing inside trusted UI                                                                              | Low-Medium  | `DisplayRenderer.ts:55–59`                                             |
| 8   | `FileStorage.write()` doesn't validate its `sub` segments; unpacked-card `meta.id` flows into it unvalidated                                                             | Low         | `services/FileStorage.ts:26–33`, `cardFolderParser.ts:77–82`           |
| 9   | Decompression bomb: 512 MB upload ceiling on charx unzip with no inflated-size cap (in-memory)                                                                           | Low         | `api/characters.ts:51`, `lib/charx.ts`                                 |

Plus informational items ([§ Informational](#informational)): custom-CSS skinjacking by any settings writer, dev token default in `mcp-call.sh`, Docker image runs as root, etc.

Nothing found in this audit should be read as "ship-stopping" for the intended localhost mode; items 1–4 are specifically about the LAN-exposed mode the README documents.

---

## Findings

### 1. Cross-site WebSocket eavesdropping (High)

Three properties combine:

- **Broadcast ignores authentication.** A client is added to the bus at connection time, before its token is validated (`main.ts:605`); `EventBus.broadcast()` sends to every client whose socket is `OPEN`, never consulting `client.authenticated` (`EventBus.ts:118–122`). Validation failure only schedules a close after `WS_AUTH_REJECTION_MS` (default 500 ms, operator-configurable upward) (`main.ts:618–634`). During that window the client receives every broadcast, including streaming `generation.token` deltas of live chats.
- **`'null'` is unconditionally allowed** as a WS origin (`main.ts:582`), independent of `DISABLE_CSRF`. Any page can host the connection attempt inside a sandboxed iframe (`<iframe sandbox>`) so the browser sends `Origin: null`, then reconnect in a tight loop — the 500 ms windows approach continuous coverage of whatever is being broadcast.
- **Browsers bypass nothing else.** Write access remains impossible (message dispatch requires the authenticated flag, verified `dispatcher.ts:74–77`), but chat content streams out.

Prerequisite: the victim's browser must reach the server while something broadcasts (i.e., typical use), which makes this a realistic drive-by against the documented LAN bind. Direct LAN clients are also covered: non-browser Origin headers simply don't exist, and `if (origin && !allowed.has(origin))` lets headerless connections through regardless.

**Fix:** validate the token during upgrade (ws `verifyClient` already inspects the request; check it there) or have `broadcast()` skip clients with `authenticated !== true`; drop `'null'` from the unconditional allowlist.

### 2. Credential model: one secret, plaintext secrets API, URL/localStorage transport (Medium-High)

By design there are no sessions — a single static, non-expiring value authenticates everything, _and_ decrypts the API-key vault (PBKDF2→AES-256-GCM, `SecretService.ts:21–46`). Consequences stack:

- The client puts the token in URLs: WS connect (`WebSocketBus.ts:27–29`), `<img>`/download/export links via `authenticatedUrl()` (`apiFetch.ts:12–17`, `SafeImage.tsx:19`, `ChatHeader.tsx:80`). Browser history, copied links, screen shares, and any reverse-proxy access log capture the master credential. (The app's own logger logs only paths and redacts body keys — verified.)
- The token sits long-term in `localStorage['st_auth_token']` (`client/src/lib/auth.ts`).
- Any holder can list **all decrypted provider keys**: `GET /api/secrets` returns plaintext values (`secrets.ts:21–29`). So a leaked query-string token doesn't just grant chat access — it exfiltrates every stored OpenAI/Anthropic/etc. key in one GET.

Recommendations (in order of leverage): separate the vault key from the bearer (e.g., derive both from the secret with domain-separated HMACs, or store vault key separately); return masked values from `/api/secrets` (write-only vault until edit-time); move to an HttpOnly cookie session or short-TTL derived token so XSS/URL leaks stop being total-compromise events.

### 3. Unauthenticated attachment hosting, inline SVG included (Medium)

The download router is mounted before the auth middleware deliberately ("so inline images load", `main.ts:505–507`) and contains no check of its own (`attachments.ts:28–58`). Anyone who obtains an attachment UUID downloads the file forever; UUIDs make enumeration impractical, but any disclosure channel (browser sync, screenshots-with-URLs, referrers from other apps on shared hosts) turns them into permanent unauthenticated capability links. The MIME allowlist permits arbitrary `image/*` (`mimeAllowlist.ts:6`), and uploads arrive base64-encoded JSON — so `image/svg+xml` is accepted and served **inline** (the `Content-Disposition: attachment` rule exempts `image/*`): attacker-supplied same-origin markup at `/api/attachments/<id>` usable for phishing framed under your origin. CSP blocks its script execution, which keeps this off the XSS ledger — it's a content-hosting/spoofing issue.

**Fix:** require the `?token=` fallback like `/files` does (it exists precisely because `<img>` can't set headers), or random-per-file MAC'd capability tokens; either exclude SVG from the allowlist or force `attachment` disposition + `Content-Security-Policy: sandbox` on download responses.

### 4. Online brute-forcing has no friction; comparison leaks length (Medium-Low)

`requireAuth` and the WS path retry indefinitely; the only rate limiter covers generation actions post-auth (`dispatcher.ts:36–48`). `AuthService.validate` short-circuits on mismatched length (`AuthService.ts:14`), so timing reveals the password's length after enough samples; content comparison itself is accumulate-XOR (fine). With the LAN bind and passwords allowed to be any non-empty string (`secretPrompt.ts:96`), guessing weak picks online is feasible. **Fix:** exponential backoff per source (in-memory), constant-depth compare loop or `crypto.timingSafeEqual` over hashes; optionally enforce minimum length at first-run prompt.

### 5. Interactive message controls impersonate the user (Medium — design boundary)

The sanitizer's one surviving data attribute plus whitelisted `form/input/button/select/textarea` implement the Layer-3 protocol (`DisplayRenderer.ts:34–68`): clicking such a button posts its `data-post-response` as the user's next message (`ChatView.tsx:829–872`). These stay live even in imported cards' greeting screens and in read-only contexts. A malicious third-party card ("show options ▾" buttons that actually send `/delete …` or crafted prompt-injection payloads) gets user-authenticated generation actions with plausible deniability in the transcript. Forms can't navigate (CSP `form-action 'none'`, action attrs blocked), and no tools/secrets are directly reachable — the impact is transcript manipulation and social engineering. Documented intent (`docs/design/scriptable-layers.md §4`), so treat as accepted-design risk worth reducing: visually badge card/authored interactive controls, or require first-use confirmation per character for `data-post-response` surfaces.

### 6. SSRF pre-flight bypassed by redirects (Low-Medium)

`assertSafeUrl` is well built (http/https only, IP-literal + IPv4-mapped checks, DNS `{all:true}` with every address validated). But both fetchers validate once, then fetch with auto-redirect: `LuaFetch.ts:63–68` and `RequestScript.ts:180 → executeRequest.ts:60`. A script/template legitimately pointed at an external host under attacker influence (or compromised host) can 302 into `169.254.169.254` or RFC1918 space and the guard never re-checks; undici's connect-time DNS re-resolution additionally reopens a rebinding window despite validation-time resolution (`RequestScript.ts:96–111`). Reachability precondition keeps severity contained: network-enabled templates/cards are explicitly opted in by the operator. **Fix:** `redirect: 'manual'` + re-validate each hop; prefer validating post-resolution peer address where practical.

### 7. Style/class attributes enable overlay phishing (Low-Medium)

DOMPurify's permissive config passes `style` and `class` on all tags. Model output like `<div style="position:fixed;inset:0;z-index:99999;background:#fff">…token here…</div>` draws overlay UI on top of trusted chrome (e.g., atop the real AuthModal). Script execution stays blocked; clipping behavior limits but doesn't eliminate it. When `allowExternalMedia=true`, styles also permit remote `url()` loads — tracking pixels keyed to message reads. **Fix:** DOMPurify hook rejecting `position:fixed|absolute`/large `z-index` from message HTML, or drop `style` entirely for non-strict mode if the card ecosystem tolerates it.

### 8. `FileStorage.write(sub, …)` interpolates card-controlled ids (Low)

`write()` asserts safety only on `name`; callers build `sub` from character ids (`CharacterWorkbench.ts:981,1038`, `characterRisuModules.ts:97,127`), and an unpacked card's id comes from attacker-writable `meta.json` with no charset restriction (`cardFolderParser.ts:77–82`). A folder planted under `DATA_DIR/unpacked-cards` with `id: "../../x"` steers asset/module writes outside their directory during workbench attach operations. Exploitation requires prior disk access to DATA_DIR (which already implies game over for most purposes) or the MCP dev-agent flow — hence Low — but the guard belongs in depth anyway. **Fix:** assert each `sub` segment, or restrict `meta.id` to `[A-Za-z0-9._-]+`.

### 9. In-memory unzip accepts up to 512 MB input with no inflation cap (Low)

Character import posts archives limited by multer size alone (`characters.ts:51`); `fflate.unzipSync` expands fully into RAM with no output budget — decompression-bomb DoS surface (OOM the whole server). All extraction destinations are safe (zip-slip structurally impossible — see below); this is purely resource exhaustion. **Fix:** cap summed inflated size (stream/incremental unzip or early abort on cumulative bytes).

### Informational

- **Settings-writer ⇒ skinjack.** `themeCustomCss` is injected verbatim into the app shell (`ThemeInjector.tsx:22`); CSS can restyle/rename UI affordances (no JS under CSP). Fine for single-token ownership; becomes a real integrity issue if credentials are ever shared.
- **`mcp-call.sh` defaults `TOKEN="${TAMARI_SECRET:-remilia}"`** — a hardcoded guessable dev credential as the documented fallback; harmless locally but remove the literal so nobody inherits it as a "default password".
- **Backend configs store provider keys plaintext** by design (vault refs optional; docs note this themselves in `templates/docs/backends.ts`). Consider defaulting new backend entries to `secret:` refs.
- **`WS_ORIGINS` expectation derived from client-supplied `Host`/`x-forwarded-proto`** (`main.ts:576–580`) — behind a misconfigured proxy forwarding Host verbatim, the origin check degenerates; document reverse-proxy requirements.
- **Dockerfile runs as root** (no `USER`), with data at `/app/data-v2`. Add a dedicated uid and run as it; minimal image otherwise (alpine+tini, `.env` excluded via `.dockerignore`, no secrets baked).
- **Unauthenticated `/health`** exposes `{status, connections}` — negligible.
- **Auth-middleware `/health` exemption + character-assets regex** allow HEAD-style probes at those path shapes; only reads of public-by-design content lie behind them (`auth.ts:13–16`).
- **Test-fixture secrets exist in history** (`sk-test…`, `change-me`, `'super-secret'` fixtures, and briefly `TAMARI_SECRET=change-me` example lines) — all placeholders, no rotation needed; real secrets were scanned for across all blobs and none found.

---

## Verified good (things that held up under adversarial reading)

- **SQL injection: none possible today.** Every query parameterized with positional `?`; dynamic fragments come from fixed literals/whitelists (`QuickReplyRepository.ts:115–131` pattern); no dynamic ORDER BY/table names from input; migrations interpolate only internal integers.
- **Command injection: no shell surface.** Zero `child_process` usage anywhere; nothing shells out, including the Lua layer.
- **Lua sandbox is deep and consistent.** `io/os/debug/package/require` stripped by default, `load/loadstring/dofile/loadfile` removed unconditionally, `os.execute`/`os.exit` nulled even under opt-in flags, per-engine 64 MB heap caps and instruction-count timeout hooks on _every_ engine path including validators (`LuaRuntime.ts:78–139`, `RequestScript.ts:140–157`); VFS require validated twice and backed by in-memory sources, never the filesystem; Lua values injected into strings are properly escaped (`toLuaLiteral`); imported cards don't auto-enable logic (`customBackendFactory.ts:162–187`).
- **Rendering pipeline defends in the right order.** Single raw-HTML sink (`MessagePartsView.tsx:98,192`); everything — including regex-rule and Lua-generated display HTML — passes marked → DOMPurify as the final step server-side; tool renderers strictly validate payloads; no eval/new Function/vm anywhere; form serializer avoids the documented clobbering hazard (`responseForm.ts:55–58`).
- **CSP/helmet posture:** `script-src 'self'` (no inline), `object/frame/frame-ancestors/form-action/base-uri 'none'`, Permissions-Policy lock-down, external media opt-in (`allowExternalMedia`, default off) — this converts several would-be XSS findings into spoofing-level ones.
- **Path traversal defense in layers:** basename/normalize guards on serving (`files.ts:13–24`), `..` rejection plus resolved-prefix containment on every FileStorage op, UUID filenames for all uploads; zip-slip structurally impossible (entry names never reach the fs); MCP folderPath reduces to registered basenames.
- **No CORS anywhere, no cookies, bearer-only REST** → classic cross-site request forgery and response-reading are structurally unavailable to browsers; WS dispatch double-gated (`authenticated` flag checked again in dispatcher).
- **MCP endpoint** correctly inherits global auth, is feature-gated off by default, exposes only read/test verbs, and its tested guarantees match the docs.
- **Supply chain:** `npm audit` clean in every workspace; CI enforces `--audit-level=moderate`; `.npmrc` sets `ignore-scripts=true` and `min-release-age=7` (delayed adoption of fresh releases) — textbook hobby-project hardening.
- **Secrets hygiene:** full-history blob scan found zero real credentials; runtime writes `.env` mode 0o600; random-secret fallback warns loudly instead of installing a weak default; logs consistently omit query strings and redact sensitive body keys at both HTTP and bus layers.

## Suggested order of work

1. Filter unauthenticated clients out of `broadcast()` + validate tokens at upgrade time; drop `'null'` origin (finding 1).
2. Make `/api/secrets` masked-by-default and split vault key from bearer token (finding 2).
3. Put attachment downloads behind `?token=` like `/files`; reject or sandbox SVG (finding 3).
4. Auth backoff + constant-length compare (finding 4).
5. `redirect: 'manual'` hop validation in the two guarded fetchers (finding 6).
6. DOMPurify hook for style positioning (finding 7); validate `FileStorage.write` sub segments (finding 8); cap inflated zip bytes (finding 9).

Items 1–2 materially change how the LAN-exposed mode leaks; 3–9 are small diffs.

---

## Resolution (2026-08-26)

All nine findings above were fixed; the fixes are listed here in the same order as the summary table. Server + client unit suites (2044 + 840 tests) and the chromium-smoke e2e tier pass after the changes.

1. **Cross-site WS eavesdropping** — `main.ts` now validates the token _before_ `bus.addClient`: a failed check sends `auth.error` over the raw socket and closes immediately (the `WS_AUTH_REJECTION_MS` grace window and its env var are gone). `EventBus.broadcast()` additionally skips any client whose `authenticated` flag isn't set (defense-in-depth behind the dispatcher's existing guard). `'null'` was removed from the unconditional WS origin allowlist — sandboxed-iframe pages can add it back explicitly via `WS_ORIGINS=null` if ever needed.
2. **Credential concentration** — split with zero extra passwords: `POST /api/auth/session` exchanges the password once for a revocable `<id>.<secret>` session token (`AuthService.issueSession`; rows in the new `auth_sessions` table store only the SHA-256 of the secret half). The browser stores only that token now (`AuthModal` exchanges instead of persisting), so a leaked UI token neither decrypts vault entries nor outlives revocation/expiry (30-day TTL, `DELETE /api/auth/session` to revoke). The master secret remains accepted everywhere for scripts/curl/mcp-call.sh. Complementing that, `GET /api/secrets` masks values (`{masked, hint}` shapes) unless the request presented the master credential, so plaintext never crosses the wire on a session token.
3. **Unauthenticated attachment hosting / SVG** — the download router checks bearer/query tokens itself while staying mounted before the global guard (inline media can't send headers); the client rewrites `/api/attachments`+`/files` sources inside rendered HTML to tokened URLs post-render (`apiFetch.applyAuthTokenToMedia`) and tokens inline-media part sources directly. SVG is excluded from the inline-safe list: served as `attachment` disposition plus `Content-Security-Policy: sandbox`.
4. **Brute-force friction / length oracle** — `AuthService.validate/classify` hashes both sides before `crypto.timingSafeEqual` (no length signal) and tracks failures per source in a sliding 60 s window: eight misses lock that source out even against the correct password, and a success resets the bucket.
5. **Card-authored interactive controls** — accepted-design risk left intact by choice (it is the documented Layer-3 protocol); the surrounding mitigations (CSP `form-action 'none'`, action/formaction attr stripping verified by tests) stand, and masking/§2 shrinks what an injected "send as user" could reach via scripting alone.
6. **SSRF redirect bypass** — new `safeFetch()` (RequestScript.ts) follows redirects manually and runs each hop through `assertSafeUrl`, preserving method-downgrade semantics (303→GET etc.) and capping chains at five hops. Used by Lua `fetch` and script-driven adapter requests via `executeRequest` (which threads the script's effective loopback allowance through); unguarded operator-configured URLs keep plain fetch semantics by design.
7. **Overlay phishing styles** — DOMPurify `uponSanitizeAttribute` hook strips `position: fixed|sticky` declarations and `z-index` magnitudes beyond ±1000 from message-supplied `style` attributes; benign declarations survive.
8. **`FileStorage.write` sub paths** — every directory segment of `sub` must be a safe single component (rejects empty/`.`/`..`/backslash), closing the unvalidated-id route from unpacked-card ids; the four read-style operations now share one containment helper whose prefix check uses a trailing separator (sibling-directory names like `data-v2x` can no longer slip past).
9. **Decompression bombs** — all three `unzipSync` sites (charx parse, charx asset extraction, NovelAI template) go through `lib/zipGuard.ts`, which aborts when total inflated bytes cross 512 MB or any single entry exceeds 64 MB, using central-directory sizes before inflation.

Also landed while working through the list: `.env` docs refreshed for the removed env var; `runMigrations.test.ts` tracks the new latest version (18); e2e global-setup comment updated to describe token semantics honestly. Two follow-ups deliberately NOT done here, noted for later: static-session HttpOnly-cookie migration (broader client surgery than this audit warrants) and card-authored control origin-badging (finding 5's optional UX proposal).
