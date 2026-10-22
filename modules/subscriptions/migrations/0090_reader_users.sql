-- Readers who sign in with Feishu to receive the reports in their own single chat. The admin's admin_users
-- is a separate identity with its own allowlist; this one is open to the login app's availability scope.
-- One of the two ids identifies the reader: union_id is developer-level, email is the fallback.
CREATE TABLE IF NOT EXISTS reader_users (
  id bigserial PRIMARY KEY,
  feishu_union_id text UNIQUE,
  feishu_open_id text,
  email text UNIQUE,
  display_name text,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reader_users_has_identity CHECK (feishu_union_id IS NOT NULL OR email IS NOT NULL)
);
