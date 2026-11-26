# 知乎个人内容备份系统

把自己在知乎上的**回答、专栏文章、想法（pin）、评论（含楼中楼防删归档）、收藏夹、赞同记录与关注答主内容**完整备份到自己的云端数据库与对象存储中，随时免代理直连浏览、全文检索、按问题归档、查看版本快照与防和谐风险评估。

后端 API 与存储跑在 **Cloudflare Workers + D1 + R2 + Workers AI**（支持挂载 Turso / 跨账号 D1 / Supabase / S3 / Webhook 外部多云存储），前端托管在 **Cloudflare Pages**（通过 `public/_worker.js` 的 **Service Binding 同源反代**直通 Worker，绕开对 `*.workers.dev` 的访问干扰），采集主力采用 **本地全量/增量同步脚本（零 Apify 额度消耗）**，并保留可选的 **Apify Actor** 云端抓取实现。

---

## 核心功能

- **内容与正文分离备份**：
  - 回答、专栏文章、想法（pin）的结构化元数据与 **4000 字纯文本检索摘要**（`content_md`，代理对安全截断）存入 **Cloudflare D1**。
  - 完整 HTML 正文按内容 SHA-256 寻址存入 **Cloudflare R2**（`html/{pk}/{hash}`）；已取消无任何读取方的 `versions/` 双写，写入前先以 `HEAD` 兜底检查 `putIfAbsent`，避免重复 Class A 计费。正文或标题/状态变化时在 D1 `content_versions` 自动留存历史版本记录。
- **全量覆盖我的创作与互动**：
  - **我的回答 & 我的专栏文章**：已独立支持 `articles` 抓取链路，并在 `answers` 与 `all` 模式结束时自动顺带备份本人专栏文章（不走关注答主过滤，全部无条件存档）。
  - **收藏夹**：支持超千条收藏夹分片提交（单批上限 1000 条）、想法（pin）块数组正文拼接与专栏文章字段兼容；仅在单片且完整到达末页时执行移除对账，防止分片或风控误删。
  - **赞同记录**：支持长正文截断检测与详情接口回源补全、`upvotes_cursor` 深水区断点续传，以及整页零失败才推进游标 + D1 每日写入限额断路器保护。
- **评论双层存储 + 防删归档**：
  - **双层存储**：根评论存 D1 `comments`，线程索引与前 2 条回复预览（每条最多 120 字）存 D1 `comment_threads`，完整楼中楼子评论存 R2 `childcomments/{rootId}.json`。详情页默认先展示预览，展开回复时按需懒加载并支持分批折叠（首展 5 条，每次「加载更多」10 条）。
  - **防删归档**：原站删评或整帖清评后，系统不物理删除已归档评论，而是对根评论保留 `is_deleted = 1`、对子评论标为 `isDeleted: true` 合并归档，并单调维护 `contents.archived_comment_count`（独立于现网 `comment_count`）；前端展示归档水位并标注「已删除」徽标。
  - **统一游标分页与闭评三态**：回答与专栏文章统一使用 `comment_v5` 游标分页（全量抓按 `order_by=ts`，热评按 `score`）；`comment_threads.is_complete` 支持三态（`0` = 未抓全待重试、`1` = 已抓全、`2` = 闭评冻结收敛）。
- **正文图片异步本地化备份**：
  - `/ingest/content` 仅做纯 CPU 的确定性改写：将知乎图床（`https://*.zhimg.com`）`<img src>` 改写为 `/api/images/{sha256}.{ext}`（基于 URL `pathname` 剥离 `_Nw` 尺寸后缀后求 SHA-256，单篇上限 50 张）并写入 `image_tasks` 队列，确保 `content_hash` 稳定不抖动。
  - 后台通过 `waitUntil` 单飞 drain 与 `POST /ingest/image-batch`（路由单批上限 8 张，配合并发闸门 4 与流式写 R2）异步下载；支持 **原图（`original`）/ 高质量 `_1440w`（`high`）/ 省空间 `_720w`（`compressed`）** 三档质量（尺寸变体 404 时自动回退原图）。
  - 本地对象尚未下载完成时，访问 `GET /api/images/*` 会安全 `302` 重定向至任务表记录的原始知乎图床外链；`.svg` 强制附件下载与沙箱 CSP。
- **外部数据库与多云存储扩展**：
  - 在「设置」页面支持挂载最多 **10 个** 外部存储节点，支持 **Turso（libSQL HTTP）**、**跨账号 Cloudflare D1**、**Supabase**、**S3 / R2 兼容对象存储** 与 **Webhook**。
  - 支持三种工作模式：
    - `offload`（直接分流扩容）：勾选范围只写外部库，主 D1 / 主 R2 零写入，读取时透明回源。
    - `overflow`（主库满额自动溢出）：主 D1 `comments` 行数达到阈值（默认 `1,500,000` 行）后自动切换为外部扩容分流。
    - `mirror`（双写灾备镜像）：主库照写，同时异步复制一份到外部库。
  - 外部配置采用 D1 `updated_at` + R2 `onlyIf` ETag 双层 CAS 乐观锁，并内置 SSRF 防护（生产环境拦截内网/回环/元数据地址）。
- **关注的人与自动抢救（`/following`）**：
  - 同步关注答主名录（D1 `followed_users` + R2 `meta/followed_users.json` 双写）。
  - **默认精选模式**：首次历史摸底按 `voteups` 无条件保存最热 **60 篇**（若 `voteups` 首页空页，自动回退按 `created` 扫描前 60 篇）；日常增量按 `created` 扫描至上次标记点 `last_checked_answer_id`（有标记点最多扫 **400 条**，无标记点最多 40 条，连续 5 条已存在早停），并补扫 `voteups` 前 **20 篇** 捞进「规则评估 + AI 复核」候选池。
  - 支持网页端为单个答主一键切换 **全量备份（`full`）**（带 `resume_offset` 断点续传，受操作密码保护），并自动收敛已注销/不可见账号（HTTP 410）。
- **推荐页、和谐风险评估与双引擎 AI（`/recommend`）**：
  - 支持 **「猜你想看（`mix`）」「高危易和谐榜（`risk`）」「偏爱与关注答主（`authors`）」「绝版与深度神贴（`classic`）」** 四频道及「换一批」，并支持单篇「找相似回答」。
  - **规则风险分引擎**：基于**现网评论数（`live_comment_count`）**识别高赞零评/清评预警，结合原站已删除/已折叠/黄标与敏感议题关键词计算 `0~100` 风险分与含金量分。
  - **双引擎 AI 深度鉴定与批量复核**：
    - Workers AI 可选模型：`@cf/qwen/qwen3-30b-a3b-fp8`（默认免费）、`@cf/deepseek-ai/deepseek-v4.1-flash-1017`、`@cf/zai-org/glm-5.3-flash`、`@cf/meta/llama-3.3-70b-instruct-fp8-fast`（底层免费回退链还包含 `@cf/meta/llama-3.1-8b-instruct-fp8`）。
    - 内置 R2 每日 Neurons 预算账本（默认 `6000` neurons/天）与 5 分钟失败冷却；额度耗尽、AI 未绑定或模型链失败时，自动无缝降级到 **OpenAI 兼容反代替补引擎（如 DeepSeek，默认模型 `deepseek-v4.1-flash`）**，仍不可用则退回规则兜底。
- **设置与凭据中心（`/settings` 与 `/auth`）**：
  - 操作密码管理（fail-closed 三级兜底：D1 `cookie_write_token` > 环境变量 `COOKIE_WRITE_TOKEN` > `API_SECRET`）。
  - 支持在线配置 4 板块评论抓取策略（我的回答与专栏文章/收藏夹默认 `full`，赞同/关注答主默认 `hot`）、关注敏感度（`strict`/`standard`/`relaxed`）、图片备份质量、Workers AI 与反代引擎配置、外部存储管理、知乎 Cookie 维护与同步状态查看。
- **其他前端能力**：
  - 按问题整理（`/questions`）、变更时间线（`/changes`）、顶部全局搜索框、内容页与收藏夹列表排序（最新 / 赞数最多）、移动端与平板响应式适配。

---

## 系统架构

```
┌───────────────────────────┐
│ 浏览器 / 手机（免代理直连） │
└─────────────┬─────────────┘
              │ https://<项目名>.pages.dev
              ▼
┌──────────────────────────────────────────────────────────────┐
│ Cloudflare Pages（React 19 + public/_worker.js）             │
│  ├─ 静态页与 SPA 路由（严格 HTML CSP / nosniff / DENY）      │
│  ├─ /api/*     ──► Service Binding (env.API)                 │
│  └─ /ingest/*  ──► 校验 Bearer 后转发至 env.API（否则 404）  │
└───────────────────────────────────────┬──────────────────────┘
                                        │ Cloudflare 内部零延迟直连
                                        ▼
┌───────────────────────┐     ┌────────────────────────────────────────┐
│ 本地采集主力（推荐）   │     │ Cloudflare Worker (Hono API)           │
│ scripts/local-sync.mjs├────►│  ├─ R2 两层边缘缓存 (Map + caches)     │
│ full-local-harvest.mjs│     │  ├─ 异步图片任务队列 & 并发槽位控制     │
└───────────────────────┘     │  └─ Workers AI + OpenAI 兼容反代兜底    │
                              └─────┬──────────┬───────────┬───────────┘
┌───────────────────────┐           │          │           │
│ Apify Actor (可选云端) ├───────────┘          │           │
│ apps/apify-crawler    │           ▼          ▼           ▼
└───────────────────────┘     ┌──────────┐ ┌────────┐ ┌────────────────┐
                              │ 主 D1 库 │ │ 主 R2  │ │ 外部多云存储   │
                              │ 元数据/  │ │ 正文/  │ │ Turso / 跨D1 / │
                              │ 根评论/  │ │ 楼中楼/│ │ Supabase / S3 /│
                              │ 索引摘要 │ │ 图片   │ │ Webhook        │
                              └──────────┘ └────────┘ └────────────────┘
```

---

## 目录结构

```
apps/
  worker/                Cloudflare Worker 后端（Hono API、D1、R2、Workers AI、外部分流、Cron 入口）
    migrations/          D1 数据库迁移文件（0000_schema.sql ~ 0006_archived_comment_count.sql）
    src/routes/          HTTP 路由（ingest / contents / collections / upvotes / questions / following / recommend / auth / sync / changes / stats）
    src/services/        核心服务（contents / comments / images / image-tasks / recommend / risk / following / collections / upvotes / lock 等）
    src/utils/           哈希与 R2 两层边缘缓存（hash.ts / r2-cache.ts）
  apify-crawler/         Playwright 爬虫实现（可本地运行，也可推送至 Apify 云端）
    src/main.ts          采集主逻辑（回答、专栏文章、收藏、赞同、关注、存量评论补采）
    src/zhihu-fetch.ts   知乎请求统一风控节流、重试、40352 快速熔断与闭评识别
  web/                   React 19 + Vite 前端（含 public/_worker.js 同源反代与 _headers）
packages/
  shared/                zod schema 与哈希/文本安全截断工具（前后端与爬虫共用）
scripts/
  local-sync.mjs                 本地日常/断点续传增量同步（单实例 wx 锁 + 代理探测 + 云锁租约）
  full-local-harvest.mjs         全新空白本地库 5 阶段全量重扒总控脚本
  run-comment-repair.mjs         存量被截断评论补采编排脚本（动态本地 Worker 端口 + 断点续传）
  repair-local-images.mjs        存量正文缺失图片重扫描入队与本地 Worker 批量补采
  download-images-direct.mjs     纯 Node 并发直下本地图片（绕开 workerd 内存限制，需先停 workerd）
  repair-upvotes-and-gaps.mjs    赞同截断正文回源补全与历史缺口复核脚本
  verify-local-harvest.mjs       100% 只读本地 D1/R2 跨库对账与 Cloudflare 免费额度体检器
  upload-to-cloudflare.mjs       本地备份导出与三阶段安全上云脚本（--dry-run / --export-only / --execute-remote）
  auto-sync-silent.vbs           Windows 计划任务后台静默启动器（日志写 logs/auto-sync.log）
  smoke-test.sh                  本地 Worker 端到端接口冒烟测试
  db-write-regression.test.mjs   数据库写入、分流、防删归档与图片状态机回归测试
  script-safety-regression.test.mjs  本地运维脚本安全边界与锁语义回归测试
  web-safety-regression.test.mjs 前端同源口令边界、竞态防护与 Pages 安全头回归测试
docs/
  ARCHITECTURE.md                架构设计与数据契约详解
  OPERATIONS.md                  本地采集、专项补采、体检与打包上云实操手册
  知乎字段审计-2026-11-01/       知乎接口实测字段审计原始证据与对比分析（只读归档）
.github/workflows/ci.yml         GitHub Actions CI（三包类型检查、前端构建、回归测试、冒烟测试）
CHANGELOG.md                     版本与演进变更记录
local-sync.bat                   Windows 手动双击运行本地同步快捷入口
```

---

## 部署与配置指南

### 1. 创建 Cloudflare D1 与应用全部 7 个迁移

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)，在 **Storage & Databases → D1 SQL Database** 创建数据库 `zhihu-backup`。
2. 复制输出的 **Database ID**，填入 `apps/worker/wrangler.toml` 的 `database_id`（占位符 `<你的 D1 database_id>`）。
3. 执行 `apps/worker/migrations/` 下的全部 7 个迁移文件（`0000_schema.sql` ~ `0006_archived_comment_count.sql`）：
   ```bash
   cd apps/worker
   npx wrangler d1 migrations apply zhihu-backup --remote
   ```
   > 若使用网页端 D1 Console 手动建表，必须按文件名序号从 `0000` 到 `0006` 逐个完整执行。

### 2. 创建 R2 存储桶并部署 Worker

1. 在 Cloudflare **R2 Object Storage** 创建存储桶 `zhihu-backup-storage`（与 `apps/worker/wrangler.toml` 中 `BUCKET` 绑定一致）。
2. 检查并按需调整 `apps/worker/wrangler.toml` 的 `[vars]`，然后在 `apps/worker` 下部署：
   ```bash
   cd apps/worker
   npx wrangler login
   npx wrangler deploy
   ```
3. 通过 `npx wrangler secret put <KEY>`（或在控制台 Variables and Secrets）注入敏感配置。完整环境变量如下（对照 [apps/worker/src/types.ts](apps/worker/src/types.ts)）：

| 类别 | 名称 | 必填 | 说明 |
|---|---|---|---|
| **Binding** | `DB` | 是 | D1 数据库绑定（`zhihu-backup`） |
| **Binding** | `BUCKET` | 是 | R2 存储桶绑定（`zhihu-backup-storage`），存正文、楼中楼、图片、配置与 AI 缓存 |
| **Binding** | `AI` | 可选 | Workers AI 绑定（`[ai]`），不绑时自动降级反代替补引擎或规则兜底 |
| **Var** | `WORKER_URL` | 推荐 | 填 Pages 域名 `https://<项目名>.pages.dev`，供云端 Apify 回传数据 |
| **Var** | `ZHIHU_USERNAME` | 推荐 | 你的知乎 `url_token`（`<你的知乎 url_token>`），用于过滤「我的内容」与抓取自身回答/文章 |
| **Var** | `ALLOWED_ORIGIN` | 推荐 | 允许跨域的前端域名，多域名用英文逗号分隔；支持 `*.pages.dev` 及其预览子域名；留空仅放行 localhost |
| **Var** | `READ_AUTH_REQUIRED` | 可选 | 设为 `"true"` 开启全站私有读门禁（除 `/api/health`、`/api/auth/zhihu-status`、`/api/images/*` 外全部 `/api/*` 均需 Bearer） |
| **Var** | `FALLBACK_AI_BASE_URL` | 可选 | Workers AI 替补引擎 OpenAI 兼容 Base URL（云端须为 `https://...`，本地开发允许回环 `http://127.0.0.1:...`） |
| **Var** | `FALLBACK_AI_MODEL` | 可选 | 替补引擎模型名，默认 `deepseek-v4.1-flash`（网页设置页保存的值优先于环境变量） |
| **Secret** | `API_SECRET` | **是** | 32 位以上随机长字符串；所有 `/ingest/*`、`/api/sync/*` 与复核接口的 fail-closed 鉴权密钥 |
| **Secret** | `COOKIE_WRITE_TOKEN` | 可选 | 设置/凭据页操作密码兜底值（不配时可用 `API_SECRET` 作为应急口令，也可在网页在线设置写入 D1） |
| **Secret** | `APIFY_TOKEN` | 可选 | Apify API Token（仅启用云端 Apify Cron 或网页查上次 Apify 运行状态时需要） |
| **Secret** | `APIFY_ACTOR_ID` | 可选 | Apify Actor ID，形如 `<你的Apify用户名>~gemini-zhihu-crawler` |
| **Secret** | `ZHIHU_COOKIE_STRING` | 可选 | 兜底知乎 Cookie（优先级低于网页端写入 D1 `app_settings.zhihu_cookie`；亦兼容 `ZHIHU_COOKIE_Z_C0`） |
| **Secret** | `FALLBACK_AI_API_KEY` | 可选 | 反代替补引擎 API Key（也可在网页设置页保存至 D1，明文永不下发给前端） |

#### 关于云端 Cron 与 Apify Actor（当前默认停用）

当前 `apps/worker/wrangler.toml` 中明确配置了 `crons = []`——**云端 Apify 定时触发已停用**，默认采用本地同步（`scripts/local-sync.mjs`）或本地全量采集（`scripts/full-local-harvest.mjs`）以节省云端写入配额与 Apify 额度，同时避免云端和本地任务并发双写。

如需重新启用云端定时同步：
1. 将最新 `apps/apify-crawler` 推送至 Apify 构建镜像（`APIFY_TOKEN=<你的 Token> npx --yes apify-cli push`，Actor 建议超时 `43200` 秒、内存 `4096` MB）。
2. 在 Worker 配置好 `APIFY_TOKEN`、`APIFY_ACTOR_ID`、`WORKER_URL`、`API_SECRET` 与 `ZHIHU_USERNAME`。
3. 将 `apps/worker/wrangler.toml` 的 `[triggers]` 改回 `crons = ["0 2,14 * * *"]`（UTC 时间，对应北京时间每天 10:00 / 22:00）并重新执行 `npx wrangler deploy`。

### 3. 部署 Cloudflare Pages 与绑定 Service Binding

1. 在 Cloudflare **Workers & Pages → Create → Pages** 关联 Git 仓库：
   - **Root directory**：留空（仓库根目录）
   - **Build command**：`pnpm --filter web build`
   - **Build output directory**：`apps/web/dist`
   - **环境变量**：
     - `VITE_API_BASE`：留空（生产构建自动走同源 `/api/*` + `public/_worker.js` Service Binding，避免跨域预检与 `*.workers.dev` 访问异常）
     - `VITE_ZHIHU_USERNAME`：**可选**，填入 `<你的知乎 url_token>`；若未配置，前端会自动请求 `&mine=1` 由 Worker 侧 `ZHIHU_USERNAME`（或 D1 `app_settings.zhihu_username`）过滤本人创作内容。
2. **绑定 Service Binding（必需）**：进入 Pages 项目的 **Settings → Bindings**，为 Production（建议连同 Preview）添加服务绑定：
   - **Variable name**：`API`（全大写，对应 `apps/web/public/_worker.js` 中的 `env.API`）
   - **Service**：选择部署好的 Worker（默认 `gemini-zhihu-api`）
3. 访问 `https://<项目名>.pages.dev/api/health`，返回 `{"ok":true}` 即表示同源反代打通；若返回 `503 {"error":"service_binding_missing",...}` 请检查上述 `API` 绑定。

---

## 本地开发与测试验证

### 1. 本地联调启动

```bash
# 1) 安装依赖
pnpm install

# 2) 配置本地 Worker 密钥（apps/worker/.dev.vars）
#    例如写入：API_SECRET=test-secret
cd apps/worker
npx wrangler d1 migrations apply zhihu-backup --local

# 3) 启动本地 Worker（推荐端口 18787，与 apps/web/vite.config.ts 的 /api 代理目标一致）
npx wrangler dev --local --port 18787
```

另开终端在仓库根目录启动前端开发服务器：

```bash
pnpm dev:web
```

此时浏览器访问 Vite 本地地址时，`/api/*` 与 `/api/images/*` 会自动同源代理至 `http://127.0.0.1:18787`，行为与线上 Pages `_worker.js` 一致。本地增量同步、全量重扒与数据上云操作见 [运维与本地采集手册](docs/OPERATIONS.md)。

### 2. 类型检查、构建与自动化测试（与 CI 对齐）

```bash
# 1) 三个 TypeScript 包类型检查
pnpm --filter worker exec tsc --noEmit
pnpm --filter web exec tsc --noEmit -p tsconfig.json
pnpm --filter apify-crawler exec tsc --noEmit

# 2) 前端生产构建
pnpm --filter web build

# 3) 全部回归测试（DB 写入/分流/图片状态机、脚本安全边界、前端安全头与竞态）
node --test scripts/db-write-regression.test.mjs scripts/script-safety-regression.test.mjs scripts/web-safety-regression.test.mjs

# 4) 端到端接口冒烟测试（先在 8788 端口启动带 API_SECRET=test-secret 的本地 Worker，或传 BASE_URL）
bash scripts/smoke-test.sh
```

---

## API 一览

> **鉴权总则**：
> - `GET /api/health`、`GET /api/auth/zhihu-status`、`GET /api/images/*` 始终公开可访问（`<img src>` 不支持携带自定义 Header）。
> - 其余 `GET /api/*` 默认公开；当 Worker 配置 `READ_AUTH_REQUIRED="true"` 时，要求携带 `Authorization: Bearer <操作密码或 API_SECRET>`。
> - 网页管理写接口遵循 **fail-closed** 鉴权：需命中 `ALLOWED_ORIGIN`（有 `Origin` 时）并携带有效的操作密码（D1 `cookie_write_token` > `COOKIE_WRITE_TOKEN` > `API_SECRET`）。
> - `/ingest/*` 与 `/api/sync/*` 强制校验 `Authorization: Bearer <API_SECRET>`；经 Pages `_worker.js` 访问 `/ingest/*` 时，未携带 Bearer 头会被直接拦截返回 `404`。

### 健康检查与图片代理

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `GET` | `/api/health` | 始终公开 | 服务健康检查（返回 `{"ok":true}`） |
| `GET` | `/api/images/*` | 始终公开 | 从 R2 读取 `images/{sha256}.{ext}`（不可变长缓存）；对象未落盘时安全 `302` 回退任务表原始 `https://*.zhimg.com` 链接；`.svg` 强制附件下载与沙箱 CSP |

### 内容与双层评论

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `GET` | `/api/contents` | 默认公开 / 可选 `READ_AUTH` | 内容列表（支持 `type`、`q`、`author`、`mine=1`、`sort=vote\|time`、`page`） |
| `GET` | `/api/contents/:pk` | 默认公开 / 可选 `READ_AUTH` | 内容详情与版本列表；正文 HTML 依次查主 R2 `html/{pk}/{hash}` → 外部扩容库 → 主 R2 旧键 `html/{pk}` → `md/` |
| `GET` | `/api/contents/:pk/comments` | 默认公开 / 可选 `READ_AUTH` | 兼容旧接口：返回扁平评论列表 |
| `GET` | `/api/contents/:pk/root-comments` | 默认公开 / 可选 `READ_AUTH` | 根评论分页（`limit` 默认 20、服务层上限 50，支持 `offset`），含前 2 条楼中楼预览（支持主库+外部扩容库透明分页去重）；传 `live_only=1` 时返回跨库收敛态 `has_incomplete_roots` |
| `GET` | `/api/contents/:pk/comments/:rootId/children` | 默认公开 / 可选 `READ_AUTH` | 展开指定根评论下的全部楼中楼子评论（优先外部扩容库 → 主 R2 `childcomments/{rootId}.json` → 主 D1 历史行） |

### 收藏夹、赞同、问题、统计与变更

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `GET` | `/api/collections` | 默认公开 / 可选 `READ_AUTH` | 收藏夹列表 |
| `GET` | `/api/collections/items` | 默认公开 / 可选 `READ_AUTH` | 全部收藏条目（支持 `page`、`sort`） |
| `GET` | `/api/collections/:id` | 默认公开 / 可选 `READ_AUTH` | 单个收藏夹详情、有效条目与快照历史 |
| `GET` | `/api/upvotes` | 默认公开 / 可选 `READ_AUTH` | 赞同记录列表（支持 `page`、`sort`） |
| `GET` | `/api/questions` | 默认公开 / 可选 `READ_AUTH` | 按问题维度聚合已赞同/收藏回答（支持 `page`、`q`） |
| `GET` | `/api/questions/:id` | 默认公开 / 可选 `READ_AUTH` | 指定问题下的全部已备份回答 |
| `GET` | `/api/stats` | 默认公开 / 可选 `READ_AUTH` | 汇总统计（带 60 秒内存缓存，加 `?fresh=1` 绕过缓存用于编排校验） |
| `GET` | `/api/changes` | 默认公开 / 可选 `READ_AUTH` | 变更时间线（`limit` 钳制 1–500，支持 `exclude_comments`、`only_comments`；已剥离 `payload_json`） |
| `GET` | `/api/changes/sync-runs` | 默认公开 / 可选 `READ_AUTH` | 最近 50 条云端同步执行记录 |

### 关注答主与推荐评估

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `GET` | `/api/following/users` | 默认公开 / 可选 `READ_AUTH` | 关注答主列表与备份进度预估（支持 `q`、`mode`、`sort`） |
| `GET` | `/api/following/feed` | 默认公开 / 可选 `READ_AUTH` | 关注答主动态流（支持 `page`、`only_risk=1`、`q`） |
| `GET` | `/api/following/users/:token` | 默认公开 / 可选 `READ_AUTH` | 指定关注答主详情及已备份内容（支持 `page`、`only_risk=1`） |
| `POST` | `/api/following/users/:token/mode` | 操作密码 / `API_SECRET` | 切换单个关注答主的备份模式（`default` vs `full`） |
| `GET` | `/api/recommend` | 默认公开 / 可选 `READ_AUTH` | 多路推荐流（`channel=mix\|risk\|authors\|classic`、`seed`、`limit`） |
| `GET` | `/api/recommend/similar/:pk` | 默认公开 / 可选 `READ_AUTH` | 同问题/同答主/相似主题关联推荐 |
| `POST` | `/api/recommend/ai-assess` | 操作密码 / `API_SECRET` | 单篇内容 AI 和谐风险与价值深度鉴定（20 次/分限流，带 R2 缓存、预算保护与反代兜底） |
| `POST` | `/api/recommend/evaluate-following` | `API_SECRET` | 供爬虫回调批量判断关注答主候选内容是否值得抢救（最多 10 条/批，12 次/分限流） |

### 设置、凭据与外部存储管理

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `GET` | `/api/auth/zhihu-status` | 始终公开 | 查询 Cookie 存在/来源/过期小时数、口令来源、游标、策略配置、外部目标数与上次 Apify 状态（不回传敏感明文） |
| `POST` | `/api/auth/zhihu-cookie` | 操作密码 / `API_SECRET` | 保存知乎 Cookie 到 D1（校验含 `z_c0` 且长度限制 20000） |
| `POST` | `/api/auth/zhihu-cookie/clear` | 操作密码 / `API_SECRET` | 清除 D1 中保存的 Cookie |
| `POST` | `/api/auth/write-token` | 白名单 Origin + 当前密码（空环境首次除外） | 在线初始化或修改操作密码（4–128 字符，支持 `COOKIE_WRITE_TOKEN` / `API_SECRET` 应急恢复） |
| `GET` | `/api/auth/settings` | 默认公开 / 可选 `READ_AUTH` | 读取同步策略、图片质量、AI 模型与反代配置（仅回传 `hasFallbackAiKey`） |
| `POST` | `/api/auth/settings` | 操作密码 / `API_SECRET` | 更新同步策略与 AI/反代配置（双写 D1 + R2 `meta/sync_config.json`，Key 独立存 D1） |
| `GET` | `/api/auth/external-targets` | 默认公开 / 可选 `READ_AUTH` | 外部多云存储节点列表（`authToken` 脱敏为 `maskedToken`） |
| `POST` | `/api/auth/external-targets` | 操作密码 / `API_SECRET` | 新增或编辑外部存储节点（上限 10 个，含 CAS 乐观锁与 SSRF 校验） |
| `POST` | `/api/auth/external-targets/delete` | 操作密码 / `API_SECRET` | 删除指定外部存储节点（CAS 乐观锁保护） |
| `POST` | `/api/auth/external-targets/test` | 操作密码 / `API_SECRET` | 真实连通性探测（支持 Turso / 跨账号 D1 / Supabase / S3 / Webhook） |

### 云端触发与爬虫入库协同

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `POST` | `/api/sync` | `API_SECRET` | 触发全量 Apify 云端同步（抢占 15 分钟分布式租约锁） |
| `POST` | `/api/sync/fast` | `API_SECRET` | 触发极速 Apify 同步（`?target=all\|answers\|articles\|collections\|upvotes\|following`） |
| `POST` | `/api/sync/full` | `API_SECRET` | 触发全量 Apify 同步（支持 `?target=`） |
| `POST` | `/ingest/content` | `API_SECRET` | 内容元数据入库、正文 HTML 写 R2/外部扩容库、纯 CPU 图片改写与入队（自动续租 `x-sync-owner`） |
| `POST` | `/ingest/image-batch` | `API_SECRET` | 批量消费 `image_tasks` 队列下载图片至 R2（路由单批上限钳制为 `8`） |
| `POST` | `/ingest/comments` | `API_SECRET` | 兼容旧通道：扁平评论批量入库（单批上限 1500） |
| `POST` | `/ingest/comments-by-root` | `API_SECRET` | 双层评论按根分组入库（单批上限 20 根，支持防删归档与外部分流） |
| `POST` | `/ingest/collection-snapshot` | `API_SECRET` | 收藏夹快照入库与移除对账（单批上限 1000 条，重复快照 0 写跳过） |
| `POST` | `/ingest/upvote` | `API_SECRET` | 写入赞同记录（时间未变 0 写跳过） |
| `GET` | `/ingest/sync-state` | `API_SECRET` | 供同步端拉取最新 Cookie、账号标识、赞同断点游标、关注进度与 `syncConfig` |
| `POST` | `/ingest/sync-state` | `API_SECRET` | 上报或清空赞同断点游标 `upvotes_cursor` |
| `POST` | `/ingest/followed-users` | `API_SECRET` | 批量更新关注答主名录（D1 + R2 双写） |
| `POST` | `/ingest/followed-user-progress` | `API_SECRET` | 上报单个关注答主的历史扫描进度（`resumeOffset`、`historyDone`、`lastCheckedAnswerId`） |
| `POST` | `/ingest/sync-lock/acquire` | `API_SECRET` | 申请分布式同步租约锁（已被占用返回 `409`） |
| `POST` | `/ingest/sync-lock/release` | `API_SECRET` | 按 `ownerId` 释放分布式同步租约锁 |
| `POST` | `/ingest/sync-all` | `API_SECRET` | 已废弃（返回 `410`，请使用 `/api/sync/full`） |

---

## 文档导航

- [系统架构设计与数据契约](docs/ARCHITECTURE.md) — D1/R2 存储结构、双层评论与防删归档状态机、图片异步管线、R2 两层边缘缓存、外部多云联邦、AI 路由预算、风控与安全边界
- [运维与本地采集手册](docs/OPERATIONS.md) — 日常增量同步、全新全量重扒、存量评论/图片/赞同补采、只读体检、三阶段打包上云与常见排障
- [更新日志](CHANGELOG.md) — 版本演进与主要架构/安全性改进记录
- [发版与自动部署指南](docs/RELEASING.md) — GitHub App 机器人 + Changesets 自动发版、production 审批部署与配置清单
- [知乎字段审计（2026-11-01）](docs/知乎字段审计-2026-11-01/README.md) — 知乎各接口真实返回字段实测证据与对比分析

---

## 技术栈

Cloudflare Workers · Cloudflare Pages (Service Binding) · Cloudflare D1 (SQLite) · Cloudflare R2 · Cloudflare Workers AI · Hono · Turso / Supabase / S3 兼容外部存储 · Apify / Crawlee · Playwright · React 19 · Vite · TypeScript · zod · DOMPurify · pnpm workspace
