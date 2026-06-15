DELETE FROM attachments
WHERE email_id IN (
  WITH ranked_emails AS (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY mailbox, direction, trim(message_id)
        ORDER BY received_at ASC, id ASC
      ) AS row_num
    FROM emails
    WHERE message_id IS NOT NULL
      AND trim(message_id) != ''
  )
  SELECT id
  FROM ranked_emails
  WHERE row_num > 1
);

DELETE FROM chat_group_message_index
WHERE email_id IN (
  WITH ranked_emails AS (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY mailbox, direction, trim(message_id)
        ORDER BY received_at ASC, id ASC
      ) AS row_num
    FROM emails
    WHERE message_id IS NOT NULL
      AND trim(message_id) != ''
  )
  SELECT id
  FROM ranked_emails
  WHERE row_num > 1
);

DELETE FROM emails
WHERE id IN (
  WITH ranked_emails AS (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY mailbox, direction, trim(message_id)
        ORDER BY received_at ASC, id ASC
      ) AS row_num
    FROM emails
    WHERE message_id IS NOT NULL
      AND trim(message_id) != ''
  )
  SELECT id
  FROM ranked_emails
  WHERE row_num > 1
);
