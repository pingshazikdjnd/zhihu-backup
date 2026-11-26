# 系统架构设计与数据契约

本文档面向项目维护者与后续协作开发，梳理当前代码库（`apps/worker`、`apps/apify-crawler`、`apps/web`、`packages/shared`）的核心存储契约、状态机、缓存架构、外部多云联邦、AI 路由、风控协议与安全边界。

---

## 1. D1 表结构与 R2 Key 命名规范

### 1.1 主 Cloudflare D1 表与关键索引（migrations `0000` ~ `0006`）

| 表名 | 引入迁移 | 用途与关键字段 | 核心索引 |
|---|---|---|---|
| `contents` | `0000` / `0006` | 内容元数据与检索索引。`pk`（`answer:123` / `article:456` / `pin:789`）、`content_html`（置空，原文在 R2）、`content_md`（4000 字纯文本检索）、`content_hash`（SHA-256）、`comment_count`（现网评论数）、`archived_comment_count`（单调归档评论水位，`0006` 新增） | `idx_contents_type_updated`、`idx_contents_last_seen`、`idx_contents_type_last_seen`、`idx_contents_author_token`、`idx_contents_author_name`、`idx_contents_deleted_type` |
| `content_versions` | `0000` | 正文或标题/状态变化时的版本元数据快照（`content_html`/`content_md` 留空，正文在 R2） | `idx_content_versions_pk_time` |
| `comments` | `0000` / `0004` | 双层评论主表：新链路只写入根评论（`parent_comment_id IS NULL`），`child_count` 记录楼中楼数（`0004` 新增）；保留历史扁平子评论行读取兜底 | `idx_comments_content_pk`、`idx_comments_parent`、`idx_comments_last_seen`、`idx_comments_deleted`、`idx_comments_content_seen` |
| `comment_versions` | `0000` | 历史遗留表（当前写入链路已全面停写，仅作历史兼容保留） | `idx_comment_versions_comment` |
| `comment_threads` | `0004` | 根评论 → R2 楼中楼索引与预览缓存。含 `root_id`、`content_pk`、`r2_key`、`child_count`、`is_complete`（`0/1/2`）、`thread_hash`、`incoming_hash`、`preview_json`、`synced_at` | `idx_comment_threads_content` |
| `collections` | `0000` | 收藏夹基本元数据 | — |
| `collection_items` | `0000` / `0004` | 收藏夹条目及移除状态（`is_removed`、`removed_at`） | `idx_collection_items_collection`、`idx_collection_items_removed`、`idx_collection_items_content_removed` |
| `collection_snapshots` | `0000` | 收藏夹每次变更快照计数 | `idx_collection_snapshots_collection` |
| `upvotes` | `0000` | 赞同记录（`content_pk` 唯一，`upvote_time`） | `idx_upvotes_time` |
| `followed_users` | `0003` | 关注答主名录与 `sync_mode`（`default` / `full`） | `idx_followed_users_mode` |
| `image_tasks` | `0005` | 正文图片异步下载队列（`content_pk`、`image_url`、`object_key`、`status`、`attempts`、`last_error`） | `idx_image_tasks_status`、`idx_image_tasks_object` |
| `change_events` | `0000` | 变更事件时间线；评论事件 `payload_json` 仅存 `{ commentId, contentPk }` 引用 | `idx_change_events_time`、`idx_change_events_content`、`idx_change_events_type_time` |
| `app_settings` | `0001` | 运行态 KV 配置（`zhihu_cookie`、`cookie_write_token`、`sync_config`、`fallback_ai_api_key`、`external_storage_targets`、`upvotes_cursor`、`sync_lock`、`apify_last_run`、`ai_daily_neuron_budget` 等） | `key` 主键 |
| `sync_runs` | `0000` | 云端 Apify 触发与运行结果日志 | — |

### 1.2 Cloudflare R2 对象键命名规范

| R2 Key 前缀/路径 | 内容格式 | 写入与缓存策略 |
|---|---|---|
| `html/{pk}/{hash}` | HTML 文本 | 正文入库写入（先 `HEAD` 兜底 `putIfAbsent`，避免重复 Class A）；读取走不可变一年边缘缓存；已取消 `versions/` 双写 |
| `html/{pk}` | HTML 文本（历史键） | 仅只读兼容回落（TTL 3600s），不再新增写入 |
| `md/{pk}/{hash}` / `md/{pk}` | Markdown 文本 | 若入库载荷含 `contentMd` 则写入；详情页 HTML 命中时跳过读取以省 Class B |
| `childcomments/{rootId}.json` | `{ children, complete, updatedAt }` | 楼中楼子评论完整 JSON；写后立刻调用 `purgeR2EdgeCache` 驱逐两层缓存 |
| `images/{sha256}.{ext}` | 二进制图片 | 图片身份为 URL `pathname` 剥离 `_Nw` 后的 SHA-256；由 `image_tasks` 异步流式写入，1 年 `immutable` 缓存 |
| `meta/followed_users.json` | JSON Map | 关注答主名录、`sync_mode`、断点 `resume_offset` / `history_done` / `last_checked_answer_id` 的权威源 |
| `meta/sync_config.json` | JSON | 同步策略（4 板块评论模式、灵敏度、AI 偏好模型、图片质量、反代 Base URL/Model；**不含** `fallbackAiApiKey`） |
| `meta/external_storage_targets.json` | JSON Array | 外部多云存储配置数组（与 D1 按 `updatedAt` 择新，并带 `customMetadata.updatedAt` 与 ETag CAS） |
| `meta/ai-risk/{pkSafe}.{digest}.v2[.wiped].json` | JSON | 单篇 AI 风险评估永久缓存；包含正文摘要与清评标记 `.wiped`，避免旧缓存掩盖清评变化 |
| `meta/ai-following/{sha256}.json` | JSON | 关注答主单篇批量 AI 复核缓存（哈希种子：`sourceId\|sourceType\|title\|excerpt`，不含动态点赞数） |
| `meta/ai-budget/{YYYY-MM-DD}.json` | `{ day, used, budget, updated_at }` | 每日 Workers AI Neurons 估算消耗账本（按 UTC 日切分） |
| `meta/ai-fail/{key}.json` | `{ failedAt, models }` | Workers AI 模型链全部失败后的 5 分钟冷却标记（`single-*` / `following-*`） |

### 1.3 外部 SQLite 扩容库自动建表（Turso / 跨账号 D1）

启用 `offload` / `overflow` 时，Worker 会在目标库幂等初始化以下表（见 [apps/worker/src/routes/auth.ts](../apps/worker/src/routes/auth.ts)）：
- `comments`、`comment_threads`：结构与主 D1 对齐（无主库 `contents` 外键约束）
- `child_comment_blobs`：`root_id` 主键、`content_pk`、`payload_json`、`complete`、`updated_at`（替代主 R2 的 `childcomments/*`）
- `content_blobs`：`pk` 主键、`content_hash`、`content_html`、`updated_at`（替代主 R2 的 `html/*`）
- `zhihu_backup_mirror`：`mirror` 异步灾备或无法承担同步分流的 Provider 写入的表（`scope`, `entity_key`, `payload_json`, `synced_at`）

---

## 2. 双层评论存储与防删归档状态机

核心实现位于 [apps/worker/src/services/comments.ts](../apps/worker/src/services/comments.ts)。

### 2.1 写入顺序与快路径 0 写判定

1. **写入固定顺序**：`D1 根评论 (comments)` → `R2 楼中楼 (childcomments/{rootId}.json)` → `D1 线程索引 (comment_threads)`。R2 PUT 失败时不回滚已写入的根评论，只将线程 `is_complete` 置为 `0`（或保留既有的闭评冻结态 `2`）供后续补抓。
2. **输入指纹快路径（0 写）**：计算 `incomingHash = sha256({ children, childCount, complete, ...(closed ? { closed: true } : {}) })`。若 `comment_threads` 中记录的 `incoming_hash`、`child_count`、`is_complete`、`thread_hash` 均已满足要求，则跳过 R2 GET/PUT 与 `comment_threads` 更新；若 R2 内容实际未变（`thread_hash === nextThreadHash`），亦跳过 R2 PUT。
3. **预览生成（`preview_json`）**：每根提取前 `2` 条子评论，优先存活回复，不足时用已删归档回复补足，单条正文截断至 `120` 字符。列表页 `GET /api/contents/:pk/root-comments` 直接读取 `preview_json`，展开前产生 **0 次 R2 Class B 读取**。

### 2.2 防删归档与双水位机制

1. **根评论防删与全量清零**：
   - 全量同步（`partial=false`）对账时，原站不再返回的旧根评论不物理删除，而是标记 `is_deleted = 1` 并记录 `deleted_at`。
   - 当原站将整篇内容的评论彻底清零（`!partial && roots.length === 0 && allRootIds.length === 0`）时，Worker 统计已归档根评论与线程历史 `child_count` 之和，将 `contents.archived_comment_count` 单调推高为 `MAX(archived_comment_count, comment_count, archivedTotal)`，同时将 `contents.comment_count`（现网数）置为 `0`。
2. **子评论防删合并（`archiveMergeChildren`）**：
   - 无论本次是否抓全，只要存在旧线程或旧扁平 D1 子评论，先强一致读回已有子评论（绕过边缘缓存）；读失败时严禁盲写覆盖旧对象。
   - 本次返回的子评论覆盖更新并清除 `isDeleted`；当 `isChildrenComplete = true` 时，历史存在但本次未返回的回复标为 `isDeleted: true` 永久留存；当 `partial` 或遇闭评时，原样保留既有子评论。
3. **双水位展示与风险评估分离**：
   - 列表与详情展示的 `comment_count` 取 `MAX(comment_count, archived_comment_count)`，保证原站删评或清评后页面评论数不归零；详情页同时返回 `live_comment_count`（现网数）。
   - `evaluateContentRisk` 读取 `live_comment_count ?? comment_count`，确保原站清评后「千赞零评 / 高赞零评」预警信号不会因归档水位而失效。

### 2.3 闭评三态与 `live_only=1` 跨库收敛探测

- **`comment_threads.is_complete` 三态**：
  - `0`：未抓全 / 落盘失败，爬虫下次同步须重试。
  - `1`：已完整抓全（`isChildrenComplete = true`）。
  - `2`：闭评冻结收敛（知乎返回 `403 code=106` 或 `200 comment_status.type=1`）；后续不再反复触发重抓，直到楼中楼重开并抓全时才升为 `1`。
- **`live_only=1` 与 `has_incomplete_roots`**：
  - `listRootComments` 单页上限为 `50` 根（受 D1 100 绑定参数上限限制）。当爬虫请求 `live_only=1` 探测还需重试的活根时，第 50 根之后的未完成线程不会出现在第一页。
  - 服务端通过 `probeIncompleteLiveRoot`（三态：`incomplete` / `complete` / `unknown`）在**当前实际写入库**执行 `SELECT 1 ... LIMIT 1` 探测；当存在可读外部扩容库时，逐一核对非活跃库中的待重试活根在当前实际写入库是否已有不早于它的明确收敛证据（软删根或 `is_complete IN (1, 2)`），并在快路径命中时按需刷新活跃库时间戳（`planInactiveIncompleteRefreshes`），彻底消除跨库切换后的死循环重抓或误跳过。

---

## 3. 正文图片异步本地化链路

核心实现位于 [apps/worker/src/services/images.ts](../apps/worker/src/services/images.ts) 与 [apps/worker/src/services/image-tasks.ts](../apps/worker/src/services/image-tasks.ts)。

1. **纯 CPU 确定性改写**：
   - `/ingest/content` 调用 `prepareContentImages`：仅匹配 `https://*.zhimg.com` 域名且 URL 含合法扩展名（`jpg/jpeg/png/gif/webp/avif/bmp/svg/heic/heif`）的 `<img src>`，单篇最多处理 `50` 张。
   - 图片身份串 = `pathname` 剥离 `_Nw` 尺寸后缀；`objectKey = images/{sha256(身份串)}.{ext}`，HTML 立即改写为 `/api/images/{sha256}.{ext}`。因路径确定，重复入库不会使 `content_hash` 抖动。
2. **`image_tasks` 状态机**：
   - 状态流转：`pending` → `processing` → `done` / `failed`。
   - 失败重试上限 `MAX_IMAGE_TASK_ATTEMPTS = 3`；`processing` 超过 `10 分钟`视为执行者死亡可被重新领取；`failed` 行经过 `6 小时`冷却期且再次入库同一内容时，可通过 CAS 更新重置 `attempts = 0` 并刷新签名 URL 重新排队。
3. **子请求预算与内存保护**：
   - 路由 `POST /ingest/image-batch` 单批上限钳制为 `8`（默认 `6`），确保含冷启动读设置 + 尺寸变体 404 回退原图的最坏情况仍控制在 **48 次以内**，低于 Workers Free 单请求 50 子请求上限。
   - `/ingest/content` 响应后通过 `executionCtx.waitUntil` 触发 isolate 内单飞 `kickImageDrain`（单次最多消化 `4` 张）。
   - 全局并发槽位锁限制整个 isolate 并发下载数 `IMAGE_FETCH_CONCURRENCY = 4`；单图超时 `10s`、体积上限 `10MB`，存在 `content-length` 时直接流式写入 R2，避免 JS 堆内存爆栈。
4. **三档画质与安全读取**：
   - 支持 `original`（原图）、`high`（`_1440w`）、`compressed`（`_720w`），非原图仅作用于位图（`jpg/jpeg/png/webp`），变体不可用时自动回退原图。
   - `GET /api/images/*` 以正则 `/^[a-f0-9]{64}\.[a-z0-9]{2,5}$/` 严防目录穿越；本地未落盘且任务非 `done` 时安全 `302` 重定向至 `https://*.zhimg.com` 原始外链；`.svg` 强制 `Content-Disposition: attachment` 与 `Content-Security-Policy: default-src 'none'; sandbox`。

---

## 4. R2 两层边缘缓存与写入降本策略

### 4.1 两层边缘缓存（[apps/worker/src/utils/r2-cache.ts](../apps/worker/src/utils/r2-cache.ts)）

1. **进程内 `Map` 缓存（Layer 1）**：
   - 按 UTF-16 估算总字节封顶 `16 MB`、单条上限 `64 KB`（大 HTML 跳过内存仅走边缘缓存）、条目硬上限 `500`，按 `bucket` 实例隔离，消除 `wrangler dev` / 单测或同 isolate 内重复读取。
2. **Cloudflare `caches.default`（Layer 2）**：
   - 带 `content_hash` 的正文 `html/{pk}/{hash}` 标为 `public, max-age=31536000, immutable`。
   - 楼中楼 `childcomments/*` 使用 `/v2/` 虚拟缓存路径前缀并默认缓存 24 小时；每次写路径覆盖或更新楼中楼后**强制执行 `purgeR2EdgeCache`**，保证写入即刻可见。

### 4.2 全栈写放大治理清单

- **停写 `comment_versions`**：消除每轮同步评论的无效版本表行膨胀。
- **裁剪 `change_events` 载荷**：评论事件在入库阶段剥离完整评论体，仅存 `{ commentId, contentPk }`；`/api/changes` 查询剥离 `payload_json`。
- **取消 `versions/` 双写 + `HEAD` 兜底**：R2 正文不再双写 `versions/` 前缀，写入 `html/{pk}/{hash}` 与 `md/{pk}/{hash}` 前通过 `HEAD` 存在即跳过（0 次重复 Class A PUT）。
- **字段与哈希归一化**：正文哈希忽略知乎图片 CDN 子域轮换（`pic1`/`picx` 等）与 `<img src>` 尺寸后缀/签名参数；头像比较通过 `normalizeAvatarUrlForCompare` 忽略 CDN 子域与签名抖动。
- **三路更新分级 & 四类 0 写快路径**：
  - `contents` 仅点赞/评论/收藏/浏览计数或作者资料变动时走轻量 `UPDATE`（不写版本、不发事件、`changed: false`）；完全未变则 **0 SQL UPDATE**。
  - `collections` 完全重复快照 **0 写跳过**；`upvotes` 时间未变 **0 写跳过**；`followed_users` 业务字段无变化 **0 D1 写**；`comments` 输入指纹一致 **0 R2/D1 写**。

---

## 5. 外部多云存储联邦架构

核心实现位于 [apps/worker/src/routes/auth.ts](../apps/worker/src/routes/auth.ts)、[apps/worker/src/routes/ingest.ts](../apps/worker/src/routes/ingest.ts)、[apps/worker/src/routes/contents.ts](../apps/worker/src/routes/contents.ts) 与 [apps/worker/src/services/comments.ts](../apps/worker/src/services/comments.ts)。

### 5.1 Provider、角色与路由矩阵

最多支持 **10 个** 外部存储节点，配置双写至 D1 `app_settings.external_storage_targets` 与 R2 `meta/external_storage_targets.json`（读时按时间戳择新，isolate 内缓存 60 秒）。

| Provider | 同步分流（`offload` / `overflow`）支持范围 | `mirror` / 兜底异步转发 |
|---|---|---|
| `turso` | `contents`（`content_blobs`）、`comments`（完整双层表结构，单批 `/v2/pipeline` 只占 1 个子请求） | `zhihu_backup_mirror` |
| `cloudflare_d1` | `contents`、`comments`（REST `/query` 逐条串行，整批共享可取消超时） | `zhihu_backup_mirror` |
| `s3_r2` | `contents`（`html/{pk}/{hash}` 对象 PUT/GET） | `<bucket>/<scope>/<entityKey>.json` |
| `supabase` | 不参与主路径分流（自动降级为异步转发） | REST `zhihu_backup_mirror` |
| `webhook` | 不参与主路径分流（自动降级为异步转发） | `POST <endpointUrl><eventPath>` |

- **`offload`（直接分流扩容）**：命中该范围的第一个启用目标直接承接写入，主 D1 评论相关表与主 R2 对应大对象 **0 写入**（主 D1 `contents` 仍保留轻量检索元数据）。
- **`overflow`（主库满额溢出）**：主 D1 `SELECT COUNT(*) FROM comments` 达到 `overflowThresholdRows`（默认 `1,500,000` 行，上限 `1,000,000,000`）时自动切换为 `offload`。行数缓存有效期 5 分钟，并与配置指纹 `configVersion` 强绑定。
- **`mirror`（双写灾备）**：主库正常写入后，通过 `executionCtx.waitUntil` 异步复制一份到外部目标。

### 5.2 跨库透明回读与失败降级

- **写入失败降级**：`offload` / `overflow` 写入外部库失败时，立刻降级回写主 D1 / 主 R2，绝不丢失已抓到的数据。
- **读取透明回源**：
  - 正文详情：主 R2 `html/{pk}/{hash}` → 外部可读 `contents` 分流目标 → 主 R2 旧键 `html/{pk}` → `md/`。
  - 根评论分页：主 D1 有行则读主 D1，主 D1 为空或跨界分页时透明查询外部可读 `comments` 分流库并与主 D1 既有根 ID 跨目标去重切片。
  - 楼中楼展开：外部可读 `comments` 分流库（`child_comment_blobs` 优先，缺失回查扁平子评论行） → 主 R2 `childcomments/{rootId}.json` → 主 D1 历史行。

### 5.3 CAS 并发控制与 SSRF 防护

- **双层 CAS 乐观锁**：更新/删除外部节点配置时，D1 通过 `WHERE updated_at = ?`（新建 `INSERT OR IGNORE`）实现 CAS；D1 不可用降级写 R2 时，强制使用 R2 原生 `onlyIf: { etagMatches | etagDoesNotMatch }`，最多重试 `2` 次，冲突返回 `HTTP 409`。
- **SSRF 防护**：
  - 仅允许 `http://` / `https://`，禁止 URL 内嵌用户名/密码，全部外部 `fetch` 使用 `redirect: "manual"`。
  - **永久拦截**：云元数据地址（`169.254.169.254`、`100.100.100.200`、`fd00:ec2::254`、IPv4-mapped IPv6 归一化形式、`metadata.google.internal`、`metadata`）。
  - **生产拦截（仅本地 `localhost`/`127.0.0.1`/`::1` 请求允许用于联调 mock）**：内网、回环、链路本地、CGNAT（`100.64.0.0/10`）、IPv6 ULA/LLA（`fc00::/7`、`fe80::/10`、`64:ff9b::`）等地址。

---

## 6. AI 路由与额度保护

核心实现位于 [apps/worker/src/services/recommend.ts](../apps/worker/src/services/recommend.ts)。

1. **Workers AI 模型链**：
   - 免费模型链：`@cf/qwen/qwen3-30b-a3b-fp8`（默认首选）、`@cf/meta/llama-3.3-70b-instruct-fp8-fast`、`@cf/meta/llama-3.1-8b-instruct-fp8`。
   - 付费可选模型（仅用户在设置页显式配置 `preferredAiModel` 时才放首位尝试）：`@cf/deepseek-ai/deepseek-v4.1-flash-1017`、`@cf/zai-org/glm-5.3-flash`。
   - 每次调用最多尝试 `2` 个模型，自动剥离 `<think>...</think>` 思考过程。
2. **每日预算账本与冷却**：
   - 默认每日上限 `6000` Neurons（可通过 D1 `app_settings.ai_daily_neuron_budget` 覆盖，最大钳制 `100,000`）。
   - 单篇深度鉴定预估扣 `60` Neurons，关注答主批量复核（最多 10 条/批）预估扣 `150` Neurons；进程内累加，每 3 次调用或每 60 秒落盘 R2 `meta/ai-budget/{YYYY-MM-DD}.json`（先读盘取较大值）。
   - 若本批模型链全部失败，写入 R2 `meta/ai-fail/*` 进行 `5 分钟` 冷却。
3. **OpenAI 兼容反代替补引擎与最终规则兜底**：
   - 当 Workers AI 未绑定、处于 5 分钟失败冷却或每日 Neurons 预算耗尽时，自动改走 OpenAI 兼容接口（`POST {baseUrl}/chat/completions`，默认模型 `deepseek-v4.1-flash`，超时 `25s`，网络/5xx 冷却 `60s`）。
   - 反代连接同样受 SSRF 约束：仅放行公网 `https://` 与本机回环 `http://`。其 API Key 独立存 D1 `app_settings.fallback_ai_api_key`（或环境变量 `FALLBACK_AI_API_KEY`），任何 GET 接口仅暴露布尔标记 `hasFallbackAiKey`。
   - 若反代也未配置或调用失败，最终退回 `evaluateContentRisk` / 灵敏度阈值规则兜底，**绝不中断前端浏览或后台采集**；规则兜底与预算耗尽结果不写入 R2 缓存，恢复后可重新评估。

---

## 7. 爬虫风控与分布式租约锁

### 7.1 知乎请求统一节流与风控状态机（[apps/apify-crawler/src/zhihu-fetch.ts](../apps/apify-crawler/src/zhihu-fetch.ts)）

- **401 登录失效**：立刻抛出 `auth` 失败并置 `riskExhausted = true`（不浪费重试）。
- **可重试风控态**（`403`、`408`、`425`、`429`、`5xx`、HTTP 200 非 JSON、以及非 `allowEmptyPage` 且非闭评的 `200 data:[] + !paging.is_end`）：
  - 单请求最多重试 `2` 次，优先读取 `Retry-After`（封顶 `120s`），否则默认 `60s` 附带 `±10%` 随机抖动。
  - 整轮运行累计暂停预算封顶 `15 分钟`；连续 `3` 个不同请求耗尽重试即判定账号级风控（置 `riskExhausted = true`）安全终止后续知乎请求。
- **特殊状态识别**：
  - **40352 人机验证**（`code=40352` 或 `/account/unhuman`）：不原地等待重试，立即置 `riskExhausted = true` 停机交由编排脚本冷却或提醒人工滑块验证。
  - **闭评响应**：`403 code=106 / 评论已关闭` 或 `200 comment_status.type=1` 立即放行且豁免风控计数。
  - **410 已注销账号**：不计入失败，关注答主链路直接标记收敛完成不再重复重试。
  - **`voteups` 合法空页**：通过 `allowEmptyPage: true` 放行知乎静默过滤列表的尾页空响应。

### 7.2 分布式 CAS 同步锁与退出码语义

- **分布式租约锁（[apps/worker/src/routes/sync.ts](../apps/worker/src/routes/sync.ts)）**：
  - 基于 D1 `app_settings.sync_lock` 存储 JSON `{"ownerId","source","acquiredAt","expiresAt"}`，默认租约 `15 分钟`。
  - 抢锁采用单条 `ON CONFLICT DO UPDATE ... WHERE` CAS SQL（自动兼容 `json_valid = 0` 的历史裸字符串锁），异常时 fail-closed；爬虫回传 `/ingest/*` 时携带 `x-sync-owner` 自动异步续租，释放锁严格校验 `ownerId`。
- **爬虫退出码语义（[apps/apify-crawler/src/main.ts](../apps/apify-crawler/src/main.ts)）**：
  - `0`：正常完成（或带 `partial_risk_controlled` 终态状态消息的断点部分完成）。
  - `1`：致命异常、401/风控且零数据入库、或 Worker 入库全失败。
  - `2`：触发连续 5 次入库失败断路器或云端 D1 每日写入预估上限安全刹车（保留断点）。
  - `130`：收到 `SIGINT`/`SIGTERM` 且成功排空在途写入并释放云锁后优雅退出。
  - `131`：中止排空超时强制中止在途请求，**故意保留云端锁**（待 15 分钟租约自然过期），防止新实例与未确认结束的在途写操作并发撞库；`local-sync.mjs` 收到 `131` 或强杀子进程后同样跳过释放云端锁。

---

## 8. 安全边界

1. **Cloudflare Pages 网关（[apps/web/public/_worker.js](../apps/web/public/_worker.js)）**：
   - 仅对 `text/html` 响应注入严格安全头：`Content-Security-Policy`（`default-src 'self'; img-src 'self' data: https:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`）、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`。二进制图片与 JSON API 响应保持原样。
   - `/ingest/*` 仅对携带 `Authorization: Bearer <token>` 的请求转发至 `env.API`，无凭据直接返回 `404`。
2. **Worker 鉴权体系（fail-closed）**：
   - `/ingest/*`、`/api/sync/*` 与 `/api/recommend/evaluate-following` 通过 `API_SECRET` 强鉴权（未配置直接 `503`）。
   - 管理写接口（`authorizeWrite`）要求携带有效 Bearer（匹配 `API_SECRET` 或三级口令：D1 `cookie_write_token` > `COOKIE_WRITE_TOKEN` > `API_SECRET`），且带 `Origin` 时必须命中 `ALLOWED_ORIGIN`。
   - `READ_AUTH_REQUIRED="true"` 时开启全站读鉴权，仅豁免 `/api/health`、`/api/auth/zhihu-status` 与 `/api/images/*`。
3. **前端凭据与 XSS 防护**：
   - [apps/web/src/lib/api.ts](../apps/web/src/lib/api.ts)：`localStorage` 中保存的写口令仅在目标 URL **严格同源**且调用方未显式传 `Authorization` 时自动附带，绝不向跨源 `VITE_API_BASE` 外发管理凭据。
   - [apps/web/src/lib/sanitize.ts](../apps/web/src/lib/sanitize.ts)：先剥离 Unicode 双向控制符（如 U+202E 防文件名/文本视觉欺骗），再通过 `DOMPurify` 白名单清洗并禁掉内联事件与 `style`/`srcset`，为所有 `<img>` 强制加 `referrerpolicy="no-referrer"`，为外链强制加 `target="_blank"` 与 `rel="noopener noreferrer nofollow"`。
   - 传入 AI Prompt 的正文与标题均经 `<DATA>...</DATA>` 分隔符包裹并转义闭合标签，防止提示词注入。
