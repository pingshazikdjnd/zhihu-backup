# 字段审计报告：知乎实际返回 vs 项目实际使用（2026-10-28）

> **【2026-11-02 真机复核勘误】** 本文写于 2026-10-28，以下旧推断已被 `docs/知乎字段审计-2026-11-01/10~15-live` 推翻，引用时以真机审计为准：
> 1. “include 40 键中 26 生效、6 个纯浪费”的统计不成立——各端点生效键集合不同，不能再用 26/6 口径。
> 2. 文章列表 `voteup_count` 带 include **实际有效**（12-live-articles 实测返回），并非“include 未被验证生效”。
> 3. 文章 `reaction.statistics.like_count` 是**伪值 0**（与 `voteup_count` 无关，不能当赞同数）；收藏夹条目 `content` 无 `reaction` 对象。

> 方法：① 真机 GET 12 次探查知乎各接口实际返回字段（只用字段名/类型，不记录值）；② 全仓库静态排查每个列/字段的写入点与读取点。全程只读。

## 一、知乎接口实测结论（关键）

### 1. include 里**请求了但知乎根本不返回**（白请求）

| 字段 | 说明 |
|---|---|
| `annotation_detail` | 列表不返回 |
| `label_info` | 不返回（`is_labeled` 正常返回） |
| `is_recognized` | 不返回 |
| `favorite_count` | 答案列表不返回（真实值在 `reaction.statistics.favorites`） |
| `topics`（`author.badge[]`） | badge 恒为空数组 |
| `voteup_count` | 答案列表不返回（真实值在 `reaction.statistics.like_count`） |
| `visit_count` | 答案列表不存在（疑似只在 `question.visit_count`） |

→ 我们现在的 include 有 40 个键，其中 26 个生效、6 个纯浪费。

### 2. 代码读取但接口不保证返回（**会导致数据恒为 0**）

| 位置 | 字段 | 实测 | 后果 |
|---|---|---|---|
| answers 列表 | `item.visit_count` | 不存在 | **回答浏览量恒 0** |
| answers 列表 | `item.voteup_count` | 不存在 | 靠 `reaction.statistics.like_count` 兜底，结果正确 |
| answers 列表 | `item.favorite_count` | 不存在 | 靠 `reaction.statistics.favorites` 兜底，结果正确 |
| **articles 列表** | `item.voteup_count / favorite_count / visit_count` | 默认不返回，include 也未被验证生效 | **文章赞数/收藏/浏览恒 0 → 「赞≥100 才进 AI 候选」门槛永远不成立，文章自动抢救实际失效** |
| collections 条目 | `favorite_count` → 兜底 `thanks_count` | 无 favorite_count，有 thanks_count | **收藏夹的"收藏数"实际是"感谢数"** |
| followees | `answer_count/articles_count/follower_count` | 必须带 include 才有 | 当前 include 正确，若被删则专栏文章全部不抓 |

### 3. 给了但我们没要（可白拿）

`reaction.statistics.favorites`（唯一真实收藏数）、`question.visit_count`、`author.badge_v2`、`can_comment`、`review_info`、`extras`、`thumbnail`、文章 `excerpt_title/image_url`、评论 `can_recommend/censor_status`、关注 `follower_count_num/text`。

### 4. 单条 JSON 体积（用于判断哪些字段是体积大户）

| 端点 | 单条字节 | 最大字段 |
|---|---|---|
| collections/items | 4,649 | `content` 4,599（98.9%） |
| activities (v3) | 8,348 | `target` 7,371（88.3%） |
| comments | 1,587 | `author` 774（48.8%） |
| answers（带 include） | 2,242 | `author` 566（25.2%） |

## 二、项目里**永远用不到**的字段/列

### 1. 数据库列

| 表 | 列 | 判定 | 建议 |
|---|---|---|---|
| `comment_versions` | **整张表 7 列** | 全仓库 **0 次 SELECT** | **可删整表**（每写一条评论多写 1 行，占评论写入量 1/3） |
| `change_events` | `payload_json` | 写整条评论原文（可达 10KB），**0 读取** | **可删列**（写放大最大来源之一） |
| `contents` | `deleted_at` | 恒 NULL，0 读取 | 可删 |
| `contents` | `first_seen_at` | 只写不读 | 可删 |
| `contents` | `content_html` | 恒写空串（正文在 R2） | 保留但勿用 |
| `content_versions` | `title/content_html/content_md/excerpt` | 恒写空串，0 读取 | 可删 4 列 |
| `content_versions` | `voteup_count/comment_count` | 仅回传，前端不渲染 | 可删 |
| `comments` | `img_url` | crawler 会写真图链，**前端连类型都没有** | 待确认（建议补渲染，删前先导出） |
| `comments` | `last_seen_at` / `deleted_at` | 只写不读 | 可删 |
| `collections` | `owner_token` / `first_seen_at` | 只写不读 | 可删 |
| `collection_items` | `removed_at` | 只写不读 | 可删 |
| `upvotes` | `first_seen_at` / `last_seen_at` | 只写不读 | 可删 |
| `followed_users` | `first_seen_at` / `last_synced_at` | 只写不读 | 可删 |
| `followed_users` | `user_id` | 只写不读 | 建议保留（未来调用户 API 可能用） |
| `sync_runs` | 整表 | 有写入，仅 `/api/changes/sync-runs` 返回，前端从不调用 | 待确认（运维日志可留） |
| `contents` | `is_deleted` | **生产永远为 0**（无删除检测写入路径） | 不是可删字段，而是"缺功能"：要么补删除检测，要么撤掉"已删除"徽标与风险引擎 55 分权重 |

### 2. R2 对象

| key 前缀 | 用途 | 判定 |
|---|---|---|
| `html/{pk}/{hash}` | 正文 | ✅ 正常 |
| `html/{pk}` | 只读回落 | 历史兼容 |
| **`versions/{pk}/{hash}`** | ingest 写入，**全仓库 0 读取** | **死存储，且与 html/ 同字节双写（存储翻倍）** |
| **`md/{pk}/{hash}`** | 读取分支存在，但爬虫恒传 `contentMd=""` | **永远为空，读分支恒 miss** |
| `meta/*` | 关注名录/设置/AI 缓存 | ✅ 正常 |

### 3. JSON payload

- 5 条上报链路的字段**全部命中 zod schema，没有被 strip**。
- 唯一"构造后丢弃"的是爬虫 AI 候选对象里的 `contentInput` 字段（发送前被白名单裁掉）。
- 所有 `contentMd` 恒为 `""`（爬虫从不上报 Markdown）。

## 三、最值得清理的 Top 5（直接影响写入量）

| # | 对象 | 省下什么 | 风险 |
|---|---|---|---|
| 1 | `comment_versions` 整表 | **评论写入从 3 行/条降到 2 行/条（-33%）** | 失去评论编辑历史（当前也无入口可看） |
| 2 | `change_events.payload_json` | 评论事件不再写整条原文（单条可达 10KB） | 无法从事件流重放，删前先导出 |
| 3 | R2 `versions/` + `content_versions` 4 个空列 | 正文存储减半、版本表写入减半 | 删除后旧版本正文不可恢复（现状也无读取路径） |
| 4 | `comments.img_url` | 列很小，但**图片评论原图链是唯一副本** | 删前补前端渲染或导出 |
| 5 | 死元数据簇（`owner_token`/`first_seen_at`/`removed_at`/`upvotes.first/last_seen_at`） | 每行写入略减 | 低 |

**如果全做**：全量评论的 D1 写入可从 **3 行/条降到 1 行/条**（只留 comments 主表），配合"评论正文进 R2"，可从 232 天降到 **1 天内完成**。

## 四、建议立刻修的三个数据错误

1. **文章赞数恒 0**：`main.ts` 文章路径改用 `item.voteup_count ?? item.reaction?.statistics?.like_count`，否则「赞≥100 进 AI 候选」永远不成立，文章自动抢救形同虚设。
2. **回答浏览量恒 0**：`visit_count` 从 answers 的 include 里删掉，改用 `question.visit_count`（或直接接受为 0，避免误导）。
3. **收藏夹"收藏数"实为"感谢数"**：`favorite_count` 缺失时不要回退 `thanks_count`，改为 `reaction.statistics.favorites`，并单独建模感谢数。

## 五、一句话结论

知乎列表接口只保证 `reaction.statistics` 与 include 白名单字段；我们 include 里 6 个字段是白请求、3 个统计字段恒 0、`comment_versions`/`payload_json`/`versions/` 三处是纯写入无读取。**先删这三处写放大，再谈全量评论，成本能降一个数量级。**