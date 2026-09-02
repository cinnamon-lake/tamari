-- 019_transformer_chains.sql
-- Request transformers: named, reusable chains of message-array transforms
-- applied to the rendered prompt before the backend adapter sees it. A chain
-- mixes built-in transform steps with user Lua transformer scripts
-- (transformer_scripts). A backend config selects one chain via
-- backend_configs.transformer_chain_id.
CREATE TABLE IF NOT EXISTS transformer_scripts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  lua_source TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transformer_chains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  steps_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE backend_configs ADD COLUMN transformer_chain_id TEXT;
