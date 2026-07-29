-- 004_custom_backends.sql
-- Custom backends: named Lua-driven backend adapters (scriptable-layers.md §2).
-- A backend config selects one via backend_provider = 'custom' plus
-- provider_params_json.customBackendId — the script's generate(prompt, ctx) may
-- rebuild the prompt and delegate to other registered backends.
CREATE TABLE IF NOT EXISTS custom_backends (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  lua_source TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
