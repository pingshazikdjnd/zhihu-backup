-- 正文图片下载任务队列（P1：图片处理从 ingest 请求剥离）。
-- ingest 只做纯 CPU 的确定性改写并写入任务行，真正的网络下载由
-- /ingest/image-batch 批量消费（cron / ingest 响应后的 waitUntil 兜底触发）。
-- 这样 /ingest/content 不会被最多 50 张图的下载与重试拖成长请求。
CREATE TABLE IF NOT EXISTS image_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_pk TEXT NOT NULL,
  -- HTML 里原始 <img src>（带签名，仅作下载与本地对象缺失时的回退来源）
  image_url TEXT NOT NULL,
  -- 本地对象名 images/{sha256}.{ext}；ingest 改写 HTML 时用的是同一个值
  object_key TEXT NOT NULL,
  -- pending / processing / done / failed
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- 同一篇正文的同名对象只排队一次：done 行同时承担「不再重复入队」的去重职责
  UNIQUE(content_pk, object_key),
  FOREIGN KEY (content_pk) REFERENCES contents(pk) ON DELETE CASCADE
);

-- 批量消费按状态 + 自增 id 取最老的待处理任务
CREATE INDEX IF NOT EXISTS idx_image_tasks_status ON image_tasks(status, id);
-- /api/images/* 未命中时按对象名反查原始外链
CREATE INDEX IF NOT EXISTS idx_image_tasks_object ON image_tasks(object_key);
