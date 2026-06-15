CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  mailbox TEXT NOT NULL,
  from_address TEXT NOT NULL,
  from_name TEXT DEFAULT '',
  to_address TEXT NOT NULL,
  peer_address TEXT,
  subject TEXT DEFAULT '',
  body_text TEXT DEFAULT '',
  body_html TEXT DEFAULT '',
  code TEXT,
  headers TEXT DEFAULT '{}',
  metadata TEXT DEFAULT '{}',
  message_id TEXT,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  attachment_count INTEGER NOT NULL DEFAULT 0,
  attachment_names TEXT DEFAULT '',
  attachment_search_text TEXT DEFAULT '',
  raw_storage_key TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status TEXT DEFAULT 'received' CHECK (status IN ('received', 'sent', 'failed', 'queued')),
  provider TEXT,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER,
  content_disposition TEXT,
  content_id TEXT,
  mime_part_index INTEGER NOT NULL,
  text_content TEXT DEFAULT '',
  text_extraction_status TEXT NOT NULL DEFAULT 'pending',
  storage_key TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  email_verified_at TEXT,
  last_authenticated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS user_aliases (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  peer_identifier TEXT NOT NULL,
  alias TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_aliases_owner_peer ON user_aliases(owner_user_id, peer_identifier);
CREATE INDEX IF NOT EXISTS idx_user_aliases_owner_updated ON user_aliases(owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS email_verification_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_sent_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  replaced_by_id TEXT,
  device_name TEXT,
  device_id TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS cli_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  label TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS apns_device_registrations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  apns_token TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
  alerts_enabled INTEGER NOT NULL DEFAULT 0 CHECK (alerts_enabled IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  last_push_at TEXT,
  last_push_status INTEGER,
  last_push_error TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS deleted_mailboxes (
  mailbox TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL,
  reason TEXT,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS direct_external_email_threads (
  id TEXT PRIMARY KEY,
  owner_mailbox TEXT NOT NULL,
  peer_email TEXT NOT NULL,
  topic_key TEXT NOT NULL DEFAULT 'default',
  topic_label TEXT,
  anchor_message_id TEXT NOT NULL,
  references_chain TEXT NOT NULL DEFAULT '',
  reply_subject TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_emails_mailbox ON emails(mailbox, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_peer ON emails(mailbox, peer_address, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_code ON emails(mailbox) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_emails_direction ON emails(direction);
CREATE INDEX IF NOT EXISTS idx_emails_mailbox_direction_message_id
  ON emails(mailbox, direction, message_id, received_at ASC, id ASC)
  WHERE message_id IS NOT NULL AND message_id != '';
CREATE INDEX IF NOT EXISTS idx_emails_has_attachments ON emails(mailbox, has_attachments, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_attachments_email_id ON attachments(email_id);
CREATE INDEX IF NOT EXISTS idx_attachments_filename ON attachments(filename);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_mailbox ON users(mailbox);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_identities_provider_subject ON user_identities(provider, provider_subject);
CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities(user_id, provider);
CREATE UNIQUE INDEX IF NOT EXISTS idx_direct_external_email_threads_owner_peer_topic
  ON direct_external_email_threads(owner_mailbox, peer_email, topic_key);
CREATE INDEX IF NOT EXISTS idx_direct_external_email_threads_owner_peer_updated
  ON direct_external_email_threads(owner_mailbox, peer_email, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_challenges_user_expires ON email_verification_challenges(user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_challenges_email_consumed ON email_verification_challenges(email, consumed_at, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_revoked ON refresh_tokens(user_id, revoked_at, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_device ON refresh_tokens(user_id, device_id, revoked_at, expires_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cli_tokens_hash ON cli_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_cli_tokens_user_revoked ON cli_tokens(user_id, revoked_at, expires_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_apns_device_registrations_user_device
  ON apns_device_registrations(user_id, device_id);
CREATE INDEX IF NOT EXISTS idx_apns_device_registrations_user_status
  ON apns_device_registrations(user_id, status);
CREATE INDEX IF NOT EXISTS idx_apns_device_registrations_token_status
  ON apns_device_registrations(apns_token, status);
