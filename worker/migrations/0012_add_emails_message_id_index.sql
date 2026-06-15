CREATE INDEX IF NOT EXISTS idx_emails_mailbox_direction_message_id
  ON emails(mailbox, direction, message_id, received_at ASC, id ASC)
  WHERE message_id IS NOT NULL AND message_id != '';
