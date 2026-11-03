# 12-live-articles：文章实体真机字段探测（2026-11-01）

请求器：`apps/collector/.fieldprobe/fetch.mjs`（playwright + cookie 直连），5 个请求逐批发送、间隔 >=3000ms。
被测账号：`yang-xu-heng-94`；被测文章：`data[0].id = 2086869210299475286`。

## 请求与状态码

| # | id | 端点 | 状态 |
|---|----|------|------|
| 1 | A_no_include | `/api/v4/members/{u}/articles?limit=2&offset=0` | 200 |
| 2 | B_project_include | 同 A + 项目 include（`data[*].content,voteup_count,comment_count,created,updated,title,excerpt`） | 200 |
| 3 | C_full_include | 同 A + 全量探测 include（23 项，含 favorite_count/visit_count/thanks_count/column/topics/reaction.statistics 等） | 200 |
| 4 | D_detail_zhuanlan | `https://zhuanlan.zhihu.com/api/articles/{id}` | 200 |
| 5 | E_detail_v4 | `https://www.zhihu.com/api/v4/articles/{id}` | 403，error.code=10003（"请求参数异常，请升级客户端后重试"） |

403 停止规则：E 本就是最后一个计划请求，其后未再发出任何请求；全程未出现 40353/40362。
任务预期 E"可能 404"，实测为 403/10003，按原样记录。

## 文章列表 item 键数（三组）

- A（无 include）：**21 键**（与旧探测 articles-probe.json 的 21 键集合完全一致）
- B（项目 include）：**24 键** = 21 + content、voteup_count、comment_count
- C（全量 include）：**25 键** = 24 + is_labeled（B 未请求该键）
- 三组并集：25 键；include_required 共 4 个：`content`、`voteup_count`、`comment_count`、`is_labeled`

include 被服务端静默忽略（不报错、键不出现）：`favorite_count`、`visit_count`、`thanks_count`、`column`、`topics`。
`author.name/headline/avatar_url`、`excerpt_title`、`image_url`、`created`、`updated`、`comment_permission`、`copyright_permission`、`paid_info`、`title`、`url` 本就是默认键或随 include 正常返回；`reaction.statistics` 被请求时也只回 like_count/favorites 两键。

## 5 个统计字段结论（核心）

| 字段 | 列表默认 | 项目 include | 全量 include | zhuanlan 详情 | 结论 |
|------|---------|--------------|--------------|---------------|------|
| voteup_count | 否 | 是（4/3） | 是 | 是（4） | **必须 include**；列表 reaction.statistics.like_count 不是赞同（实测 like_count=0 而 voteup_count=4），详情可用 statistics.up_vote_count |
| comment_count | 否 | 是（0/0） | 是 | 是（0） | **必须 include** |
| favorite_count | 否 | 否 | 否 | 否（顶层） | **列表与详情顶层都不返回**；真实收藏数在 `reaction.statistics.favorites`（列表默认就有：1/12；详情 favlists_count=1、statistics.favorites=1，三处一致） |
| visit_count | 否 | 否 | 否 | 否 | **拿不到**——列表 reaction.statistics 也无 visit_count 键（与 answers 不同） |
| thanks_count | 否 | 否 | 否 | 否 | **拿不到**——详情也只有 tipjarors_count（打赏） |

## reaction.statistics 键

- 列表（A/B/C 一致）：`like_count`、`favorites`；relation：`faved`、`liked`
- zhuanlan 详情（18 键）：`up_vote_count, down_vote_count, like_count, comment_count, share_count, play_count, interest_play_count, favorites, pv_count, bullet_count, applaud_count, question_follower_count, question_answer_count, plaincontent_vote_up_count, plaincontent_like_count, img_like_count(按图片哈希), subscribe_count, republishers`；relation 10 键（is_author, vote, liked, img_liked, faved, following, subcribed, is_navigator_vote, current_user_is_navigator, vote_next_step）；reaction 另含 `image_reactions`

## 与旧探测（data/plan-verify-b/articles-probe.json）一致性：changed

- 一致部分：无 include 的 21 键集合、reaction=[statistics,relation]、statistics=[like_count,favorites]、excerpt 157 字符、is_end=false/totals=22、id/title 字符串、created/updated 数字——全部复现。
- 不一致部分："带 include 多一个 content" 不再成立：项目 include 下新增 **3** 键（content/voteup_count/comment_count），全量 include 下新增 **4** 键（再加 is_labeled）。旧结论仅在 include 只含 content 时可能成立。

## 列表 vs 详情差异

- 键数：列表并集 25（无 include 21）；详情 69；两侧共有 24 键。
- 列表有详情无：`paid_info`（恒 `{}`）。详情独有 45 键（title_image/state/ip_info/topics/column/favlists_count/is_normal/contributions/share_text/settings 等，完整清单见 JSON）。
- 统计字段见上表：voteup_count/comment_count 详情默认返回；favorite_count 详情由 favlists_count/statistics.favorites 承载；visit_count/thanks_count 两侧皆无。
- topics/column：列表 include 也不给；详情默认给（column 完整对象 articles_count=18/followers=2；topics 含 id/name/url）。
- author：详情多 uid/description/is_followed/is_following/exposed_medal。
- excerpt/content：同一文章 excerpt 列表 157 vs 详情 616 字符；content 列表（include 后）14891 vs 详情 8271，开头一致但互不包含——两处正文非同一形态。
- 时间：两侧均为 created/updated 数字时间戳，均无 created_time/updated_time。

## 其他记录

- paging 键：is_end/totals/previous/is_start/next；totals=22。
- 与 answers 列表差异：answers 的 voteup_count/favorite_count/visit_count/thanks_count include 也不返回；articles 的 voteup_count/comment_count include 即返回，favorite_count 走 statistics.favorites，visit_count/thanks_count 完全拿不到。
- raw 响应：临时目录 `C:/Users/lixueshu/AppData/Local/Temp/zhihu-probe-12/out-a..e.json`；`G:/gemini zhihu` 项目未改动 `.fieldprobe` 之外任何文件。
- 结构化数据见同目录 `12-live-articles.json`。
