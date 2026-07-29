# Getting Started

tamari is a single-user LLM frontend for character chat — a ground-up rewrite of SillyTavern. It runs as a Node.js server that owns all of your state (characters, chats, settings, and files live in a SQLite database and storage directory on the server) plus a thin SolidJS client in your browser that stays in sync over a WebSocket. You run the server, open the page, log in with a shared secret, and chat.

## Install & Run

tamari requires **Node.js 20 or newer** (the Docker image uses Node 22).

### From source

```sh
npm install
npm start
```

`npm start` builds the client and server, then starts the server. When it's up, the log shows:

```
tamari server listening on http://[::]:8000
```

Open `http://localhost:8000` in your browser.

Alternatively, `./start.sh` does the whole thing in one shot — it checks for Node.js, runs `npm install`, builds, and starts the server (any extra arguments are passed through to the server).

> **Note:** The dev servers from `npm run dev` (Vite + tsx watch) are for development. For normal use, `npm start` is all you need.

### Docker

The repo ships a root `Dockerfile` that builds the full app:

```sh
docker build -t tamari .
docker run -p 8000:8000 -v tamari-data:/app/data-v2 tamari
```

- The image sets `DATA_DIR=/app/data-v2` and `PORT=8000` — mount a volume at `/app/data-v2` or your database and uploads disappear with the container.
- Pass configuration with `-e`, e.g. `-e TAMARI_SECRET=change-me` (see [Configuration](#configuration)).

> **Warning:** The `.dockerignore` excludes `data-v2/` (and docs, tests, and `.env` files) from the build context. Your data only ever lives in the volume you mount — never in the image.

## First Run: The Auth Secret

tamari is single-user but still requires a login: every API call and WebSocket connection must present a shared secret as a bearer token. The browser asks for it on the **Authentication Required** screen — paste the token into the **Secret token** field and click **Connect**.

Where the token comes from:

- **Set `TAMARI_SECRET` yourself (recommended).** Pick any long random string and start the server with it. That's your login token, and it survives restarts:

  ```sh
  TAMARI_SECRET=$(openssl rand -hex 32) npm start
  ```

- **If `TAMARI_SECRET` is unset**, the server generates a random secret on every boot and logs a warning — but only a **masked** form of it:

  ```
  No TAMARI_SECRET set. Generated random secret: ab12...yz90
  Set TAMARI_SECRET environment variable to persist the secret across restarts.
  ```

  The full token is never printed, so there is nothing to copy into the login screen — and the secret changes on every restart, logging out any stored session. Treat this as a nudge, not a login method: set `TAMARI_SECRET` before your first real run.

> **Note:** `SILLYTAVERN_SECRET` is still accepted as a pre-rebrand fallback when `TAMARI_SECRET` is unset.

The token is checked against `TAMARI_SECRET` with a timing-safe comparison, and it also keys the AES-256-GCM vault that encrypts stored API keys — so rotate it thoughtfully (see [Backends](./backends.md) for the secrets vault). Clients can present it as an `Authorization: Bearer <token>` header or a `?token=<token>` query parameter; the browser client handles this for you once you've connected.

## Configuration

Everything is configured with environment variables. These are the defaults from the server (`server/src/config.ts`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8000` | HTTP server port |
| `HOST` | `::` | HTTP server bind address (all interfaces, IPv4 + IPv6) |
| `DATA_DIR` | `./data-v2` | Path to the SQLite database (`tamari.db`) and file storage, relative to the working directory |
| `LOG_LEVEL` | `info` | Server log level: `debug`, `info`, `warn`, `error` |
| `TAMARI_SECRET` | *(random per boot)* | Shared auth secret for bearer tokens; also keys the secrets vault |
| `DISABLE_CSRF` | `false` | When `true`, allows WebSocket connections from any `localhost`/`127.0.0.1` port (dev mode) |
| `WS_ORIGINS` | *(empty)* | Comma-separated list of additional allowed WebSocket origins, e.g. `http://myhost:3000,https://myhost` |
| `HTTP_JSON_LIMIT` | `5mb` | Max body size for JSON HTTP requests |
| `WS_MAX_PAYLOAD_BYTES` | `1048576` | Max WebSocket message payload in bytes (1 MB) |
| `AVATAR_MAX_FILE_SIZE_BYTES` | `52428800` | Max persona avatar upload file size in bytes (50 MB) |
| `WS_AUTH_REJECTION_MS` | `500` | Delay before closing an unauthenticated WebSocket connection |
| `SHUTDOWN_TIMEOUT_MS` | `5000` | Graceful shutdown timeout before force-exit |
| `MAX_TOOL_ROUNDS` | `100` | Tool-call rounds allowed per generation before the loop stops (see [Tools](./tools.md)) |

WebSocket origin checks always allow `localhost`/`127.0.0.1` (any scheme, no port) plus whatever you add in `WS_ORIGINS`; `DISABLE_CSRF=true` widens that to any localhost port, which is meant for development only.

> **Note:** If you're migrating from a pre-rename install, the server automatically renames a legacy `sillytavern.db` (plus its WAL/SHM sidecars) to `tamari.db` in `DATA_DIR` on first boot.

## Your First Chat

Three steps: point tamari at a model, create a character, and start a chat.

### 1. Configure a backend

A fresh install seeds one **Default** backend config and makes it active. Open the sidebar and click **Backend Config** (the footer of the sidebar) to edit it in the **Backend Config** modal:

1. Under **Active Backend Config**, the **Default** config is selected. To keep it and add another, click **Duplicate Config** — that's how new configs are created (the last remaining config can't be deleted).
2. Pick a **Generation Mode** — **Chat Completion** or **Text Completion** — then a **Provider**:
   - Chat: OpenAI, OpenRouter, Claude, Gemini, Custom (Lua)
   - Text: OpenAI, llama.cpp, TabbyAPI, KoboldCPP
3. Set the **API URL** and **API Key** for your provider.
4. Pick a **Model** — the dropdown can fetch the model list from the provider (refresh icon), or type a name manually.

Everything saves automatically. The full field tour — sampling parameters, instruct templates, the request transformer — is in [Backends](./backends.md); a `Custom (Lua)` provider is covered in [Custom Backends](./custom-backends.md).

### 2. Create a character

In the sidebar's **Characters** section, click the **+** button (**Create character**) to open a blank card in the character editor, or use the import button (**Import card**) to import an existing card — PNG character cards, `.charx`, and `.json` files are accepted.

At minimum, give the character a **Name** and a **First Message** — that's the opening message of every new chat. Description, personality, scenario, and the rest are covered in [Characters](./characters.md).

Optionally, open **Personas** in the sidebar footer and click **New Persona** to set who *you* are — the persona name fills the `{{user}}` macro (see [Personas](./personas.md) and [Macro System](./macros.md)).

### 3. Start chatting

Click your character in the sidebar to see its chats, then click **New chat**. The character's first message appears; type your reply in the message box and send. Every generation goes to the provider configured in your active backend config.

If nothing comes back, the usual suspects are a wrong **API URL**, a missing **API Key**, or a model name the provider doesn't recognize — all three are on the config you edited in step 1.

## Where to Go Next

- [Characters](./characters.md) — card fields, greetings, lorebooks, importing
- [Personas](./personas.md) — your identity in chat
- [Backends](./backends.md) — providers, sampling, model lists
- [World Info](./world-info.md) — keyword-triggered lore injection
- [Macro System](./macros.md) — `{{user}}`, `{{char}}`, variables, and conditionals
- [Regexes](./regexes.md) — find-and-replace scripts over prompts and display
- [Slash Commands](./slash-commands.md) — the command palette for power users
- [Tools](./tools.md) — tool calling, toolsets, and Lua tool templates
- [The Workbench](./workbench.md) — let the AI edit your data with filesystem-style tools
- [Custom Backends](./custom-backends.md) and [Request Scripts](./request-scripts.md) — Lua-driven request logic
- [Assets](./assets.md) — attachments, character assets, avatars
- [TTS](./tts.md) — text-to-speech
- [UI Customization](./ui-customization.md) — themes and layout
- [Lua Scripting](./lua-scripting.md) — the Lua sandbox and `st` API

## Tips & Gotchas

- **Set `TAMARI_SECRET` before anything else.** Without it the secret rotates every restart, stored sessions break, and only a masked value is ever logged — you can't recover the full token from the logs.
- **Everything lives in `DATA_DIR`.** Back it up (or your Docker volume) and you've backed up all of tamari: database, avatars, attachments, the lot.
- **You don't restart to reconfigure.** Backends, characters, personas, prompts, and tools are all edited live in the UI — env vars are the only things that need a restart.
- **Bind deliberately.** The default `HOST` is `::` (all interfaces). If the machine is reachable by others, anyone with the secret can log in — keep `TAMARI_SECRET` strong, or bind to localhost and reverse-proxy.
- **Chat Completion vs Text Completion matters.** Local servers like llama.cpp, TabbyAPI, and KoboldCPP are **Text Completion** providers and need an instruct template; hosted chat APIs are **Chat Completion**. Picking the wrong mode is the most common "it doesn't work" cause — see [Backends](./backends.md).
