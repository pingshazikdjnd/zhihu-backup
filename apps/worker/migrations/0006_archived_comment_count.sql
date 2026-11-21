-- 评论防删归档：保留 contents.comment_count 作为知乎现网评论数（供爬虫差量同步），
-- 新增 archived_comment_count 单调记录已归档评论水位，原站删评/清评后列表与详情页不归 0。
ALTER TABLE contents ADD COLUMN archived_comment_count INTEGER NOT NULL DEFAULT 0;
UPDATE contents SET archived_comment_count = comment_count WHERE archived_comment_count < comment_count;
