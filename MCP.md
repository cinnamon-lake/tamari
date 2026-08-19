# MCP server notes

tamari exposes a **read/test-only MCP tool surface** for external LLM agents
(kimi code / claude code style) developing unpacked cards on disk. Source:
`server/src/api/mcp.ts`. Agents WRITE card files with their own filesystem
tools; no MCP tool writes card or config data.

## Connecting

- **Default host is ::1, default port is 8000** — the server binds `::` (all
  interfaces) by default, so it is reachable on IPv6/IPv4 loopback; override
  with the `HOST` / `PORT` env vars.
- Endpoint: `POST /api/mcp` (MCP Streamable HTTP, **stateless**).
- Auth: `Authorization: Bearer <token>` — the same bearer token as the rest of
  the API (derived from `TAMARI_SECRET`). No token → 401. (Token not recorded
  here; ask the user.)
- Feature gate: the `mcp.enabled` setting (Settings → Developer → MCP server).
  When off, every request 404s with a message telling the agent to ask the
  user to enable it. Applies immediately — no restart.

### Hand-rolled client transport notes

- Every POST is self-contained: no `initialize` handshake and no session id —
  `tools/list` / `tools/call` can be sent directly.
- Send `Accept: application/json, text/event-stream` (the transport requires
  both).
- Responses are **SSE-framed** (`Content-Type: text/event-stream`, one
  `event: message` + `data: <json-rpc reply>` per message) even for single
  requests — parse the `data:` lines, don't expect a bare JSON body.
- `GET`/`DELETE` on the endpoint return 405 (stateless, POST only).
- Minimal CLI client: `node tools/tamari-mcp.mjs list` /
  `call <tool> '<json-args>'`.

## Tools (11, fixed whitelist — no mutation verbs)

| Tool | What it does |
|---|---|
| `test_card` | Scripted multi-turn card test: `{ characterId? \| folderPath?, turns: string[] (1–20), keepChat?, backendConfigId?, timeoutMs? }`. Real generation path in an in-memory test session. Session kept by default (returns `sessionId`); `keepChat: false` ends it immediately. |
| `test_session_start` | Open an interactive test session: `{ characterId? \| folderPath?, personaId?, greetingIndex?, backendConfigId? }` → `{ sessionId, greeting }`. |
| `test_session_message` | One user message + one generation: `{ sessionId, content, timeoutMs? }` → `{ reply, generationId, finishReason, scriptState?, debug? }`. |
| `test_session_state` | Inspect a session: chain, generations (no prompts), latest Lua `scriptState`. `generationId` opts into the full record incl. captured round prompts. |
| `test_session_end` | End a session early (aborts in-flight generation, drops state). |
| `test_backend_logic` | Dry-run a card's `backend_logic.lua` against a recording delegate — no real backend calls. |
| `test_regex` | Preview merged regex rules (global + character-scoped) against sample text. |
| `test_luatool` | Run a Lua tool (stored template id or ad-hoc `code`). |
| `test_custom_backend` | Dry-run a custom-backend script against a recording delegate. |
| `test_backend` | Dry/live-test a backend config (`configId` defaults to active; `patch` is in-memory only). Dry-run redacts sensitive request fields (`[REDACTED]`). |
| `read_generation` | Read a generation debug trace: `/generations/<id>/{meta.json, error.txt, prompt.json, prompts.json}`. Prompt files only exist when prompt capture was on. |

Sessions expire after **30 min idle**. Test generations run against the
ACTIVE backend config by default (real LLM, real cost) — pass
`backendConfigId` (e.g. a mock-provider config) for deterministic/free runs.

## Result & error conventions

- Tool results are MCP text content. JSON results are stringified into the
  text field.
- Failures are flagged `isError: true` when the text starts with `Error: ` —
  a string-prefix heuristic; non-conforming messages would look like
  successes.

## Safety properties (verified live 2026-08-17)

- No tool mutates card/config data; write verbs simply don't exist (unknown
  tool).
- "Test" still means real side effects where intended: real generations (LLM
  cost), `test_backend` mode `live` sends real requests, `test_luatool` may
  act on real chat/attachments per the template's sandbox flags — but test
  sessions themselves are in-memory: no real chat rows, no DB writes, no UI
  broadcasts.
- Path traversal is blocked: workbench paths reject `.`/`..` segments, and
  `read_generation` resolves records via DB `getById` (not filesystem paths)
  with a fixed filename enum.
- No `Authorization` header → 401; disabled server → 404.

Test coverage: `server/src/api/mcp.test.ts` (gate, auth, exact whitelist, arg
validation, isError flagging, no-mutation, 405s). User-facing docs:
`docs/user/unpacked-cards.md` § "Testing cards with an LLM agent".
