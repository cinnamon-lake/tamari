-- 001_init.sql
-- Base schema for tamari (squashed from all migrations).
-- Messages are stored as a tree (parent_id) to natively support swipes / branches.

-- World Info / Lorebooks
CREATE TABLE IF NOT EXISTS world_info (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    entries TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
);

-- Characters: canonical data. Avatars are filesystem-backed.
CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    personality TEXT,
    scenario TEXT,
    first_mes TEXT,
    mes_example TEXT,
    creator TEXT,
    character_version TEXT,
    tags TEXT DEFAULT '[]',
    avatar_path TEXT,
    avatar_thumbnail_path TEXT,
    creator_notes TEXT DEFAULT '',
    system_prompt TEXT DEFAULT '',
    post_history_instructions TEXT DEFAULT '',
    alternate_greetings TEXT DEFAULT '[]',
    group_only_greetings TEXT DEFAULT '[]',
    nickname TEXT DEFAULT '',
    creator_notes_multilingual TEXT DEFAULT '{}',
    source TEXT DEFAULT '[]',
    extensions TEXT DEFAULT '{}',
    create_date TEXT DEFAULT '',
    world_info_id TEXT REFERENCES world_info(id) ON DELETE SET NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_characters_name ON characters(name);
CREATE INDEX IF NOT EXISTS idx_characters_name_nocase ON characters(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_characters_world_info_id ON characters(world_info_id);
CREATE INDEX IF NOT EXISTS idx_characters_updated_at_id ON characters(updated_at DESC, id DESC);

-- Personas: multiple user identities.
CREATE TABLE IF NOT EXISTS personas (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    avatar_path TEXT,
    avatar_thumbnail_path TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_personas_name ON personas(name);
CREATE INDEX IF NOT EXISTS idx_personas_updated_at_id ON personas(updated_at DESC, id DESC);

-- Chats: conversation containers.
-- active_child_id = the active leaf message (what the user sees last).
-- head_message_id = the parent of the active leaf (siblings are swipes).
CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
    persona_id TEXT REFERENCES personas(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    head_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    active_child_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    metadata TEXT DEFAULT '{}',
    forked_from_chat_id TEXT,
    forked_at_message_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chats_character ON chats(character_id);
CREATE INDEX IF NOT EXISTS idx_chats_persona ON chats(persona_id);
CREATE INDEX IF NOT EXISTS idx_chats_forked_from ON chats(forked_from_chat_id);
CREATE INDEX IF NOT EXISTS idx_chats_forked_at ON chats(forked_at_message_id);
CREATE INDEX IF NOT EXISTS idx_chats_updated_at_id ON chats(updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_chats_character_updated ON chats(character_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_chats_persona_updated ON chats(persona_id, updated_at DESC, id DESC);

-- Messages: one row per message. Tree-structured via parent_id.
-- Sibling messages with the same parent_id represent swipes / branches.
-- The message pool is global (no chat_id). Reachability is via parent_id chains from chats.active_child_id.
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES messages(id),
    role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    extra TEXT DEFAULT '{}',
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
CREATE INDEX IF NOT EXISTS idx_messages_parent_created ON messages(parent_id, created_at);

-- Settings: singleton JSON blob. Only row id = 0 is valid.
CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 0),
    blob TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER DEFAULT (unixepoch())
);

-- Secrets: encrypted at rest with user's passphrase or OS keychain.
CREATE TABLE IF NOT EXISTS secrets (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    label TEXT,
    updated_at INTEGER DEFAULT (unixepoch())
);

-- Generation state: ephemeral, for event bus replay and resuming across tabs.
CREATE TABLE IF NOT EXISTS generations (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'streaming', 'complete', 'error', 'aborted')),
    backend TEXT NOT NULL,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    error_message TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_generations_chat_id ON generations(chat_id);
CREATE INDEX IF NOT EXISTS idx_generations_chat_created ON generations(chat_id, created_at DESC, id DESC);

-- Extension data: each extension gets its own row(s).
CREATE TABLE IF NOT EXISTS extension_data (
    extension_id TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('global', 'character', 'chat', 'message')),
    entity_id TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (extension_id, entity_type, entity_id)
);

-- Attachments (images, files embedded in messages). File-system backed, blob is optional.
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    mime_type TEXT NOT NULL,
    blob BLOB,
    file_path TEXT,
    meta TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

-- Group chats: member tracking and activation settings.
CREATE TABLE IF NOT EXISTS chat_members (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    talkativeness REAL DEFAULT 1.0,
    depth_prompt TEXT DEFAULT '',
    depth_prompt_depth INTEGER DEFAULT 4,
    enabled INTEGER DEFAULT 1,
    PRIMARY KEY (chat_id, character_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_members_chat ON chat_members(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_members_character ON chat_members(character_id);

-- Quick Replies with Lua scripting support.
CREATE TABLE IF NOT EXISTS quick_replies (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK(scope IN ('global', 'character', 'chat')),
    scope_id TEXT NOT NULL,
    label TEXT NOT NULL,
    icon TEXT DEFAULT '',
    color TEXT DEFAULT '',
    script TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'lua',
    auto_execute INTEGER DEFAULT 0,
    order_index INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_quick_replies_scope ON quick_replies(scope, scope_id);
CREATE INDEX IF NOT EXISTS idx_quick_replies_scope_order ON quick_replies(scope, scope_id, order_index, created_at, id);

-- Character assets for V3 card support.
-- Assets are filesystem-backed. This table stores metadata.
CREATE TABLE IF NOT EXISTS character_assets (
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'other',
    ext TEXT NOT NULL DEFAULT 'png',
    file_path TEXT,
    meta TEXT DEFAULT '{}',
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_character_assets_character ON character_assets(character_id);
CREATE INDEX IF NOT EXISTS idx_character_assets_character_created ON character_assets(character_id, created_at, id);

-- Backend configs
CREATE TABLE IF NOT EXISTS backend_configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    backend_provider TEXT NOT NULL DEFAULT 'openai',
    generation_mode TEXT NOT NULL DEFAULT 'chat',
    model TEXT NOT NULL DEFAULT '',
    api_url TEXT,
    api_key TEXT,
    temperature REAL,
    max_tokens INTEGER,
    top_p REAL,
    top_k REAL,
    min_p REAL,
    top_a REAL,
    repetition_penalty REAL,
    frequency_penalty REAL,
    presence_penalty REAL,
    instruct_template TEXT DEFAULT '',
    context_length INTEGER,
    prompt_history_limit INTEGER,
    provider_params_json TEXT NOT NULL DEFAULT '{}',
    stop_strings_json TEXT DEFAULT '[]',
    openrouter_provider TEXT DEFAULT NULL,
    logit_bias_json TEXT DEFAULT NULL,
    supports_images INTEGER NOT NULL DEFAULT 1,
    supports_audio INTEGER NOT NULL DEFAULT 1,
    supports_video INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_backend_configs_name ON backend_configs(name);

-- Prompt lists
CREATE TABLE IF NOT EXISTS prompt_lists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    prompts_json TEXT NOT NULL DEFAULT '[]',
    prompt_order_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_prompt_lists_name ON prompt_lists(name);

-- Tool templates: Lua scripts that define arrays of tools + shared state + global config.
CREATE TABLE IF NOT EXISTS tool_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    config_schema TEXT DEFAULT '{}',
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
);

-- Toolsets: user-created instances based on a template, with custom config and per-tool overrides.
CREATE TABLE IF NOT EXISTS toolsets (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    tool_overrides TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_toolsets_template ON toolsets(template_id);
