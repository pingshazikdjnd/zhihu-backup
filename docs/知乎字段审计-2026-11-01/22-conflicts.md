# 22 · 旧审计 vs 真机实测 对账报告（2026-11-01）

- 对象：`G:/gemini zhihu/FIELD_AUDIT.md`（2026-10-28，只读未动）vs 2026-11-01 真机产物（10/11/12/13/14/15/20 号 + 01 盘点）
- 方法：旧文档行号经 `grep -n` 核实；include 键数对 01 JSON 逐键重算；体积对原始响应逐条实测字节（utf-8 紧凑序列化）
- 机器可读版：`22-conflicts.json`
- **结论速览：7 个冲突点 — 旧审计仍成立 5 条（C2/C4/C5/C6/C7），部分成立部分过时 2 条（C1/C3）。旧审计的"事实观察"几乎全对，错在两处拆分/后果判定（include 生效拆分、文章赞数恒 0）。**

---

## C1 include 键数量：40 vs 32 —— both_partly

| 方 | 主张 | 出处 |
|---|---|---|
| 旧 | "include 有 40 个键，其中 26 个生效、6 个纯浪费"；白请求表列 7 行 | FIELD_AUDIT.md:19（表 ：9-17） |
| 新 | answers_list_mine=32（31 标量+1 badge）、collections_items=32、answer_detail=4、followees=5、member_answers=13、member_articles=7，合计 93 项；全仓字段名去重并集=40 | 01-endpoints-include.json（逐键重算） |

**判定：两个数字各自口径都对。** "40"=全部端点 include 字段名去重并集，脚本重算精确等于 40；"32"=单个 answers/collections include 串项数。只在一方出现的键（相对 answers 32 项）：并集独有 **8 项** = `answer_count/articles_count/follower_count/headline/avatar_url`（followees 5 项）+ `created/updated/title`（member_articles 3 项）；反向 answers 32 项无一缺失。

**真正错的是旧审计的拆分**：proj include 32 项实测 **21 项按请求路径返回、11 项未返回**（annotation_detail、voteup_count、label_info、voting、is_author、is_thanked、is_nothelp、is_recognized、visit_count、favorite_count、badge topics），其中 4 项（voting/is_author/is_thanked/is_nothelp）位移到 `relationship.*` 返回 → 严格"响应任何位置都没有"= **7 项**。"26 生效、6 白请求"与实测（21/11 或 25/7）不符，且 26+6=32 与自身"40"矛盾、白请求表 7 行与"6"矛盾——该表 7 行内容反而与实测严格白请求 7 项完全吻合。

## C2 answers 列表三统计字段 —— agree（旧审计对）

- 旧（FIELD_AUDIT.md:14,16,17,25-27）：列表不返回 voteup_count/favorite_count/visit_count；visit_count 疑似只在 question.visit_count；兜底结果正确但浏览量恒 0。
- 新（10-live-answers.json）：proj/max 两次带 include 请求，`data[].voteup_count/favorite_count/visit_count/thanks_count` 全部 ✗（conclusion=never_returned）；详情端点 include 返回 voteup_count/comment_count/visit_count/thanks_count/reaction，**唯 favorite_count include 也不返回**；question.visit_count 仅 proj 列表内嵌 question 有。

**判定："请求了但不返回"就是列表端点的唯一真相**——01 标【双】只说明"include 了且代码读了"，不说明接口会给。两点细化：①"疑似只在 question.visit_count"确认为真，但仅限 answers 列表（详情/activities/collections 的内嵌 question 都没有）；②"浏览量恒 0"须限定列表路径——answer 详情 include 实测返回 visit_count，sync.ts:104 逐条详情路径可拿真值，恒 0 仅限已删详情请求的 main.ts 路径。

## C3 articles 三统计字段 —— both_partly（前半句对，后半句错）

- 旧（FIELD_AUDIT.md:28、:98）："默认不返回，include 也未被验证生效 → 文章赞数/收藏/浏览恒 0 → AI 候选门槛永远不成立，文章自动抢救实际失效"。
- 新（12-live-articles.json + Temp/zhihu-probe-12 raw）：项目 include **实测生效**——B 组 24 键 = 默认 21 + content/voteup_count/comment_count，**voteup_count=4**（同条 reaction.statistics.like_count=0，证明 like_count 对文章是伪值）；favorite_count/visit_count/thanks_count/column/topics 被 include 静默忽略；zhuanlan 详情顶层也无 favorite/visit/thanks（实际键 favlists_count=1 / tipjarors_count=0 / statistics.up_vote_count=4）。

**判定：**
- **对的半句**："默认不返回"三字段全部成立；favorite_count/visit_count 对 include 免疫也成立（且文章 visit/thanks 任何端点都拿不到，比旧审计更糟）。
- **错的半句**："include 也未被验证生效"对 voteup_count/comment_count 不成立——include 生效且返回真值，member_articles 的 include 本来就含 voteup_count，**"赞数恒 0、AI 候选失效、文章自动抢救形同虚设"的后果判定被推翻**。连带 ：98 修复建议 1 的前提失效；若要兜底，正确键是详情 statistics.up_vote_count，照旧建议用 like_count 反而写入 0。

## C4 collections 兜底逻辑 —— agree（仍成立），但旧修复建议过时

- 旧（FIELD_AUDIT.md:29、:100）：无 favorite_count、有 thanks_count → 收藏数实为感谢数；建议改用 reaction.statistics.favorites。
- 新（13-live-collections.json）：content(answer 27 键) 中 voteup_count/comment_count/thanks_count 默认下发（1012/75/46），**favorite_count ❌（include 显式请求也不给）、visit_count ❌、reaction ❌**——该接口根本没有 reaction 对象；且端点整体忽略 include（无 include / 项目 32 项 / 探测 include 三组**字节级一致**）。

**判定：争议事实逐字复现，兜底逻辑今天仍成立**（collector sync.ts:363 仍会把感谢数当收藏数写入）。**但修复建议 ：100 被推翻**：reaction.statistics.favorites 在此端点不存在，照改恒 0；main.ts:785 的兜底链实测两头全空。条目级收藏数在此端点任何字段都拿不到；收藏夹级统计（item_count=921/view_count=16/updated_time）只能走 `/collections/{id}` 详情（实测 200）。新增：外层 item 仅 `{content, created}` 2 键，内嵌 question 无 visit_count。

## C5 followees 必须带 include —— agree（旧审计对）

- 旧（FIELD_AUDIT.md:30）：answer_count/articles_count/follower_count 必须带 include；include 被删则专栏文章全部不抓。
- 新（14-live-members.json）：带 include 的 followees 三计数全返回真值（answer_count=210、follower_count_num='4316'）；**member 详情默认 26 键、followers 列表 20 键均零个计数字段**。

**判定：双向对照坐实"必须带 include"。** 新增：description 在 followees include 中被忽略（include 盲区）；follower_count_text/_num/_unit 未请求即赠送（旧审计把它归白拿清单是对的）。

## C6 白拿清单 10 项 —— agree（全部存在，端点范围需精确化）

| # | 字段 | 实测 | 端点限定 |
|---|---|---|---|
| 1 | reaction.statistics.favorites | ✓ basic 默认有、articles 默认有（=1）、详情有 | **collections/items 无 reaction** |
| 2 | question.visit_count | ✓ proj 列表内嵌 question 有（basic 无） | 仅 answers 列表；详情/activities/collections 内嵌 question 均无 |
| 3 | author.badge_v2 | ✓ answers 列表默认（author 内）、member、activities actor | 评论 author.member 只有 badge |
| 4 | can_comment | ✓ answers 列表需 include；root_comments 包装层 comment_status.can_comment 默认有 | — |
| 5 | review_info | ✓ answers 列表 include 生效（is_reviewing/tips/type） | — |
| 6 | extras | ✓ answers 列表与详情默认 | — |
| 7 | thumbnail | ✓ answers 列表默认（空串）、collections answer content 也有 | — |
| 8 | 文章 excerpt_title/image_url | ✓ articles 列表默认键、collections article content 也有 | answers 列表 include excerpt_title ✗（不适用答案） |
| 9 | 评论 can_recommend/censor_status | ✓ can_recommend 根/子都有；censor_status（number）仅根评论 | — |
| 10 | 关注 follower_count_num/text | ✓ followees 未请求即赠送（'4316' string）、member+include 也有 | — |

**判定：清单无一项落空**，修正仅在各字段的端点适用范围（①②④⑧有限定）。

## C7 单条 JSON 体积 —— agree（四组全部可复现）

| 端点 | 旧值 | 新实测 | 复现度 |
|---|---|---|---|
| collections/items | 4,649（content 4,599，98.9%） | 首条 **4,650**（content 4,600，98.9%）；20 条样本 3,523–23,031 | 同条样本差 1 字节，精确复现 |
| activities (v3) | 8,348（target 88.3%） | 7 条 4,760–11,416；首条 target 占比 89.0% | 旧值落在新区间，占比吻合 |
| comments | 1,587（author 774，48.8%） | 根评论 5 条 1,305–1,880；author 占比 32–36% | 旧值落在新区间；author 占比随样本浮动，非常数 |
| answers（带 include） | 2,242（author 566，25.2%） | proj 首条 **2,242**、author **566** | 逐字节相同 |

**判定：体积结论整体成立**，content/target/author 确为各端点体积大户。

---

## 汇总

**旧审计仍成立**（10 条）：answers 列表三统计字段不返回（include 也拿不到）；statistics.favorites 是 answers/articles 唯一真实收藏数；answers 列表 like_count 兜底赞同数正确；question.visit_count 仅在 answers 列表内嵌 question；"40 键"并集口径复现；collections 无 favorite_count 有 thanks_count、兜底行为仍在；followees 计数必须 include；白拿清单 10 项全存在；四组体积数字可复现；从 include 删 visit_count 的建议仍正确。

**旧审计已过时**（8 条）：26/6 生效拆分（实际 21/11 或 25/7）；"include 未验证生效"对文章 voteup/comment 不成立；"文章赞数恒 0→AI 候选失效"后果判定被推翻；:98 修复建议 1 前提失效且其兜底键 like_count 对文章是伪值（应为详情 up_vote_count）；:100 修复建议 3 在 collections 端点被推翻（无 reaction，恒 0）；statistics.favorites 须限定 answers/articles 上下文；"浏览量恒 0"须限定列表路径（详情可拿）；"6 个白请求/3 个统计恒 0"的总结数字过时。

**新发现（旧审计没有）**（12 条）：详情 include 唯 favorite_count 不返回；collections/items 整体忽略 include（三组字节级一致）；collections 外层仅 {content, created} 且 question 无 visit_count；reaction.statistics 三个伪键（upvote_count/favorite_count/visit_count）全端点不存在→兜底死代码；评论无 reply_to_comment_id、无 img 三键、赞叫 vote_count、include 被忽略；文章评论端点 404、articles/questions 直连 403 需签名；activities limit 无效、target.answer 34 键比详情全、游标是时间戳；member 默认零计数字段、include 盲区 relationship/is_bind_phone/description；me 与 member 两套字段面（favorite_count≠favorited_count 口径陷阱）；文章 favorite_count 只有 statistics.favorites/favlists_count、visit/thanks 全端点拿不到；max 探测 17 项默认赠送字段可白拿；20 号把 favlists/collections 误标"零实测端点"（未纳入 13 号输入）。
