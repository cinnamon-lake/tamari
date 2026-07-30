-- Toolsets gain an explicit sub-agent visibility flag: only toolsets the user
-- marks are advertised to sub-agents (run_agent). Default off.
ALTER TABLE toolsets ADD COLUMN agent_visible INTEGER NOT NULL DEFAULT 0;
