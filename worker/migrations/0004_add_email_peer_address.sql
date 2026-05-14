ALTER TABLE emails ADD COLUMN peer_address TEXT;

UPDATE emails
SET peer_address = CASE
  WHEN direction = 'inbound' THEN lower(trim(from_address))
  WHEN direction = 'outbound' AND instr(to_address, ',') = 0 THEN lower(trim(to_address))
  ELSE NULL
END
WHERE peer_address IS NULL;

CREATE INDEX IF NOT EXISTS idx_emails_peer ON emails(mailbox, peer_address, received_at DESC);
