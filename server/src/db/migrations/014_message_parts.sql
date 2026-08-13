-- 014_message_parts.sql
-- Split message content parts out of the messages.extra JSON blob into their
-- own table: one row per part, ordered by idx. `type` is denormalized out of
-- the part JSON so reads can filter (e.g. text-only) without parsing every row.
-- The data backfill lives in 015_message_parts_data.ts (code migration — needs
-- JSON handling).

CREATE TABLE IF NOT EXISTS message_parts (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (message_id, idx)
);
