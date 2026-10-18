-- 通用键值配置表：目前用于存放扫码登录拿到的知乎 cookie。
-- 放在 D1 而不是 wrangler secret，是因为 secret 只能在部署时用 CLI 写入，
-- 而扫码登录需要在运行时由本地脚本上传。
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
