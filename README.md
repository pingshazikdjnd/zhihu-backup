# 知乎备份

把自己在知乎上的回答、收藏、赞同内容备份到自己的库里，随时能查、能搜、能看历史版本。

存储和接口跑在 **Cloudflare Workers + D1 + R2**，抓取交给 **Apify Actor**，前端是个纯静态的 React 站点。

> 只备份你自己账号可见的内容。抓取需要登录态，cookie 由你自己在网页上粘贴。

---

## 它做什么

- **内容备份**：回答、文章、想法（pin）的正文、作者、赞同/评论/收藏/浏览数
- **版本历史**：正文变化会留快照，判断依据是正文内容的 SHA-256
- **收藏夹追踪**：收藏夹里加了什么、移除了什么
- **评论备份**：根评论 + 子评论，含「答主/置顶/精选」标记
- **赞同记录**：你在什么时间赞同了哪条内容
- **变更时间线**：所有新增/更新/删除事件
- **cookie 网页维护**：登录态失效时，打开网页贴一下就行，不用改代码或重部署
- **定时抓取**：Cloudflare Cron 每天两次触发 Apify

---

## 架构

```
┌─────────────┐   POST /ingest/*   ┌──────────────────────┐
│ Apify Actor │ ─────────────────► │ Cloudflare Worker    │
│ (Playwright)│   Bearer 鉴权      │ Hono + D1 + R2       │
└─────────────┘                    └──────────┬───────────┘
       ▲                                      │
       │ 触发（Cron / 手动）                    │ 只读 API
       └──────────────────────────────────────┤
                                              ▼
                                    ┌──────────────────┐
                                    │ React 前端        │
                                    │ /auth 填 cookie   │
                                    └──────────────────┘
```

- **D1** 存结构化数据：内容、评论、收藏、赞同、变更事件、配置
- **R2** 存正文原文：`html/{pk}/{hash}`、`md/{pk}/{hash}`、`versions/{pk}/{hash}`
- D1 里只保留 4000 字的纯文本用于搜索，正文本身不进 D1

---

## 目录结构

```
apps/
  worker/          Cloudflare Worker：API + D1 + R2（生产后端）
  apify-crawler/   Apify Actor：唯一的抓取实现
  web/             React + Vite 前端
  api/             ⚠️ 已废弃：早期本地 Node 后端，仅作参考
  collector/       ⚠️ 已废弃：早期本地 Playwright 抓取，仅作参考
packages/
  shared/          zod schema 与哈希/文本工具，前后端共用
scripts/legacy/    历史脚本归档（不要直接运行）
```

`apps/api` 与 `apps/collector` 不在生产链路里，可以忽略或删掉。

---

## 前置要求

- Node.js ≥ 20
- pnpm 10
- Cloudflare 账号（Workers 免费版够用）
- Apify 账号（免费额度够个人使用）

---

## 部署

### 1. 创建 Cloudflare 资源

```bash
cd apps/worker
npx wrangler login
npx wrangler d1 create zhihu-backup          # 记下返回的 database_id
npx wrangler r2 bucket create zhihu-backup-storage
```

### 2. 填 `apps/worker/wrangler.toml`

```toml
[[d1_databases]]
database_id = "<上一步的 UUID>"     # 不能留全零，否则所有查询失败

[vars]
WORKER_URL    = "https://gemini-zhihu-api.<你的子域>.workers.dev"
ZHIHU_USERNAME = "<你的知乎 url_token>"
ALLOWED_ORIGIN = "https://<前端域名>"   # 多个用逗号分隔
```

> `WORKER_URL` 部署前还不知道真实值，先随便填一个，deploy 完拿到域名再回来改，然后**再 deploy 一次**。

### 3. 建表、配密钥、部署

```bash
npx wrangler d1 migrations apply zhihu-backup --remote

# 下面四条是交互式的，执行后会提示你粘贴值
npx wrangler secret put API_SECRET          # 自己生成一个长随机串
npx wrangler secret put APIFY_TOKEN         # apify_api_xxx
npx wrangler secret put APIFY_ACTOR_ID      # 形如 username~actor-name

npx wrangler deploy
```

> `migrations apply` 不能跳过。不跑的话 `app_settings` 表不存在，网页提交 cookie 会直接 500。

### 4. 发布 Apify Actor

```bash
cd apps/apify-crawler
npx apify-cli login
npx apify-cli push
```

`APIFY_ACTOR_ID` 就是 push 之后 Console 里的 `用户名~Actor名`。

### 5. 构建前端

回到**仓库根目录**：

```bash
cd ../..
```

新建 `.env.production`：

```
VITE_API_BASE=https://gemini-zhihu-api.<你的子域>.workers.dev
VITE_ZHIHU_USERNAME=<你的知乎 url_token>
```

然后：

```bash
pnpm --filter web build
```

产物在 `apps/web/dist`。用 Cloudflare Pages 托管的话：

```bash
npx wrangler pages deploy apps/web/dist --project-name=zhihu-backup
```

第一次会提示你创建 Pages 项目。

> `.env.production` 被 `.gitignore` 排除，不会进仓库。如果让 CF Pages 从 Git 自动构建，把 `VITE_API_BASE` 和 `VITE_ZHIHU_USERNAME` 配在 Pages 的 **Environment variables** 里，不要提交这个文件。

**接 Cloudflare Pages 时的配置**（Git 集成）：

| 配置项 | 值 |
|---|---|
| Root directory | **留空**（仓库根） |
| Build command | `pnpm --filter web build` |
| Output directory | `apps/web/dist` |

Root 一定要留空。设成 `apps/web` 会让 `pnpm install` 找不到 workspace 根，因为 `shared` 是 `workspace:*` 依赖。

### 6. 填 cookie

打开 `https://<前端域名>/auth`，按页面提示把 cookie 整行粘进去，保存。状态变成「已登录」就通了。

取 cookie 的方法：

1. 浏览器登录 `zhihu.com`，按 `F12`
2. 切到 `Network`，刷新页面，点任意一条 `zhihu.com` 的请求
3. 右侧 `Headers` → `Request Headers` → 找 `cookie:`，复制冒号后面整行

`z_c0` 是 HttpOnly cookie，`document.cookie` 读不到，只能从 Network 里拿。

---

## 日常维护

**cookie 失效时**：打开 `/auth`，重新贴一次。页面会显示上次 Apify run 的状态，`FAILED` 通常就是 cookie 过期了。

**手动触发一次抓取**：

```bash
curl -X POST "https://<worker>/api/sync/full?target=all" \
  -H "authorization: Bearer <API_SECRET>"
```

**定时抓取**：在 `wrangler.toml` 的 `[triggers]` 里改，默认 `0 2,14 * * *`（UTC，即北京 10:00 / 22:00）。每次触发都是一次真实 Apify run，会产生费用。

---

## API

只读接口都不需要鉴权；写接口需要 `Authorization: Bearer <API_SECRET>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/contents?page=&q=&type=&author=` | 内容列表（分页 50） |
| GET | `/api/contents/:pk` | 详情（正文从 R2 注入） |
| GET | `/api/contents/:pk/comments` | 评论树数据 |
| GET | `/api/collections` | 收藏夹列表 |
| GET | `/api/collections/items?page=` | 收藏条目 |
| GET | `/api/collections/:id` | 收藏夹详情 |
| GET | `/api/changes?limit=&exclude_comments=&only_comments=` | 变更时间线 |
| GET | `/api/changes/sync-runs` | 同步记录 |
| GET | `/api/upvotes?page=` | 赞同记录 |
| GET | `/api/stats` | 汇总统计 |
| POST | `/ingest/content` | 写入内容（Apify 调用） |
| POST | `/ingest/comments` | 写入评论 |
| POST | `/ingest/collection-snapshot` | 写入收藏夹快照 |
| POST | `/ingest/upvote` | 写入赞同记录 |
| POST | `/api/sync` `/fast` `/full?target=` | 触发 Apify run |
| GET | `/api/auth/zhihu-status` | cookie 状态 + 上次 run 结果 |
| POST | `/api/auth/zhihu-cookie` | 保存 cookie（网页表单） |
| POST | `/api/auth/zhihu-cookie/clear` | 清除 cookie |

`pk` 格式是 `answer:123` / `article:456` / `pin:789`。

---

## 环境变量

| 名称 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `database_id` | `wrangler.toml` | ✅ | `d1 create` 返回的 UUID |
| `WORKER_URL` | `[vars]` | ✅ | Worker 公网地址，Apify 回传用 |
| `ZHIHU_USERNAME` | `[vars]` | ✅ | 知乎 url_token |
| `ALLOWED_ORIGIN` | `[vars]` | 线上必填 | 前端域名，逗号分隔；留空只放行 localhost |
| `API_SECRET` | secret | ✅ | Apify 回传、手动触发的 Bearer |
| `APIFY_TOKEN` | secret | ✅ | Apify API token |
| `APIFY_ACTOR_ID` | secret | ✅ | `username~actor-name` |
| `ZHIHU_COOKIE_STRING` | secret | ❌ | 兜底用；D1 里有 cookie 时优先用 D1 |
| `COOKIE_WRITE_TOKEN` | secret | ❌ | 配了之后 `/auth` 需要填口令才能提交 |

前端只需要 `VITE_API_BASE` 和 `VITE_ZHIHU_USERNAME`。

---

## 常见问题

| 现象 | 原因 |
|---|---|
| 网页提交 cookie 返回 500 | `d1 migrations apply` 没跑，`app_settings` 表不存在 |
| 页面所有请求被浏览器拦 | `ALLOWED_ORIGIN` 没填或填错（不带协议/多了斜杠都算错） |
| 触发同步报 `WORKER_URL is not configured` | `wrangler.toml` 里还是 `example.workers.dev` 占位符 |
| Apify 显示成功但库里没数据 | Actor 拿不到 `apiSecret`，回传全 401。检查 `INPUT_SCHEMA.json` 是否声明了该字段，以及 Worker 是否配了 `API_SECRET` |
| 详情页正文空白 | R2 没绑定，或历史数据的 key 还是旧的 `html/{pk}`（代码有回落，理论不会空） |
| 数据一直不更新 | cookie 过期。看 `/auth` 页的「上次 Apify 同步」状态 |
| 评论被大量标记删除 | 不该发生。抓取不完整时会带 `partial`，服务端会跳过删除检测；若出现请检查 Actor 的 `paging.is_end` 判断 |

---

## 已知限制

- 正文版本快照存在 R2 的 `versions/` 下，前端暂时**没有**历史版本对比界面
- 收藏夹被彻底清空时，本地不会把旧条目标记为移除（避免权限异常导致误删）
- Apify run 失败只在 `/auth` 页显示状态，没有主动告警
- 搜索是 `LIKE '%keyword%'`，数据量到十万级会慢，届时需要换 FTS5
- `apps/api` 与 `apps/collector` 是早期实现，已不在链路里，保留只为参考

---

## 安全说明

- 仓库建议保持 **private**
- `.env`、`data/`、`.wrangler/`、`node_modules/` 都在 `.gitignore` 里，**不要**强行提交
- 知乎 cookie 只存在 D1，`/api/auth/zhihu-status` 只返回项数和时间，**不返回明文**
- `/api/auth/zhihu-cookie` 默认允许网页直接提交（方便你随时换 cookie）。介意的话配一个 `COOKIE_WRITE_TOKEN`，之后需要口令才能写入
- 如果 cookie 曾经明文落在磁盘或截图里，去知乎「退出所有设备」轮换一次，比改代码更有效

---

## 技术栈

Cloudflare Workers · Hono · D1 · R2 · Apify · Crawlee · Playwright · React 19 · Vite · TypeScript · zod · pnpm workspace
