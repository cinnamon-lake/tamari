# tamari

LLM Frontend for Power Users

## Documentation

- [`docs/README.md`](docs/README.md) — index of all project documentation
- [`docs/user/getting-started.md`](docs/user/getting-started.md) — **user guide: start here**
- [`docs/user/`](docs/user/) — full user documentation (features, scripting, tools)
- [`docs/design/AGENTS.md`](docs/design/AGENTS.md) — tamari architecture rules (authoritative)
- [`docs/roadmap/`](docs/roadmap/) — roadmap, breaking changes, pending features

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8000` | HTTP server port |
| `HOST` | `::` | HTTP server bind address |
| `DATA_DIR` | `./data-v2` | Path to SQLite database and file storage |
| `LOG_LEVEL` | `info` | Server log level (`debug`, `info`, `warn`, `error`) |
| `TAMARI_SECRET` | *(random)* | Auth secret for bearer tokens |
| `DISABLE_CSRF` | `false` | When `true`, allows WebSocket connections from any `localhost`/`127.0.0.1` port (dev mode) |
| `WS_ORIGINS` | *(empty)* | Comma-separated list of additional allowed WebSocket origins (e.g. `http://myhost:3000,https://myhost`) |
| `HTTP_JSON_LIMIT` | `5mb` | Max body size for JSON HTTP requests |
| `WS_MAX_PAYLOAD_BYTES` | `1048576` | Max WebSocket message payload in bytes (1 MB) |
| `AVATAR_MAX_FILE_SIZE_BYTES` | `52428800` | Max persona avatar upload file size in bytes (50 MB) |
| `WS_AUTH_REJECTION_MS` | `500` | Delay before closing an unauthenticated WebSocket connection |
| `SHUTDOWN_TIMEOUT_MS` | `5000` | Graceful shutdown timeout before force-exit |
| `MAX_TOOL_ROUNDS` | `100` | Tool-call rounds allowed per generation turn |
| `MAX_AGENT_DEPTH` | `4` | Maximum nesting depth for sub-agents (`run_agent`) |

## License

GPL-3.0
