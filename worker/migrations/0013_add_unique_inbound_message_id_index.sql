CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_unique_inbound_message_id
  ON emails(mailbox, lower(trim(message_id)))
  WHERE direction = 'inbound' AND message_id IS NOT NULL AND trim(message_id) != '';
