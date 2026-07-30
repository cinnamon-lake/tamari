-- Generation records gain a free-form debug-trace payload (layer, depth,
-- rounds, tool calls, structured error chain, optional prompt snapshot) —
-- docs/design/debug-traces.md.
ALTER TABLE generations ADD COLUMN meta TEXT;
