/** Reference doc for the `request_scripts` topic, served by the Docs tool. */
export const REQUEST_SCRIPTS_DOC = `# Request Scripts (Lua request transformer)

Every backend adapter runs an optional Lua script against its outgoing HTTP request. Configured per backend config via \`providerParams.requestScript\`. Use it for custom auth headers, provider-specific body features, URL rewriting/proxies, and dynamic parameters.

## The \`request\` table

The script receives a mutable global \`request\`:

| Field | Type | Description |
|---|---|---|
| \`request.url\` | string | Full request URL |
| \`request.method\` | string | Usually \`POST\` |
| \`request.headers\` | table | Request headers |
| \`request.body\` | table | The JSON body as a Lua table — mutate directly; it is re-serialized automatically |

\`\`\`lua
-- custom header
request.headers["X-Custom-Auth"] = "my-secret-token"

-- Azure OpenAI: api-version in URL + different body shape
request.url = request.url .. "?api-version=2024-06-01"
request.body["data_sources"] = { { type = "azure_search", parameters = { endpoint = "...", index_name = "..." } } }
\`\`\`

## Limits and safety

- 5-second execution timeout; a runaway script fails the generation with a request-script error (it never hangs the server).
- Sandboxed: no \`io\`/\`os\`/\`debug\`/\`require\`/\`load\`.
- **SSRF protection:** only http(s); private/loopback/link-local ranges are blocked, and DNS results are re-checked (rebinding defense). Exception: if the configured backend endpoint is itself loopback (a local llama.cpp etc.), the script may keep targeting loopback — a script can never redirect a cloud backend's request to 127.x.
- Scripts see the request *after* the adapter built it — including headers with credentials. The request log scrubs credentials, but don't exfiltrate them in shared cards.

## Testing

Use the Workbench: \`run {"verb":"test_backend","args":{"mode":"dry","patch":{"providerParams":{"requestScript":"..."}}}}\` shows the before/after URL, headers, and body (scrubbed) without sending — the \`patch\` applies in memory only. Then \`mode: "live"\` for a minimal real request, then \`write /backends/<id>.json\` to persist.
`;
