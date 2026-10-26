# 知乎个人内容备份系统

把自己在知乎上的**回答、文章、想法、评论、收藏夹、赞同记录**完整备份到自己的云端数据库与对象存储里，随时免代理直连浏览、全文检索、按问题归档整理、查看版本快照。

存储与接口跑在 **Cloudflare Workers + D1 + R2**，前端托管在 **Cloudflare Pages**（通过 **Service Binding 同源反代**直通后端 Worker，彻底绕开国内对 `*.workers.dev` 的 DNS 污染，手机/电脑免梯子直连秒开），抓取采用 **「本地计划任务全自动追平历史存量 + Apify Actor 云端日常增量」** 双轨架构。

---

## 核心功能

- **内容与正文分离备份**：回答、文章、想法（pin）的完整 HTML 正文与历史版本存入 **Cloudflare R2**（免费 10GB、零流量费），结构化元数据与 4000 字搜索摘要存入 **Cloudflare D1**。
- **按问题整理（`/questions`）**：将你所有**赞同过**或**收藏过**的回答按所属知乎问题自动聚合归档，支持按问题标题搜索，同时展示「赞同 / 收藏」双来源标签与回答状态。
- **版本历史追踪**：正文发生修改时按 SHA-256 哈希自动保留历史快照。
- **收藏夹与评论同步**：追踪收藏夹新增/移除条目；备份根评论与子评论（含「答主/置顶/精选」标记，支持 500 条分批幂等对账）。
- **赞同记录与断点续传（`upvotes_cursor`）**：记录每次赞同的时间与目标回答，支持深水区历史分页断点续传与 **D1 每日写入限额断路器保护**（单页零失败才推进游标，连续 5 次失败自动安全停机保游标，绝不漏存）。
- **凭据页密码锁（`/auth`）**：网页端粘贴更新知乎 Cookie，内置 **操作密码（`COOKIE_WRITE_TOKEN`）保护** 与在线 **「设置 / 修改密码」** 面板，防止他人知道网址后误改或清空 Cookie。
- **移动端适配**：窄屏横向滑动导航栏、44px 触控热区、自适应卡片与三级页面滚动位置记忆。
- **双轨全自动同步**：本地 Windows 计划任务（每天 `08:05` / `20:05` 后台静默运行，关机错过自动补跑）零成本追平历史存量；追平后由 Cloudflare Cron（每天 `10:00` / `22:00`）触发 Apify 快速增量同步。

---

## 系统架构

```
┌───────────────────────────┐
│ 浏览器 / 手机（免代理直连） │
└─────────────┬─────────────┘
              │ https://<项目名>.pages.dev
              ▼
┌──────────────────────────────────────────────────────────┐
│ Cloudflare Pages（React 19 前端 + public/_worker.js）     │
│  ├─ 静态路由 (/ /questions /collections /changes /auth)  │
│  └─ /api/* 与 /ingest/* ──► Service Binding (env.API)    │
└───────────────────────────────────────┬──────────────────┘
                                        │ 机房内部零延迟直连（绕开 workers.dev DNS 污染）
                                        ▼
┌───────────────────────┐     ┌────────────────────────────┐
│ 本地自动计划任务       │     │ Cloudflare Worker          │
│ scripts/local-sync.mjs├────►│ Hono API + Cron Trigger    │
│ (每天 08:05 / 20:05)  │     └─────────┬──────────┬───────┘
└───────────────────────┘               │          │
                                        ▼          ▼
┌───────────────────────┐     ┌──────────────┐ ┌──────────────┐
│ Apify Actor (云端增量) ├────►│ Cloudflare D1│ │ Cloudflare R2│
│ Playwright Chromium   │     │ 结构化元数据 │ │ 完整HTML正文 │
└───────────────────────┘     └──────────────┘ └──────────────┘
```

---

## 目录结构

```
apps/
  worker/          Cloudflare Worker：Hono API + D1 + R2 + Cron（生产后端）
  apify-crawler/   Playwright 抓取实现（可部署至 Apify 云端，也可由 local-sync.mjs 在本地直接运行）
  web/             React 19 + Vite 前端（含 public/_worker.js 同源 Service Binding 转发）
  api/             本地开发 Node 后端（仅本地调试用）
packages/
  shared/          zod schema 与哈希/文本安全截断工具，前后端共用
scripts/
  local-sync.mjs         本地全自动断点续传同步脚本（零 Apify 额度消耗）
  auto-sync-silent.vbs   Windows 计划任务后台静默启动器（不弹黑框，日志写 logs/auto-sync.log）
  smoke-test.sh          端到端冒烟测试脚本
local-sync.bat           手动双击运行本地同步的快捷入口
```

---

## 手把手部署教程（Cloudflare 与 Apify 网页端逐步操作指南）

下面提供**以 Cloudflare 网页控制台和 Apify 网页控制台为主**的完整图文级步骤（同时附上等效命令行，任选其一即可）。

---

### 第一部分：在 Cloudflare 网页端创建存储与部署后端 Worker

#### 第 1 步：创建 D1 数据库并建表
1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)。
2. 左侧菜单点击 **存储和数据库 (Storage & Databases)** → **D1 SQL 数据库 (D1 SQL Database)**。
3. 点击右上角 **创建数据库 (Create database)**，名称填 `zhihu-backup`，点击创建。
4. 进入刚创建的 `zhihu-backup` 数据库页面，复制页面上的 **数据库 ID (Database ID)**（形如 `bbb2772e-3921-4d73-8423-9e3eceda1157`），填入项目文件 `apps/worker/wrangler.toml` 的 `database_id` 字段。
5. **初始化表结构**：
   - **方式 A（网页端控制台执行）**：在 D1 数据库页面点击顶部的 **控制台 (Console)** 标签页，依次打开仓库 `apps/worker/migrations/` 下的 3 个 SQL 文件（`0000_schema.sql`、`0001_app_settings.sql`、`0002_performance_indexes.sql`），将内容粘贴进网页控制台点击 **执行 (Execute)**。
   - **方式 B（本地终端一行命令执行，推荐）**：
     ```bash
     cd apps/worker
     npx wrangler d1 migrations apply zhihu-backup --remote
     ```

#### 第 2 步：创建 R2 对象存储桶（存回答/文章正文）
1. 在 Cloudflare 左侧菜单点击 **R2 对象存储 (R2 Object Storage)** → **概述 (Overview)**。
2. 点击右上角 **创建存储桶 (Create bucket)**，名称填 `zhihu-backup-storage`，一路默认点击创建。
   > `apps/worker/wrangler.toml` 中已默认将 `zhihu-backup-storage` 绑定为变量名 `BUCKET`。

#### 第 3 步：部署 Worker 并设置环境变量与密码
1. 在本地终端进入 `apps/worker` 部署 Worker 代码：
   ```bash
   cd apps/worker
   npx wrangler login
   npx wrangler deploy
   ```
2. 部署成功后，回到 Cloudflare 网页端，左侧菜单点击 **计算 (Workers)** → **Workers 和 Pages** → 点击进入 **`gemini-zhihu-api`**。
3. 点击顶部 **设置 (Settings)** 标签页：
   - **检查域和路由 (Domains & Routes)**：记下默认的 `https://gemini-zhihu-api.<你的子域>.workers.dev` 地址。
   - **检查绑定 (Bindings)**：确认已包含 D1 数据库 `DB`（指向 `zhihu-backup`）和 R2 存储桶 `BUCKET`（指向 `zhihu-backup-storage`）。若在网页端新建，可点击 **添加绑定 (Add binding)** 手动绑定这两个名称。
   - **配置变量和机密 (Variables and Secrets)**：点击 **添加 (Add)**，依次配置以下项目：

| 类型 (Type) | 变量名称 (Variable name) | 值 (Value) 说明 |
|---|---|---|
| **文本 (Text)** | `WORKER_URL` | 填你的 Pages 同源域名 `https://zhihu-backup.pages.dev`（或 Worker 域名） |
| **文本 (Text)** | `ZHIHU_USERNAME` | 你的知乎个人主页 `url_token`（例如主页是 `zhihu.com/people/zhang-san`，就填 `zhang-san`） |
| **文本 (Text)** | `ALLOWED_ORIGIN` | 填你的前端域名 `https://zhihu-backup.pages.dev`（多个用英文逗号隔开） |
| **机密 (Secret)** | `API_SECRET` | 随便生成一串 32 位以上随机字符串，用于爬虫入库鉴权 |
| **机密 (Secret)** | `COOKIE_WRITE_TOKEN` | **凭据页（`/auth`）操作密码**（如 `8367274466`），设置后修改/清除 Cookie 必须输此密码 |
| **机密 (Secret)** | `APIFY_TOKEN` | 下一步在 Apify 网页端获取的 API Token（`apify_api_...`） |
| **机密 (Secret)** | `APIFY_ACTOR_ID` | 下一步在 Apify 网页端创建的 Actor ID（形如 `用户名~gemini-zhihu-crawler`） |

   - **配置定时触发器 (Trigger Events / Cron Triggers)**：在 **设置 → 触发器 (Triggers) → Cron 触发器** 中，确认已添加 `0 2,14 * * *`（UTC 时间 02:00 和 14:00，对应北京时间每天 **10:00** 和 **22:00** 自动触发增量同步）。

---

### 第二部分：在 Apify 网页端配置云端爬虫 Actor

1. 注册并登录 [Apify 控制台 (console.apify.com)](https://console.apify.com/)。
2. **获取 `APIFY_TOKEN` 与用户名**：
   - 点击左下角头像 → **Settings** → **Integrations**（或直接访问 `https://console.apify.com/settings/integrations`）。
   - 复制 **Personal API tokens** 下的默认 Token（以 `apify_api_` 开头），并记下页面上的 **Username**。
   - 将该 Token 填入上面 Cloudflare Worker 的 `APIFY_TOKEN` 机密中。
3. **发布爬虫代码到 Apify**：
   - **方式 A（本地终端一键推送，推荐）**：
     ```bash
     cd apps/apify-crawler
     APIFY_TOKEN="你的apify_api_token" npx --yes apify-cli push
     ```
   - **方式 B（Apify 网页端关联 GitHub 仓库）**：
     1. 在 Apify 控制台左侧点击 **Actors** → **Development** → 右上角 **Create new** → 选择 **Link Git repository**。
     2. 填入你的 GitHub 仓库地址，**Branch** 填 `main`，**Folder** 填 `apps/apify-crawler`。
     3. Actor 名称设为 `gemini-zhihu-crawler`，点击 **Save** 然后点击右上角 **Build** 构建镜像。
4. **在 Apify 网页端设置超时与内存**：
   - 进入 `gemini-zhihu-crawler` Actor 页面 → 点击 **Settings** 标签页：
     - **Timeout**：设为 `43200` 秒（12 小时，防止大账号同步中途被 1 小时默认超时掐断）。
     - **Memory**：设为 `4096` MB（4 GB）。
   - 点击页面右上角复制该 Actor 的标识（格式为 `你的Apify用户名~gemini-zhihu-crawler` 或 Actor ID），填入 Cloudflare Worker 的 `APIFY_ACTOR_ID` 机密中。

---

### 第三部分：部署 Cloudflare Pages 前端并配置「Service Binding 同源免代理直连」

> **为什么要配 Service Binding？**
> 国内网络下，`*.pages.dev` 可以免梯子直连秒开，但 `*.workers.dev` 会被 DNS 污染导致手机/浏览器报 `Failed to fetch`。我们在 `apps/web/public/_worker.js` 中内置了同源转发逻辑：只要在 Pages 项目上绑定 Worker 服务，前端请求 `https://zhihu-backup.pages.dev/api/*` 就会在 Cloudflare 机房内部零延迟直达后端 Worker，**手机/电脑不开代理也能直接打开网页看数据**！

#### 第 1 步：构建并部署 Pages 前端
- **方式 A（在 Cloudflare 网页端关联 GitHub 自动构建）**：
  1. Cloudflare 左侧菜单点击 **计算 (Workers) → Workers 和 Pages** → 右上角 **创建 (Create)** → 切换到 **Pages** 标签页 → **连接到 Git (Connect to Git)**。
  2. 选择你的 `zhihu-backup` 仓库，填入以下构建设置：
     - **项目名称 (Project name)**：`zhihu-backup`
     - **生产分支 (Production branch)**：`main`
     - **根目录 (Root directory)**：**留空**（必须是仓库根目录，不能填 `apps/web`）
     - **构建命令 (Build command)**：`pnpm --filter web build`
     - **构建输出目录 (Build output directory)**：`apps/web/dist`
  3. 展开下方的 **环境变量 (Environment variables)**，添加：
     - `VITE_API_BASE` = `https://gemini-zhihu-api.<你的子域>.workers.dev`
     - `VITE_ZHIHU_USERNAME` = `<你的知乎 url_token>`
  4. 点击 **保存并部署 (Save and Deploy)**。
- **方式 B（本地终端直接打包上传）**：
  在项目根目录新建 `.env.production`：
  ```env
  VITE_API_BASE=https://gemini-zhihu-api.<你的子域>.workers.dev
  VITE_ZHIHU_USERNAME=<你的知乎 url_token>
  ```
  然后执行：
  ```bash
  pnpm --filter web build
  npx wrangler pages deploy apps/web/dist --project-name=zhihu-backup --branch=main
  ```

#### 第 2 步：在 Cloudflare 网页端绑定 Service Binding（关键步骤）
1. 在 Cloudflare 网页端进入 **Workers 和 Pages** → 点击进入你的 Pages 项目 **`zhihu-backup`**。
2. 点击顶部 **设置 (Settings)** → 左侧选择 **绑定 (Bindings)**（或 **函数 / Functions → Service bindings**）。
3. 点击 **添加 (Add)** → 选择 **服务绑定 (Service binding)**：
   - **变量名称 (Variable name)**：必须填 **`API`**（全大写，对应 `_worker.js` 中的 `env.API`）
   - **服务 (Service)**：下拉选择 **`gemini-zhihu-api`**
   - **环境 (Environment)**：选择 **`Production`**
4. 点击 **保存 (Save)**（Production 和 Preview 环境都绑上 `API -> gemini-zhihu-api`）。
5. 保存后如果是在网页端新绑定的，重新触发一次 Pages 部署即可生效。此时直接访问 `https://zhihu-backup.pages.dev/api/health` 会返回 `{"ok":true}`。

---

### 第四部分：网页端填知乎 Cookie 与使用凭据页密码锁（`/auth`）

1. 打开 `https://zhihu-backup.pages.dev/auth`（顶部导航栏最右侧 **「凭据」**）。
2. **获取知乎 Cookie（30 秒）**：
   - 电脑浏览器登录 `https://www.zhihu.com`，按 `F12` 打开开发者工具。
   - 切到 **Network（网络）** 面板，刷新页面，点击列表里任意一条 `www.zhihu.com` 的请求。
   - 在右侧 **Headers → Request Headers** 中找到 `cookie:`，把冒号后面的**整行内容**复制下来，粘贴到 `/auth` 页面的文本框中。
3. **验证凭据操作密码**：
   - 页面带有 `🔒 已开启操作密码保护` 标记。在下方 **「凭据操作密码（口令验证）」** 输入框中输入你设置的密码（当前已设为 `8367274466`）。
   - 点击 **「保存 cookie」**（或点 **「在本机记住密码」**），当前浏览器会自动记住该密码，下次更新 Cookie 无需重复输入。
4. **在线设置 / 修改密码**：
   - 点击密码框右侧的 **「⚙️ 设置 / 修改密码」** 按钮，展开密码管理面板。
   - 输入 **「当前密码」** 和 **「新密码」**（至少 4 位），点击 **「保存新密码」** 即可直接在线修改密码（新密码保存在云端 D1 `app_settings` 表的 `cookie_write_token` 键中，优先级高于环境变量 `COOKIE_WRITE_TOKEN`）。
   - **如果忘记密码**：进入 Cloudflare 网页端 → `gemini-zhihu-api` → **设置 → 变量和机密** 重置 `COOKIE_WRITE_TOKEN`，并在 D1 数据库 `zhihu-backup` 控制台执行 `DELETE FROM app_settings WHERE key = 'cookie_write_token';` 即可恢复。

---

### 第五部分：双轨自动同步配置（本地全自动追平存量 + 云端日常增量）

由于老账号首次全量同步往往有数千条历史赞同，会触及 **Cloudflare D1 免费版每日 100,000 行写入上限** 与 **Apify 免费版每月 $5 额度**，本项目内置了本地全自动计划任务：

1. **配置项目根目录 `.env.local`**（已被 `.gitignore` 忽略，不会上传 GitHub）：
   ```env
   # 直接走 Cloudflare Pages 同源 Service Binding 通道，国内免代理直连秒通！
   WORKER_URL=https://zhihu-backup.pages.dev
   API_SECRET=<你的 API_SECRET>
   ZHIHU_USERNAME=<你的知乎 url_token>
   ```
2. **智能断点续传与 D1 限额防漏保护**：
   - 运行 `node scripts/local-sync.mjs --type=all --fast`（或双击 `local-sync.bat`）时，脚本会自动从云端 `/ingest/sync-state` 拉取最新 Cookie 与赞同断点游标 `upvotes_cursor`。
   - 回答与收藏夹先做快速增量（省下 D1 每日写入配额），随后赞同段在扫完头部最新动态后自动跳转到 `upvotes_cursor`（如第 614 页）继续向历史深处翻页。
   - **防漏保证**：只有整页 20 条全部入库成功（`pageFailures === 0`）才推进并上报下一页游标；一旦当天 D1 100K 写入额度用尽（连续 5 次写入失败），全局断路器立即安全刹车并保留当前页游标，绝不跳过任何一条数据。
3. **Windows 系统后台全自动定时任务（已自动注册，无需人工干预）**：
   - 任务名：`ZhihuBackup_LocalAutoSync`（通过 `scripts/auto-sync-silent.vbs` 静默运行，不弹黑框，日志追加写入 `logs/auto-sync.log`）。
   - 触发时间：每天 **08:05**（北京时间 08:00 D1 每日写入额度重置后 5 分钟）与 **20:05** 自动运行，且开启了 **错过自动补跑（`StartWhenAvailable`）**——若当时关机或休眠，开机后自动后台补跑。
   - 如需在新电脑上重新注册该自动任务，在 PowerShell 中执行：
     ```powershell
     $vbsPath = "G:\gemini zhihu\scripts\auto-sync-silent.vbs"
     $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbsPath`"" -WorkingDirectory "G:\gemini zhihu"
     $t1 = New-ScheduledTaskTrigger -Daily -At "08:05"
     $t2 = New-ScheduledTaskTrigger -Daily -At "20:05"
     $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 12) -MultipleInstances IgnoreNew
     Register-ScheduledTask -TaskName "ZhihuBackup_LocalAutoSync" -Action $action -Trigger @($t1, $t2) -Settings $settings -Force
     ```
4. **存量追平后的日常云端增量**：
   - 当历史赞同全部翻到底（`is_end = true`）后，`upvotes_cursor` 会自动清空。此后每天新增的回答、收藏、赞同只有寥寥几条，Cloudflare Cron 每天 10:00 / 22:00 触发 Apify 快速增量同步每次仅需 1～2 分钟，免费额度完全够用。

---

## API 一览

只读接口公开访问；写接口需 `Authorization: Bearer <API_SECRET>`，凭据页接口需 `Authorization: Bearer <COOKIE_WRITE_TOKEN>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/contents?page=&q=&type=&author=` | 内容列表（分页 50，按同步时间倒序，支持全文检索） |
| GET | `/api/contents/:pk` | 内容详情（正文从 R2 实时读取注入） |
| GET | `/api/contents/:pk/comments` | 评论树数据 |
| GET | `/api/questions?page=&q=` | 按问题整理列表（聚合赞同/收藏回答计数，支持问题标题搜索） |
| GET | `/api/questions/:id` | 指定问题下的全部已备份回答（含赞同/收藏双标签与状态） |
| GET | `/api/collections` | 收藏夹列表 |
| GET | `/api/collections/items?page=` | 全部收藏条目 |
| GET | `/api/collections/:id` | 单个收藏夹详情与快照历史 |
| GET | `/api/changes?limit=&exclude_comments=&only_comments=` | 变更时间线（limit 钳制 1–500，默认 100） |
| GET | `/api/changes/sync-runs` | 同步运行记录 |
| GET | `/api/upvotes?page=` | 赞同记录列表 |
| GET | `/api/stats` | 汇总统计 |
| POST | `/ingest/content` | 写入内容（D1 元数据 + R2 正文与版本快照） |
| POST | `/ingest/comments` | 写入评论（支持分批 `partial` 与 `allIds` 对账） |
| POST | `/ingest/collection-snapshot` | 写入收藏夹快照 |
| POST | `/ingest/upvote` | 写入赞同记录 |
| GET | `/ingest/sync-state` | 读取最新 Cookie、知乎账号与赞同断点游标（供本地自动同步使用） |
| POST | `/ingest/sync-state` | 上报或清空赞同断点游标 `upvotes_cursor` |
| POST | `/api/sync` `/fast` `/full?target=` | 手动触发 Apify 云端同步（带 10 分钟防重入锁） |
| GET | `/api/auth/zhihu-status` | 查询 Cookie 状态、密码开启状态与上次 Apify 运行结果 |
| POST | `/api/auth/zhihu-cookie` | 保存知乎 Cookie（需验证凭据页密码） |
| POST | `/api/auth/zhihu-cookie/clear` | 清除已保存的 Cookie（需验证凭据页密码） |
| POST | `/api/auth/write-token` | 在线设置或修改凭据页操作密码 |

---

## 数据导出备份与恢复

```bash
# 导出 D1 全量 SQL（schema + 全部结构化数据）
npx wrangler d1 export zhihu-backup --remote --output=backups/d1-$(date +%F).sql

# 导出 R2 全量正文（配置 Cloudflare R2 S3 API Token 后使用 rclone 同步）
rclone config create r2 s3 provider=Cloudflare \
  access_key_id=<AK> secret_access_key=<SK> endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
rclone sync r2:zhihu-backup-storage backups/r2-$(date +%F)/
```

---

## 技术栈

Cloudflare Workers · Cloudflare Pages (Service Binding) · D1 (SQLite) · R2 · Hono · Apify · Crawlee · Playwright · React 19 · Vite · TypeScript · zod · pnpm workspace
