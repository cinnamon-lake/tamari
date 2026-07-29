-- 003_tool_template_sandbox.sql
-- Per-template Lua sandbox flags (allowIo/allowOs/allowDebug/allowRequire) as a
-- JSON blob, e.g. {"allowOs":true}. Empty object = fully sandboxed (default).
ALTER TABLE tool_templates ADD COLUMN sandbox TEXT NOT NULL DEFAULT '{}';
