# 知乎备份系统 · 现状报告（2026-10-28）

> 审查基线：`bb06988`（main，当前 HEAD），只读审查，未修改任何既有代码。
> 验收命令：`pnpm --filter apify-crawler build && pnpm --filter web build && (cd apps/worker && npx tsc --noEmit)`，实测 EXIT 0。
> 说明：线上运行状态无法离线复现的部分一律标注“未验证”；第三节数字均取自 git 提交说明，本次未重新实测。

---

## 一、系统架构与数据流（含线上/本地/Apify 三条运行轨道）

### 1.1 组件与边界

| 层 | 位置 | 职责 |
|---|---|---|
| 前端 | `apps/web`（React 19 + Vite） | 概览、推荐、内容、收藏、问题、关注、变更、设置（`/settings`）八个页面；`apps/web/src/App.tsx:19-34` |
| 同源反代 | `apps/web/public/_worker.js:2-8` | `/api/*`、`/ingest/*` 通过 Service Binding `env.API` 直通 Worker，绕开 `workers.dev` DNS 污染 |
| 后端 | `apps/worker`（Hono） | 只读 API + `/ingest/*` 写接口；路由挂载见 `apps/worker/src/index.ts:58-68` |
| 存储 | Cloudflare D1 + R2 | D1 存结构化元数据、事件、游标；R2 存 `html/`、`md/`、`versions/` 正文，键带 content_hash |
| AI | Workers AI 绑定 `AI` | 单篇内容风险鉴定，模型由设置页 `preferredAiModel` 决定；`apps/worker/src/services/recommend.ts:303-310` |
| 定时 | Cron `0 2,14 * * *` | UTC 02:00/14:00（北京时间 10:00/22:00）触发 Apify 快速同步；`apps/worker/wrangler.toml` 的 `[triggers]`、`apps/worker/src/index.ts:75-77` |

### 1.2 三条运行轨道

1. 线上服务轨道（读）：浏览器 → `*.pages.dev` → `_worker.js` → Service Binding → Worker → D1/R2。
2. 本地定时轨道（写）：Windows 计划任务 `ZhihuBackup_LocalAutoSync`（每天 08:05/20:05）→ `scripts/auto-sync-silent.vbs` → `scripts/local-sync.mjs --type=all --fast` → `GET /ingest/sync-state` 取线上 cookie/游标/设置 → 本地 `tsc` 编译 `apps/apify-crawler` → 启动 `dist/main.js`（Playwright）→ 逐条 `POST /ingest/*` 回写云端。
3. Apify 云端轨道（写）：Cron 或手动 `POST /api/sync/*` → `apps/worker/src/services/apify.ts:28-136` 调 Apify Runs API → 云端 Actor（同一份 `apps/apify-crawler/src/main.ts`）→ 逐条 `POST /ingest/*` 回写云端。

### 1.3 写入数据流

- 内容：`POST /ingest/content`（`apps/worker/src/routes/ingest.ts:26-69`）→ `upsertContent` → `contents` / `content_versions` / `change_events`；正文由路由写入 R2。
- 评论：`POST /ingest/comments` → `replaceComments` 分批 batch 写 `comments` / `comment_versions` / `change_events`，非 partial 时做删除对账。
- 收藏：`POST /ingest/collection-snapshot` → `collections` / `collection_items` / `collection_snapshots`。
- 赞同：`POST /ingest/upvote` → `upvotes`（同 content_pk 唯一）。
- 关注：`POST /ingest/followed-users` → R2 `meta/followed_users.json` + D1 `followed_users`；`POST /ingest/followed-user-progress` → 只更新 R2 中的进度字段。
- 游标：`POST /ingest/sync-state` 只允许写 `upvotes_cursor`（`apps/worker/src/routes/ingest.ts:179-199`）；`GET /ingest/sync-state` 返回 cookie、用户名、`upvotesCursor`、`fullModeUsers`、`followedProgress`、`syncConfig`（`apps/worker/src/routes/ingest.ts:110-143`）。

---

## 二、已实现功能清单（按模块：内容/评论/收藏/赞同/关注/问题整理/推荐与风险评估/设置中心）

| 模块 | 已实现能力 | 代码证据 |
|---|---|---|
| 内容 | 回答/文章/想法入库；正文与元数据分离；SHA-256 版本快照；标题/正文/计数/折叠/标签变更检测；全文检索；列表分页与排序 | `apps/worker/src/services/contents.ts:11-351`、`apps/worker/src/services/contents.ts:353-422`、`apps/worker/src/routes/contents.ts` |
| 评论 | 根评论 + 子评论；答主/置顶/精选标记；500 条分批幂等提交；partial 时跳过删除对账；全量/热评/不抓三档策略 | `apps/worker/src/services/comments.ts:19-220`、`apps/apify-crawler/src/main.ts:445-548` |
| 收藏 | 收藏夹列表、条目快照、新增/移除对账、重新加入事件、条目去重、单请求 1000 条截断保护 | `apps/worker/src/services/collections.ts:9-194`、`apps/apify-crawler/src/main.ts:550-755` |
| 赞同 | 赞同时间入库、`upvotes_cursor` 深水区断点续传、同时间跳过写入、连续 5 次失败熔断 | `apps/worker/src/services/upvotes.ts:3-30`、`apps/apify-crawler/src/main.ts:757-964` |
| 关注 | 关注名录 R2+D1 双写；单人 default/full 模式；历史进度 `resumeOffset/historyDone/lastCheckedAnswerId`；风险+质量双维自动抢救；关注动态流 | `apps/worker/src/services/following.ts:106-281`、`apps/apify-crawler/src/main.ts:966-1375` |
| 问题整理 | 按 `question_id` 聚合赞同过/收藏过的回答，双来源标签与状态 | `apps/worker/src/services/questions.ts:12-98` |
| 推荐与风险评估 | `mix/risk/authors/classic` 四频道；规则风险分 + 价值分；AI 深度鉴定与 R2 永久缓存；相似回答 | `apps/worker/src/services/recommend.ts:16-172`、`apps/worker/src/services/recommend.ts:174-364`、`apps/worker/src/services/risk.ts:31-135` |
| 设置中心 | `/settings` 与 `/auth` 共用页面；4 个板块评论策略 + 关注抢救灵敏度 + AI 模型；操作密码校验；游标状态展示；Cookie 在线更新与改密 | `apps/web/src/App.tsx:31`、`apps/web/src/components/Layout.tsx:35`、`apps/web/src/pages/AuthPage.tsx:119-140`、`apps/web/src/pages/AuthPage.tsx:366-510`、`apps/worker/src/routes/auth.ts:341-356` |
| 变更时间线 | `change_events` 统一记录内容/评论/收藏事件 | `apps/worker/src/services/changes.ts:16-48`、`apps/worker/src/routes/changes.ts` |

---

## 三、最近改动与实测效果

最近三轮提交：`b65e3de`（固化写入预算护栏草稿，120000）→ `697f5f8`（按需写 + 注入补齐 + 预算降到 90000）→ `bb06988`（头像移出变更判定 + 删除逐条详情请求 + 统计日志）。

| 指标 | 改动前 | 改动后 | 数据来源/口径 |
|---|---:|---:|---|
| 扫描页数 | 29 页 | 4 页 | `bb06988` 提交说明（同一账号本地实测） |
| 提交条数 | 821 条 | 103 条 | 同上 |
| changed=true（变更/误判变更） | 511 条 | 14 条 | 同上 |
| changed=false（“无变化”日志口径） | 未记录 | 89 条 | 同上；注意该口径含“仅计数/仅头像”写入 |
| 极速早停 | 永远无法触发 | 4 页正常早停 | 同上 |
| 同 payload 重发 | 未记录 | `changed=false` | `697f5f8` 提交说明（线上实测，无具体数字） |
| 仅计数变化 | 未记录 | `changed=false`，早停可触发 | 同上 |

口径说明：
- “无变化 89 条”不等于零写入。仅计数变化走 `contents.ts:325-345` 的单条 UPDATE，仅头像/简介变化走 `contents.ts:315-324` 的单条 UPDATE，两者都返回 `changed=false`，都会被计入爬虫的 `noChangeCount`（`apps/apify-crawler/src/main.ts:253-254`）。
- 提交说明没有给出改动前的 `changed=false` 数量，本报告不推算、不补数字。
- 上述数字来自作者提交说明，本次只读审查未复测；本地构建仅验证类型与打包，不验证抓取行为。

---

## 四、一致性与契约核查结论（逐条 1~6 的结论）

### 4.1 最近三轮改动是否自洽

#### 4.1.1 `apps/worker/src/services/contents.ts`

三组变更（`contents.ts:175-217`）与四类返回路径覆盖完整，无不可达组合：

| 返回路径 | 条件 | 写入内容 | changed | prevCommentCount |
|---|---|---|---|---|
| 新建 | `!existing`（`:56`） | 整行 + 版本（有正文时）+ 事件（`:56-128`） | `created=true` | `0`（`:127`） |
| body 变更 | `bodyChanges.length > 0`（`:233`） | 整行 UPDATE + 版本（正文变时）+ 事件（`:233-314`） | `true` | `:304-314` 计算 |
| 仅头像/简介 | `profileChanges > 0 && counterChanges === 0`（`:315`） | 头像/简介/last_seen_at 两列级 UPDATE，无版本/事件（`:318-322`） | `false` | `:324` 计算 |
| 仅计数 | `counterChanges.length > 0`（`:325`） | 4 个计数 + 头像/简介 + last_seen_at，无版本/事件（`:329-343`） | `false` | `:345` 计算 |
| 全无变化 | 其余（`:348-349`） | 不执行任何 UPDATE | `false` | `:349` 计算 |

结论：三种分组的所有组合都能落到某个分支；`profileChanges > 0` 且 `counterChanges > 0` 时由计数分支顺带写资料（`:329-343`），不会漏写头像；`prevCommentCount` 在新建 + 4 个更新返回路径上全部有值，且新建路径返回 0 是正确语义。

发现的问题：
- 单字段变化不落库：`source_url`、`question_id`、`question_title`、`author_name`、`author_url_token`、`label_info`、`excerpt`、`created_time`、`updated_time` 不参与任何变更比较（`:184-216` 只比较 title/hash/4 个计数/头像/简介/collapsed/labeled），也只在 body 分支的整行 UPDATE 中写入（`:239-271`）。若只有这些字段之一变化（例如答主改名、URL 纠错、问题标题变更、`label_info` 文案变化），本次 ingest 不会落库、`changed=false`，要等下一次正文/计数变化才被顺带修复。P2。
- 头像抖动只从 `changed` 判定中移除，并没有消除写入：头像 URL 每次轮换仍会进入 profile 分支执行一条 UPDATE（`:315-324`）；因此 `bb06988` 解决的是“早停失效”，不是“头像写入为零”。日志会把这类行计入“无变化”。P2。
- 全无变化分支不再刷新 `last_seen_at`（`:348-349`），而列表默认按 `last_seen_at DESC` 排序（`contents.ts:381-386`）。README 第 251 行仍写“按同步时间倒序”，语义已变成“按最近一次实质变更/计数变化时间”。P2（文档不一致）。
- `contents.is_deleted` 在新分支中不再被复位（旧实现曾在无变化路径写 `is_deleted=0`）。当前代码没有任何路径把 `contents.is_deleted` 置 1（全局检索仅 `comments.ts:188` 对评论置删），因此暂未发现实际影响；若未来加入内容删除标记，需要补回复位逻辑。观察项。

#### 4.1.2 `apps/worker/src/services/comments.ts`

- 类型不一致导致永久重复写入：未发现。数据库 `comments.likes` 是 `INTEGER NOT NULL DEFAULT 0`（`apps/worker/migrations/0000_schema.sql:59`），入参 `likes` 由 zod 强制为 number（`packages/shared/src/schemas.ts:53`），D1 返回 number，`exists.likes !== c.likes`（`comments.ts:166`）不会因 number/string 类型差异恒真。
- 但 `time_text` / `location` 存在 NULL 与空串不等价的问题：`needsRefresh` 直接比较 `exists.time_text !== c.time`、`exists.location !== c.location`（`comments.ts:167-168`），而 UPDATE 使用 `COALESCE(NULLIF(?, ''), time_text)`（`comments.ts:174-177`）。若历史行是 NULL、本次抓到的值为空串，则每次同步都判定“有变化”，UPDATE 后仍是 NULL，形成永久重复写入。P1，触发条件为旧数据中存在 NULL 时间/位置且评论本身缺该字段。
- `author_avatar` 为 NULL 时：只要本次传入非空头像，会通过 `COALESCE(NULLIF(?, ''), author_avatar)` 回填（`comments.ts:115`、`comments.ts:174`）；若传入为空串，则 NULL 永远保持 NULL，不会被回填（`needsRefresh` 第一条还要求 `!!c.authorAvatar`，`comments.ts:165`）。
- 与上一条联动：`contents.ts:220-231` 只要发现该内容下存在 `author_avatar IS NULL` 的评论，就把 `prevCommentCount` 强制为 0。对于“匿名/已注销作者、头像恒为空串”的旧评论，NULL 永远不会被回填，于是每次同步都返回 `prevCommentCount=0`，爬虫每次都重抓该内容全部评论（并在 `runScraper` 中把 `existingCount` 重置为 0，`main.ts:264`，导致早停失效）。P1，触发条件为历史评论中存在 NULL 头像且当前抓取头像为空。
- 删除对账只在 `!input.partial` 时执行（`comments.ts:183-204`），且 hot 模式固定 `partial=true`（`main.ts:540`），因此热评模式不会误删，符合预期。

#### 4.1.3 `apps/worker/src/services/upvotes.ts`

- `upvote_time` 相同即跳过写入（`upvotes.ts:15-21`），返回 `{ created:false, unchanged:true }`（`:20`）；不同则 upsert 并返回 `{ created: !existing }`（`:23-29`）。
- 调用方只消费 `created`（`main.ts:887-904`）：`created=false` 表示“该赞已存在”，用于累计 `existingCount` 和早停；`unchanged` 字段无人消费但无副作用。语义满足调用方，早停判定正确。
- 边界：内容不存在时返回 `{created:false, skipped:true}`（`upvotes.ts:8-11`），调用方同样按“已存在”计数。若连续 20 条内容都不存在，会触发早停并跳过本页剩余条目；这些条目本身也没有内容行可关联，影响有限，但属于“早停口径把 skipped 当 existing”的隐含行为。观察项。

#### 4.1.4 `apps/worker/src/services/collections.ts`

- 跳过 UPDATE 的 `continue`（`collections.ts:125-132`）没有跳过必要逻辑：
  - `incomingKeys` 在循环前由全部 `input.items` 构建（`:47`），不受 `continue` 影响；
  - 删除对账基于 `existingKeys` 与 `incomingKeys`（`:159-181`），不受影响；
  - 快照计数使用 `input.items.length`（`:183-187`），`added/removed` 只在真正新增/移除时累加，`continue` 不改变统计。
- 副作用：未变化的条目不再刷新 `last_seen_at`，而 `getCollectionDetail` 按 `last_seen_at DESC` 排序（`collections.ts:245`），详情页条目顺序会停留在旧值。P2。
- 另外，快速模式会强制 `incremental=true`（`main.ts:741` 的 `cIsEnd && isFast`），服务端因此跳过移除对账（`collections.ts:159`）。也就是说，自动化的本地 `--fast` 与云端快速 Cron 都不会发现收藏夹“移除”动作，只有手动全量（`isFast=false`）才会对账。README 第 19 行“追踪收藏夹新增/移除条目”没有说明这一限制。P2（文档/行为不一致）。

#### 4.1.5 `apps/apify-crawler/src/main.ts`

- 列表 `include` 已显式请求 `voteup_count`、`visit_count`、`favorite_count`、`comment_count`（`main.ts:195`），删除逐条 `/answers/{id}` 后，代码改为从列表项读取（`main.ts:225-227`、`:240`）。代码层面字段来源成立；知乎线上响应是否始终包含这些字段，本次无法联网验证，标注“未验证”。
- `finalFavorite` 在 `favorite_count` 缺失时回退到 `thanks_count`（`main.ts:226`，收藏/赞同路径同样如此），而“感谢数”与“收藏数”不是同一指标，可能写入偏大的 `favorite_count`。P2（数据准确性）。
- `runScraper` 的 4 个统计变量 `pagesScanned/submitted/createdCount/noChangeCount`（`main.ts:189-192`）都与末尾日志一一对应（`:434-437`），但：
  - `noChangeCount` 包含“仅计数变化/仅头像变化”的条目（`changed=false`），与日志标签“无变化”不完全等价；
  - 日志没有单独的“变更数”变量（`createdCount` 只统计新增，正文变更与计数变化都没有单独计数）；
  - 早停后缀用 `existingCount >= 20` 判断（`:436`），若循环自然翻到末页时恰好尾部有 20 条未变，也会打印“命中连续无更新早停”，实际并未早停。P2（日志口径）。
- `comment_count` 一直来自列表项（改动前也是如此），删除详情请求不影响评论数。

### 4.2 爬虫 ↔ Worker 契约一致性

四个 scraper 对 `{ created, changed, prevCommentCount }` 的使用：

| Scraper | created | changed | prevCommentCount | 结论 |
|---|---|---|---|---|
| `runScraper`（`main.ts:251-274`） | 新增计数、日志 | 参与早停：`!created && !changed` 才累加 | 仅在 `commentCount > prevCommentCount` 时补抓评论（`:260`） | `changed` 语义变化后仍正确；计数/头像变化按“稳定”计数，符合早停目的。但 partial 评论缺口不会被修复（见 4.5 P1） |
| `runCollectionScraper`（`main.ts:681-699`） | 同上 | 参与早停 | 仅 `prevCommentCount === 0` 时抓热评（`:686`） | `changed` 语义正确；已知内容新增评论不会补抓 |
| `runUpvotesScraper`（`main.ts:870-905`） | 仅用返回的 `pk` 关联赞同 | 不使用 | 仅 `prevCommentCount === 0` 时抓热评（`:875`） | 不受 `changed` 语义变化影响；赞同早停由 `upRes.created` 驱动（`:887-904`），正确 |
| `runFollowingScraper`（`main.ts:1252-1270`） | 保存计数 | 参与早停（`:1262-1269`） | 仅 `prevCommentCount === 0` 时抓热评（`:1256`） | `changed` 语义正确；与 collection/upvotes 一样只在首次抓评论 |

早停计数 `existingCount` 的加减：
- `runScraper`：`needComments` 为真时把 `existingCount=0`（`:264`），created/changed 为真时清零（`:272-274`），只有 `!created && !changed` 才累加（`:265-266`）。逻辑本身自洽；但如前所述，若某内容因 NULL 头像导致 `prevCommentCount` 恒为 0，`needComments` 每轮为真，`existingCount` 被反复清零，早停会失效。
- `runCollectionScraper`：`needHotComments` 为真时走 else 分支清零（`:690-699`）；否则累加。无多加/漏加。
- `runUpvotesScraper`：只按 `upRes.created` 加减（`:887-904`）；`created=false` 同时涵盖“已存在”和“内容不存在被 skipped”，存在轻微口径混杂，但没有发现会漏抓新增赞的路径。
- `runFollowingScraper`：`savedForUser++` 对未变化条目也自增（`:1261`），随后日志“智能风险抢救共入库 N 篇”（`:1292-1294`）会把未变化条目也算作“入库”；仅日志口径问题。

`/ingest/followed-users`：
- 爬虫发送 `{ users:[{urlToken,userId,name,avatarUrl,headline,answerCount,articlesCount,followerCount}], incremental: fIncomplete }`（`main.ts:1008-1032`）。
- Worker 按同名 camelCase 字段读取（`ingest.ts:163-176`），`upsertFollowedUsersSnapshot` 写 R2 全量 map 与 D1（`following.ts:106-214`）。
- 字段一致；`incremental=true` 时跳过“未出现即标记取关”（`following.ts:150-156`），与爬虫“列表抓取不完整”的语义一致。未发现不一致。

`/ingest/followed-user-progress`：
- 爬虫发送 `{ urlToken, resumeOffset, historyDone, lastCheckedAnswerId }`（`main.ts:1137-1138`、`:1287`、`:1368-1370`）。
- Worker 解析同名字段并只写 R2（`ingest.ts:145-161`、`following.ts:264-281`）。
- `getFollowedUsersMap` 合并 D1 与 R2 时，进度字段以 R2 为准（`following.ts:84-94`）。字段一致；`lastCheckedAnswerId` 为空时不会覆盖旧值（`following.ts:274-276`）。未发现不一致。
- 附带发现：`followedProgress` 中虽然注入了 `syncMode`（`apify.ts:86-91`），爬虫只用 `resumeOffset/historyDone/lastCheckedAnswerId`（`main.ts:1145-1147`），`syncMode` 实际未被消费；全量与否由 `fullModeUsers` 集合决定（`main.ts:31`、`:1047-1051`）。冗余字段，无功能影响。

`/ingest/sync-state`：
- 爬虫上报 `{ key:"upvotes_cursor", value:url|null }`（`main.ts:768-770`）；Worker 只允许该 key，值必须是 `https://` 前缀或 null（`ingest.ts:179-199`）。
- 读取端返回 `upvotesCursor/cookieString/zhihuUsername/fullModeUsers/followedProgress/syncConfig`（`ingest.ts:110-143`），`local-sync.mjs:159-169` 与 `apify.ts:61-109` 均按同名读取。
- 字段一致；游标只在整页无失败且处于 resuming/非 fast 时推进（`main.ts:920-948`），与“单页零失败才推进”的 README 描述一致。

### 4.3 设置页 ↔ 爬虫实际消费

`syncConfig` 6 个字段的完整链路：

| 字段 | 存储/校验 | 注入 | 消费位置 | 结论 |
|---|---|---|---|---|
| `commentsMyAnswers` | `auth.ts:14,24,62` | `apify.ts:83,108`；`local-sync.mjs:167-169,202` | `main.ts:34`，用于 `main.ts:258`（是否抓）与 `main.ts:311`（hot 截断） | 已使用 |
| `commentsCollections` | `auth.ts:15,25,63` | 同上 | `main.ts:35`、`main.ts:684-688` | 已使用 |
| `commentsUpvotes` | `auth.ts:16,26,64` | 同上 | `main.ts:36`、`main.ts:873-878` | 已使用 |
| `commentsFollowing` | `auth.ts:17,27,65` | 同上 | `main.ts:37`、`main.ts:1254-1259` | 已使用 |
| `followingSensitivity` | `auth.ts:18,28,66` | 同上 | `main.ts:38`、`main.ts:1124-1125` | 已使用 |
| `preferredAiModel` | `auth.ts:19,29,35-40,67,81` | 随 `syncConfig` 一起注入，但爬虫不读 | Worker `recommend.ts:309-310`（AI 模型链首位） | 已使用（仅 Worker 侧） |

结论：6 个字段都有消费方，没有“存了但没人用”的字段；`preferredAiModel` 只在 Worker 的 AI 鉴定中使用，爬虫不消费属于设计预期。设置页对 4 个评论板块和灵敏度、模型均有对应控件（`AuthPage.tsx:366-510`），保存走 `POST /api/auth/settings`（`AuthPage.tsx:127-134`）。

注入完整性：
- `apps/worker/src/services/apify.ts` 确实注入了 `upvotesCursor`、`fullModeUsers`、`followedProgress`、`syncConfig` 四项（`:61-71`、`:77-95`、`:97-109`）。
- `apps/apify-crawler/.actor/INPUT_SCHEMA.json` 已声明 `upvotesCursor`（`:46-51`）、`fullModeUsers`（`:52-57`）、`syncConfig`（`:58-63`）、`followedProgress`（`:64-69`），满足“Apify 会剥离未声明字段”的约束。
- `scripts/local-sync.mjs` 从 `GET /ingest/sync-state` 读取并注入同样四项（`:159-169`、`:192-203`）。
- 关键限定：以上只对“新镜像/本地新代码”成立。云端当前仍是旧镜像，旧 INPUT_SCHEMA 没有这些声明，Worker 注入的 `syncConfig/followedProgress` 会在云端被剥离或忽略（见第六节 P0）。

### 4.4 写预算与限额护栏

`stats.estimatedWrites` 的 cost 模型（`main.ts:92-98`）与实际 D1 行写入对比：

| 路径 | 估算 cost | 实际典型行写入 | 判断 |
|---|---:|---|---|
| `/ingest/content` | 3 | 新建/正文变更 3（contents+version+event）；仅标题等 body 变更 2；仅计数/头像 1；无变化 0 | 偏保守（高估），不会低估 |
| `/ingest/comments` | 每条评论 2 | 新增/更新 3（comments+comment_versions+change_events）；仅刷新 1；删除 2 | 低估新评论约 33%，首次全量评论同步最危险 |
| `/ingest/upvote` | 2 | 1（INSERT 或 ON CONFLICT UPDATE 一行） | 高估，安全 |
| `/ingest/collection-snapshot` | 每条 item 1 | 新增 2（item+event）；更新 1；移除 2；另加 collections/snapshot 各 1 | 首次收藏夹快照低估约 50% |
| `/ingest/followed-users` | 每用户 1 | 每用户 1 行 upsert | 基本准确 |

结论：
- `MAX_DAILY_ESTIMATED_WRITES=90000` 相对 D1 免费版 100000 行/天留 10% 余量，在混合负载下大体合理；但高写入路径（首次评论全量、首次收藏快照）会低估，实际可能越过 100k 硬顶后才触发断路器。P1。
- 断路器触发方式：`post()` 在成功响应并把 cost 累加后，若 `estimatedWrites >= 90000` 才置 `circuitBroken`（`main.ts:99-105`）；`post()` 本身不会在已熔断时拒绝请求。生效点只在各 scraper 的页/计划级循环判断：
  - `runScraper`：页尾判断（`:285`）、评论队列任务开始判断（`:294`）、保存失败 catch（`:277`）；
  - `runCollectionScraper`：收藏夹循环/页尾判断（`:600`、`:723`）；
  - `runUpvotesScraper`：页尾判断（`:922`）；
  - `runFollowingScraper`：用户循环/计划循环/页循环条件（`:1141`、`:1188`、`:1193`）。
- 不能覆盖的路径：
  - `runScraper` 的评论分块循环没有检查 `circuitBroken`（`main.ts:404-421`），一次已收集的数百条评论仍会继续分块提交；
  - `syncHotCommentsForContent` 在 while 条件里检查熔断，但退出循环后仍会无条件发送已收集的评论（`main.ts:531-543`）；
  - 收藏单页/关注单页/赞同单页内部逐条循环不检查，最多多跑一页（约 20 条）的写入。
  因此断路器只能“在下一个检查点前刹车”，不能保证不越界。P1。
- 预算状态只存在进程内存（`main.ts:44-52`），没有按日期持久化：本地 08:05 与 20:05 是两个进程，各自从 0 开始，云端 Cron/手动 run 又是独立进程。若一天内两次本地运行都接近 90k，合计仍可超过 D1 100k 硬顶；云端旧镜像的阈值还是 120k（`bb06988` 之前的 `b65e3de` 值，本地已改为 90k）。P1。
- 熔断日志称“已保存断点”（`main.ts:103`），实际只有赞同游标（`main.ts:768-770`）和关注答主进度（`main.ts:1137-1138`、`:1287`、`:1369`）有持久化；我的回答/收藏夹没有游标，重启后从头扫（依赖 `changed`/`last_seen_at` 幂等）。P2（提示语过度承诺）。

### 4.5 文档与实现的一致性

| 文档描述 | 实现实际 | 结论 |
|---|---|---|
| README:5、23 “本地计划任务追平历史 + Cloudflare Cron 触发 Apify 快速增量” | 本地 `auto-sync-silent.vbs` 每天 08:05/20:05 跑 `--type=all --fast`；`wrangler.toml` cron `0 2,14 * * *` 触发 `triggerApifyRun(env,"all",true)`（`index.ts:75-77`） | 一致 |
| README:156 “Service Binding 同源免代理” | `apps/web/public/_worker.js:2-8` 对 `/api/*`、`/ingest/*` 走 `env.API.fetch`；README 的绑定变量名 `API` 与代码一致 | 一致 |
| README:19 “收藏夹与评论同步……支持 500 条分批幂等对账” | 评论 `CHUNK=500`（`main.ts:403`、`:534`），与服务端单请求 1500 上限兼容；收藏快照另有服务端 1000 条上限（`schemas.ts:87-88`），是该句之外的独立限制 | 评论描述一致；收藏条目上限未在 README 说明（补充项，不是错误） |
| README:19 “追踪收藏夹新增/移除条目” | 仅 `!incremental` 时做移除对账（`collections.ts:159`）；快速模式强制 `incremental=true`（`main.ts:741`） | 自动化快速同步不检测移除，文档未说明 |
| README:12、258 “默认每人精选前 50 篇（最新 20 + 最高赞 30）” | 首次历史摸底实际 `maxScan=60`（created）+ `maxScan=60`（voteups），最多扫描 120 篇（`main.ts:1181-1184`）；`following.ts:355-365` 的 `default_quota_items` 仍按 `min(total,50)` 展示 | 不一致（扫描上限 120 vs 展示/文档 50） |
| README:16 “免费 `[ai]` 算力（qwen1.5-14b / llama-3.1-8b）” | 默认 `@cf/qwen/qwen3-30b-a3b-fp8`，回退链为 deepseek-v4.1-flash、glm-5.3-flash、llama-3.3-70b、llama-3.1-8b（`auth.ts:35-40`、`recommend.ts:303-310`） | 不一致（模型列表过期） |
| README 未提及“设置中心 /settings”与“评论全量/热评/不抓” | 前端存在 `/settings`（`App.tsx:31`）与 4 个评论策略控件（`AuthPage.tsx:366-441`）；API 为 `GET/POST /api/auth/settings`（`auth.ts:341-356`） | 文档缺章，功能已实现 |
| README:251 “内容列表……按同步时间倒序” | 无变化条目不再刷新 `last_seen_at`（`contents.ts:348-349`），默认排序变成“最近一次实质变更/计数变化时间” | 语义漂移，未同步文档 |
| README:20 “连续 5 次失败自动安全停机保游标，绝不漏存” | 断路器只保 `upvotes_cursor` 与关注进度；评论 partial 批次失败后，`contents.comment_count` 已是全量值，`prevCommentCount` 不会因“评论行数不足”而归零（`contents.ts:220-231` 只判断 `cnt===0` 或头像未迁移），缺口可能长期存在（`main.ts:414-417` 的注释也承认） | “绝不漏存”过度承诺 |
| README:244-282 API 表 | 缺 `GET/POST /api/auth/settings`、`POST /ingest/followed-user-progress`；`/api/sync/*` 仍在表中，但前端头部“快速同步/全量扫描”按钮只弹提示、不调用接口（`Layout.tsx:10-15`、`:41-57`） | 局部不一致/缺项 |

另外发现一个与功能无关但与安全相关的文档问题：`README.md:120`、`README.md:203` 与 `apps/web/src/pages/AuthPage.tsx:121` 出现固定的操作口令明文（本报告不复述具体值）。若线上仍在用该口令，任何拿到仓库/截图的人都能修改或清空知乎 Cookie。P1，建议轮换口令并从文档/提示语中移除。

### 4.6 现存风险与待办总览

- 本次共识别：P0 1 项、P1 7 项、P2 10 项（明细见第五节）。
- 未实现阶段：爬虫状态机 `sync-state.json`、按内容 id 断点、批量 `/ingest/batch`、删除废弃 `apps`、VPS/Turso 评估，均未在仓库中出现（详见第七节）。
- 部署差异：Worker 侧改动已在线上；爬虫侧改动只在本地下次运行时通过 `tsc` 生效；Apify 云端仍是旧镜像，必须重新部署才生效（详见第六节）。

---

## 五、现存风险（P0/P1/P2）

| 级别 | 风险与触发条件 | 证据（文件:行号） | 影响 |
|---|---|---|---|
| P0 | 云端 Apify 仍是旧镜像：Worker 注入的 `syncConfig`/`followedProgress` 在旧 INPUT_SCHEMA 下被剥离/忽略；旧镜像仍用 120000 预算与逐条 `/answers/{id}` 详情请求。触发：每天 Cron 10:00/22:00 或手动 `/api/sync/*` 的云端 run | `apps/apify-crawler/src/main.ts:43`（本地已是 90000）、`apps/worker/src/services/apify.ts:97-109`、`apps/apify-crawler/.actor/INPUT_SCHEMA.json:58-69`；部署状态由任务给定 | 云端设置不生效（如 comments=none 仍会抓评论）、102 位关注答主每轮从头扫、预算超过 D1 100k 硬顶后连续 500 并熔断；这是“必须重新部署 Apify 才生效”的核心项 |
| P1 | 评论写入成本按 2 行/条估算，实际新增/更新为 3 行/条。触发：首次全量评论同步、热门回答数千评论 | `apps/apify-crawler/src/main.ts:94`；`apps/worker/src/services/comments.ts:65-159` | 90k 估算可能对应约 135k 实际写入，越过 D1 100k 硬顶才发现 |
| P1 | 熔断后仍有继续提交的路径：`post()` 不拒绝已熔断请求；评论分块循环、`syncHotCommentsForContent` 退出循环后的发送都不检查 `circuitBroken` | `main.ts:54-108`、`:404-421`、`:531-543` | 单次可越界数百至上千行写入，断路器不能保证硬顶 |
| P1 | 预算只存在进程内存、不按天共享：本地 08:05 与 20:05 各自从 0 计数，云端 run 另起进程；旧镜像阈值 120k | `main.ts:43-52`、`:99-105`；`scripts/auto-sync-silent.vbs` | 同一天多次运行可能累计超过 D1 100k；熔断状态无法跨进程恢复 |
| P1 | 评论 NULL/空串语义导致永久重写/重抓：`time_text`/`location` 为 NULL 且本次为空串时永久 `needsRefresh`；`author_avatar` 为 NULL 且本次为空串时永远被 `contents` 判为“未迁移”，`prevCommentCount` 恒 0 | `apps/worker/src/services/comments.ts:164-179`、`apps/worker/src/services/contents.ts:220-231` | 相关内容的评论每轮全量重抓 + 行重写；`runScraper` 的 `existingCount` 被反复清零（`main.ts:264`），早停失效，写入放大回归 |
| P1 | 评论 partial 批次失败后缺口无人修复：`contents.comment_count` 已是全量值，`resolvePrevCommentCount` 只判断 `cnt===0`/头像未迁移，不比较 `cnt < comment_count` | `main.ts:404-421`（代码注释自述缺口）、`contents.ts:220-231` | 中途失败/熔断后缺失的评论批次永久缺失，直到该内容评论数再次增长才可能被 `runScraper` 重抓 |
| P1 | 评论补抓策略不一致：`runScraper` 在评论数增长时补抓；collection/upvotes/following 只在 `prevCommentCount===0` 时抓 | `main.ts:260` vs `main.ts:686`、`:875`、`:1256` | 收藏/赞同/关注频道下，已抓过一次的内容新增评论永远不会再抓，评论备份逐渐过期 |
| P1 | 操作口令明文出现在仓库文档与前端提示中 | `README.md:120`、`README.md:203`、`apps/web/src/pages/AuthPage.tsx:121` | 仓库/截图泄露即可覆盖 Cookie 或清空凭据；且已进入 git 历史，仅删除文本不够，需要轮换 |
| P2 | 内容单字段变化不落库：`source_url`、`question_id`、`question_title`、`author_name`、`author_url_token`、`label_info`、`excerpt`、`created_time`、`updated_time` 不参与比较，只在 body 分支整行 UPDATE 时写入 | `contents.ts:184-216`、`:239-271` | 答主改名、URL 纠错、问题标题变更等要等下一次正文/计数变化才被顺带修复 |
| P2 | 头像轮换仍会为每篇内容写一条 profile UPDATE，只是 `changed=false`；日志把它计入“无变化” | `contents.ts:315-324`、`main.ts:253-254` | 写入放大从 3 行降到 1 行但未归零；“无变化 89 条”不是零写入 |
| P2 | 每次 `/ingest/content` 即使 `changed=false` 也会重新 PUT 同一 R2 对象 | `apps/worker/src/routes/ingest.ts:44-66` | R2 Class A 写操作与 Worker 子请求被无谓消耗；大账号每轮数百次 |
| P2 | 收藏条目未变化时 `continue` 不刷新 `last_seen_at`，详情页按 `last_seen_at DESC` 排序 | `collections.ts:125-132`、`:245` | 收藏详情条目顺序停留在旧值 |
| P2 | 快速模式强制 `incremental=true`，自动同步永不检测收藏夹移除 | `main.ts:741`、`collections.ts:159-181` | 收藏移除状态只在手动全量时更新，README 未说明 |
| P2 | `local-sync.mjs` 仅在 `apps/apify-crawler/node_modules/typescript/bin/tsc` 存在时编译，缺失时静默跳过 | `scripts/local-sync.mjs:212-223` | 依赖目录损坏时会用旧 `dist` 运行，且无告警 |
| P2 | 关注进度以“读整个 R2 map—改—写回”方式更新 | `following.ts:264-281` | 本地与云端 run 并发（手动触发/长任务重叠）时后写覆盖先写，丢失进度 |
| P2 | `favorite_count` 缺失时回退到 `thanks_count` | `main.ts:226`、`:673`、`:860` | “感谢数”被写成“收藏数”，可能虚高 |
| P2 | README 与实际不一致：模型列表过期、默认 50 篇 vs 实际 60+60、`/settings` 与评论策略未文档化、列表“同步时间”语义漂移 | `README.md:12`、`:16`、`:19`、`:20`、`:251`；`main.ts:1181-1184`；`auth.ts:35-40`；`App.tsx:31` | 使用/运维预期偏差，排障时误判 |
| P2 | 早停日志可能误报：自然翻到末页且尾部恰好有 20 条未变时也会打印“命中连续无更新早停”；`createdCount` 不统计正文/计数变化 | `main.ts:434-437` | 统计日志不能直接用于评估同步效果 |

---

## 六、部署与生效状态矩阵

| 变更 | 线上 Worker | 本地计划任务 | Apify 云端 | 依据 |
|---|---|---|---|---|
| `contents/comments/upvotes/collections` 按需写 | 已上线（任务给定 Worker 已部署最新） | 生效（所有写入都经 Worker） | 生效（所有写入都经 Worker） | `contents.ts:233-349`、`comments.ts:161-179`、`upvotes.ts:19-21`、`collections.ts:123-132` |
| `apify.ts` 注入 `syncConfig/followedProgress/fullModeUsers/upvotesCursor` | 已上线 | 生效 | 注入已发出，但旧镜像不消费 | `apify.ts:61-109` |
| 90k 写预算、删除逐条详情请求、4 个统计日志 | 不适用 | 下次 08:05/20:05 编译源码后生效 | 未生效（旧镜像仍 120k、仍有详情请求） | `main.ts:43`、`:225-227`、`:433-437`；`local-sync.mjs:211-223` |
| `INPUT_SCHEMA` 新增 `syncConfig/followedProgress` | 不适用 | 不适用（本地直接读 INPUT.json） | 未生效，必须重新 push/build Apify | `.actor/INPUT_SCHEMA.json:46-69` |
| `/settings` 页面与 4 个评论策略控件 | 代码在仓库；Pages 是否已重新部署未验证 | 不适用 | 不适用 | `App.tsx:31`、`AuthPage.tsx:366-510` |
| `followed_users` migration `0003` | 远端是否已 apply 未验证；缺表时代码降级为 R2（`following.ts:49-51`、`:97-99`） | 不适用 | 不适用 | `apps/worker/migrations/0003_followed_users.sql` |
| README 文档 | 未随代码更新 | 不适用 | 不适用 | 第四节 4.5 |

按生效方式分组：

- 已在线上生效：Worker 的 `contents/comments/upvotes/collections` 写入策略、`/api/auth/settings`、`/ingest/sync-state` 扩展字段、`apify.ts` 的四项注入（前提：Worker 确已按任务给定部署最新）。这些对所有调用方（本地/云端）立即生效。
- 只在本地下次运行生效：`apps/apify-crawler` 的 90k 预算、删除逐条详情请求、统计日志、`syncConfig`/`followedProgress` 消费；`local-sync.mjs` 每次运行会重新 `tsc`，所以 08:05/20:05 的下一次任务即可带上新代码（前提：`node_modules/typescript` 存在）。
- 必须重新部署 Apify 才生效：云端 Actor 的上述爬虫侧全部改动，以及新 `INPUT_SCHEMA` 对 `syncConfig`/`followedProgress` 的声明。未重新部署前，云端 run 仍然：120k 预算、逐条详情请求、忽略设置与关注进度、每轮重扫 102 位答主。
- 未验证：Pages 前端是否已重新部署、远端 D1 migration `0003` 是否已执行、R2/D1 实际数据量、知乎线上列表接口是否稳定返回 `voteup_count/visit_count/favorite_count/comment_count`、线上 Worker 是否确实为 `bb06988` 版本。

---

## 七、待办与建议（按优先级）

### 7.1 立即（P0）

1. 重新部署 Apify Actor（`cd apps/apify-crawler && apify-cli push`，在控制台 Build），确认新 `INPUT_SCHEMA` 生效；用一次 `isFast=true` 的云端 run 验证：
   - 日志出现“日常增量/全量断点续传”而不是每位答主从头扫；
   - 预算阈值为 90000；
   - 不再出现逐条 `/answers/{id}` 详情请求；
   - `commentsFollowing=none` 等设置确实阻止评论抓取。

### 7.2 高优先（P1）

1. 把写预算改成“按日持久化、跨进程共享”的账本（D1/R2 按日期 key 存已用行数），或由 Worker 在响应里回传实际写入行数；至少让本地两次运行与云端 run 共享同一日额度。
2. 修正 cost 模型：`/ingest/comments` 按 3 行/条（新增/更新），`/ingest/collection-snapshot` 按 2 行/新条目 + 固定 2 行，避免首次全量低估。
3. 在 `post()` 入口短路已熔断状态；在评论分块循环、`syncHotCommentsForContent` 的发送段、各 scraper 的逐条循环中加入 `circuitBroken` 检查。
4. 统一评论 NULL/空串语义：对 `time_text/location` 用 `COALESCE` 归一化后再比较；对 `author_avatar` 增加“已尝试迁移”标记（或把未迁移判定改为 `author_avatar IS NULL AND first_seen_at < 某阈值`），避免匿名头像导致永久重抓与早停失效。
5. 补“评论完整性”判定：`resolvePrevCommentCount` 在 `cnt < comment_count` 时也返回 0，或在 `contents` 记录上次评论同步是否完整（partial 标记），让 partial 缺口在下轮自动修复。
6. 统一四个 scraper 的评论补抓策略（建议都用 `commentCount > prevCommentCount` 或显式的“评论是否过期”字段），避免收藏/赞同/关注频道只抓一次。
7. 轮换凭据页操作口令，并从 `README.md`、`AuthPage.tsx` 的提示语中移除明文；仅改文本不够，需同时在 D1 `app_settings.cookie_write_token` / 环境变量中更新。

### 7.3 中低优先（P2）

1. 内容变更检测补上 `source_url/question_id/question_title/author_name/label_info/excerpt/created_time/updated_time` 中至少 URL、问题标题、作者名的比较，避免单字段变化永不落库。
2. `/ingest/content` 在 `changed=false` 时跳过 R2 PUT（或先比较 hash 是否存在同名对象），减少 R2 Class A 与子请求。
3. 收藏条目 `continue` 时也可只更新 `last_seen_at`（如果详情排序依赖它）；或在详情查询改用 `first_seen_at` 排序并在文档说明。
4. 快速模式收藏移除对账：若要保留“快速不误删”，在 README 与 UI 明确“移除仅在手动全量时检测”。
5. `local-sync.mjs` 在找不到 `tsc` 时至少打印警告并退出，避免静默使用旧 `dist`。
6. 关注进度改为按用户粒度写 R2（或加版本号/乐观锁），避免并发 run 覆盖。
7. `favorite_count` 去掉 `thanks_count` 回退，或单独建模“感谢数”，避免指标混淆。
8. 更新 README：模型列表、默认 50 vs 实际 60+60、`/settings` 与评论策略、列表“同步时间”语义、`/api/auth/settings` 与 `/ingest/followed-user-progress` 缺项。
9. 修正统计日志：单独记录“正文变更”和“仅计数/资料变化”，早停用显式布尔值而不是 `existingCount >= 20` 推断。

### 7.4 报告中未做的阶段与优先级建议

| 未做阶段 | 当前状态 | 建议优先级 | 理由 |
|---|---|---|---|
| 爬虫状态机 `sync-state.json` | 仓库中不存在；目前只有 `upvotes_cursor`（D1 `app_settings`）与 `meta/followed_users.json` 中的关注进度 | P1 | 本地/云端多进程运行，缺统一状态机时无法判断“上次跑到哪、是否完整”，也是 partial 缺口与重复扫描的根因之一 |
| 按内容 id 断点 | 未实现；`runScraper` 每轮 offset 从 0 开始；收藏夹无游标；只有关注答主有 `resumeOffset/lastCheckedAnswerId` | P1 | 我的回答/收藏夹在中断后只能靠 `changed=false` 早停或重扫，老账号大收藏夹重复成本高 |
| 批量 `/ingest/batch` | 未实现；仍逐条 `POST /ingest/content` | P2 | 可减少 HTTP 往返与 Workers 子请求，但会增大单请求事务复杂度；在 D1 写入额度问题解决后再做 |
| 删除废弃 `apps` | `apps/api`（Hono + better-sqlite3 本地后端）与 `apps/collector`（旧 collector、测试脚本）仍在 `pnpm-workspace` 和 git 中（两者合计 34 个 tracked 文件）；工作目录里还有未 tracked 的 `answer_raw.json`、`comments_raw.json` 等原始抓取样本 | P2 | 死代码增加审查面；原始样本存在内容/凭据残留风险，建议清理 |
| VPS/Turso 评估 | 无代码、无文档 | P2 | D1 免费版 100k 行/天硬顶、无交互式事务是当前写入放大的结构性约束；若同步规模继续增长，需评估 SQLite 兼容托管（Turso）或自建 VPS + 本地 SQLite 的迁移成本 |

---

## 附：本次审查证据索引

- 工作区状态：`git status --short` 为空；HEAD `bb06988`。
- 构建验证：`pnpm --filter apify-crawler build && pnpm --filter web build && (cd apps/worker && npx tsc --noEmit)`，EXIT 0。
- 关键代码：`apps/worker/src/services/contents.ts`、`comments.ts`、`upvotes.ts`、`collections.ts`、`following.ts`、`apify.ts`、`recommend.ts`、`risk.ts`；`apps/worker/src/routes/ingest.ts`、`auth.ts`；`apps/apify-crawler/src/main.ts`、`.actor/INPUT_SCHEMA.json`；`scripts/local-sync.mjs`、`scripts/auto-sync-silent.vbs`；`apps/web/src/App.tsx`、`pages/AuthPage.tsx`、`components/Layout.tsx`；`packages/shared/src/schemas.ts`；`apps/worker/migrations/0000_schema.sql`。
- 提交证据：`bb06988`、`697f5f8`、`b65e3de` 的提交说明与 diff。
