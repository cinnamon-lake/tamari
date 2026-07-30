-- Generation records gain a kind (which target produced the run) and a parent
-- reference (sub-agent runs point at the spawning generation), giving a
-- traceable tree per docs/design/generation-runner.md.
ALTER TABLE generations ADD COLUMN parent_id TEXT;
ALTER TABLE generations ADD COLUMN kind TEXT NOT NULL DEFAULT 'send';
