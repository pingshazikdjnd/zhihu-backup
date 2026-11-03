# 21 · 独立抽样复测报告（2026-11-01）

> 方法：对 10~15 号产物的 7 条字段结论做独立复测。所有结论只依据**本轮自己发出的 9 个请求**的响应，不照抄任何既有产物的数据；URL 目标（账号 `yang-xu-heng-94`、收藏夹 `822239827`、回答 id 取自本轮 R1 响应）沿用项目已知对象。
> 请求器：`G:/gemini zhihu/apps/collector/.fieldprobe/fetch.mjs`（每次调用 1 个 job，调用间显式 `sleep 3` + 启动耗时，实际间隔 >=3200ms）。
> **预算：9/9 用尽，全部 200，未出现 403/40353/40362**；`G:/gemini zhihu` 仅读取并运行 `.fieldprobe/fetch.mjs`，未写入项目任何文件。原始响应留存 `tmp/verify21/out-*.json`（jobs 同目录）。

## 0. 总判定

| # | 结论 | 判定 |
|---|------|------|
| 1 | answers 列表 4 计数 include 也拿不到；comment_count/content 需要 include；statistics 仅两键 | **PASS** |
| 2 | answer 详情 favorite_count 缺失；reaction.statistics 17 键 | **PASS** |
| 3 | 评论接口忽略 include；无 img 字段；vote_count；top/featured 键名 | **PASS** |
| 4 | 文章列表 include 只多 4 字段；favorite/visit/thanks 拿不到；收藏在 statistics.favorites | **PASS** |
| 5 | members 计数必须 include 才返回 | **PASS**（仅验证 include 方向） |
| 6 | collections/items 忽略 include；answer 27 键 / article 14 键；favorite/visit 拿不到 | **PASS** |
| 7 | v3 activities data[] 9 键；target.answer 34 / question 16 | **UNVERIFIED**（预算耗尽未发出） |

**PASS 6 条 / FAIL 0 条 / PARTIAL 0 条 / UNVERIFIED 1 条。没有发现任何误报。**

## 1. 请求台账（9 个）

| # | id | 端点摘要 | status | 结果文件 |
|---|----|----------|--------|----------|
| 1 | v21_r1_answers_noinc | `/api/v4/members/…/answers?limit=5`（无 include） | 200 | out-r1.json |
| 2 | v21_r2_answers_inc | 同上 + include（**原始逗号 + 每项重复 data[*]. 前缀**） | 200 | out-r2.json |
| 3 | v21_r2b_answers_inc_fixed | 同上 + include（**首项前缀 + %2C 分隔**） | 200 | out-r2b.json |
| 4 | v21_r3_answer_detail_inc | `/api/v4/answers/2095990096667341029?include=6项` | 200 | out-r3.json |
| 5 | v21_r4_root_comments_inc | `/api/v4/answers/2082485163410331245/root_comments?limit=5&include=9项` | 200 | out-r4.json |
| 6 | v21_r6_articles_inc | `/api/v4/members/…/articles?limit=2&include=8项` | 200 | out-r6.json |
| 7 | v21_r7_members_inc | `/api/v4/members/yang-xu-heng-94?include=10个计数` | 200 | out-r7.json |
| 8 | v21_r8_collections_items_inc | `/api/v4/collections/822239827/items?limit=50&include=6项(%2C编码)` | 200（**空响应**） | out-r8.json |
| 9 | v21_r8b_collections_items_inc20 | 同端点 `limit=20` + 原始逗号 content 级 include（20 项） | 200 | out-r8b.json |

（R5 计划中的 root_comments 无 include 对照、R9 activities 因预算未发出；R2 是语法失误但如实计入预算。）

## 2. 逐条复测依据

### 断言 1 — PASS（R1 + R2b 双向对照）
- R1（无 include，9 条）：`comment_count/content/voteup_count/favorite_count/visit_count/thanks_count` 全部不存在；`reaction.statistics={like_count,favorites}`。
- R2b（include 生效形态，9 条）：`comment_count`（…/343/2）与 `content` 返回；**4 个计数被显式请求仍全部缺席**；`reaction.statistics` 仍恰 `{like_count,favorites}` 两键（请求的就是 reaction.statistics，没有多出第三键）。
- "只有 comment_count、content 需要 include" 成立：默认无、include 后有，且这是仅有的两个新增键。

### 断言 2 — PASS（R3）
- 顶层 23 键中无 `favorite_count`（include 显式请求了它）；`voteup_count=36、visit_count=1049、thanks_count=1、comment_count=0` 均在场。
- `reaction.statistics` **恰 17 键**：applaud_count, bullet_count, comment_count, down_vote_count, favorites, interest_play_count, like_count, plaincontent_like_count, plaincontent_vote_up_count, play_count, pv_count, question_answer_count, question_follower_count, republishers, share_count, subscribe_count, up_vote_count。

### 断言 3 — PASS（R4）
- include（9 项，含 7 个"不存在字段"候选 + content/vote_count）在 R2b 已证明可生效的形态下发出；totals=6，返回 5 条根评论。
- 对整份响应做键树遍历：`img_url/image_url/imageUrl/is_top/is_featured/like_count/likes` **零出现**；`data[]` 键并集恰 29 个纯默认模式键（含 censor_status、can_recommend、child_comment_count、attached_info 等），include 未增删任何字段。
- `vote_count`（number，样本 379）、`top`、`featured`（boolean，样本 featured=true）在场；`is_top/is_featured` 不存在。
- 注：单请求下"接口忽略 include"与"这些字段本就不存在"不可分离，但两种解释对该结论的操作含义一致（请求了也白求）。

### 断言 4 — PASS（R6）
- 两条文章 item 均 **25 键** = 所称 21 默认键 + 4 个 include 键（content/voteup_count/comment_count/is_labeled），并集完全吻合、无第 5 个新增键。
- `favorite_count/visit_count/thanks_count` 显式请求仍缺席。
- `reaction.statistics={like_count,favorites}`：favorites=1/12（真实收藏数载体）；like_count=0 而 voteup_count=4/3，两数分离复现。
- caveat：无 include 的 21 键基线未在本轮复测（预算），见 §4。

### 断言 5 — PASS，仅 include 方向（R7）
- 10/10 计数以顶层 number 返回：answer_count=562, articles_count=22, follower_count=1209, following_count=102, voteup_count=36253, thanked_count=19278, favorited_count=18909, question_count=96, pins_count=21, logs_count=457。
- 附赠 `follower_count_text/_num/_unit`、`following_count_num/_unit`（与既有结论一致）；响应 41 顶层键。
- "无 include 时计数不返回"的反向未在本轮复测（预算耗尽），本轮无任何反证。

### 断言 6 — PASS（R8b）
- totals=921，20 条（19 answer + 1 article）；外层 item 仅 `{content, created}`。
- `content.answer` **恰 27 键**、`content.article` **恰 14 键**，逐键与结论相符（answer 含 thanks_count/thumbnail_info/attachment 等；article 为贫化对象，时间用 created/updated）。
- include 显式请求的 `favorite_count/visit_count/reaction.statistics/is_labeled` 一个都没出现；answer/article 两侧均无 reaction；include 未新增任何键 → "忽略 include"成立。
- `thanks_count` 在 answer 侧存在（属 27 键默认面），与结论一致。

### 断言 7 — UNVERIFIED
- 9 个请求预算在断言 1~6 复测中耗尽（1 个用于修正 include 语法、1 个用于复测 R8 空响应异常），`/api/v3/moments/…/activities` 未发出。不给结论，不猜。

## 3. 两个本轮新发现（对采集器有直接影响）

1. **include 语法陷阱（R2 vs R2b）**：include 写成"原始逗号分隔 + 每项重复 `data[*].` 前缀"时，服务端**整体静默忽略** include（响应与无 include 完全一致，不报错）。必须写成"首项带 `data[*].` 前缀、其余裸字段名、逗号编码为 `%2C`"（items 端点则用 `data[*].content.` 前缀 + 原始逗号亦可用，见 R8b）。任何"include 不生效"的旧结论都应先排查是不是踩了这个语法坑（11 号产物的 D 请求正是原始逗号形态）。
2. **collections/items 的 limit=50 空响应（R8）**：同一收藏夹、同一 Cookie，`limit=50` + %2C 编码 include 返回 **200 但 totals=0、data=[]**；`limit=20` + 原始逗号 include 正常返回 921/20 条（R8b）。R2b 已证明 %2C 编码在 v4 answers 列表可用，故首要嫌疑是 items 端点对大 limit 返回静默空页（%2C 在该端点的兼容性为次要嫌疑，未单变量隔离）。**采集器翻页请把 items 的 limit 控制在 20 以内**，并建议后续单独复测确认阈值。

## 4. unverified 清单

- 断言 7（activities 9/34/16 键）：未发出请求。
- 断言 5 反向（members 无 include 时无计数）：未复测。
- 断言 4 基线（articles 无 include 恰 21 键）：未复测（本轮验证的是"include 响应恰为 21+4 并集"）。
- 断言 3 中"忽略 include"与"字段不存在"不可分离（单请求局限）。
- R8 空响应成因（limit=50 vs %2C include）未做单变量隔离。

## 5. 产物

- 本报告：`21-verification.md` / `21-verification.json`
- 原始响应与 jobs：`tmp/verify21/out-r1|out-r2|out-r2b|out-r3|out-r4|out-r6|out-r7|out-r8|out-r8b.json`（jobs 同目录）
- 分析脚本：`analyze-21.mjs`（键树遍历/计数，均以绝对路径参数运行）
