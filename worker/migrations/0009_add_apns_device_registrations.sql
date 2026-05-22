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

CREATE UNIQUE INDEX IF NOT EXISTS idx_apns_device_registrations_user_device
  ON apns_device_registrations(user_id, device_id);

CREATE INDEX IF NOT EXISTS idx_apns_device_registrations_user_status
  ON apns_device_registrations(user_id, status);

CREATE INDEX IF NOT EXISTS idx_apns_device_registrations_token_status
  ON apns_device_registrations(apns_token, status);
