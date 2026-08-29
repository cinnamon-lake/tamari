# tamari code-quality audit

**Date:** 2026-08-28 · **Scope:** full repo at `main` — server (`server/src`, 387 files / ~84.5k LOC), client (`client/src`, 181 files / ~29k LOC), e2e (`e2e/`, 132 spec files / ~27k LOC), `packages/types`, tooling/CI/Docker/docs.
**Method:** four parallel source-review passes (server, client, e2e, tooling) plus automated verification: ESLint all workspaces, `tsc --noEmit` all workspaces, full vitest runs, `npm audit`, `npm outdated`. Complements, and does not repeat, the security audit in [AUDIT.md](../../AUDIT.md) (2026-08-26).

---

## Automated gate results (all run fresh for this audit)

| Check                                           | Result                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ESLint — server, packages/types                 | clean (0 problems)                                                                                                                                           |
| ESLint — client                                 | 0 errors, **157 warnings**, all `@typescript-eslint/no-unnecessary-condition` (deliberately `warn`, rationale documented in `client/eslint.config.js:25-30`) |
| `tsc --noEmit` — server, client, packages/types | clean                                                                                                                                                        |
| vitest — client                                 | **840/840 pass** (73 files)                                                                                                                                  |
| vitest — server                                 | **2069/2069 pass** (157 files)                                                                                                                               |
| `npm audit --audit-level=moderate`              | 0 vulnerabilities                                                                                                                                            |
| e2e                                             | not executed here (runs in CI; qualitative review below)                                                                                                     |

## Executive summary

The codebase is in unusually good shape for its size: zero TODO/FIXME markers anywhere, zero production `@ts-ignore`, zero `any` in client production code, zero empty catch blocks, strict ESLint enforced in CI, test/source ratios of 0.68 (server) and 0.62 (client), and no skipped or disabled e2e tests. The real debt is concentrated in a small number of items:

| #   | Finding                                                                                                                                                                    | Severity    | Where                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------- |
| 1   | Prettier not installed; `format` scripts dead; no format check in CI — formatting is unenforced despite `.prettierrc` and docs claiming otherwise                          | High        | root `package.json`, `.github/workflows/ci.yml`, CLAUDE.md:40 |
| 2   | `node-fetch → whatwg-url` override not applied in lockfile (lockfile predates the override; `whatwg-url@5.0.0` still pinned/installed)                                     | High        | root `package.json:20-22`, `package-lock.json`                |
| 3   | License contradiction: `AGPL-3.0` in package.json vs GPL v3 `LICENSE` file vs "GPL-3.0" in README                                                                          | High        | `package.json:5`, `LICENSE`, `README.md:33`                   |
| 4   | `createStApi` god-factory: 1,455 lines, ~145 closures — the single worst complexity hotspot in the repo                                                                    | High        | `server/src/scripting/StApi.ts:343`                           |
| 5   | WebSocket core effectively untested: `bus/EventBus.ts` zero tests; `dispatch/` 1,585 LOC vs 272 test LOC                                                                   | High        | `server/src/bus/EventBus.ts`, `server/src/dispatch/`          |
| 6   | Client god-components: `BackendConfigModal.tsx` (1,449 LOC / 44 signals), `SettingsModal.tsx` (1,196 / 68, ignores existing `SchemaForm`), `ChatView.tsx` (1,151 / 45)     | High        | `client/src/components/`                                      |
| 7   | Modal scaffold duplicated across 19 components (no shared shell); modal management via DOM poking in `App.tsx`                                                             | High        | `client/src/components/*Modal.tsx`, `App.tsx:81-141`          |
| 8   | e2e duplication: `uniqueName` redefined in 86 specs; login/backend wiring hand-rolled in 74 files despite `journeyTest` fixture; WS-call boilerplate ~6×                   | High        | `e2e/tests/`, `e2e/helpers/`                                  |
| 9   | e2e selector strategy: 1,928 raw `.locator()` calls vs 3 `getByRole` / 4 `data-testid` — contradicts `e2e/README.md:86-98`'s own advice                                    | Medium-High | `e2e/tests/`                                                  |
| 10  | e2e workspace outside lint and typecheck; CI has no standalone typecheck step                                                                                              | Medium      | `e2e/`, `.github/workflows/ci.yml`                            |
| 11  | No e2e coverage for the two newest server surfaces: `/v1` proxy and `/api/mcp`                                                                                             | Medium      | `server/src/api/proxy.ts`, `api/mcp.ts`                       |
| 12  | SSE stream framing implemented 3× and `parseDataUrl` byte-identical in 3 backend adapters                                                                                  | Medium      | `server/src/backends/{OpenAI,Claude,Gemini}BackendAdapter.ts` |
| 13  | Two-and-a-half error-response patterns: central `{error:{code,message}}` vs 52 hand-rolled flat sites; `apiError()` helper dead in production                              | Medium      | `server/src/middleware/errorHandler.ts`, `server/src/api/`    |
| 14  | Dead code: client `Skeleton.tsx` + `lib/charx.ts` whole modules; e2e `fixtures/server.ts` + `fixtures/mockBackend.ts` (still documented as alive); ~5 orphan CSS selectors | Medium      | client, e2e                                                   |
| 15  | `engines: node >= 24` allows a version the Dockerfile documents as crash-broken under wasmoon; CI and Docker both use Node 26                                              | Medium      | `package.json:11-13`, `Dockerfile:1-4`                        |

Plus low-severity items ([§ Low / informational](#low--informational)) and a healthy dependency picture ([§ Dependencies](#dependencies)).

---

## Server (`server/src`)

Baseline: 387 files, 50.4k source + 34.1k test LOC, ratio 0.68. Zero TODOs, zero empty catches, zero production `@ts-ignore`, ~69 real `any` (thinly spread), 26 eslint-disables — all justified in writing.

**Complexity.**

- `createStApi` (`scripting/StApi.ts:343`): 1,455 lines returning a ~145-method API object. Should be split by domain (chat actions, world info, variables, generation). 100 functions repo-wide exceed 60 lines; other notable: `importLegacyData` (754, `db/import-legacy.ts:536`, one-shot — tolerable), `LuaBackendAdapter.stream` (327, `backends/LuaBackendAdapter.ts:257`), `createCharacterRouter` (316, `api/characters.ts:268`).
- Largest data-only files (`gameCardsExample.ts` 4,356; `InstructTemplate.ts` ~600 of 661 is template data) are fine as-is.

**Duplication.**

- SSE line framing (`buffer.split('\n')` + `data:` prefix) triplicated: `OpenAIBackendAdapter.ts:135` (169 lines), `ClaudeBackendAdapter.ts:53` (145), `GeminiBackendAdapter.ts:99`. No shared SSE reader exists.
- `parseDataUrl` byte-identical in the same three adapters (`:472` / `:433` / `:377`).
- `services/characterAvatar.ts` vs `services/personaAvatar.ts`: 53 near-identical lines each; parameterize.
- All 11 TTS adapters re-implement the same ~15-line `baseUrl`/`headers`/`applyScript` boilerplate (~150 lines removable via a base class).

**Error handling.**

- Central handler emits `{ error: { code, message } }` (`middleware/errorHandler.ts:57`) while 52 route sites hand-roll flat `{ error: 'string' }`; `apiError()` (`errorHandler.ts:20`) is used only by its own test. Adopt it or delete it.
- Mixed async strategy: `api/chats.ts:40,69` catches locally (central handler never sees those), `api/mcp.ts` relies on Express 5 forwarding, `api/characters.ts` has 14 local try/catches. Pick one pattern.
- ~7 silent `catch { return null/[]/false }` sites without logging, e.g. `services/SecretService.ts:97`, `services/workbench/CharacterWorkbench.ts:1034`, `scripting/LuaFetch.ts:54` — some plausibly intentional, but `SecretService` paths can mask real breakage.

**Test gaps.**

- `bus/EventBus.ts` (229 LOC, WS fan-out core): zero tests.
- `dispatch/` handler builders (14 domains, 1,585 LOC): only `dispatcher.test.ts` (272 LOC).
- 8 of 18 repositories lack direct tests (`AttachmentRepository`, `AuthSessionRepository`, `CharacterAssetRepository`, `PersonaRepository`, `PromptListRepository`, `SecretRepository`, `ToolTemplateRepository`, `WorldInfoRepository`) — some indirect coverage via router tests.
- `services/FileStorage.ts` (all file writes) and `db/import-legacy.ts` (1,342 LOC) untested directly.

**Consistency (low).** Logger channel names mix `'db'`, `'api/characters'`, `'GenerationService'`, `'lua-backend'` styles. Only 4 routes use zod validation; the rest trust the compile-time `HandlerMap` (which does give an exhaustive `satisfies` check — a good pattern).

## Client (`client/src`)

Baseline: 108 source files / 18.0k LOC + 73 test files / 11.2k LOC (ratio 0.62). Zero TODOs, **zero `any` in production code**, 2 non-null assertions, 1 eslint-disable, no console.log/debugger leftovers, CSS hook lint clean (0 §16 violations), inline styles essentially absent.

**God-components.**

- `BackendConfigModal.tsx` (1,449 LOC): 44 `createSignal`s plus `parseLogitBias`/`buildAdvancedProviderParams` data-shaping and model-list fetching in one component.
- `SettingsModal.tsx` (1,196 LOC): 68 signals, hand-rolled schema form despite `SchemaForm.tsx` existing.
- `ChatView.tsx` (1,151 LOC): 45 reactive primitives; `getVisibleMessages` already extracted — continue in that direction.
- `stores/serverStore.ts` (732 LOC): one 26-field mega-store mixing entity caches, per-chat maps, settings, generation state, plus all bus handlers.

**Duplication.**

- Modal scaffold (~30 lines of focus-trap/backdrop/overlay boilerplate) copied into 19 components; no shared `<Modal>` shell.
- Autosave-debounce-with-saved-indicator re-implemented in 7 editors.
- Avatar upload+crop flow near-identical in `CharacterEditor.tsx:288-310` and `PersonaManager.tsx:188-235`.

**Dead code (grep-verified).** `components/Skeleton.tsx` (all 4 exports, plus CSS at `styles/global.css:318`), `lib/charx.ts` (whole 96-line module), `focusFirst` (`lib/focusUtils.ts:76`), `inputPopup` (`stores/popupStore.ts:80`), `isAuthenticated` (`lib/auth.ts:38`). Orphan CSS selectors: `plot-log`/`tool-widget-slot` (`ChatView.css`), `advanced-section` (`utilities.css`), `sampler-input-field` (`BackendConfigModal.css`). (Correction issued during resolution: `map-room` in `ChatView.css` is **not** orphaned — it is emitted at runtime by character-card Lua regex scripts, e.g. `data-v2/unpacked-cards/*/regex/floor-map.json`; it was kept.)

**Modal management.** No store-driven registry: `Sidebar.tsx` keeps ~11 `showX` signals; `App.tsx:81-141` works around this with `document.querySelectorAll('.modal-overlay')` + synthetic clicks and a `MutationObserver` for `inert`. Functional, commented, fragile.

**Test gaps.** Untested: `AuthModal` login form, `GreetingsEditor`, `DiceResult`/`SceneResult` tool-renderers, `lib/coerce.ts` (31 call sites — highest value), `lib/fileToBase64.ts`, `lib/focusUtils.ts`, `lib/secrets.ts`.

## E2E (`e2e/`)

Baseline: 101 smoke + 10 journey specs (~379 tests) + 21 vitest bus-level files (190 tests). Zero skipped/disabled tests, zero `networkidle`, deterministic mock LLM, race-aware page object — well above average overall.

**Duplication (the biggest e2e finding).**

- `uniqueName` redefined in 86 specs despite `helpers/quickReplies.ts:18` exporting it.
- Login + mock-backend wiring hand-rolled in 74 files (157 `resetBackendConfig` calls); `fixtures/journey.ts` provides exactly this but only 9 files use it. ~600 lines removable with a smoke-tier fixture.
- ~40-line inline-WebSocket-promise pattern duplicated ~6× across `helpers/backendConfig.ts` and `helpers/app.ts` — extract a `wsRpc(page, msg, awaitType)`.
- `const AUTH = { Authorization: 'Bearer e2e-test-secret' }` hardcoded in ≥7 specs instead of `TEST_SECRET` from `helpers/auth.ts:7`.
- "-2" file pairs (`chat-ops`, `text-completion`, `wi-decorators`) suggest split-instead-of-refactor.

**Selectors.** 1,928 `.locator()` calls (98% raw CSS, 1,478 class/id-based) vs 3 `getByRole` and 4 `data-testid`; 483 text-dependent selections; 97 `.nth()` positional picks (e.g. `helpers/app.ts:159,162` — reorder the form and these silently fill wrong fields). The workspace's own README prescribes `data-testid`; only the auth form follows it.

**Flakiness.**

- CI (`.github/workflows/ci.yml:87-90`) encodes a workaround for an unresolved intermittent generation-stall by interleaving smoke+journeys — fix or quarantine the flake rather than encoding the workaround.
- 15 `force: true` clicks, incl. `generation.spec.ts:29` on the very button `helpers/app.ts:224-228` documents as the flake source.
- 9 programmatic `evaluate(el => el.click())` bypasses; 26 serial-mode files; suite-wide shared DB safe only because `workers: 1` (`data-maid.spec.ts` calls a GLOBAL cleanup endpoint).
- 25 ad-hoc `test.setTimeout` overrides in smoke specs show the 30s default doesn't fit — set a smoke-level timeout.
- `retries: 0` locally means trace/video (`on-first-retry`) are never captured outside CI.

**Dead/documented-as-alive.** `fixtures/server.ts` (88 lines) and `fixtures/mockBackend.ts` (half-finished stub) are unused but described as architecture in `e2e/README.md:72-73`. Unused exports: `getAxeViolations`, `lastNarratorBubble`.

**Coverage gaps.** `/v1` proxy and `/api/mcp` — the two newest server surfaces (most recent feature commits) — have no end-to-end exercise. `/api/models` and `/files` are partial/indirect.

## Tooling, CI, repo hygiene

- **H1 — Prettier absent.** Not in any manifest or the lockfile; `format` scripts in server/client fail; no `format:check` in CI; CLAUDE.md:40 documents it as working. Add prettier as a root devDependency + CI check, or delete the scripts/config/docs.
- **H2 — Lockfile drift.** The `node-fetch → whatwg-url@^14` override never landed: lockfile and disk still carry `whatwg-url@5.0.0` (lockfile mtime ~Aug 14 predates the ~Aug 26 package.json change). Regenerate `package-lock.json`.
- **H3 — License contradiction** (AGPL vs GPL, three files).
- **M1 — Engines.** `>= 24` should be `>= 26` per the Dockerfile's own V8/wasmoon crash note.
- **M2 — `.npmrc ignore-scripts=true` nullifies `@tamari/types`' `prepare` hook**; CLAUDE.md:18/26 promise "builds on npm install". CI compensates with an explicit build; local fresh installs don't match the docs.
- **M3 — e2e unlinted/untypechecked**; it shows (`page: any` in `generation.spec.ts:10`, which the repo's own rules would reject). Also no standalone `tsc` step for server/client in the CI lint-and-test job (type errors surface only in the e2e job's build).
- **M4 — Dockerfile.** No `HEALTHCHECK`; runs as root (known/accepted per AUDIT.md); `.dockerignore` misses `/repos` so the JS-Slash-Runner reference tree is copied into the image.
- **M5 — CLAUDE.md:136 points at `docs/quality/`** which doesn't exist (it's `docs/audits/`); also still names branch `refactor-v2` while the repo is on `main`.

## Dependencies

`npm audit`: **0 vulnerabilities** in all workspaces. `.npmrc` hardening (`ignore-scripts=true`, `min-release-age=7`) is textbook. No unused deps found in spot-checks; no dep/devDep misplacement; duplicated cross-workspace deps are version-consistent except `@types/node` (`^25` server vs `^24` e2e — and both lag the Node 26 actually used) and a `@vitest/coverage-v8 ^4.1.7` vs `vitest ^4.1.5` minor skew.

`npm outdated` shows only routine drift; the notable majors are `typescript 7.0.2`, `jsdom 30`, `@testing-library/jest-dom 7`, `cropperjs 2`, `vectra 0.15`, `@types/node 26`. None urgent; given `min-release-age=7`, batch them into a routine bump. Aligning `@types/node` with the Node 26 runtime is the one with real signal.

## Low / informational

- `packages/types/tsconfig.json` has only `strict: true` — lacks the extra flags (`noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, etc.) the other workspaces set; the shared foundation is the least-checked package. No workspace enables `noImplicitOverride`.
- `.editorconfig` says `indent_size = 4` for js/json/css/html; the entire codebase uses 2 — editors honoring EditorConfig fight the code.
- `packages/types/test-schema.cjs` is a tracked, stale compiled artifact referenced by nothing.
- `e2e/ux-audit/shots/` not gitignored (empty today; first ux-audit run creates PNG noise). `playwright.ux-audit.config.ts` hardcodes port 8765 and a NixOS chromium path without the `existsSync` guard other configs have.
- `.dockerignore:60` excludes stale name `eslint-base.cjs` (actual file `eslint-base.config.js`).
- Server logger channel naming inconsistent; client `serverStore.ts:497,502` `console.debug` fires per-key from server pushes.
- Working tree: only `M .gitignore` (`/repos/` addition — correct, uncommitted). All generated artifacts (`data-v2/`, `*.db*`, `dist/`, `mcp-call.sh`, `e2e/.auth/`, `e2e/local/`) properly ignored.

## Verified good

- ESLint baseline enforces `no-explicit-any` + all five `no-unsafe-*` + a type-checked ruleset at `error` across all linted workspaces; suppressions are narrow, documented, and test-scoped.
- Dispatch layer has a compile-time exhaustive `satisfies HandlerMap` check — a missing message type is a build error.
- Uniform ESM `.js`-extension imports; consistent `buildXHandlers(deps)` pattern; pino logging everywhere except deliberate CLI/TTY paths.
- e2e: zero skipped tests, zero `networkidle`, deterministic mock LLM, stale-build guard in global-setup, honest CI-vs-ci.sh parity documentation.
- Docker build stages, port, and `DATA_DIR` all match reality; `.dockerignore` excludes `/old`, `.env`, `data-v2`.

## Suggested order of work

1. Repo-metadata fixes (small diffs, real correctness): regenerate lockfile for the whatwg-url override (#2); resolve AGPL/GPL (#3); `engines >= 26` (#15); CLAUDE.md docs paths/branch (M5).
2. Restore formatting enforcement: install prettier, add `format:check` to CI (#1); fix `.editorconfig` indent while there.
3. Close the e2e tooling gap: eslint + `tsc` for e2e, standalone typecheck in CI (#10).
4. Test the WebSocket core: `EventBus` + dispatch handlers (#5); e2e for `/v1` proxy and `/api/mcp` (#11).
5. Delete verified dead code (#14): `Skeleton.tsx`, `lib/charx.ts`, e2e `fixtures/server.ts`/`mockBackend.ts`, `test-schema.cjs`, orphan CSS; fix or trim `e2e/README.md:72-73`.
6. Structural refactors, in descending leverage: split `createStApi` (#4); shared SSE reader + `parseDataUrl` (#12); shared `<Modal>` shell + store-driven modal registry (#7); smoke-tier e2e fixture migration + `uniqueName` dedupe (#8); extract `BackendConfigModal`/`SettingsModal` logic (#6).
7. Unify route error handling on the central shape; adopt-or-delete `apiError` (#13).
8. Routine dependency bump batch; align `@types/node` with Node 26.

---

## Resolution (2026-08-29)

All findings were addressed. Final gate state: `prettier --check .` clean; ESLint clean in all four workspaces (client retains its deliberate `no-unnecessary-condition` warnings); `tsc --noEmit` clean in server, client, packages/types, and e2e; `lint:css` clean; `npm audit` 0 vulnerabilities; `npm ci --dry-run` in sync. Unit suites: server 173 files / 2,271 tests, client 81 files / 912 tests, e2e bus-level 21 files / 188 tests — all green, plus the full Playwright suite (smoke + journeys).

**Summary-table items:**

1. **Prettier** — installed as root devDependency (^3.9.6), `format:check` script + `.prettierignore` added, format step wired into CI (`ci.yml`) and `ci.sh`, and the repo normalized with a one-time `prettier --write` (~500 files of accumulated drift).
2. **Lockfile/whatwg-url** — lockfile regenerated from a clean resolution; `node-fetch`'s nested `whatwg-url` is now 14.2.0 on disk and in the lockfile; `npm ci --dry-run` confirms sync.
3. **License** — `package.json` now `GPL-3.0-only`, matching the `LICENSE` file and README.
4. **`createStApi` split** — `scripting/StApi.ts` 1,860 → 132 LOC delegating entry; 145 methods moved into 13 domain factories under `scripting/stapi/` (`chatActions`, `messageQueries`, `messageWrites`, `chatManagement`, `characters`, `personas`, `settings`, `variables`, `state`, `worldInfo`, `generation`, `ui`, `utilities`), with a runtime key-parity check proving the public surface is byte-identical.
5. **WS core tested** — new `bus/EventBus.test.ts` (25 tests: lifecycle, auth-gated broadcast, error mapping, sendTo/closeAll) plus `dispatch/` handler suites: `chatHandlers` (11), `messageHandlers` (5), `worldInfoHandlers` (8), `customBackendHandlers` (+6), `generationHandlers` rate-limiter (5).
6. **God-components** — `SettingsModal.tsx` 1,187 → 288 LOC, now schema-driven via an extended `SchemaForm` (new `variant="inline"`, range/radio controls, `visibleWhen`/`disabledWhen`); `BackendConfigModal.tsx` 1,449 → 1,334 LOC with pure logic extracted to `client/src/lib/backendConfig.ts` (+29 unit tests). `ChatView.tsx` left as-is (its `getVisibleMessages` extraction already exists; deeper surgery deferred).
7. **Modal shell + registry** — new `components/Modal.tsx` (focus save/restore, trapFocus, backdrop dismiss, topmost-aware Escape) adopted by all 19 modals; new `stores/modalStore.ts` replaced Sidebar's 11 `showX` signals; App.tsx's `querySelectorAll('.modal-overlay')` Escape hack and MutationObserver inert-sync deleted in favor of registry-driven inert.
8. **e2e duplication** — `uniqueName` canonicalized in `helpers/names.ts` (85 specs converted); `authHeaders()` from `helpers/auth.ts` replaced 40+ hardcoded bearer literals (10 specs); `helpers/ws.ts` `wsRpc`/`wsPoll` collapsed the 6 inline-WebSocket patterns (~200 lines); new `fixtures/smoke.ts` (`smokeTest`, sharing its wiring core with `journeyTest`) adopted by 69 specs — hand-rolled login/mock-backend/reset wiring deleted across the suite, and the three `-2` split files merged back.
9. **Selectors** — `data-testid` added across the schema-driven settings form (`setting-<key>`), ToolsModal, Sidebar modal buttons, BackendConfigModal, InstructTemplates/RegexRules modals, CharacterEditor textareas; the two worst specs (`settings-advanced`, `tools-modal`) and `helpers/app.ts`'s positional `.nth()` picks migrated to testids. The remaining ~1,800 raw locators are stable id/class hooks; a full migration is not planned.
10. **e2e tooling** — new `e2e/eslint.config.mjs` (base strictness + documented test overrides), `lint` script, 762 initial lint errors fixed or justifiably overridden; e2e lint + typecheck wired into CI and `ci.sh`; all pre-existing e2e tsc errors fixed — e2e is now as gated as the other workspaces.
11. **e2e proxy/MCP coverage** — new `proxy-api.spec.ts` (8 tests: gate-off 404, auth matrix, models listing, mock-LLM round-trip, finish-reason and error mapping, key-rotation flush) and `mcp.spec.ts` (9 tests: gate, auth, method whitelist, 11-tool read/test surface, write-verb rejection, `test_regex`/`test_backend`/session round-trip), both executed green.
12. **SSE/parseDataUrl dedupe** — new `backends/sseReader.ts` (`readSseEvents` async generator + 10 unit tests) adopted by OpenAI/Claude/Gemini **and** KoboldCpp adapters (net −214 LOC); `parseDataUrl` moved to `backends/resolveLocalAttachment.ts`.
13. **Error handling** — routes now throw `ApiError` (an `Error` subclass with `details`/`cause`) and let Express 5 forward to the central handler, which serializes the flat `{ error: string }` wire shape clients actually consume; 62 hand-rolled sites and ~20 catch-and-generic-500 blocks converted; a prod-side `err.message` leak in `characters.ts` 5xx responses fixed in passing.
14. **Dead code** — all deleted: `Skeleton.tsx`, `lib/charx.ts`, `focusFirst`, `inputPopup`, `isAuthenticated`, orphan CSS (except `map-room`, see correction above), e2e `fixtures/server.ts`/`mockBackend.ts` (+ README corrected), unused e2e helper exports, the no-op hover hack (12 call sites), `packages/types/test-schema.cjs`.
15. **Engines** — root `package.json` now `node: ">= 26"`, matching Dockerfile and CI.

**Medium/low items:** TTS adapters share `tts/BaseTtsAdapter.ts` (−146 LOC, 11 adapters); avatar flows share `services/avatarPipeline.ts`; silent catches got debug logs where not intentional probes (`loadDefaultConfigs`, `ToolsetWorkbench`, `CharacterWorkbench`; `LuaFetch`/`cardFolderParser`/`SecretService` documented as probes); logger channels normalized to module-path style (46 call sites); 8 untested repositories + `FileStorage` + `AssistantMessageTarget` now have direct suites (+130 tests); `packages/types` tsconfig gained the full strictness flag set; `.editorconfig` indent fixed to 2; `.dockerignore` excludes `/repos` and names `eslint-base.config.js` correctly; Dockerfile has a `HEALTHCHECK`; `.gitignore` covers `e2e/ux-audit/shots/`; CLAUDE.md/docs README drift corrected; e2e smoke tier got a 60s project timeout (redundant per-test overrides removed); `playwright.ux-audit.config.ts` honors `E2E_PORT` and is cross-platform; dependencies refreshed across all workspaces including majors `typescript@7`, `jsdom@30`, `@types/node@26`, `@testing-library/jest-dom@7`, `cropperjs@2` (CropModal migrated to the v2 web-components API).

**Known follow-ups (deliberately not done):** the intermittent generation-stall flake worked around in CI (`ci.yml:87-90`) still needs a root-cause fix; `backend-config-modal.spec.ts` intentionally keeps login-only wiring (smokeTest does not fit); `ChatView.tsx` deeper decomposition; `PromptListRepository.update` throws plain `Error` instead of `NotFoundError` (pinned by tests, inconsistent with sibling repos); `autoFixMarkdown`'s naive fence fixer mangles unclosed fences (pre-existing, pinned by test); `ToolsetWorkbench.ts:106` has a second silent `getDefinition()` swallow worth a log line.
