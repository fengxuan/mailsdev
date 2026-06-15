WITH duplicate_groups AS (
  SELECT
    mailbox,
    direction,
    trim(message_id) AS normalized_message_id,
    COUNT(*) AS row_count,
    MIN(received_at) AS first_received_at,
    MAX(received_at) AS last_received_at
  FROM emails
  WHERE message_id IS NOT NULL
    AND trim(message_id) != ''
  GROUP BY mailbox, direction, trim(message_id)
  HAVING COUNT(*) > 1
)
SELECT
  COUNT(*) AS duplicate_group_count,
  COALESCE(SUM(row_count - 1), 0) AS duplicate_row_count,
  MIN(first_received_at) AS earliest_duplicate_at,
  MAX(last_received_at) AS latest_duplicate_at
FROM duplicate_groups;

WITH duplicate_groups AS (
  SELECT
    mailbox,
    direction,
    trim(message_id) AS normalized_message_id,
    COUNT(*) AS row_count,
    MIN(received_at) AS first_received_at,
    MAX(received_at) AS last_received_at
  FROM emails
  WHERE message_id IS NOT NULL
    AND trim(message_id) != ''
  GROUP BY mailbox, direction, trim(message_id)
  HAVING COUNT(*) > 1
)
SELECT
  mailbox,
  direction,
  normalized_message_id AS message_id,
  row_count,
  first_received_at,
  last_received_at
FROM duplicate_groups
ORDER BY row_count DESC, last_received_at DESC
LIMIT 20;
