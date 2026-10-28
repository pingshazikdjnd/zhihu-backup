# 知乎备份系统 · 施工总纲（修订版 v2）

**初版**：2026-10-28
**本版**：2026-10-28，按「代码逐条核对 + 字段真机实测 + 评论双层方案可行性验证」修订
**核对基线**：commit `9b7edb4`（WORKER 已部署版本 `1e83fb8e`）
**使用方式**：本文档自包含。标「实测」的结论经过真实请求或代码核对；标「推断」的需自行验证；标「已修复」的条目已在当前代码中落地，不要再按原文施工。

> 修订要点（相对初版）：
> 1. 初版有 6 条断言过时或与现状冲突（见 §10.1），已全部改写；
> 2. 新增 §4.4「评论双层存储」方案与期 7；
> 3. 评论排序经真实账号实测确认为**时间倒序**，但**首屏必须跳过 `top=true`**，否则会立刻误停；
> 4. 期 0 增加硬前置：**先停云端 Apify cron**，否则旧镜像与本地并发双写；
> 5. 批量接口批大小从 10 改为 **5**（子请求与 CPU 约束）。

---

## 0. 一页纸

> 系统现在的主要浪费已经从「每轮重写整库」收敛为**三处纯写不读的固定税**（`comment_versions` 整表、`change_events.payload_json`、R2 `versions/` 双写），加上**三个数据字段取错**（文章赞数、回答浏览量、收藏数语义），以及**评论存储模型不适合全量**。
>
> 治的顺序：**先停云端旧镜像 → 砍固定税 → 修数据错 → 补增量游标 → 评论双层存储 → 最后做状态机与批量**。

---

## 1. 现状

### 1.1 模块规模（实测行数）

| 模块 | 规模 | 状态 |
|---|---|---|
| `apps/worker` | 约 3,814 行 | 生产，架构正确，**只改不重构** |
| `apps/apify-crawler` | **1 文件约 1,666 行**（4 个 scraper 占约 80%） | 生产，**需重构骨架** |
| `apps/web` | 18 文件约 3,188 行 | 生产，评论改造时才动 |
| `apps/api` | 17 文件约 1,373 行 | 已废弃，建议删（见期 1） |
| `apps/collector` | 约 630 行 | 已废弃，建议删 |
| `packages/shared` | 3 文件约 143 行 | 生产 |

### 1.2 数据流

```
爬虫（Playwright）──POST /ingest/*（Bearer API_SECRET）──▶ Worker（Hono）
                                                            ├── D1（元数据 + 评论根）
                                                            └── R2（HTML 正文 + 子评论 JSON）
前端（React + Pages）──GET /api/*（Service Binding 同源）──▶ Worker
```

### 1.3 运行方式

| 平台 | 频率 | 状态 |
|---|---|---|
| Windows 计划任务 / VPS cron | 每天 08:05、20:05 | 主力（每次启动会重新 `tsc`，改源码即生效） |
| Apify Cron | 每天 10:00、22:00（北京时间） | **必须停用**：镜像仍是旧代码，且与本地任务并发双写 |

> ⚠️ **施工硬前置**：`apps/worker/wrangler.toml` 的 `crons = ["0 2,14 * * *"]` 每天会拉起旧 Actor。在期 0 之前必须二选一：
> - **把 `crons` 显式改为 `crons = []` 再 `wrangler deploy`**（推荐）。注意：只注释掉 `[triggers]` 段**不会**删除已部署的 cron（Cloudflare 文档：`triggers` 为 undefined 时保留现有 cron，只有 `crons = []` 才移除）；
> - 或重新 `apify-cli push` + Build（额度允许时）。
> 否则本计划的所有收益只对本地生效，云端仍按旧逻辑烧额度并写脏数据。

### 1.4 关键文件索引

| 用途 | 路径 |
|---|---|
| 爬虫主逻辑 | `apps/apify-crawler/src/main.ts` |
| 爬虫输入声明 | `apps/apify-crawler/.actor/INPUT_SCHEMA.json` |
| 写库入口 | `apps/worker/src/routes/ingest.ts` |
| 内容写入 | `apps/worker/src/services/contents.ts` |
| 评论写入 | `apps/worker/src/services/comments.ts` |
| 赞同写入 | `apps/worker/src/services/upvotes.ts` |
| 收藏写入 | `apps/worker/src/services/collections.ts` |
| 关注名录/进度 | `apps/worker/src/services/following.ts` |
| 变更事件 | `apps/worker/src/services/changes.ts` |
| 风险/推荐/AI | `apps/worker/src/services/risk.ts`、`recommend.ts` |
| 表结构 | `apps/worker/migrations/0000~0003_*.sql` |
| 本地同步 | `scripts/local-sync.mjs` |
| 审查报告 | `STATUS_REPORT.md`、`TEST_REPORT.md`、`FIELD_AUDIT.md` |

---

## 2. 硬限制（实测 / 官方文档）

| 资源 | 限额 | 说明 |
|---|---|---|
| D1 写 | **10 万行/天** | 超了返回 500，次日 UTC 00:00（北京 08:00）恢复 |
| D1 读 | 500 万行/天 | |
| D1 存储 | 5 GB | |
| Workers CPU | **10 ms/请求**（免费版） | 大 JSON 序列化会撞 1102 |
| Workers 子请求 | 50/请求 | 单条 content 实际 **4-6 个**子请求 → 批量接口每条 ≤5 条（5 条约 20-30） |
| Workers 内存 | 128 MB | |
| R2 | 10 GB、100 万 Class A/月、1000 万 Class B/月 | 子评论对象天然适合放这里 |
| Apify 免费 | **$5/月 ≈ 1.3 小时** | 当前额度已耗尽至 11/25 |
| Turso（已注册空库） | 1000 万行写/月、5GB | 暂不使用 |

**当前真实数据量（两套口径，别混用）**：

| 口径 | contents | comments | upvotes | collection_items |
|---|---|---|---|---|
| 线上 D1（`d1-remote-20261028.sql`） | 5,700 | 25,495 | 4,201 | 1,100 |
| 旧本地全量库（`data/app.db`，备份在 `data/backups/`） | 29,689 | 3,610 | 28,971 | 1,083 |

---

## 3. 问题总账

### A. 功能缺失

| # | 问题 | 状态 | 证据 |
|---|---|---|---|
| A1 | **自己的专栏文章从来没被抓过** | **仍存在** | `runType` 枚举无 article；自有路径只抓 `/answers`；文章只在关注答主路径出现 |
| A2 | 评论父子关系靠外层 id 硬塞（读不存在的 `reply_to_comment_id`） | 仍存在（无害） | `main.ts` 读该字段恒 undefined，parentId 由外层根 id 赋值 |
| A3 | 没有内容删除检测 | 仍存在 | `contents.is_deleted` 生产恒 0；但风险引擎/前端有「已删除」逻辑 |

### B. 数据错误

| # | 位置 | 错误 | 状态 |
|---|---|---|---|
| B1 | 文章段 + **关注答主回答段 + 自动抢救评分器** | 赞数无 `reaction.statistics.like_count` 兜底 → 恒 0 | **本地实测修正**：文章段**带 include 时 `voteup_count` 有值**（B1 对文章不成立）；真正失效的是**关注答主回答段 + 评分器**。文章段的真实错误是 `favorite_count`/`visit_count` 恒 0 |
| B2 | 回答列表 | `visit_count` 不存在 → 回答浏览量恒 0 | 仍存在 |
| B3 | 收藏夹条目 | `favorite_count \|\| thanks_count \|\| reaction.favorites` → 收藏数取成感谢数 | **部分过时**：回答列表用 reaction 兜底是对的；真正取错只有收藏夹条目；关注答主/文章两处则完全没兜底 |
| B4 | 收藏夹列表 | 读 `item.updated_time`，接口不返回 → 落库回退 now | 仍存在（去掉后 `collections.updated_time` 会退化为"最后同步时间"） |

### C. 写放大

| # | 对象 | 现状 | 状态 |
|---|---|---|---|
| **C1** | `comment_versions` **整表** | 全仓库 0 次 SELECT，每写一条评论多 1 行 | **仍存在**（评论写入 -33% 的确定收益） |
| **C2** | `change_events.payload_json` | 写整条评论原文（可达 10KB） | **半修复**：查询侧已排除该列，写入仍在 |
| **C3** | R2 `versions/{pk}/{hash}` | 只有 put 无 get，与 `html/` 同字节双写 | **仍存在** |
| C4 | 无变化也写 | 内容/评论/赞同/收藏的按需写 | **已修复**；残留：每个收藏夹每轮 1 行 collections 更新 + 1 行快照 |
| C5 | 写预算 12 万 > D1 硬顶 10 万 | — | **已修复**（90,000）；但预算仍是**单进程内存**，本地两次 + 云端各算各的 |

**死数据提醒**：
- `contents.last_seen_at` **不是死字段**（默认列表排序、收藏排序、问题/关注/推荐页都在读）。期 3 停更后它只影响"默认排序的刷新频率"，不影响正确性。
- `contents.is_deleted` 生产恒 0，但读取点 8+ 处（风险引擎 55 分权重、前端徽标、stats）。**删列前必须先决定是否补删除检测。**
- R2 `md/{pk}/{hash}` 永远为空（爬虫恒传 `contentMd=""`），读分支恒 miss。

### D. 结构性问题

| # | 问题 | 状态 |
|---|---|---|
| D1 | 爬虫无状态，靠"连续 20 条重复"猜早停 | **部分修复**：`changed` 语义已正确（计数不再算变更），我的回答/收藏可早停；但 answers/收藏仍每轮 `offset=0`，只有 upvotes/关注有游标 |
| D2 | 4 个 scraper 重复约 80% 逻辑 | 仍存在（评论抓取已抽公共函数） |
| D3 | 云端读不到 `syncConfig` / `followedProgress` | **已修复代码**（INPUT_SCHEMA 已声明、apify.ts 已注入）；但云端 Actor 仍是旧镜像，需重部署才生效 |

### E. 初版遗漏、本版补入

| # | 问题 | 证据 |
|---|---|---|
| E1 | 云端旧镜像 + cron 与本地并发双写 | `wrangler.toml` 触发器 + 旧 Actor |
| E2 | 写预算是单进程内存，不是每日预算 | `main.ts` 模块级 `stats.estimatedWrites` |
| E3 | 评论补抓只按"计数增长"触发（5 处均为 `commentCount > prevCommentCount`），**删除/替换/风控截断不会触发**；hot 模式只取第一页（20 条） | `main.ts:300/724/912/1412/1457`、`:351-354` |
| E4 | 评论 partial 缺口永不修复（`comment_count` 先更新，中断后 `prev==cc`） | `contents.ts` 只判 `cnt===0` |
| E5 | 内容单字段（`source_url`/`question_title`/`author_name`/`label_info`/`excerpt`/时间）不参与变更比较 | `contents.ts` 变更组只含 title/hash/折叠/标签 |
| E6 | `changed=false` 仍每次重 PUT R2（html + versions 双写） | `ingest.ts` 无条件 put；实测稳态 fast 轮每轮约 100-600 条上报 → 200-1200 次 Class A，全量轮才会到 5 万级 |
| E7 | 全量评论直写 D1 不可行（769 万条 = 2,317 万行、14.4GB） | TEST_REPORT |
| **E8** | **answers 分页重叠导致假早停（本地实测，最严重）**：answers 接口忽略 `limit=20`，实测 offset=0/20/40 分别返回 37/38/20 条；爬虫按 `offset+=20` 翻页 → 约 40% 重复提交；重复项在空库上凑满「连续 20 条无变化」→ **562 篇只备份了 57 篇就 exit 0** | 本地验证：3 页/95 提交/57 新增/38 无变化 |

---

## 4. 目标架构

### 4.1 状态与游标（复用现有，不新建大文件）

| 数据 | 现存放 | 本版做法 |
|---|---|---|
| 赞同游标 | D1 `app_settings.upvotes_cursor` | 保留 |
| 关注答主进度 | R2 `meta/followed_users.json`（`resume_offset/history_done/last_checked_answer_id`） | 保留 |
| 我的回答/收藏的"上次见到的最旧 id" | **无** | 新增两个游标，仍走 `app_settings`（`answers_cursor`、`collections_cursor.<folderId>`），**不引入 1.5MB 的 seen 映射** |

> 初版的 `sync-state.json`（含 1.5MB `seen` 映射）**不再采用**：Worker 解析/合并大 JSON 会撞 10ms CPU，且与现有两套游标重复。

### 4.2 抓取循环

```
url = app_settings 里的游标 || 第一页
while (url):
    json = GET url
    逐条处理（内容走 /ingest/content；评论按 §4.3）
    if (撞到上次记录的最旧 id):  break        ← 确定性停止
    url = json.paging.next || 自己拼 offset    ← 优先跟随服务端
```

### 4.3 评论增量（已实测：时间倒序 + 必须跳过置顶）

**实测结论（真实账号，2026-10-28）**：`root_comments` 按 `created_time` **严格递减**返回（10-14 → 10-01 → 09-09 → 09-08 → 05-31），`&order=` 参数确实被忽略。

**因此增量算法必须是**：

```
newest_comment_time = 上次成功同步记录的最新根评论时间（存在 app_settings）
for page in pages(offset = 0, 20, 40, ...):
  for c in page.data:
    if (c.top) continue                 ← 关键：置顶评论时间可能很老，必须跳过
    if (c.created_time <= newest_comment_time):
        stop = true; break
    保存 c（根评论）
  if (stop or page.paging.is_end) break
同步成功且抓到过新评论时，更新 newest_comment_time
```

> ⚠️ 不跳过 `top=true` 会在第一页就误停（置顶老评论的 `created_time` 远小于 newest），导致**漏抓全部新评论**。
>
> ⚠️ **"hot 模式"名不副实**：由于知乎固定时间倒序且 `&order=` 被忽略，当前代码里所谓"前 20 条热评"实际是**最新 20 条**（`comments.ts:43`、`main.ts:436` 的旧注释假设了点赞序）。如果要按真实热度取 top20，必须多翻几页（例如 5 页 100 条）在本地按 `vote_count` 排序，成本 ×5。此项列入 §9 待决策。
>
> ⚠️ 该算法只解决"新增"，不能发现"删除/点赞变化"：删除对账只能在**完整抓到 `is_end=true`** 的轮次里做（见 §4.4 的 `complete` 标志）。

### 4.4 评论双层存储（新增，替代"全量直写 D1"）

**结构**：
- **根评论 → D1 `comments` 表**（保留现有表，加 `child_count` 列），排序/分页走 SQL；
- **子评论 → R2 `childcomments/{rootId}.json`**，点「展开 N 条回复」时才读；
- **同步元数据 → D1 新表 `comment_threads`**（root_id / content_pk / r2_key / child_count / complete / synced_at）。

**为什么可行（实测数据）**：

| 指标 | 实测值 |
|---|---|
| 根/子占比 | 深抓样本 28.3% / 71.7%（D1 的 57.8% 被 hot-20 截断放大，不可采用） |
| 根/内容 | avg 6.95 / p95 20（接口 offset 上限约 420 → 单内容最多约 440 根） |
| 子/根 | avg 5.77 / p95 21 / p99 35 / max 81 |
| 子评论对象体积 | p95 约 9.4KB、max 约 60KB |
| 写入量（1 行/根） | 我的回答 638 行；收藏 16.8 万行（1.7 天）；全量 218 万行（21.8 天） |
| R2 对象数 | 收藏约 6.7 万；全量约 87 万（逼近 100 万/月免费上限） |

**必须同时满足的 6 个工程约束**：
1. 爬虫保存 `child_comment_count`；根评论翻页直到 `is_end`（offset>420 返回空时标 `partial`，**禁止删除对账**）。
2. `/ingest/comments` **按「根」分块，每请求 ≤20 个根**。原因：partial 合并时需要先 GET 旧 JSON，最坏 20 GET + 20 PUT + 2 SELECT + 1 batch ≈ 43 子请求（40 根会到 ~83，超 50 上限）；不能按 500 条评论分块（会跨 100+ 根 → 直接撞上限）。
3. R2 对象带 `complete` 标志：只有抓到 `is_end=true` 才允许整对象覆盖；否则与旧 JSON 合并。
4. `comments` 加 `child_count`；新建 `comment_threads`。
5. 前端 `CommentTree` 已是"首批 50 条 + 滚动加载"，但**数据仍是一次性全量拉取**（`/api/contents/:pk/comments` 无分页）；需要把懒加载下沉到数据层（根分页 + 子评论按需）。

**本地实测补充（合成 5,000 根 + 500 根×5-80 子）**：
- 索引查询：热度 OFFSET 0/1000/4000 分别 0.09/0.21/0.68ms，时间 OFFSET 1000 = 0.20ms，COUNT = 0.71ms；EXPLAIN 均为 `SEARCH ... USING INDEX`，无 TEMP B-TREE。
- 子评论对象体积：p50 24KB / p95 **41.9KB** / max 44.7KB（不是初版估的 p95 9.4KB；9.4KB 是本地真实深抓样本，两者分布不同）。
- 回填体积：5,581 个有子根按 5-80 子重放约 **124MB**（PLAN 初版 4-9MB 偏低 10 倍以上），回填策略需用真实 25,495 条样本重算。
- 子请求：20 根（partial 时 20 GET + 20 PUT + 2 SELECT + 1 batch）= **43 < 50**，余量仅 7；40 根 = 83 超限。
6. 孤儿清理：根删除/内容删除时删 R2 对象与 `comment_threads` 记录（每周 cron）。

**索引与查询**：

```sql
-- 根列表（热度）
SELECT id, author_name, author_avatar, content_md, time_text, location,
       likes, is_author, is_top, is_featured, is_deleted, child_count
FROM comments
WHERE content_pk = ? AND parent_comment_id IS NULL AND is_deleted = 0
ORDER BY is_top DESC, likes DESC, id DESC
LIMIT 20 OFFSET ?;

CREATE INDEX IF NOT EXISTS idx_comments_root_hot
  ON comments(content_pk, is_deleted, is_top DESC, likes DESC, id DESC)
  WHERE parent_comment_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_comments_root_time
  ON comments(content_pk, is_deleted, time_text DESC, id DESC)
  WHERE parent_comment_id IS NULL;
```

**适用范围**：只建议用于「我的回答 + 收藏」；全量 769 万条不适用（21.8 天 D1 写入 + 87 万 R2 PUT）。

**已知不可解**：知乎 offset 约 420 后返回空 → 单内容最多约 440 根、单根最多约 440 子；声明 26,156 条评论的巨贴**永远备份不全**。

---

## 5. 施工计划

### 期 0：停云端旧镜像 + 建立基线（不改业务代码）

1. **停 Apify cron**：把 `apps/worker/wrangler.toml` 的 `crons` 显式改为 `crons = []` 后 `wrangler deploy`（只注释 `[triggers]` **不会**删除已部署的 cron；Cloudflare 文档：`triggers` 为 undefined 时保留现有 cron，只有 `crons = []` 才移除）。
2. 跑一次本地同步，记录：扫描页数 / 提交条数 / 无变化条数 / 写入行数（Cloudflare 面板）/ 耗时。

**本地实测基线（2026-10-28，`data/plan-verify-a`，`commentsMyAnswers=none`）**：

| 指标 | 冷启动 | 稳态（第二次） |
|---|---|---|
| 扫描页数 | 3 | 1 |
| 提交条数 | 95 | 20 |
| 新增 | 57 | 0 |
| 无变化 | 38 | 20 |
| D1 写入行 | 190（171 INSERT + 19 UPDATE） | 7 |
| R2 html 对象 | 57 / 237KB | 0 新增 |

> ⚠️ 冷启动暴露 E8：answers 接口忽略 `limit`（offset=0/20/40 返回 37/38/20 条），`offset+=20` 产生 40% 重复，重复凑满早停 → **562 篇只入库 57 篇**。**任何全量同步前必须先修 E8。**

**验证**：`/api/stats` 正常；本地日志出现 `📊 本轮…` 统计行；云端不再产生新 run。

### 期 1：砍固定税（收益最确定）

| 动作 | 位置 | 注意 |
|---|---|---|
| 删 `comment_versions` 整表 | 新增 `0004_drop_comment_versions.sql`；`comments.ts` 去掉两处 INSERT | 评论写入 3→2 行 |
| 删 `change_events.payload_json` 写入 | `changes.ts` 两处 INSERT | 查询侧已排除该列 |
| 删 R2 `versions/` 双写 | `ingest.ts` 的 PUT | 存储减半；全仓库仅 put 无 get |
| R2 写入改为「HEAD 兜底」 | `ingest.ts`：`created` 直接 PUT；否则先 `BUCKET.head(key)`，miss 才 PUT；`md/` 同理 | **不要裸用 `created \|\| changed`**：D1 已写成功但 R2 PUT 失败时，下一轮 `changed=false` 会永久缺正文。HEAD 为 Class B（1000 万/月免费，稳态约 3.6 万/月），miss 即自愈 |
| 删死列 | `contents.deleted_at/first_seen_at`、`content_versions` 的 4 个正文列、`collections.owner_token`、`collection_items.removed_at`、`upvotes.first/last_seen_at`、`comments.last_seen_at/deleted_at` | **跨 4 个 service 约 14 条写入 SQL**（comments 4、contents 3、collections 5、upvotes 1 等）；`comments.last_seen_at` 上有索引 `idx_comments_last_seen`，migration 必须先 `DROP INDEX` 再 `DROP COLUMN` |
| 删废弃模块 | `apps/api/`、`apps/collector/` | **必须重新生成 `pnpm-lock.yaml`**（其中仍含两个 importer；`--frozen-lockfile` 会报 ERR_PNPM_OUTDATED_LOCKFILE）。`pnpm-workspace.yaml` 是 `apps/*`、根 `package.json` 无引用，无需改 |

**验证**：`(cd apps/worker && npx tsc --noEmit)` + `pnpm --filter apify-crawler build` + 跑一次同步，写入行数应显著下降（评论部分降 33%）。
**R2 侧验证**：部署前后各记录 R2 面板 24h 的 Class A/B；部署后跑一轮 `--type=all --fast`，预期 Class A/轮 ≈ 0-10、Class B/轮 ≈ 上报条数；抽查 5 篇正文可读；手动删一个 `html/{pk}/{hash}` 后重发，确认 HEAD miss 自动补回。

**回滚**：migration 配套写回滚 SQL；代码按文件 `git revert`。

### 期 2：修数据错误

| 改法 |
|---|
| 文章段、关注答主回答段、自动抢救评分器：赞数/收藏数统一 `?? reaction.statistics.*` 兜底 |
| `favorite_count` 优先 `reaction.statistics.favorites`；`thanks_count` 单独建模 |
| 回答 `visit_count` 改用 `question.visit_count`，或明确置 0 且前端不显示 |
| 收藏夹去掉 `item.updated_time` 读取（或改用 `created` 字段） |

**验证**：抽 5 条文章/回答/收藏，与知乎页面数字对一遍。

### 期 3：确认无变化不写（大部分已完成）

当前已实现：内容四路（body/profile/counter/无变化）、评论 needsRefresh、赞同时间不变跳过、收藏字段一致跳过。
本期待办仅剩：
- `contents.ts` 正文变更分支里残留的 `author_avatar IS NULL` 判"评论未迁移"（会因匿名头像永久触发重抓）；
- 每个收藏夹每轮固定 1 行 collections + 1 行快照（可接受，或改为仅在 `updated_time` 变化时写）。

> 初版写的「`sort=recent` 改 `updated_time`」**不存在该排序**（前端只有 `time`/`vote`），不要执行。

### 期 4：补两条游标（不新建大 state 文件）

1. `app_settings` 增加 `answers_cursor`、`collections_cursor.<folderId>`（存最旧 id + 时间）。
2. `POST /ingest/sync-state` 的 key 白名单从仅 `upvotes_cursor` 扩展为上述 key；**值校验当前只允许 `https://`，需要放宽为"`https://` 或纯 id"**（新游标是 id）。
3. `GET /ingest/sync-state` 的 SELECT 也要带上这些新 key（当前只查 `upvotes_cursor` 与 `zhihu_cookie`），并同步加进 `scripts/local-sync.mjs` 的 `inputPayload`。
4. 爬虫在 `runScraper` / `runCollectionScraper` 撞到游标 id 时停止，并上报新游标。
5. **`apify.ts` 的 `triggerApifyRun` 也必须注入新游标**（当前只注入 `upvotesCursor`），否则云端 cron 仍每轮从头翻。

**本地实测**：`app_settings` 存纯 id 与 `collections_cursor.<folderId>` 完全可行（103 个 key 下点查 avg 15.6µs；key 4,019 字符仍成功；无 CHECK，服务端校验是唯一防线）。

**验证**：第二次跑同一批数据时，请求页数应降到 1 页。

### 期 5：批量接口（批大小 5，不是 10）

- 新增 `POST /ingest/batch`，每请求 **≤5 条 content**：
  - 本地实测单条子请求：新内容 **6**、无变化 **4**、仅计数 **5**、**正文变更 8**（含 2 HEAD + 2 PUT）；
  - 5 条/批最坏 40（安全）、6 条最坏 48（仅剩 2 余量）、**8 条正文变更 = 64，必超 50**；
  - 若先做 hash 前置（一次 SELECT 批量取回旧 hash，跳过相等项的 HEAD/PUT）并把 D1 写合并为 1 个 batch，可放宽到 6。
- 评论仍按根分组（≤20 根/请求，见 §4.4）。
- 注意：D1 单语句绑定参数 ≤100，不能把多条 content 拼成一条多行 INSERT，必须逐条语句入 batch。

### 期 6：补自己的专栏文章（功能缺失）

新增 `runArticleScraper()`：`GET /v4/members/{me}/articles?limit=20&offset=N`，翻到撞 `oldest_article_id` 停。
需同步注册 **4 处**：`main.ts` 的 `runType` 联合类型、`INPUT_SCHEMA.json`、`scripts/local-sync.mjs` 的 `VALID_TYPES`、`main.ts` 的入口分发（if/else 分支）。`apify.ts` 无 target 映射（`/api/sync` 的 target 是任意透传），不在改动范围。

**真机实测（limit=2 两次 GET）**：
- 字段：`id/title/created/updated/excerpt` 必有；`content` 需 include；赞数在 `reaction.statistics.like_count`、收藏在 `reaction.statistics.favorites`；**`comment_count` 即使 include 也不返回**（要显示评论数得走详情接口或留空）。
- 时间戳：`created`/`updated` 是 **10 位秒**，`toIsoOrNull` 已是秒×1000，可直接复用。
- **停止游标 `articles_cursor` 需同期 4 一起加**（PLAN 初版只说撞 `oldest_article_id`，未定义存储位置）。
注意：文章时间字段是 `created`/`updated`（秒），需确认后走 `toIsoOrNull`。

### 期 7：评论双层存储（新增，见 §4.4）

顺序：
1. 爬虫：保存 `child_comment_count`、根翻页到 `is_end`、`partial` 禁止删除对账；
2. schema：`comments.child_count`、`comment_threads`、两个 partial index；
3. Worker：根列表 API（分页/排序）+ 子评论 R2 接口；ingest 按根分组；
4. 前端：`CommentTree` 懒加载（保留旧扁平接口 feature flag 回退）；
5. 迁移：现有 25,495 条中 5,581 个有子根回填 R2（约 4-9MB，估算），抽样比对后删 D1 子行；
6. 收尾：孤儿 GC、ETag/Cache-Control、R2 用量监控。

**验证**：任选一篇 200+ 根评论的回答，检查根分页/排序、展开子评论、`child_count` 与 R2 对象条目数一致。

---

## 6. 字段实测参考

### 6.1 回答列表（默认 20 字段）

默认返回含 `id/created_time/updated_time/reaction/question/author/url/is_collapsed/...`，但**没有 `content`、`voteup_count`、`favorite_count`、`visit_count`**：
- 赞数 → `reaction.statistics.like_count`
- 收藏数 → `reaction.statistics.favorites`
- 浏览量 → 列表不存在（可用 `question.visit_count`）
- 正文/摘要/评论数 → 需带 include 才返回

### 6.2 评论（31 字段）

- **排序：时间倒序（已实测）**，`&order=` 被忽略；**首屏必须跳过 `top=true`**。
- **没有 `updated_time`** → 改没改只能靠内容 hash。
- **没有 `reply_to_comment_id`** → 楼中楼只有两层，靠 `reply_to_author` 显示「回复 @xxx」。
- `limit` 上限 **20**。
- 有 `is_delete`、`censor_status`、`reviewing`、`collapsed` 等审核字段（当前未取，与防和谐直接相关）。

### 6.3 收藏夹列表（只有 5 字段）

`url, is_public, type, id, title` —— 没有 `updated_time`、没有 `item_count`。

### 6.4 赞同动态

- `limit` 不生效（传 2 返回 7 条）；`offset=1793097471926` 是**毫秒时间戳游标**。
- `target` 含 `content/voteup_count/comment_count/author/question/updated_time`。

### 6.5 单条 JSON 体积

| 端点 | 单条字节 | 最大字段 |
|---|---|---|
| collections/items | 4,649 | `content` 98.9% |
| activities (v3) | 8,348 | `target` 88.3% |
| comments | 1,587 | `author` 48.8% |
| answers（带 include） | 2,242 | `author` 25.2% |

---

## 7. 坑（已验证）

| 坑 | 说明 |
|---|---|
| Apify 剥字段 | 按 `INPUT_SCHEMA` 白名单剥离；`apiSecret`/`syncConfig`/`followedProgress` 必须声明 |
| 评论 limit 上限 | **20**，传 50 → 400 |
| 深翻 offset 截断 | 评论 offset > 约 420 返回空数组；空页 + `is_end=false` 必须当"不完整"，禁止删除对账 |
| 评论时间倒序 + 置顶 | 首屏有置顶老评论，按 created_time 早停会立刻误停；必须跳过 `top=true` |
| offset 漂移 | 翻页期间新增内容会让 offset 指向别处；断点用 id/时间戳 |
| 网页版匿名 403 | 必须带登录 cookie |
| Worker 10ms CPU | 响应 > 约 300KB 有风险；2MB JSON 序列化必挂 |
| R2 流式透传 | `return new Response(obj.body)` 不消耗 CPU；D1 必须序列化 |
| 零数据仍成功 | 空页/未知 runType/进程被信号杀死都曾 exit 0（已修 white-list 与失败计数，仍需关注新路径） |

---

## 8. 明确不做的事

- ❌ Turso 读写分流（一条数据拆两库，查询要跨库合并）
- ❌ 换数据库（只写新数据后 D1 每天新增几十条）
- ❌ 一次性重写爬虫（无测试兜底）
- ❌ 全量 769 万条评论直写 D1（需 232 天、14.4GB）
- ❌ 初版的 1.5MB `sync-state.json`（撞 CPU 且与现有游标重复）

---

## 9. 待决策

1. **浏览量**：保持实时（每条写 1 行）还是首次入库后冻结（推荐冻结，改为 `question.visit_count`）
2. **`comment_versions` 删除后**评论编辑历史永久丢失（当前无任何入口可看）——接受吗
3. **R2 `versions/` 删除后**旧版本正文不可恢复（当前也无读取路径）——接受吗
4. **内容删除检测**：补写入路径，还是撤掉前端"已删除"徽标与风险引擎 55 分权重
5. **评论双层存储的适用范围**：只做「我的回答 + 收藏」，还是也覆盖赞同（赞同 2.9 万条内容，全量根评论仍需 21.8 天）
6. **hot 模式语义**：接受"最新 20 条"（零额外成本），还是改成真·最热 20（多翻 5 页取 top20，抓取成本 ×5）
7. **跨进程写预算**：是否把 90k 预算持久化到 D1/R2（按日期 key），让本地两次 + 云端共享同一日额度（当前各自从 0 计数）
8. **操作口令**：口令已从文档移除但仍在 git 历史，是否正式轮换（设置页 + Cloudflare secret 同步改）
9. **评论 partial 缺口补偿**：是否给 `contents` 增加"上次评论同步是否完整"标记，让中断的评论批次下轮自动补

---

## 10. 修订记录与验证

### 10.1 初版已过时的断言（本版已改写）

| 初版断言 | 实际情况 |
|---|---|
| 「`contents.last_seen_at` 全项目无任何逻辑读取」 | 错：默认列表/收藏/问题/关注/推荐页都在读 |
| 「C4 无变化也写」 | 已修复；仅剩收藏夹每轮 2 行固定写 |
| 「C5 护栏 12 万」 | 已修复为 90,000（但仍为单进程内存） |
| 「D3 云端读不到 syncConfig」 | 代码已修；差 Apify 重部署 |
| 「期 3 改 `sort=recent`」 | 该排序不存在，前端只有 time/vote |
| 「批量 10 条」 | 会撞 50 子请求与 10ms CPU，改为 5 条 |
| 「模块 1428/3331 行」 | 现为约 1666/3814 行 |

### 10.2 证据来源

- 知乎接口：真机 12 次 GET（字段与体积）+ 真实账号评论时间序实测
- 代码：commit `9b7edb4` 逐条核对
- 数据：`data/app.db`（旧全量库）+ `data/backups/d1-remote-20261028.sql`（线上导出）
- 报告：`STATUS_REPORT.md`、`TEST_REPORT.md`、`FIELD_AUDIT.md`
- 评论方案：根/子分布、对象体积、索引性能（合成 5,000 根，OFFSET 0~4980 耗时 0.59–1.22ms）

---

*本文件由 FIELD_AUDIT.md + 两轮全局审查 + 评论双层存储可行性验证合并而成。施工前请先读 §1.3 的硬前置。*