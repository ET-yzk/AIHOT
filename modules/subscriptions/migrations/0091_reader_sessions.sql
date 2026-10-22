-- Reader sessions: an opaque token kept hashed; auth_binding ties it to the login app and the reader, so
-- changing FEISHU_LOGIN_APP_ID or SESSION_SECRET signs existing sessions out. 30 days, like the admin's.
CREATE TABLE IF NOT EXISTS reader_sessions (
  id_hash text PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES reader_users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  auth_binding text NOT NULL,
  expires_at timestamptz NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
