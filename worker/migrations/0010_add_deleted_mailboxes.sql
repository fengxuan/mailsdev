CREATE TABLE IF NOT EXISTS deleted_mailboxes (
  mailbox TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL,
  reason TEXT,
  created_by TEXT
);
