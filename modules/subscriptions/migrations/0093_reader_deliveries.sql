-- One row per reader and issue: the unique key makes the sweep idempotent and keeps a report regeneration
-- from pushing twice. A timeout is "unknown" and is not retried automatically; a transport error is
-- "failed" and the queue retries it.
CREATE TABLE IF NOT EXISTS reader_deliveries (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES reader_users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('daily', 'weekly', 'monthly')),
  report_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped', 'unknown')),
  attempts integer NOT NULL DEFAULT 0,
  error text,
  feishu_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (user_id, kind, report_key)
);
