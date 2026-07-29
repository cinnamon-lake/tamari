# Request Scripts

A request script is a small Lua script attached to a single backend config that rewrites the outgoing HTTP request every time tamari talks to that backend. Use it to add custom auth headers, reshape the request body for provider-specific features, rewrite the URL for a proxy, or tweak parameters on the fly — without forking an adapter.

Every backend adapter supports it: OpenAI, Claude, Gemini, OpenRouter, Moonshot, KoboldCpp, llama.cpp, TabbyAPI, and text-completion mode all run the same transformer before sending.

## Where to Put It

Open **Backend Config** from the sidebar (the sliders icon), pick the config you want to modify, and paste your Lua into the **Request Transformer (Lua)** textarea.

The script is stored per backend config in `providerParams.requestScript`, so different configs on the same provider can have different scripts — and a config with no script behaves exactly as before.

## The `request` Table

Your script receives a mutable global `request` table. Whatever it contains when the script finishes is what gets sent:

| Field | Type | Description |
|-------|------|-------------|
| `request.url` | string | The full request URL |
| `request.method` | string | HTTP method (usually `POST`) |
| `request.headers` | table | Request headers, keyed by header name |
| `request.body` | table | The JSON request body as a Lua table |

> **Note:** `request.body` is a Lua table, not a string. Mutate it directly (`request.body.temperature = 0.7`) — tamari serializes it back to JSON automatically after the script runs.

## When It Runs

The script runs **after** the adapter has built the complete request and **before** it is sent. That means:

- The URL already points at the configured endpoint.
- Headers already include credentials (`Authorization`, `x-api-key`, …), so your script can read, replace, or remove them.
- Body already contains the fully assembled prompt and parameters.

> **Warning:** Because the script can see credentials, treat request scripts like secrets. Never ship a script that copies headers to an outside URL, and review scripts before importing backend configs someone else made. tamari's own request log and the workbench dry-run scrub credentials, but your script itself runs with full access.

If the script throws an error or times out, the generation fails with a `Request script error: …` message instead of sending anything.

## Limits & Safety

- **5-second timeout.** A runaway script (e.g. an accidental `while true do end`) fails the generation with a request-script error — it can never hang the server.
- **Sandboxed.** There is no `io`, `os`, `debug`, `package`, `require`, `load`, `loadstring`, `loadfile`, or `dofile`. You get plain Lua plus the `request` table.
- **SSRF protection.** If your script rewrites `request.url`, the final URL is validated before sending: only `http:`/`https:` is allowed, and private, loopback, link-local, and unspecified address ranges are blocked. Hostnames are resolved and every returned IP is re-checked, so DNS-rebinding tricks don't work either.
- **Loopback exception.** If the backend's *configured* endpoint is itself loopback (`localhost`, `127.x`, `::1` — e.g. a local llama.cpp), the script may keep targeting loopback. A script can never redirect a *cloud* backend's request to `127.x`.

## Examples

The two most common cases — a custom auth header and a full Azure OpenAI body transform — are covered in [Lua Scripting](./lua-scripting.md#backend-request-scripts). Here are two more:

### Rewrite the URL for a Proxy

Run a logging proxy on your machine, point the backend config's endpoint at it (`http://localhost:8787`), and use the script to route individual requests between local services:

```lua
-- send long-context models to a different local server
if request.body.model == "my-long-context-model" then
  request.url = string.gsub(request.url, "localhost:8787", "localhost:8080")
end
```

> **Note:** Redirecting to `localhost` only works here because the config's own endpoint is loopback (the exception described above). A script attached to a cloud backend can never redirect its request to `127.x` — the final URL check blocks it.

### Conditional Model Tweak

Change the model or a sampling parameter based on the current one:

```lua
if request.body.model == "gpt-4o" then
  request.body.temperature = 0.4
  request.body.top_p = 0.9
end
```

## Testing with the Workbench

Don't iterate against live generations — use the backend workbench's `test_backend` verb (see [Workbench](./workbench.md)):

1. **Dry run first:** `run {"verb":"test_backend","args":{"mode":"dry","patch":{"providerParams":{"requestScript":"-- your script"}}}}` builds the exact request the adapter would send and shows the before/after URL, headers, and body — credentials scrubbed, nothing actually sent. The `patch` applies in memory only, so a broken script never dirties your saved config.
2. **Live test:** the same verb with `mode: "live"` fires a minimal real request and returns the model's reply or the upstream error.
3. **Persist:** once the test is green, save the script into the config (e.g. `write /backends/<id>.json`).

See [Lua Scripting](./lua-scripting.md) for more request-script examples and [Tools](./tools.md) for how the built-in tool templates expose these verbs to the AI.

## Tips & Gotchas

- **Scripts run on every generation request** for that config. Keep them fast and side-effect-free.
- **Set headers with exact casing you mean.** `request.headers["X-Custom-Auth"]` and `request.headers["x-custom-auth"]` are different keys in the table; the adapter's own headers use whatever casing the provider client set.
- **Check your work with a dry run before deleting anything.** Removing a credential header is a legitimate move (e.g. re-deriving auth), but a typo there fails every generation on that config.
- **A syntax error fails loudly, not silently.** You'll get `Request script error: …` on the next generation — no request leaves the server.
- **Scripts live in the backend config, not the character card.** Every character using that config gets the same transform, and the script does not travel with a card export.
