-- 008_script_blobs.sql
-- Script blobs: a global append-only key-value store for backend Lua scripts
-- (the `store` global: put(name, text) -> id, get(id) -> text). Blobs are
-- immutable. A "mutation" is a new row with a fresh seq plus the script moving
-- its branch-aware pointer in `state`, so swipes and forks stay correct.
-- Lookup is by exact id only. The name lives inside the id purely as a
-- debug-readable prefix, never queried.
CREATE TABLE IF NOT EXISTS script_blobs (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
