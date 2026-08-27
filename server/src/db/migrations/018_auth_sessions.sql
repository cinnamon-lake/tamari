-- 018_auth_sessions.sql
-- Server-side session store for the token-exchange login flow. The browser
-- authenticates once with the password and thereafter holds a revocable
-- `<id>.<secret>` session token (see AuthService). Only the SHA-256 hash of
-- the secret half is stored, so a DB dump cannot mint sessions.

CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
