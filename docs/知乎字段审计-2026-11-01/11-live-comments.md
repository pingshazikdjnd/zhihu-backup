# 11 - 评论实体（comments）真机字段清单

- 日期：2026-11-01
- 请求器：`G:/gemini zhihu/apps/collector/.fieldprobe/fetch.mjs`（Playwright 请求上下文 + Cookie）
- 硬限制执行情况：共 **7 次请求**（恰好在预算上限），间隔均 >=3000ms；**未出现 403/40353/40362**。
- 输出数据：`11-live-comments.json`

## 1. 请求清单与状态码

| id | 端点 | 状态 | 说明 |
|----|------|------|------|
| A | `/api/v4/answers/2095990096667341029/root_comments?limit=5&offset=0` | 200 | 指定回答，totals=0，data 为空 |
| C1 | `/api/v4/members/yang-xu-heng-94/articles?limit=1&offset=0` | 200 | 取文章 id=2086869210299475286 |
| D | A + `&include=data[*].content,author.name,...,be_replied`（URL 编码） | 200 | 与 A 逐字节等价的包装结构，totals=0 |
| C2 | `/api/v4/articles/2086869210299475286/root_comments?limit=5&offset=0` | **404** | 纯 HTML "404: Not Found"，page fallback 同样 404 |
| A2 | `/api/v4/members/yang-xu-heng-94/answers?limit=5&offset=0` | 200 | 实际返回 9 条（无视 limit=5）；默认项无 comment_count |
| R | `/api/v4/answers/2082485163410331245/root_comments?limit=5&offset=0` | 200 | 选取互动最高的回答（like_count=403）；totals=6，返回 5 条 |
| B | `/api/v4/comments/11576157620/child_comments?limit=5&offset=0` | 200 | 父评论 child_comment_count=54；totals=54，返回 5 条 |

指定回答 A 的 `comment_status`：`{can_comment:true, can_reply:true, toast:"评论千万条，友善第一条"}`，但 totals=0 —— 该回答只是没有根评论，不是关闭评论。

## 2. 评论对象字段清单（data[]，共 66 个字段路径）

### 2.1 评论本体（标量/简单字段，R=答案根评论，B=子评论）

| 字段路径 | 类型 | 出现于 | 备注 |
|---|---|---|---|
| `data[].id` | number | R,B | 评论 id 为 JSON number |
| `data[].type` | string | R,B | 固定 `comment` |
| `data[].resource_type` | string | R,B | `answer`（被评资源类型） |
| `data[].url` | string | R,B | `https://www.zhihu.com/api/v4/comments/{id}` |
| `data[].content` | string | R,B | 评论正文（HTML 片段） |
| `data[].created_time` | number | R,B | Unix 秒 |
| `data[].vote_count` | number | R,B | 赞同数（样本 176~383） |
| `data[].liked` | boolean | R,B | 当前用户是否已赞 |
| `data[].disliked` | boolean | R | 仅根评论 |
| `data[].voting` | boolean | R,B | 投票状态标记 |
| `data[].is_author` | boolean | R,B | 是否作者本人评论 |
| `data[].is_delete` | boolean | R,B | 软删除标记 |
| `data[].featured` | boolean | R | 精选（样本 R 的 5/5 根评论均为 true） |
| `data[].top` | boolean | R,B | 置顶（样本全 false） |
| `data[].collapsed` | boolean | R | 仅根评论（被折叠） |
| `data[].reviewing` | boolean | R | 仅根评论（审核中） |
| `data[].censor_status` | number | R | 仅根评论（样本全 0） |
| `data[].allow_like` | boolean | R,B | |
| `data[].allow_vote` | boolean | R | 仅根评论 |
| `data[].allow_delete` | boolean | R,B | |
| `data[].allow_reply` | boolean | R,B | |
| `data[].can_recommend` | boolean | R,B | 存在 |
| `data[].can_collapse` | boolean | R,B | |
| `data[].address_text` | string | R,B | IP 属地文本 |
| `data[].attached_info` | string | R,B | 不透明 base64 风格串（如 `ggIGCAsQABgA`），非图片信息 |
| `data[].child_comment_count` | number | R | 仅根评论 |
| `data[].child_comments` | array | R | 仅根评论，**恒为空数组占位**（子评论不内联） |

### 2.2 author 子对象

结构为 `author = { role, member }`，真实用户卡片在 `author.member`：

| 字段路径 | 类型 | 出现于 |
|---|---|---|
| `data[].author.role` | string | R,B（样本 `normal`） |
| `data[].author.member.id` | string | R,B |
| `data[].author.member.url_token` | string | R |
| `data[].author.member.name` | string | R,B |
| `data[].author.member.headline` | string | R,B |
| `data[].author.member.avatar_url` | string | R,B |
| `data[].author.member.avatar_url_template` | string | R |
| `data[].author.member.gender` | number | R,B |
| `data[].author.member.type` | string | R,B |
| `data[].author.member.user_type` | string | R,B |
| `data[].author.member.url` | string | R,B |
| `data[].author.member.badge` | array | R,B |
| `data[].author.member.vip_info` | object | R,B（内含 `is_vip` boolean） |
| `data[].author.member.is_org` | boolean | R |
| `data[].author.member.is_advertiser` | boolean | R |
| `data[].author.member.is_followed` | boolean | B |
| `data[].author.member.is_following` | boolean | B |

注：`is_org/is_advertiser/url_token/avatar_url_template` 仅在 R 的 5 个样本出现、`is_followed/is_following` 仅在 B 出现 —— 更可能是**逐作者/观看者关系差异**而非根评论/子评论模式差异（5 样本限制，已如实标注 seen_in）。

### 2.3 reply_to_author 子对象

| 字段路径 | 类型 | 出现于 | 备注 |
|---|---|---|---|
| `data[].reply_to_author` | object/null | R,B | 根评论样本 R 中 4/5 为 null、1/5 非 null（会话式根评论回复）；子评论恒 object |
| `data[].reply_to_author.role` | string | B | |
| `data[].reply_to_author.member.*` | object | B | 与 `author.member` 同构（avatar_url,badge,gender,headline,id,is_followed,is_following,name,type,url,user_type,vip_info） |

### 2.4 仅子评论出现的字段

| 字段路径 | 类型 | 备注 |
|---|---|---|
| `data[].replies_count` | number | 该子评论的楼中楼回复数 |
| `data[].extra_info` | object | 样本为 `{}` |

## 3. 顶层包装与 paging

根评论（A/D/R）包装键：`featured_counts, common_counts, collapsed_counts, reviewing_counts, comment_status{can_comment,can_reply,toast}, paging, data`。
子评论（B）包装键：仅 `paging, data`（无四个 counts、无 comment_status）。

paging 键：`is_end(boolean), is_start(boolean), next(string), previous(string), totals(number)`。
**child_comments 的 paging 没有 `is_start`**（仅 R/B 差异之一）。`totals` 在两接口都存在。

## 4. 特别确认（任务第 4 项）

1. **img 字段结论：`img_url` / `image_url` / `imageUrl` 全都不存在。** 对 R、B 原始 JSON 全文 grep 均为 false；评论载荷中没有任何图片字段；`attached_info` 是不透明字符串，不是图片信息。
2. **like 字段：`vote_count`（number）**。不存在 `likes`，也不存在 `like_count`。投票状态用 `liked`/`disliked`/`voting` 三个 boolean 表达。
3. **`is_top`/`is_featured` 键不存在**，实际键为 **`top`** 和 **`featured`**（boolean）。**`censor_status` 存在**（number，仅根评论层），**`can_recommend` 存在**（boolean，根/子都有）。
4. **include 不生效（include_effect=ignored）**：A 与 D 是同一 URL 带/不带 include，返回的包装结构完全一致（同键序、同 totals=0）；由于该回答 0 条评论，data 级对比无法在该回答上进行。关键旁证：R **不带 include** 就返回了完整模式（content、vote_count、censor_status、can_recommend、author.member 卡片等），说明评论接口返回固定默认模式，include 参数被忽略，既不增也不减字段。

## 5. 根评论 vs 子评论 字段差异（任务第 5 项）

仅根评论有：`child_comment_count`、`child_comments`（空数组占位）、`allow_vote`、`censor_status`、`reviewing`、`featured`、`collapsed`、`disliked`。
仅子评论有：`replies_count`、`extra_info`。
结构差异：`reply_to_author` 根评论并非恒 null（样本 R 中 4/5 为 null、1/5 非 null，用于会话式根评论回复），子评论恒 object（含被回复人 member 卡片）；包装层子评论少 4 个 counts 与 comment_status；paging 少 `is_start`。
共有核心：`id,type,url,content,created_time,vote_count,liked,voting,is_author,is_delete,top,allow_like,allow_delete,allow_reply,can_recommend,can_collapse,address_text,attached_info,author{role,member}`。

## 6. 其他观察

- 文章评论端点 `GET /api/v4/articles/{id}/root_comments` 对存在的文章（comment_permission=all）返回 **404**（HTML），page 上下文 fallback 也 404；受 7 次预算限制未尝试变体路径。文章评论的真实端点待后续单独验证。
- 答案列表 `/members/{token}/answers`：limit=5 却返回 9 条；默认项无 `comment_count`（include 未测试），`reaction/extras/biz_ext` 中也不含评论数。
- 根评论的 `child_comments` 占位数组从不内联子评论，拿子评论必须调 `/api/v4/comments/{id}/child_comments`。
- 子评论返回顺序与 id/created_time 均不单调，排序规则未在预算内确定。
- 评论 `id` 是 number（`11576157620` 量级，JS 安全整数范围内），与回答 id（超过 2^53，需字符串处理）不同。

## 7. 汇总统计

- 请求数：7 / 7（6x200，1x404），无 403/40353/40362。
- 观测到的字段路径总数：81（含包装层）；其中 `data[]` 评论实体层 66。
- include：ignored。
- img 字段：三者皆不存在。
- like 字段：`vote_count`。
