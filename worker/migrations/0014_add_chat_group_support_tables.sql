CREATE TABLE IF NOT EXISTS chat_groups (
  id TEXT PRIMARY KEY,
  mailbox TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by_user_id TEXT NOT NULL,
  service_user_id TEXT NOT NULL,
  sync_mode TEXT NOT NULL DEFAULT 'mail' CHECK (sync_mode IN ('mail', 'fast_chat')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  FOREIGN KEY (service_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS chat_group_members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  member_mailbox TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left')),
  joined_at TEXT NOT NULL,
  left_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES chat_groups(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS chat_group_external_members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left')),
  joined_at TEXT NOT NULL,
  left_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES chat_groups(id)
);

CREATE TABLE IF NOT EXISTS chat_group_message_index (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  group_mailbox TEXT NOT NULL,
  email_id TEXT NOT NULL,
  sender_email TEXT NOT NULL,
  sender_name TEXT,
  topic TEXT,
  sender_source TEXT NOT NULL CHECK (sender_source IN ('internal', 'external')),
  text TEXT NOT NULL,
  render_text TEXT,
  provider TEXT,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES chat_groups(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_groups_mailbox ON chat_groups(mailbox);
CREATE INDEX IF NOT EXISTS idx_chat_groups_status_updated ON chat_groups(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_groups_status_sync_updated ON chat_groups(status, sync_mode, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_groups_service_user_status ON chat_groups(service_user_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_group_members_group_user ON chat_group_members(group_id, user_id);
CREATE INDEX IF NOT EXISTS idx_chat_group_members_user_status ON chat_group_members(user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_group_members_group_mailbox ON chat_group_members(group_id, member_mailbox);
CREATE INDEX IF NOT EXISTS idx_chat_group_members_group_status ON chat_group_members(group_id, status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_group_external_members_group_email
  ON chat_group_external_members(group_id, email);
CREATE INDEX IF NOT EXISTS idx_chat_group_external_members_group_status
  ON chat_group_external_members(group_id, status, joined_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_group_external_members_email_status
  ON chat_group_external_members(email, status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_group_message_index_group_email
  ON chat_group_message_index(group_id, email_id);
CREATE INDEX IF NOT EXISTS idx_chat_group_message_index_group_received
  ON chat_group_message_index(group_id, received_at ASC, email_id ASC);
