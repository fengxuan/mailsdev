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

CREATE UNIQUE INDEX IF NOT EXISTS idx_direct_external_email_threads_owner_peer_topic
  ON direct_external_email_threads(owner_mailbox, peer_email, topic_key);

CREATE INDEX IF NOT EXISTS idx_direct_external_email_threads_owner_peer_updated
  ON direct_external_email_threads(owner_mailbox, peer_email, updated_at DESC, id DESC);
