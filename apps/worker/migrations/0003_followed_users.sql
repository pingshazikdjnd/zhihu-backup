-- 关注的知乎用户表（配合 R2 meta/followed_users.json 双写容灾）
CREATE TABLE IF NOT EXISTS followed_users (
  url_token TEXT PRIMARY KEY,
  user_id TEXT,
  name TEXT NOT NULL,
  avatar_url TEXT,
  headline TEXT,
  answer_count INTEGER NOT NULL DEFAULT 0,
  articles_count INTEGER NOT NULL DEFAULT 0,
  follower_count INTEGER NOT NULL DEFAULT 0,
  sync_mode TEXT NOT NULL DEFAULT 'default' CHECK (sync_mode IN ('default', 'full')),
  is_unfollowed INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_synced_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_followed_users_mode
  ON followed_users(is_unfollowed, sync_mode);
