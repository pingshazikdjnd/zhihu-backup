-- 性能索引：2.6 万条内容实测发现的主要慢路径修复（EXPLAIN QUERY PLAN 审计）。
-- 全部 IF NOT EXISTS，对既有库重复 apply 幂等。
--
-- 最差读路径：type 过滤 + 深分页 3.57s —— 旧索引 (source_type, updated_time)
-- 与列表实际排序列 last_seen_at 不符，SQLite 只能整类捞出后 TEMP B-TREE 排序。
CREATE INDEX IF NOT EXISTS idx_contents_type_last_seen ON contents(source_type, last_seen_at DESC);

-- author 过滤原先全表扫（author_name/author_url_token 无索引，0.9s）。
-- 两列分别建索引，SQLite 对 OR 条件做 multi-index OR。
CREATE INDEX IF NOT EXISTS idx_contents_author_token ON contents(author_url_token);
CREATE INDEX IF NOT EXISTS idx_contents_author_name ON contents(author_name);

-- /api/stats 的两条 count(is_deleted=...) 原先全表扫（实测 1.37s，随数据量线性恶化）。
CREATE INDEX IF NOT EXISTS idx_contents_deleted_type ON contents(is_deleted, source_type);
CREATE INDEX IF NOT EXISTS idx_comments_deleted ON comments(is_deleted);

-- /api/changes 的 exclude_comments/only_comments 过滤原先沿时间索引扫穿全表。
CREATE INDEX IF NOT EXISTS idx_change_events_type_time ON change_events(event_type, created_at DESC);

-- 5000 条评论的评论树原先命中索引后仍要 TEMP B-TREE 排序。
CREATE INDEX IF NOT EXISTS idx_comments_content_seen ON comments(content_pk, first_seen_at);
