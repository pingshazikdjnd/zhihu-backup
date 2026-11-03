# 13-live-collections：收藏夹实体真机测试（2026-11-01）

请求器：`node .fieldprobe/fetch.mjs`（Playwright 无头 + ZHIHU_COOKIE_STRING），共 **6 个请求，全部 200**，无 403/40353/40362。
被测对象：用户 `yang-xu-heng-94` 的收藏夹，主收藏夹 id=**822239827**（『我的收藏』，is_public=false，本人可读）。

## 0. 请求清单

| # | id | 端点 | status | ms | 结果文件 |
|---|----|------|--------|----|----------|
| 1 | 13A_favlists | /api/v4/members/yang-xu-heng-94/favlists?limit=5&offset=0 | 200 | 430 | out-13-a.json |
| 2 | 13B_items_plain | /api/v4/collections/822239827/items?limit=2&offset=0（无 include） | 200 | 287 | out-13-b.json |
| 3 | 13C_items_project_include | 同 B + 项目 32 项 include（01-endpoints-include.json#collections_items） | 200 | 243 | out-13-c.json |
| 4 | 13D_items_probe_include | 同 B + 探测 include（voteup/favorite/visit/thanks/reaction.statistics/is_labeled/…） | 200 | 134 | out-13-c.json |
| 5 | 13E_collection_detail | /api/v4/collections/822239827 | **200**（非 404） | 181 | out-13-c.json |
| 6 | 13F_items_wide20 | /api/v4/collections/822239827/items?limit=20&offset=0 | 200 | 472 | out-13-d.json |

说明：13A-13E 为 2026-11-01 19:05-19:06 同一请求器发出的完整结果（out-13-a/b/c.json，favlist id 自洽，本轮复用）；13F 为本轮补发的第 6 个请求（预算上限 6）。所有请求间隔 >=3200ms。G:/gemini zhihu 仅读取与运行 `.fieldprobe/fetch.mjs`，未修改项目任何文件。

## 1. favlists 列表项字段全集 + paging

favlist 列表项**确认仍为 5 个键**（与历史证据一致）：

```
id, title, type, is_public, url
```

- **updated_time 不在**、**item_count 不在**。条目数/更新时间只能从 E（收藏夹详情）拿。
- `type` 恒为 `"collection"`；`url` 指向 `http://www.zhihu.com/api/v4/collections/{id}`。
- 样本：822239827 我的收藏(is_public=false) / 985856299 / 977651564 / 635409377 / 863172851（其余 4 个 is_public=true）；favlists totals=13。
- favlists 的 paging 5 键：`is_end, is_start, totals(13), next, previous`。

## 2. collections/items：content 子对象字段树（answer/article 混排）

外层 item **只有 2 个键**：`["content", "created"]`。
- 没有 item 级 id/type/url/title——实体 id 与类型全在 content 里（`content.id` / `content.type`）。
- `created` 是 **ISO8601 字符串**（收藏时间，如 `2026-10-22T19:36:40+08:00`），不是 epoch。
- items 的 paging 5 键：`is_end, is_start, next, previous, totals(921)`。

### content.type = "answer"（27 键，19/20 条）

```
type("answer"), answer_type("NORMAL"), id, url,
created_time(number), updated_time(number),
author(object), question(object),
content(HTML), excerpt,
voteup_count(number), comment_count(number), thanks_count(number),
is_collapsed, is_copyable, is_visible, is_normal, is_deleted, is_mine,
comment_permission("all"), reshipment_settings("disallowed"),
thumbnail(""), thumbnail_info({count,type,thumbnails[]}),
attached_info(base64), attachment({type:"ANSWER",attachment_id:""}),
suggest_edit({reason,status,tip,title,unnormal_details,url}), relationship(object)
```

**重点核对的计数字段：**

| 字段 | 在吗 | 说明 |
|------|------|------|
| voteup_count | ✅ 有 | 默认下发（无需 include），样本 1012 |
| comment_count | ✅ 有 | 默认下发，样本 75 |
| thanks_count | ✅ 有 | 默认下发，样本 46 |
| favorite_count | ❌ 无 | include 显式请求也不下发 |
| visit_count | ❌ 无 | include 显式请求也不下发 |
| reaction | ❌ 无 | **reaction.statistics 在该接口不存在**，无任何样本 |

- `relationship`（5 键，19 条 answer 全部一致）：`is_author, is_authorized, is_nothelp, is_thanked, voting`。
- `question`（8 键）：`type, title, question_type, created, updated_time, url, is_deleted, id` —— **注意没有 visit_count**。FIELD_AUDIT 里『浏览量疑似只在 question.visit_count』的结论在 collections/items 不成立：此接口任何位置都拿不到浏览量。
- `author`（16 键）：`id, url_token, name, use_default_avatar, avatar_url, avatar_url_template, is_org, type, url, user_type, headline, gender, is_advertiser, vip_info, badge_v2, actived_at`。

### content.type = "article"（14 键，1/20 条）

```
type("article"), title, excerpt_title, id, url(zhuanlan.zhihu.com/p/{id}),
image_url, created(number), updated(number),
author(object), comment_permission("all"), content(HTML),
voteup_count(number), column(object), comment_count(number)
```

- article 是**贫化对象**：无 question、relationship、is_collapsed、is_deleted、excerpt（只有 excerpt_title）、thumbnail_info 等。
- 时间字段用 `created/updated`（epoch 数字），不是 answer 的 `created_time/updated_time`。
- 计数只有 `voteup_count`(994)、`comment_count`(31)；favorite_count/visit_count/thanks_count/reaction 同样全部缺席。
- `author` 17 键 = answer 的 16 键 **+ badge**。
- `column`（9 键）：`id, type:"column", url_token, title, url, created, updated, description, image_url`。

## 3. 外层 item 与 content 的关系

- item = `{ content, created }`；`content.type` 实测取值：**answer / article**（20 条样本 19:1）。
- E 详情：`answer_count=921`、`item_count=921`、**无 article_count 字段**，两者同口径等于 items paging 的 totals——`answer_count` 命名并不排除 article 混排（本收藏夹 20 条里就有 1 条 article）。

## 4. include 是否生效：**不生效**

B（无 include）/ C（项目 32 项 include）/ D（探测 include）三者对同 2 条 answer 逐键比对：

- content 顶层键集：**完全相同**（27 键，与 B 的实测逐键 diff 为空）；
- question / author / relationship 键集：完全相同；
- include 请求的字段一个都没新增：`favorite_count`、`visit_count`、`reaction.statistics`、`is_labeled`、`label_info`、`mark_infos`、`review_info`、`relationship.is_authorized`（默认已有）……全部照旧缺席；
- 默认字段也没有减少。

结论：**collections/items 端点忽略 include 参数**，抓取时无需携带（带着不报错但无用）。

## 5. E：collections/{id} 收藏夹详情（200，非 404）

外层 `{ collection: {...}, status: 100, message: "" }`。collection 18 键：

```
id, type("collection"), title, is_public(false), url(https://api.zhihu.com/collections/{id}),
description, follower_count(0), answer_count(921), item_count(921), like_count(0),
view_count(16), comment_count(0), is_following, is_liking, created_time, updated_time,
creator(object), is_default
```

- `url` 是 **api.zhihu.com** 域（favlist 列表项里的 url 是 www.zhihu.com 域）。
- `creator` 11 键：`id, type:"people", is_following, avatar_url, headline, user_type, gender, url, name, is_followed, badge`。
- 收藏夹的条目数（item_count）、查看数（view_count）、更新时间（updated_time）都在这里，favlists 列表项拿不到。

## 6. 对抓取器的直接结论

1. `collections/items` 不需要也不依赖 include；带项目现有 include 是无效请求面。
2. 收藏夹内 answer 的『收藏数、浏览量』在该接口**拿不到**（favorite_count/visit_count/reaction 全缺席），`sync.ts:363` 的 `favorite_count ?? reaction.statistics.favorites` 兜底链在此接口恒为 0；`thanks_count` 是唯一真实存在的额外计数（但语义是感谢不是收藏）。
3. 需要收藏夹级别统计（item_count/view_count/updated_time）时调 E 详情接口（200 可用）。
4. answer/article 字段面差异大，解析须按 `content.type` 分支；article 无 excerpt 用 `excerpt_title`，时间读 `created/updated`。

## 附：产物

- 结构化结果：`13-live-collections.json`
- 原始响应：`out-13-a.json`、`out-13-b.json`、`out-13-c.json`、`out-13-d.json`（jobs：`jobs-13-a/b/c/d.json`）
