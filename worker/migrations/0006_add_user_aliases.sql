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
