# 运维与本地采集手册

本手册涵盖本项目日常本地增量同步、全新空白本地库全量重扒、存量数据专项补采、本地只读体检与三阶段打包上云的完整实操步骤，所有脚本路径与参数均与仓库当前实现一致。

> **安全提醒**：下列所有本地运维脚本均严格遵守「凭据不落日志」约定，`.env.local`、`.dev.vars` 与临时 `INPUT.json` 中的 Cookie / 密钥仅在内存使用并在退出时清理。文档示例中所有域名与密钥均使用占位符。

---

## 1. 日常本地增量同步

日常增量同步将当前本地浏览器作为采集节点，**零 Apify 额度消耗**，直接通过 `WORKER_URL` 回传至线上 Cloudflare（推荐填 Cloudflare Pages 域名走同源 Service Binding，国内免代理直连）。

### 1.1 准备 `.env.local`

在仓库根目录创建 `.env.local`（已被 `.gitignore` 忽略）：

```env
WORKER_URL=https://<项目名>.pages.dev
API_SECRET=<与 Worker 侧 API_SECRET 一致的随机字符串>
ZHIHU_USERNAME=<你的知乎 url_token>

# 可选：访问 *.workers.dev 需要代理时可配置；若配置为 Pages 域名通常无需代理
# HTTPS_PROXY=http://127.0.0.1:7890
```

> 若使用 `HTTPS_PROXY`，`local-sync.mjs` 会先 TCP 探测该代理端口是否存活：存活时若当前 Node 支持 `--use-env-proxy`（需要 **Node >= 22.21 或 >= 24.0**）则自动重启自身让 Node `fetch` 走代理（Playwright 抓知乎仍保持直连）；Node 20 会自动回退直连模式。

### 1.2 手动执行与全部 CLI 参数

```bash
# 快捷命令（等价于 node scripts/local-sync.mjs）
pnpm sync:local -- --type=all --fast

# 仅同步赞同（含断点续传）
pnpm sync:upvotes

# 直接调用并按模块同步
node scripts/local-sync.mjs --type=answers --fast
node scripts/local-sync.mjs --type=articles --fast
node scripts/local-sync.mjs --type=collections --fast
node scripts/local-sync.mjs --type=upvotes --fast
node scripts/local-sync.mjs --type=following --fast
node scripts/local-sync.mjs --type=following-list
```

**支持参数一览（[scripts/local-sync.mjs](../scripts/local-sync.mjs)）**：

| 参数 | 说明 |
|---|---|
| `--type=all\|answers\|articles\|collections\|upvotes\|following\|following-list` | 指定抓取范围（默认 `all`） |
| `--upvotes` / `--upvotes-only` | 等价于 `--type=upvotes` |
| `--answers` | 等价于 `--type=answers` |
| `--collections` | 等价于 `--type=collections` |
| `--fast` | 极速增量模式（连续 20 条无更新早停；回答顺带我的专栏文章连续 5 篇无变化早停） |
| `--dry-run` | 仅拉取状态、编译爬虫并校验，不占用本地锁也不启动爬虫 |

- **Windows 快捷双击入口**：直接双击仓库根目录的 [local-sync.bat](../local-sync.bat)（执行 `node scripts/local-sync.mjs --type=upvotes`）。
- **本地原子锁保护**：脚本启动即以 `wx` 模式创建 `apps/apify-crawler/.local-sync.lock`。若上一轮异常终止留下锁文件，脚本**不会自动删除或接管**，而是诊断打印原 PID 状态后安全退出；请确认原进程已退出后手动删除该锁文件。
- **云端分布式锁协同**：同步前请求 `POST /ingest/sync-lock/acquire`（已被占用返回 `409` 并跳过），回传数据时通过 `x-sync-owner` 自动续租 15 分钟租约，正常结束释放（若子进程被强杀或以 `131` 退出，则跳过释放等待租约自然过期）。

### 1.3 Windows 后台静默计划任务

仓库内置静默启动器 [scripts/auto-sync-silent.vbs](../scripts/auto-sync-silent.vbs)（无窗口运行 `node scripts/local-sync.mjs --type=all --fast`，日志追加写入 `logs/auto-sync.log`）。在 PowerShell 中注册每日 08:05 / 20:05 自动任务（将 `<仓库目录>` 替换为本机实际路径）：

```powershell
$repoDir = "<仓库目录>"
$vbsPath = Join-Path $repoDir "scripts\auto-sync-silent.vbs"
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbsPath`"" -WorkingDirectory $repoDir
$t1 = New-ScheduledTaskTrigger -Daily -At "08:05"
$t2 = New-ScheduledTaskTrigger -Daily -At "20:05"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 12) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "ZhihuBackup_LocalAutoSync" -Action $action -Trigger @($t1, $t2) -Settings $settings -Force
```

---

## 2. 全新本地全量重扒

当需要从零重建全量本地 D1/R2 备份（不受云端 D1 每日 10 万行写入限制与 Apify 额度限制），使用总控脚本 [scripts/full-local-harvest.mjs](../scripts/full-local-harvest.mjs)。脚本默认以本地 Worker `http://127.0.0.1:18787` 为目标（**绝不执行任何线上 D1/R2 写操作**）。

### 2.1 5 个采集阶段与黄金策略

全量脚本默认向本地库写入以下 `GOLDEN_POLICY`（只有赞同因基数大采用 `hot`）：
- `commentsMyAnswers`: `"full"`
- `commentsCollections`: `"full"`
- `commentsFollowing`: `"full"`
- `commentsUpvotes`: `"hot"`
- `followingSensitivity`: `"standard"`

| 阶段 ID | `runType` | 内容 |
|---|---|---|
| `stage1_following_list` | `following-list` | 同步全部关注答主名录（含 `sync_mode` 与断点） |
| `stage2_my_answers_articles` | `answers` | 本人全部回答 + 本人全部专栏文章（全量正文与全部根/子评论） |
| `stage3_collections_full` | `collections` | 全部收藏夹及其中全量正文与评论 |
| `stage4_following_full` | `following` | 关注答主最热前 60 篇（`full` 模式答主全量）及规则/AI 复核抢救内容 |
| `stage5_upvotes_all` | `upvotes` | 全部历史赞同（前 20 热评+楼中楼，按 `upvotes_cursor` 自动冷却续跑，最多 12 轮） |

### 2.2 常用命令与 CLI 参数

```bash
# 1. 首次全新初始化：自动备份旧 state、应用全部本地迁移、写入 cookie 与黄金策略并启动
node scripts/full-local-harvest.mjs --init-fresh

# 2. 中断/断电/休息后从上次阶段断点继续
node scripts/full-local-harvest.mjs

# 3. 只跑指定阶段，或从某个阶段起跑
node scripts/full-local-harvest.mjs --only=stage3_collections_full
node scripts/full-local-harvest.mjs --from=stage4_following_full

# 4. 重置阶段进度文件（不清空已有数据）
node scripts/full-local-harvest.mjs --reset-progress
```

其他常用参数：
- `--cooldown-seconds=600`（兼容别名 `--rest-seconds`）：遇知乎风控 `partial_risk_controlled` 时的冷却等待秒数（默认 `600` 秒）。
- `--skip-build`：跳过 `apps/apify-crawler` 编译。
- `--wait-worker-seconds=120`：等待本地 Worker 启动就绪的最大秒数。
- `--dry-run`：仅做预检打印计划，不写库不抓知乎。
- 独立运维透传入口：`--repair-comments`（配 `--repair-batch-size=50`、`--repair-max=0`）、`--repair-images`（透传 `--image-batch-size`、`--image-max-batches`、`--image-scan-only`、`--dry-run`）。

> **风控冷却与 40352 处理**：阶段出现部分风控时，脚本会自动等待 `--cooldown-seconds` 并从 `logs/full-harvest-progress.json`、赞同游标与关注答主 `history_done` 断点继续；若冷却重跑后 0 新进展且再次撞 `40352` 风控，脚本会停机并提示先在浏览器打开知乎完成一次滑块验证后再续跑。

---

## 3. 专项存量补采运维

### 3.1 存量评论补采（[scripts/run-comment-repair.mjs](../scripts/run-comment-repair.mjs)）

针对早期由 `v4` 接口截断在第 20 条根评论的高评论内容，以及根+子评论总数仍明显低于现网 `comment_count` 的存量内容，走 `comment_v5` 全量补采与删除对账。该脚本会自动扫描本地 D1 并排除已完整条目、维护持久化断点 `logs/repair-comments-progress.json` 与文件锁 `logs/repair-comments.lock`，并**自动选择空闲本地回环端口（默认起始 `18789`，探测 `18789..18799`）**拉起和清理单实例本地 Worker：

```bash
# 只读扫描待补采数量（不启 Worker、不连知乎）
node scripts/run-comment-repair.mjs --dry-run

# 启动断点式全量评论补采（每批 200 条，遇风控自动停 Worker 冷却 600 秒）
node scripts/run-comment-repair.mjs

# 小批量试跑或自定义端口/冷却时间
node scripts/run-comment-repair.mjs --batch-size=50 --max=200 --cooldown-seconds=600 --port=18789

# 清空断点重新扫描（已补齐内容仍会被 SQL 扫描自动排除）
node scripts/run-comment-repair.mjs --reset-progress
```

完整参数：`--dry-run`、`--batch-size=200`、`--max=0`（0=不限）、`--cooldown-seconds=600`、`--max-cooldowns=200`、`--port=18789`、`--reset-progress`、`--help`。遇 `40352` 人机验证或连续 3 轮 0 进展风控时自动保存断点安全停机；遇 `401` 会先校验 `/api/v4/me` 确认是否真过期。

### 3.2 存量图片补采（两条路径）

#### 方式 A：经本地 Worker 批量补采（[scripts/repair-local-images.mjs](../scripts/repair-local-images.mjs)）

只读本地 D1/R2 已有正文（绝不重抓知乎正文或改动 `content_hash`），按生产规则重建缺失的 `image_tasks`，再通过 loopback `http://127.0.0.1:18787` 调用 `POST /ingest/image-batch` 有限批下载（注意运行前需已启动本地 Worker）：

```bash
# 只读扫描缺图统计
node scripts/repair-local-images.mjs --repair-images --dry-run

# 只扫描并补写 image_tasks 队列，暂不下载
node scripts/repair-local-images.mjs --repair-images --image-scan-only

# 通过本地 Worker 分批下载（默认每批 20，也可调小至 8）
node scripts/repair-local-images.mjs --repair-images --image-batch-size=8 --image-max-batches=50
```

完整参数：`--repair-images`、`--dry-run`、`--image-scan-only`、`--image-batch-size=20`（脚本钳制 1..100，Worker 路由单批上限钳制为 8）、`--image-max-batches=0`（0=直至清空或失败）。

#### 方式 B：纯 Node 并发直下（[scripts/download-images-direct.mjs](../scripts/download-images-direct.mjs)）

当历史待补采图片数量巨大时，Miniflare `workerd` 长时间批量下载容易内存溢出。本脚本以纯 Node 并发直接下载并按 Miniflare v3 格式原子写入本地 R2 `_mf_objects` 与 `blobs/`，严格对齐生产 10MB 体积上限、尺寸变体（`original`/`high`/`compressed`）与状态机（`MAX_ATTEMPTS=3`）。

> **硬性前置条件**：写模式运行前**必须停止所有正在运行的 `workerd` / `wrangler dev` 进程**（脚本启动前会自动通过 `tasklist` / `pgrep` 检测，检测到运行中的 `workerd` 会直接拒绝写入以防止损坏本地 SQLite）。

```bash
# 1. 只读统计待下载与本地已有 R2 对象可核销数
node scripts/download-images-direct.mjs --dry-run

# 2. 仅将 R2 里已存在对象的任务核销标记为 done（不发网络请求）
node scripts/download-images-direct.mjs --reconcile-only

# 3. 确认已停止本地 wrangler dev / workerd 后，并发直下全量待处理图片
node scripts/download-images-direct.mjs --concurrency=12

# 4. 仅小样本试跑，或重试此前 failed 的任务
node scripts/download-images-direct.mjs --limit=50 --concurrency=8 --timeout-ms=15000
node scripts/download-images-direct.mjs --retry-failed
```

完整参数：`--dry-run`、`--reconcile-only`、`--skip-reconcile`、`--limit=N`、`--concurrency=12`（1..32）、`--timeout-ms=15000`、`--retry-failed`、`--help`。

### 3.3 赞同截断与历史缺口补抓（[scripts/repair-upvotes-and-gaps.mjs](../scripts/repair-upvotes-and-gaps.mjs)）

针对赞同动态流返回截断长正文或缺失本地 R2 HTML 的历史内容，通过低频随机抖动直接回源详情页并通过本地 Worker（`http://127.0.0.1:18787`，可用 `LOCAL_WORKER_PORT` 覆盖）写回（断点文件 `logs/repair-upvotes-progress.json`）：

```bash
# 只读扫描缺 R2 HTML 与疑似截断候选数量
node scripts/repair-upvotes-and-gaps.mjs --dry-run

# 依次执行全部 4 个子任务（补缺 HTML + 复核截断正文 + 增量扫新赞同 + 局部复核历史低谷）
node scripts/repair-upvotes-and-gaps.mjs

# 仅跑指定子任务
node scripts/repair-upvotes-and-gaps.mjs --task=html
node scripts/repair-upvotes-and-gaps.mjs --task=truncated --include-with-punct
node scripts/repair-upvotes-and-gaps.mjs --task=incremental
node scripts/repair-upvotes-and-gaps.mjs --task=nov2024
```

---

## 4. 本地体检与打包上云

### 4.1 100% 只读跨库体检（[scripts/verify-local-harvest.mjs](../scripts/verify-local-harvest.mjs)）

以 `{ readonly: true }` + `PRAGMA query_only = ON` 打开本地 Miniflare D1 与 R2 SQLite，不发起任何网络请求，输出全表行数、HTML/楼中楼/图片 R2 落盘对账率，以及 Cloudflare 免费额度预估告警（**D1 免费单库上限 500 MB**、**免费账户总存储 5 GB**、**每日 10 万行写入上限**，以及 R2 10 GB / 每月 100 万次 Class A）：

```bash
node scripts/verify-local-harvest.mjs
node scripts/verify-local-harvest.mjs --json
```

### 4.2 三阶段打包与安全上云（[scripts/upload-to-cloudflare.mjs](../scripts/upload-to-cloudflare.mjs)）

脚本按外键顺序导出全部 14 张表（含 `image_tasks`），并对 `app_settings` 执行**严格白名单导出（仅导出 `sync_config`）**，清空线上表时自动保留 9 项远端运行态键（`zhihu_cookie`、`fallback_ai_api_key`、`cookie_write_token`、`external_storage_targets`、`sync_config`、`upvotes_cursor`、`apify_last_run`、`ai_daily_neuron_budget`、`sync_lock`），防止本地旧配置覆盖线上凭据或锁。

#### 阶段 1：纯只读预检（默认模式）

```bash
node scripts/upload-to-cloudflare.mjs
# 或
node scripts/upload-to-cloudflare.mjs --dry-run --json
```

#### 阶段 2：本地打包（零拷贝清单）

生成 `data/cf-upload-bundle/d1-chunks/chunk-NNNN.sql`、`0000_wipe_remote_tables.sql` 与直接指向 `blobs/<blob_id>` 的零拷贝清单 `r2-manifest.jsonl`（不复制任何 R2 实体文件）：

```bash
node scripts/upload-to-cloudflare.mjs --export-only --chunk-rows=2000 --chunk-mb=5
```

#### 阶段 3：真上云（双重确认 + 断点续传）

必须同时提供 `--execute-remote` 与 `--confirm-wipe-remote` 才会操作线上资源。建议设置环境变量 `CF_ACCOUNT_ID`（或 `CLOUDFLARE_ACCOUNT_ID`）与 `CF_API_TOKEN`（或 `CLOUDFLARE_API_TOKEN`）以启用 Cloudflare REST API 高并发直传与线上 R2 对象枚举清理；未配置时自动回退至 `wrangler` CLI（此时因 wrangler 无法枚举远端全量 R2 对象，需按需附加 `--skip-r2-wipe`）：

```bash
# PowerShell 设置上云凭据（仅当前终端会话有效，不落盘）
$env:CF_ACCOUNT_ID = "<你的 Cloudflare Account ID>"
$env:CF_API_TOKEN  = "<具有 D1 Edit + R2 Edit 权限的 API Token>"

# 执行清空并断点续传导入
node scripts/upload-to-cloudflare.mjs --execute-remote --confirm-wipe-remote --concurrency=16
```

- **R2 `key + etag` 严格断点续传**：每上传成功一片 SQL 或一个 R2 对象会写入 `data/cf-upload-bundle/upload-progress.json` 与 `r2-done.log`（JSON Lines，必须 `key` 与去引号后的 `etag` 完全一致才判定跳过）；中断后重跑同一条命令即可自动续传。如需在已有进度下强行重新清空线上库，需显式追加 `--force-wipe`。

---

## 5. 云端数据备份、灾难恢复与常见排障

### 5.1 云端 D1 与 R2 定期备份

```bash
# 导出线上 D1 全量 SQL（schema + 数据）
cd apps/worker
npx wrangler d1 export zhihu-backup --remote --output=../../backups/d1-$(date +%F).sql

# 使用 rclone 同步线上 R2 存储桶到本地（先配置 Cloudflare R2 S3 凭据）
rclone config create r2 s3 provider=Cloudflare \
  access_key_id=<R2_ACCESS_KEY_ID> \
  secret_access_key=<R2_SECRET_ACCESS_KEY> \
  endpoint=https://<你的 Cloudflare Account ID>.r2.cloudflarestorage.com

rclone sync r2:zhihu-backup-storage backups/r2-$(date +%F)/
```

### 5.2 常见排障速查

| 现象 | 排查与处理方式 |
|---|---|
| **提示 Cookie 失效 / 爬虫报 `401`** | 浏览器重新登录 `www.zhihu.com` 复制整行 `cookie`（含 `z_c0`），在前端 `/settings`（或 `/auth`）粘贴保存即可，无需重新部署 Worker 或重启本地脚本。 |
| **忘记网页端操作密码** | 可直接输入 Worker 环境变量中的 `COOKIE_WRITE_TOKEN` 或 `API_SECRET`（应急恢复主钥）解锁并重设；若需彻底清除 D1 在线密码，在 Cloudflare D1 Console 执行 `DELETE FROM app_settings WHERE key = 'cookie_write_token';`。 |
| **本地同步报 `409`（云端同步锁占用）** | 说明另一台机器或上一次异常被强杀（退出码 `131`）的同步持有着租约。最多等待 **15 分钟** 租约自动过期；或确认无其他实例在跑后通过 `POST /ingest/sync-lock/release` 释放对应 `ownerId`。 |
| **本地同步提示 `.local-sync.lock` 已存在** | 检查日志里打印的旧 `PID` 是否仍在运行；确认无 `local-sync.mjs` / 爬虫进程存活后，手动删除 `apps/apify-crawler/.local-sync.lock` 即可。 |
| **知乎触发 `40352` 人机验证** | 立刻停止并发脚本等待至少 10 分钟（`--cooldown-seconds=600`），用同账号浏览器访问知乎随便点开一个回答并完成滑块验证，再重新执行脚本从断点续跑。 |
| **前端接口报 `503 service_binding_missing`** | 进入 Cloudflare Pages 项目 → **Settings → Bindings**，确认已为 Production（及 Preview）添加名为 `API`（全大写）的 Service Binding 指向 `gemini-zhihu-api` Worker，保存后重新部署 Pages。 |
| **线上 Workers AI 未生效，落盘显示 `fallback:...` 或 `rule-fallback`** | 打开 `/settings` 检查是否触达当日 Neurons 预算上限（默认 `6000`/天），或查看 Worker `[ai]` 绑定与反代配置（`fallbackAiBaseUrl` 在云端生产环境必须为 `https://`）。 |
