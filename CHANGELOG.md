# 更新日志

## Unreleased（2026-10-28 ~ 2026-11-23）

### 评论双层存储与防删归档

- **双层存储架构（migration `0004_comment_threads.sql`）**：根评论留存 D1 `comments`，完整楼中楼子评论外置至 R2 `childcomments/{rootId}.json`，并在 D1 `comment_threads` 维护每根的完整度标记、哈希指纹及前 2 条回复预览（`preview_json`，每条截断 120 字），详情页打开即可先渲染预览、按需懒加载并支持分批折叠（首展 5 条 + 每次加载 10 条）。
- **`comment_v5` 游标分页统一**：回答与专栏文章全面切换至 `comment_v5` 游标分页（全量按 `order_by=ts` 防止 `score` 排序在约 200 根处假终止，热评按 `score`），彻底解决高评论内容被旧版 v4 截断在 20 条的问题。
- **防删归档与闭评三态（migration `0006_archived_comment_count.sql`）**：新增单调水位 `contents.archived_comment_count` 与现网 `comment_count` 分离；原站删评/清评后不再物理删除已归档根评论与楼中楼，而是对根评论置 `is_deleted = 1`、对子评论通过 `archiveMergeChildren` 标注 `isDeleted: true` 合并保留，前端渲染「已删除」徽标；支持 `is_complete` 三态（`0` = 待重试、`1` = 已抓全、`2` = 闭评冻结收敛）。
- **跨库收敛与全页重试探测**：`/api/contents/:pk/root-comments?live_only=1` 新增三态 `probeIncompleteLiveRoot`（`incomplete` / `complete` / `unknown`），确保第 50 根之后仍存在未完成活根或外部扩容库存在分叉状态时不会被错误跳过或误吞重试信号。

### 正文图片异步本地化

- **异步任务队列解耦（migration `0005_image_tasks.sql`）**：将图片网络下载从 `/ingest/content` 剥离；入库阶段仅做纯 CPU 的确定性 `<img src>` 改写（`/api/images/{sha256}.{ext}`，基于 URL `pathname` 剥离 `_Nw` 后缀计算 SHA-256，单篇上限 50 张）与 `image_tasks` 入队，保证重复入库时 `content_hash` 零抖动。
- **内存安全与预算控制**：`images.ts` 实现跨请求共享的全局并发闸门（并发上限 4）、单图 10MB 体积上限、10s 超时中止与流式 `BUCKET.put`，根治 Worker 内存溢出；`/ingest/image-batch` 单批路由上限下调至 8，确保单次调用稳定在 Workers Free 50 子请求预算以内。
- **三档画质与安全回退**：支持设置原图（`original`）、高质量 `_1440w`（`high`）、省空间 `_720w`（`compressed`），尺寸变体 404 时自动回退原图；本地对象未就绪时 `GET /api/images/*` 302 安全回退到任务表原始 `https://*.zhimg.com` 外链，`.svg` 强制附件下载与沙箱 CSP。

### 外部多云存储与联邦读写

- **多节点管理与三模式分流**：支持在设置页挂载最多 10 个外部节点（Turso、跨账号 Cloudflare D1、Supabase、S3/R2 兼容、Webhook），提供 `offload`（直接分流扩容，主库零写）、`overflow`（主 D1 评论行达到默认 `1,500,000` 阈值后自动溢出分流，行计数缓存绑定配置版本 `configVersion`）、`mirror`（主库照写 + 异步双写灾备）。
- **跨库透明回读与并发一致性**：正文 HTML 与双层评论读取支持按优先级跨主库与外部库透明回源，外部写入异常自动降级写回主库防丢；外部节点配置采用 D1 `updated_at` + R2 `onlyIf` ETag 双层 CAS 乐观锁；远程 SQL 执行接入可取消超时，保存与探测路径内置严格 SSRF 校验。

### AI 体系与推荐能力升级

- **模型链更新与额度保护**：Workers AI 模型升级为 `@cf/qwen/qwen3-30b-a3b-fp8`（默认免费）、`@cf/deepseek-ai/deepseek-v4.1-flash-1017`、`@cf/zai-org/glm-5.3-flash`、`@cf/meta/llama-3.3-70b-instruct-fp8-fast`（免费回退链含 `@cf/meta/llama-3.1-8b-instruct-fp8`）；新增 R2 每日 Neurons 预算账本（`meta/ai-budget/`，默认 6000 neurons/天）与 5 分钟失败冷却（`meta/ai-fail/`）。
- **OpenAI 兼容反代替补引擎与关注复核**：Workers AI 额度耗尽、未绑定或模型链失效时自动降级调用 OpenAI 兼容反代接口（默认模型 `deepseek-v4.1-flash`，Key 独立存 D1 app_settings（不写 R2、永不回传前端）），最后退回规则兜底；新增 `POST /api/recommend/evaluate-following` 批量 AI 复核关注答主高潜敏感内容；推荐规则分同步改为读取现网 `live_comment_count` 以保留高赞零评/清评预警。

### 爬虫、风控与分布式租约锁

- **本人专栏文章与详情补全**：新增本人专栏文章 `articles` 同步（`answers` 与 `all` 结束时自动顺带备份）；补全我的回答浏览量与收藏数详情回源、赞同长正文截断检测与详情回源；重构 `followed_users`（migration `0003_followed_users.sql`）支持首次历史摸底按 `voteups` 无条件保存最热 60 篇（首页空页自动回退 `created` 前 60 篇）、日常 `created` 增量至标记点（上限 400）+ `voteups` 前 20 复核，以及单人一键全量断点续传。
- **风控统一治理（`zhihu-fetch.ts`）**：统一处理 401 即刻失败、403/429/5xx/风控空页/非 JSON 暂停重试（优先 `Retry-After` 封顶 120s，否则 60s ±10%，整轮累计上限 15 分钟）、40352 人机验证快速熔断、410 已注销账号收敛、闭评响应（403 `code=106` 与 200 `comment_status`）豁免重试、`voteups` 排序允许合法空页。
- **分布式 CAS 租约锁与优雅停机**：`app_settings.sync_lock` 升级为 15 分钟 CAS 租约锁（兼容旧裸字符串），爬虫通过 `x-sync-owner` 自动续租；支持信号优雅停机、在途写入排空及退出码 `0` / `1` / `2` / `130` / `131` 精细化锁保护。

### 性能治理、运维工具链、安全与测试

- **R2 两层边缘缓存与全栈零写放大**：新增 `r2-cache.ts`（进程内 16MB/单条 64KB 封顶 Map + `caches.default`，楼中楼 `/v2/` 前缀与写后即时 purge）；停写 `comment_versions`、`/api/changes` 剥离 `payload_json`、取消 `versions/` 双写并改 `HEAD` 兜底 `putIfAbsent`、正文 HTML 哈希与头像 URL CDN 子域/签名归一化、内容/收藏夹/关注名录/评论快路径 0 写；停用云端 Apify Cron（`crons = []`）。
- **本地全量采集与运维脚本工具链**：新增 `full-local-harvest.mjs`（5 阶段本地全量重扒）、`run-comment-repair.mjs`（断点式存量评论补采）、`repair-local-images.mjs`、`download-images-direct.mjs`（纯 Node 并发补下）、`repair-upvotes-and-gaps.mjs`、`verify-local-harvest.mjs`（只读体检对账）与 `upload-to-cloudflare.mjs`（三阶段打包与 `key+etag` 断点续传上云）；加固 `local-sync.mjs` 本地 `wx` 原子锁、代理探测（兼容 Node 20 无 `--use-env-proxy`）与 IPC 软停机。
- **安全边界与自动化测试**：写接口全面 fail-closed，新增可选 `READ_AUTH_REQUIRED` 私有读门禁，Pages `_worker.js` 注入严格 HTML CSP 与 `/ingest/*` Bearer 门禁，前端 `api.ts` 限定仅同源自动携带写口令；新增顶部全局搜索、排序、手机端响应式适配；移除早期遗留的本地旧后端与旧采集目录；将 `db-write-regression`、`script-safety-regression`、`web-safety-regression` 三套测试接入 CI。

---

## 0.1.1（2026-10-25，未发布 tag）

- **修复 Docker 构建链（P0）**：基础镜像换 `apify/actor-node-playwright:24-1.61.1`（原 `:20` 为非 root 用户，`WORKDIR /usr/src/app` 以 root 属主创建导致 npm install 必败）；`package-lock.json` 进镜像 + `npm ci`（原被 .dockerignore 排除导致 playwright 浮动漂移、镜像内浏览器下载 EACCES）；playwright 精确锁定 1.61.1（Apify 要求 tag 与依赖版本严格一致）
- **并发正确性（P1）**：新增按 key 的进程内串行化锁接入三个写服务，消除同 pk 并发写入的静默覆盖（实测 60 并发曾丢失 48 条更新且全部响应 200）
- **安全**：cookie 端点 CSRF 防线（跨站表单 Origin 校验）；sourceUrl 限定 http(s) 协议（zod `.url()` 原放行 `javascript:` 伪协议）；`/api/changes` 剥离 payload_json（5.4MB 匿名响应放大面）；评论悬空 contentPk 返回 404；page/limit 全量钳制
- **数据一致性**：仅改标题的更新会真正落库；收藏项复活补发事件；空头像不再产生假更新事件；检索文本截断改为代理对安全（4 字节 emoji 在 4000 字边界不再被切裂成非法代理）
- **性能**：新增 7 个索引（migration 0002），type 过滤深分页从 3.57s 降至 ~220ms，stats 从全表扫描降至 52ms
- **前端**：窄屏溢出修复、错误提示提取、快照时间本地化、DOMPurify 前剥离双向控制符（RTLO 视觉欺骗面）、favicon、Pages 安全头
- **依赖**：crawler npm 依赖 audit 修复（high 漏洞 15→5，余 5 为上游无解链且不可达）
- **文档**：环境变量表补 CSRF 硬依赖说明；新增「数据备份与恢复」章节（D1/R2 导出与灾难恢复命令）

## 0.1.0（2026-10-25）

首个交付版本。

### 功能

- 备份回答 / 文章 / 想法（pin）的正文与元数据，正文原文存 R2，D1 只存 4000 字纯文本供检索
- 正文按 SHA-256 做版本快照，内容变化自动留历史（R2 `versions/`，前端对比界面暂缺）
- 评论备份（根评论 + 子评论，答主 / 置顶 / 精选标记），抓取不完整时跳过删除对账防误删
- 收藏夹快照追踪（新增 / 移除对账）、赞同记录、全量变更时间线
- cookie 网页维护（`/auth` 粘贴即可，无需重部署），可选购写入口令
- Cloudflare Cron 每天 2 次定时触发 Apify 抓取（可配）

### 可靠性（交付前 6 轮审查 + 实测打磨）

- 抓取失败可见：cookie 失效（401/403）、知乎风控空页、回传全失败、运行异常都会让 Apify run 显示 FAILED 并带可读状态信息，不再静默假成功
- 数据完整性：空正文 / 占位串（"未知问题"、`/question/undefined/`）/ 1970 哨兵时间戳不覆盖库内真实数据；空正文不覆盖正文哈希
- 评论链路：500 条分批提交（`allIds` 全量对账协议）、批次失败重试、分页漂移重复 id 双侧去重、单请求上限 2000
- `/api/sync` 10 分钟防重入锁，杜绝 cron 与手动重叠并发导致的评论假删除
- 接口加固：`/api/changes` limit 钳制 1–500、搜索 LIKE 通配符按字面匹配、悬空 upvote 拒绝写入、写接口鉴权 fail-closed
- 前端：无限滚动失败不再跳页、收藏夹详情错误态与重试、`tsc` 不再散落 `.js` 产物

### 质量记录

- CI（GitHub Actions）：类型检查 ×3 + 前端构建 + 本地 D1 端到端冒烟
- 本地验证累计：冒烟测试 28 项、针对性场景 25 项、爬虫纯逻辑单测 73 项、E2E 边界矩阵 6 组、干净 clone 验收 8 步
