-- 根评论 → 子评论线程索引
CREATE TABLE IF NOT EXISTS comment_threads (
  root_id TEXT PRIMARY KEY,           -- 根评论 id
  content_pk TEXT NOT NULL,
  r2_key TEXT NOT NULL,               -- childcomments/{rootId}.json
  child_count INTEGER NOT NULL DEFAULT 0,
  is_complete INTEGER NOT NULL DEFAULT 0,  -- 子评论是否抓全
  -- R2 里实际落盘的 { children, complete } 的 sha256；'' = 尚未成功写入。
  -- 与本次输入算出的 hash 相同说明 R2 已是同一份内容，可跳过 PUT（省 Class A 写入）。
  thread_hash TEXT NOT NULL DEFAULT '',
  -- 最近一次同步输入 { children, childCount, isChildrenComplete } 的 sha256。
  -- 与本次相同且 R2 已落盘 = 完全重复的同步，可跳过全部 R2 GET/PUT 与 D1 写入。
  incoming_hash TEXT NOT NULL DEFAULT '',
  -- 前 2 条子评论的轻量预览 JSON，列表页直接展示，打开详情页前 0 次 R2 读取
  preview_json TEXT NOT NULL DEFAULT '[]',
  synced_at TEXT NOT NULL,
  FOREIGN KEY (content_pk) REFERENCES contents(pk)
);
CREATE INDEX IF NOT EXISTS idx_comment_threads_content ON comment_threads(content_pk);

-- comments 表新增列
ALTER TABLE comments ADD COLUMN child_count INTEGER NOT NULL DEFAULT 0;

-- 收藏条目按 is_removed 过滤的列表/计数查询（全表扫描 -> 索引）
CREATE INDEX IF NOT EXISTS idx_collection_items_removed ON collection_items(is_removed);

-- 收藏聚合 JOIN 的覆盖索引：所有 FAV_JOIN 都是
-- WHERE is_removed = 0 GROUP BY content_pk，联合索引可直接定位并分组，
-- 避免每次推荐/问题/关注列表查询都全表扫描 collection_items。
CREATE INDEX IF NOT EXISTS idx_collection_items_content_removed ON collection_items(content_pk, is_removed);
