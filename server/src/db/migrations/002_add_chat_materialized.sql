-- Track whether a chat has ever been materialized.
-- This distinguishes a brand-new chat (virtual greeting) from a chat whose
-- messages have all been deleted.
ALTER TABLE chats ADD COLUMN materialized INTEGER DEFAULT 0;

-- Existing chats with an active branch were already materialized.
-- Chats that were materialized and then fully deleted cannot be distinguished
-- from never-materialized chats, so they conservatively stay unmaterialized.
UPDATE chats SET materialized = (active_child_id IS NOT NULL OR head_message_id IS NOT NULL);
