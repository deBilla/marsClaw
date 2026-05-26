ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN failed_at INTEGER;
ALTER TABLE outbox ADD COLUMN last_error TEXT;

-- Backfill: any undelivered row older than 24h is almost certainly stale
-- (the bot was down). Mark them failed so the new attempt-cap poller
-- doesn't immediately flood the channel after upgrade.
UPDATE outbox
SET failed_at = unixepoch(),
    last_error = 'migrated-stale'
WHERE delivered_at IS NULL
  AND failed_at IS NULL
  AND created_at < unixepoch() - 86400;
