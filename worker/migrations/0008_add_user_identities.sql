ALTER TABLE users ADD COLUMN last_authenticated_at TEXT;

CREATE TABLE IF NOT EXISTS user_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('mailbox_code', 'email_code', 'apple')),
  provider_subject TEXT NOT NULL,
  provider_email TEXT,
  verified_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

INSERT OR IGNORE INTO user_identities (
  id, user_id, provider, provider_subject, provider_email,
  verified_at, last_used_at, created_at, updated_at
)
SELECT
  lower(hex(randomblob(16))),
  id,
  'mailbox_code',
  mailbox,
  CASE WHEN email != mailbox THEN email ELSE NULL END,
  email_verified_at,
  NULL,
  created_at,
  updated_at
FROM users;

INSERT OR IGNORE INTO user_identities (
  id, user_id, provider, provider_subject, provider_email,
  verified_at, last_used_at, created_at, updated_at
)
SELECT
  lower(hex(randomblob(16))),
  id,
  'email_code',
  email,
  email,
  email_verified_at,
  NULL,
  created_at,
  updated_at
FROM users
WHERE email != mailbox;

UPDATE users
SET last_authenticated_at = (
  SELECT COALESCE(MAX(last_used_at), MAX(created_at))
  FROM refresh_tokens
  WHERE refresh_tokens.user_id = users.id
)
WHERE last_authenticated_at IS NULL;

UPDATE users
SET last_authenticated_at = updated_at
WHERE last_authenticated_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_provider_subject
  ON user_identities(provider, provider_subject);

CREATE INDEX IF NOT EXISTS idx_user_identities_user
  ON user_identities(user_id, provider);
