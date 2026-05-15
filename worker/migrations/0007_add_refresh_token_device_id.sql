ALTER TABLE refresh_tokens ADD COLUMN device_id TEXT;
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_device ON refresh_tokens(user_id, device_id, revoked_at, expires_at DESC);
