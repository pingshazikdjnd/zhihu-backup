
CREATE TABLE IF NOT EXISTS contents (
  pk TEXT PRIMARY KEY,                         -- answer:123 / article:456 / pin:789
  source_type TEXT NOT NULL CHECK (source_type IN ('answer', 'article', 'pin')),
  source_id TEXT NOT NULL,
  source_url TEXT,
  title TEXT,
  author_name TEXT,
  author_url_token TEXT,
  author_avatar TEXT,
  author_headline TEXT,
  question_id TEXT,
  question_title TEXT,
  content_html TEXT,
  content_md TEXT,
  excerpt TEXT,
  voteup_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  favorite_count INTEGER NOT NULL DEFAULT 0,
  visit_count INTEGER NOT NULL DEFAULT 0,
  is_collapsed INTEGER NOT NULL DEFAULT 0,
  is_labeled INTEGER NOT NULL DEFAULT 0,
  label_info TEXT,
  created_time TEXT,
  updated_time TEXT,
  content_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  UNIQUE(source_type, source_id)
);

CREATE TABLE IF NOT EXISTS content_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_pk TEXT NOT NULL,
  version_hash TEXT NOT NULL,
  title TEXT,
  content_html TEXT,
  content_md TEXT,
  excerpt TEXT,
  voteup_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  snapshot_at TEXT NOT NULL,
  FOREIGN KEY (content_pk) REFERENCES contents(pk) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  content_pk TEXT NOT NULL,
  parent_comment_id TEXT,
  author_name TEXT,
  author_avatar TEXT,
  be_replied TEXT,
  content_md TEXT,
  img_url TEXT,
  time_text TEXT,
  location TEXT,
  likes INTEGER NOT NULL DEFAULT 0,
  is_author INTEGER NOT NULL DEFAULT 0,
  is_top INTEGER NOT NULL DEFAULT 0,
  is_featured INTEGER NOT NULL DEFAULT 0,
  comment_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  FOREIGN KEY (content_pk) REFERENCES contents(pk) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comment_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id TEXT NOT NULL,
  content_pk TEXT NOT NULL,
  version_hash TEXT NOT NULL,
  content_md TEXT,
  img_url TEXT,
  likes INTEGER NOT NULL DEFAULT 0,
  snapshot_at TEXT NOT NULL,
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
  FOREIGN KEY (content_pk) REFERENCES contents(pk) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  owner_token TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_time TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id TEXT NOT NULL,
  content_pk TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('answer', 'article', 'pin')),
  source_id TEXT NOT NULL,
  title TEXT,
  author_name TEXT,
  source_url TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  is_removed INTEGER NOT NULL DEFAULT 0,
  removed_at TEXT,
  UNIQUE(collection_id, source_type, source_id),
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS collection_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id TEXT NOT NULL,
  snapshot_at TEXT NOT NULL,
  item_count INTEGER NOT NULL,
  added_count INTEGER NOT NULL DEFAULT 0,
  removed_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
  message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS change_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'content.created',
      'content.updated',
      'content.deleted',
      'comment.added',
      'comment.updated',
      'comment.deleted',
      'collection.item_added',
      'collection.item_removed'
    )
  ),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('content', 'comment', 'collection_item')),
  entity_pk TEXT NOT NULL,
  content_pk TEXT,
  summary TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contents_type_updated ON contents(source_type, updated_time DESC);
CREATE INDEX IF NOT EXISTS idx_contents_last_seen ON contents(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_versions_pk_time ON content_versions(content_pk, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_content_pk ON comments(content_pk);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_comment_id);
CREATE INDEX IF NOT EXISTS idx_comments_last_seen ON comments(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_comment_versions_comment ON comment_versions(comment_id, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_collection_items_collection ON collection_items(collection_id, is_removed, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_collection_snapshots_collection ON collection_snapshots(collection_id, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_change_events_time ON change_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_change_events_content ON change_events(content_pk, created_at DESC);

CREATE TABLE IF NOT EXISTS upvotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_pk TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  upvote_time TEXT NOT NULL,
  UNIQUE(content_pk)
);
CREATE INDEX IF NOT EXISTS idx_upvotes_time ON upvotes(upvote_time DESC);
