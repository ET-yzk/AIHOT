-- One subscription per reader: which reports to push, and whether to narrow them to categories or topics.
-- Pushing starts with issues generated after created_at; changing filters applies to later issues only.
CREATE TABLE IF NOT EXISTS reader_subscriptions (
  user_id bigint PRIMARY KEY REFERENCES reader_users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  daily boolean NOT NULL DEFAULT true,
  weekly boolean NOT NULL DEFAULT true,
  monthly boolean NOT NULL DEFAULT false,
  scope text NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'categories', 'topics')),
  categories text[] NOT NULL DEFAULT '{}',
  topics text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
