# 知乎接口与 include 字段审计 · 第一轮（静态代码盘点）

> 方法：全仓库 grep `zhihu.com/api`（apps/**/*.ts，排除 node_modules）+ 逐行人工核对。**未发任何网络请求**；所有字段路径与 file:line 均来自代码原文。与 JSON 版 `01-endpoints-include.json` 内容一致。
>
> 涉及源文件（全仓仅此 3 个调用知乎 API）：
> - `apps/collector/src/jobs/sync.ts`（collector 本地同步）
> - `apps/apify-crawler/src/main.ts`（Apify 云端爬虫）
> - `apps/api/src/routes/contents.ts`（API 服务的 sync-live 手动同步）
>
> 图例：【请】= include 里请求了但代码不读；【读】= 代码读了但 include 没请求；【双】= 请求了且读了。评论类接口无 include，全部读的字段标【读】（相对 include 而言）。

## 接口总览（13 个）

| # | id | 接口 | 类型 | include |
|---|---|---|---|---|
| 1 | answers_list_mine | /api/v4/members/{u}/answers | 列表 | 32 项 |
| 2 | answer_detail | /api/v4/answers/{id} | 详情 | 4 项 |
| 3 | answers_root_comments | /api/v4/answers/{id}/root_comments | 列表 | 无 |
| 4 | comments_child_comments | /api/v4/comments/{id}/child_comments | 列表 | 无 |
| 5 | articles_root_comments | /api/v4/articles/{id}/root_comments | 列表 | 无 |
| 6 | members_favlists | /api/v4/members/{u}/favlists | 列表 | 无 |
| 7 | collections_items | /api/v4/collections/{id}/items | 列表 | 32 项 |
| 8 | v3_moments_activities | /api/v3/moments/{u}/activities | 列表 | 无 |
| 9 | members_followees | /api/v4/members/{u}/followees | 列表 | 5 项 |
| 10 | member_answers | /api/v4/members/{token}/answers | 列表 | 13 项 |
| 11 | member_articles | /api/v4/members/{token}/articles | 列表 | 7 项 |
| 12 | answers_favlists | /api/v4/answers/{id}/favlists | 列表（用作总数查询） | 无 |
| 13 | article_detail_zhuanlan | zhuanlan.zhihu.com/api/articles/{id} | 详情 | 无 |

---

## 1. answers_list_mine —— 我的回答列表（list）

- **URL 模板**：`https://www.zhihu.com/api/v4/members/{username}/answers?include={include}&limit=20&offset={offset}`
- **调用位置**：collector sync.ts:83；main.ts:270、393（include 串在 sync.ts:80 与 main.ts:264 逐字节一致）
- **其他 query 参数**：`limit=20`；`offset=0/20/40…`（main.ts 优先跟随 `paging.next`，缺失时 offset+=20；sync.ts 只按 offset 自增）

**include 原文（URL 解码后）**：
```
data[*].is_normal,admin_closed_comment,reward_info,is_collapsed,annotation_action,annotation_detail,collapse_reason,collapsed_by,suggest_edit,comment_count,can_comment,content,voteup_count,reshipment_settings,comment_permission,mark_infos,created_time,updated_time,review_info,question,excerpt,is_labeled,label_info,relationship.is_authorized,voting,is_author,is_thanked,is_nothelp,is_recognized,visit_count,favorite_count;data[*].author.badge[?(type=best_answerer)].topics
```

**include 字段（32 项）**：is_normal, admin_closed_comment, reward_info, is_collapsed, annotation_action, annotation_detail, collapse_reason, collapsed_by, suggest_edit, comment_count, can_comment, content, voteup_count, reshipment_settings, comment_permission, mark_infos, created_time, updated_time, review_info, question, excerpt, is_labeled, label_info, relationship.is_authorized, voting, is_author, is_thanked, is_nothelp, is_recognized, visit_count, favorite_count（以上带 `data[*].` 前缀）＋ `data[*].author.badge[?(type=best_answerer)].topics`

**代码读取字段**：

| 字段路径 | 证据 | 关系 |
|---|---|---|
| json.data / json.paging.is_end / json.paging.next | sync.ts:91,160 \| main.ts:288,379,380 | 【读】 |
| item.type / item.id | sync.ts:96,117 \| main.ts:306 | 【读】 |
| item.voteup_count | sync.ts:98 \| main.ts:318 | 【双】 |
| item.reaction.statistics.like_count / .upvote_count | sync.ts:98 \| main.ts:318 | 【读】 |
| item.favorite_count | sync.ts:99 \| main.ts:319 | 【双】 |
| item.thanks_count | sync.ts:99 \| main.ts:319 | 【读】 |
| item.reaction.statistics.favorites / .favorite_count | sync.ts:99 \| main.ts:319 | 【读】 |
| item.visit_count | sync.ts:100 \| main.ts:320 | 【双】 |
| item.reaction.statistics.visit_count | sync.ts:100 \| main.ts:320 | 【读】 |
| item.question.title / .id | sync.ts:118-119,121 \| main.ts:325-326,328 | 【双】（question 整体在 include） |
| item.author.name / .url_token / .avatar_url / .headline | sync.ts:120 \| main.ts:327 | 【读】（include 只要 badge[].topics） |
| item.content | sync.ts:122 \| main.ts:329 | 【双】 |
| item.excerpt | sync.ts:124 \| main.ts:331 | 【双】 |
| item.comment_count | sync.ts:126 \| main.ts:333 | 【双】 |
| item.is_collapsed / .is_labeled / .label_info | sync.ts:129-131 \| main.ts:336-338 | 【双】 |
| item.created_time / .updated_time | sync.ts:132-133 \| main.ts:339-340 | 【双】 |

**小结**：【请】20 项（is_normal、admin_closed_comment、reward_info、annotation_action、annotation_detail、collapse_reason、collapsed_by、suggest_edit、can_comment、reshipment_settings、comment_permission、mark_infos、review_info、relationship.is_authorized、voting、is_author、is_thanked、is_nothelp、is_recognized、badge[].topics）；【双】12 项；【读】14 项。

---

## 2. answer_detail —— 单条回答统计（detail）

- **URL 模板**：`https://www.zhihu.com/api/v4/answers/{answerId}?include=voteup_count,comment_count,visit_count,favorite_count`
- **调用位置**：collector sync.ts:104（逐条补统计）；api contents.ts:39（sync-live）
- **其他 query 参数**：无（include 写死在 URL，无 `data[*].` 前缀）

**include 原文**：`voteup_count,comment_count,visit_count,favorite_count`

**include 字段（4）**：voteup_count, comment_count, visit_count, favorite_count

**代码读取字段**：

| 字段路径 | 证据 | 关系 |
|---|---|---|
| detail.voteup_count / .favorite_count / .visit_count | sync.ts:107-109 | 【双】 |
| data.error.message / .code | contents.ts:58-59 | 【读】 |
| data.voteup_count / .comment_count / .visit_count / .favorite_count | contents.ts:65-68 | 【双】 |
| data.thanks_count | contents.ts:68 | 【读】 |
| data.reaction.statistics.favorites / .favorite_count | contents.ts:68 | 【读】 |

**小结**：【请】0；【双】4；【读】5。

---

## 3. answers_root_comments —— 回答根评论列表（list）

- **URL 模板**：`https://www.zhihu.com/api/v4/answers/{answerId}/root_comments?limit=20&offset={offset}`
- **调用位置**：sync.ts:174；main.ts:411；contents.ts:135
- **其他 query 参数**：`limit=20`；`offset`（main.ts:421 hot 模式 offset>=20 即停）；**无 include**

**代码读取字段**（三处代码一致）：

| 字段路径 | 证据 | 关系 |
|---|---|---|
| json.data / json.paging.is_end | sync.ts:180-181 \| main.ts:417-418 \| contents.ts:140-141 | 【读】 |
| c.id | main.ts:429 \| sync.ts:187 \| contents.ts:147 | 【读】 |
| c.reply_to_comment_id | main.ts:430 \| sync.ts:188 \| contents.ts:148 | 【读】 |
| c.author.member.name / .avatar_url | main.ts:431-432 \| sync.ts:189-190 \| contents.ts:149-150 | 【读】 |
| c.reply_to_author.member.name | main.ts:433 \| sync.ts:191 \| contents.ts:151 | 【读】 |
| c.content | main.ts:427 \| sync.ts:192 \| contents.ts:152 | 【读】 |
| c.img / c.imageUrl / c.image_url | main.ts:224（pickCommentImageUrl，经 main.ts:427 normalizeCommentImage 传入） | 【读】 |
| c.created_time / c.address_text | main.ts:437-438 \| sync.ts:194-195 \| contents.ts:154-155 | 【读】 |
| c.vote_count / c.reaction.statistics.like_count | main.ts:439 \| sync.ts:196 \| contents.ts:156 | 【读】 |
| c.is_author / c.author.role | main.ts:440 \| sync.ts:197 \| contents.ts:157 | 【读】 |
| c.top / c.featured | main.ts:441-442 \| sync.ts:198-199 \| contents.ts:158-159 | 【读】 |
| c.child_comment_count / c.child_comments[] | main.ts:445 \| sync.ts:202 \| contents.ts:162-163 | 【读】 |

**小结**：无 include，全部【读】。

---

## 4. comments_child_comments —— 评论的子评论列表（list）

- **URL 模板**：`https://www.zhihu.com/api/v4/comments/{commentId}/child_comments?limit=20&offset={offset}`
- **调用位置**：sync.ts:206；main.ts:451；contents.ts:164（该处只传 `limit=20`，随后跟随 `json.paging.next` 翻页，见 contents.ts:195）
- **其他 query 参数**：`limit=20`；`offset`（sync/main 版）或 `paging.next`（api 版）；**无 include**

**代码读取字段**（与根评论同构，对象名 child）：

| 字段路径 | 证据 |
|---|---|
| json.data / json.paging.is_end / json.paging.next | sync.ts:209,231 \| main.ts:454,478 \| contents.ts:170-171,195 |
| child.id | main.ts:462 \| sync.ts:216 \| contents.ts:179 |
| child.author.member.name / .avatar_url | main.ts:464-465 \| sync.ts:218-219 \| contents.ts:181-182 |
| child.reply_to_author.member.name | main.ts:466 \| sync.ts:220 \| contents.ts:183 |
| child.content | main.ts:460 \| sync.ts:221 \| contents.ts:184 |
| child.img / .imageUrl / .image_url | main.ts:224（经 main.ts:460 传入） |
| child.created_time / .address_text | main.ts:470-471 \| sync.ts:223-224 \| contents.ts:186-187 |
| child.vote_count / child.reaction.statistics.like_count | main.ts:472 \| sync.ts:225 \| contents.ts:188 |
| child.is_author / child.author.role | main.ts:473 \| sync.ts:226 \| contents.ts:189 |
| child.top / child.featured | main.ts:474-475 \| sync.ts:227-228 \| contents.ts:190-191 |

**小结**：无 include，全部【读】。

---

## 5. articles_root_comments —— 专栏文章根评论列表（list）

- **URL 模板**：`https://www.zhihu.com/api/v4/articles/{articleId}/root_comments?limit=20&offset={offset}`
- **调用位置**：main.ts:582（`endpointType='articles'` 分支，main.ts:572）
- **其他 query 参数**：`limit=20`；`offset`（full 模式最多 200 页 / hot 模式 1 页，main.ts:577）；**无 include**

**代码读取字段**（main.ts syncHotCommentsForContent）：

| 字段路径 | 证据 |
|---|---|
| json.data / json.paging.is_end | main.ts:588,634 |
| c.id / c.reply_to_comment_id | main.ts:595-596 |
| c.author.member.name / .avatar_url | main.ts:597-598 |
| c.content | main.ts:593 |
| c.img / .imageUrl / .image_url | main.ts:224（经 main.ts:593 传入） |
| c.created_time / c.address_text | main.ts:603-604 |
| c.vote_count / c.reaction.statistics.like_count | main.ts:605 |
| c.is_author / c.author.role / c.top / c.featured | main.ts:606-608 |
| c.child_comments[]（内联子评论） | main.ts:611 |
| child.id / .author.member.name / .avatar_url / .reply_to_author.member.name | main.ts:615-619 |
| child.content / .created_time / .address_text | main.ts:613,620,623-624 |
| child.vote_count / child.reaction.statistics.like_count | main.ts:625 |
| child.is_author / .top / .featured | main.ts:626-628 |

**小结**：无 include，全部【读】。

---

## 6. members_favlists —— 我的收藏夹列表（list）

- **URL 模板**：`https://www.zhihu.com/api/v4/members/{username}/favlists?limit=20&offset={offset}`
- **调用位置**：sync.ts:293；main.ts:676
- **其他 query 参数**：`limit=20`；`offset`；**无 include**

**代码读取字段**：

| 字段路径 | 证据 | 关系 |
|---|---|---|
| json.data / json.paging.is_end | sync.ts:299,309 \| main.ts:686,702 | 【读】 |
| item.id / item.title | sync.ts:302 \| main.ts:695 | 【读】 |
| item.updated_time | sync.ts:303 \| main.ts:696 | 【读】 |

**小结**：无 include，全部【读】。只取 id/title/updated_time 三个元数据字段。

---

## 7. collections_items —— 收藏夹条目列表（list）

- **URL 模板**：`https://www.zhihu.com/api/v4/collections/{collectionId}/items?include={include}&limit=20&offset={offset}`
- **调用位置**：sync.ts:328；main.ts:722（include 串在 sync.ts:316 与 main.ts:709 逐字节一致）
- **其他 query 参数**：`limit=20`；`offset`

**include 原文（URL 解码后）**：
```
data[*].content.is_normal,admin_closed_comment,reward_info,is_collapsed,annotation_action,annotation_detail,collapse_reason,collapsed_by,suggest_edit,comment_count,can_comment,content,voteup_count,reshipment_settings,comment_permission,mark_infos,created_time,updated_time,review_info,question,excerpt,is_labeled,label_info,relationship.is_authorized,voting,is_author,is_thanked,is_nothelp,is_recognized,visit_count,favorite_count;data[*].content.author.badge[?(type=best_answerer)].topics
```

**include 字段（32 项）**：与接口 1 相同的 31 个标量，但全部挂在 `data[*].content.` 下；badge 选择器为 `data[*].content.author.badge[?(type=best_answerer)].topics`

**代码读取字段**（响应包一层：`row.content` → item）：

| 字段路径 | 证据 | 关系 |
|---|---|---|
| row.content | sync.ts:339 \| main.ts:746 | 【读】 |
| item.type | sync.ts:340 \| main.ts:747 | 【读】 |
| item.id | sync.ts:353 \| main.ts:775 | 【读】 |
| item.question.id / .title | sync.ts:345,347,357 \| main.ts:753,762,779 | 【双】 |
| item.url | sync.ts:346 \| main.ts:756 | 【读】 |
| item.title | sync.ts:347 \| main.ts:762 | 【读】 |
| item.content | sync.ts:350,358 \| main.ts:767,770 | 【双】 |
| item.content[].content | main.ts:771（pin 的 content 是块数组 [{type,content}]，逐块取 b.content） | 【读】 |
| item.author.name / .url_token / .avatar_url / .headline | sync.ts:356 \| main.ts:778 | 【读】 |
| item.excerpt | sync.ts:360 \| main.ts:782 | 【双】 |
| item.voteup_count | sync.ts:361 \| main.ts:783 | 【双】 |
| item.reaction.statistics.like_count / .upvote_count | sync.ts:361 \| main.ts:783 | 【读】 |
| item.comment_count | sync.ts:362 \| main.ts:784 | 【双】 |
| item.favorite_count | sync.ts:363 \| main.ts:785 | 【双】 |
| item.thanks_count | sync.ts:363（**仅 collector**；main.ts:785 已不读） | 【读】 |
| item.reaction.statistics.favorites | sync.ts:363 \| main.ts:785 | 【读】 |
| item.reaction.statistics.favorite_count | sync.ts:363 | 【读】 |
| item.visit_count | sync.ts:364 \| main.ts:786 | 【双】 |
| item.reaction.statistics.visit_count | sync.ts:364 \| main.ts:786 | 【读】 |
| item.is_collapsed / .is_labeled / .label_info | sync.ts:365-367 \| main.ts:787-789 | 【双】 |
| item.created_time / .updated_time | sync.ts:368-369 \| main.ts:790-791 | 【双】 |
| json.paging.is_end | sync.ts:334 \| main.ts:737 | 【读】 |

**小结**：【请】20 项（同接口 1 的清单，均挂 content. 下）；【双】12 项；【读】15 项。注意 collector 与 main.ts 对"收藏数"兜底已分叉：sync.ts:363 仍回退 `thanks_count`（FIELD_AUDIT.md 指出因此收藏数实为感谢数），main.ts:785 已改为 `favorite_count ?? reaction.statistics.favorites ?? 0`。

---

## 8. v3_moments_activities —— 我的赞同/动态列表（list，v3）

- **URL 模板**：`https://www.zhihu.com/api/v3/moments/{username}/activities?limit=20`
- **调用位置**：sync.ts:428；main.ts:909
- **其他 query 参数**：仅 `limit=20`；翻页完全跟随 `json.paging.next` 返回的完整 URL（游标内含 before_id/page_num/offset；代码不自行构造，只读取 page_num/offset 做断点比较，main.ts:899-904）；**无 include**

**代码读取字段**：

| 字段路径 | 证据 | 关系 |
|---|---|---|
| json.data / json.paging.is_end / json.paging.next | sync.ts:440,518-519 \| main.ts:933,1056-1057 | 【读】 |
| paging.next URL 的 page_num / offset 参数 | main.ts:899,903（断点比较） | 【读】 |
| item.action_text（过滤"赞同"） | sync.ts:443 \| main.ts:944 | 【读】 |
| item.created_time（赞同发生时间） | sync.ts:491 \| main.ts:999 | 【读】 |
| item.target | sync.ts:445 \| main.ts:946 | 【读】 |
| target.id / .type | sync.ts:446,453 \| main.ts:947,954 | 【读】 |
| target.question.title / .id | sync.ts:455-456 \| main.ts:956-957 | 【读】 |
| target.title | sync.ts:459 \| main.ts:960 | 【读】 |
| target.author.name / .url_token / .avatar_url / .headline | sync.ts:472 \| main.ts:973 | 【读】 |
| target.content / .excerpt | sync.ts:474,476 \| main.ts:975,977 | 【读】 |
| target.voteup_count / target.reaction.statistics.like_count | sync.ts:465 \| main.ts:966 | 【读】 |
| target.comment_count | sync.ts:478 \| main.ts:979 | 【读】 |
| target.favorite_count / target.thanks_count | sync.ts:479 \| main.ts:980 | 【读】 |
| target.reaction.statistics.favorites / .favorite_count / .visit_count | sync.ts:479-480 \| main.ts:980-981 | 【读】 |
| target.visit_count | sync.ts:480 \| main.ts:981 | 【读】 |
| target.is_collapsed / .is_labeled / .label_info | sync.ts:481-483 \| main.ts:982-984 | 【读】 |
| target.created_time / .updated_time | sync.ts:484-485 \| main.ts:985-986 | 【读】 |

**小结**：无 include，全部【读】。整个 target 子树（answer/article）被当内容源用。

---

## 9. members_followees —— 我的关注列表（list）

- **URL 模板**：`https://www.zhihu.com/api/v4/members/{username}/followees?include=data%5B*%5D.answer_count,articles_count,follower_count,headline,avatar_url&limit=20&offset={offset}`
- **调用位置**：main.ts:1191（源码中 include 即为此 URL 编码形态）
- **其他 query 参数**：`limit=20`；`offset`

**include 原文（解码）**：`data[*].answer_count,articles_count,follower_count,headline,avatar_url`

**include 字段（5）**：answer_count, articles_count, follower_count, headline, avatar_url（带 `data[*].` 前缀）

**代码读取字段**：

| 字段路径 | 证据 | 关系 |
|---|---|---|
| json.data / json.paging.is_end | main.ts:1201,1223 | 【读】 |
| u.url_token / u.name | main.ts:1210 | 【读】（默认字段，不在 include） |
| u.id | main.ts:1213 | 【读】（默认字段） |
| u.avatar_url / u.headline | main.ts:1215-1216 | 【双】 |
| u.answer_count / u.articles_count / u.follower_count | main.ts:1217-1219 | 【双】 |

**小结**：【请】0；【双】5；【读】4。FIELD_AUDIT.md 强调：三个计数字段必须带 include 才返回，当前 include 正确，若被删则专栏文章全部不抓。

---

## 10. member_answers —— 关注答主的回答列表（list）

- **URL 模板**：`https://www.zhihu.com/api/v4/members/{urlToken}/answers?include={include}&limit={limit}&offset={offset}&sort_by={sortBy}`
- **调用位置**：main.ts:1412（include 串定义在 main.ts:1254-1256）
- **其他 query 参数**：`limit=min(20, maxScan-offset)`；`offset`（按上一页实际返回条数推进，main.ts:1545）；`sort_by=created|voteups`（两种扫描计划，main.ts:1383-1400）

**include 原文（解码）**：`data[*].is_normal,comment_count,content,voteup_count,created_time,updated_time,question,excerpt,is_collapsed,is_labeled,label_info,visit_count,favorite_count`

**include 字段（13）**：is_normal, comment_count, content, voteup_count, created_time, updated_time, question, excerpt, is_collapsed, is_labeled, label_info, visit_count, favorite_count

**代码读取字段**：

| 字段路径 | 证据 | 关系 |
|---|---|---|
| json.data / json.paging.is_end | main.ts:1421,1424,1543 | 【读】 |
| item.id | main.ts:1434 | 【读】 |
| item.content | main.ts:1451 | 【双】 |
| item.question.title | main.ts:1457（评估器 1289、候选 1494 也读） | 【双】 |
| item.question.id | main.ts:1458,1465 | 【双】 |
| item.author.name / .url_token / .avatar_url / .headline | main.ts:1460-1463（兜底 u.*） | 【读】 |
| item.excerpt | main.ts:1468（1289、1496） | 【双】 |
| item.voteup_count | main.ts:1470（1284、1488） | 【双】 |
| item.reaction.statistics.like_count | main.ts:1470（1284、1488） | 【读】 |
| item.comment_count | main.ts:1471（1285、1498） | 【双】 |
| item.favorite_count | main.ts:1472（1286、1499） | 【双】 |
| item.reaction.statistics.favorites | main.ts:1472（1286、1499） | 【读】 |
| item.visit_count | main.ts:1473（**无 reaction 兜底**，直接 \|\| 0） | 【双】 |
| item.is_collapsed / .is_labeled / .label_info | main.ts:1474-1476（1287-1288、1500-1501） | 【双】 |
| item.created_time / .updated_time | main.ts:1477-1478 | 【双】 |

**小结**：【请】1 项（is_normal）；【双】12 项；【读】9 项。代码注释自证（main.ts:1469）：「following 列表不下发顶层 voteup_count/favorite_count，需回退到 reaction.statistics」。

---

## 11. member_articles —— 关注答主的专栏文章列表（list）

- **URL 模板**：`https://www.zhihu.com/api/v4/members/{urlToken}/articles?include={include}&limit={limit}&offset={offset}`
- **调用位置**：main.ts:1590（articleIncludeStr 定义在 main.ts:1257-1259）
- **其他 query 参数**：`limit=min(20, maxArticles-offset)`；`offset`（main.ts:1692）；**无 sort_by**（与 member_answers 不同）

**include 原文（解码）**：`data[*].content,voteup_count,comment_count,created,updated,title,excerpt`

**include 字段（7）**：content, voteup_count, comment_count, created, updated, title, excerpt

**代码读取字段**：

| 字段路径 | 证据 | 关系 |
|---|---|---|
| json.data / json.paging.is_end | main.ts:1599,1601,1690 | 【读】 |
| item.id | main.ts:1610 | 【读】 |
| item.content | main.ts:1618 | 【双】 |
| item.title | main.ts:1623（评估器 1289、候选 1655） | 【双】 |
| item.author.name / .url_token / .avatar_url / .headline | main.ts:1626-1629（兜底 u.*） | 【读】 |
| item.excerpt | main.ts:1633,1657 | 【双】 |
| item.voteup_count | main.ts:1635,1649 | 【双】 |
| item.reaction.statistics.like_count | main.ts:1635,1649 | 【读】 |
| item.comment_count | main.ts:1636,1659 | 【双】 |
| item.favorite_count | main.ts:1637,1660 | 【双】 |
| item.reaction.statistics.favorites | main.ts:1637,1660 | 【读】 |
| item.visit_count | main.ts:1638（**不在 include 中，且无兜底**） | 【读】 |
| item.created（兜底 .created_time） | main.ts:1639 | 【双】/【读】 |
| item.updated（兜底 .updated_time） | main.ts:1640 | 【双】/【读】 |
| item.is_collapsed / .is_labeled / .label_info | main.ts:1661-1662（评估器 1287-1288） | 【读】（不在 include） |
| item.question.title | main.ts:1289（共用评估器；文章响应无 question，恒 undefined，unverified-不返回） | 【读】 |

**小结**：【请】0；【双】7；【读】15 项。要点：include 只要 7 个字段，但代码读了 visit_count、is_collapsed、is_labeled、label_info、author.* 等 15 个 include 之外的字段——文章统计恒 0 风险与 FIELD_AUDIT.md「文章赞数/收藏/浏览恒 0」结论互相印证。

---

## 12. answers_favlists —— 回答被收藏总数（list，用作总数查询）

- **URL 模板**：`https://www.zhihu.com/api/v4/answers/{answerId}/favlists?limit=1&offset=0`
- **调用位置**：contents.ts:72
- **其他 query 参数**：`limit=1`；`offset=0`；**无 include**

**代码读取字段**：

| 字段路径 | 证据 | 关系 |
|---|---|---|
| json.paging / json.paging.totals | contents.ts:75-76（typeof === 'number' 才采用） | 【读】 |

**小结**：实际当作"查总数"接口用：回答详情 favorite_count===0 时，用 `paging.totals` 充当真实收藏数（contents.ts:70-82）。

---

## 13. article_detail_zhuanlan —— 专栏文章详情（detail，zhuanlan 域）

- **URL 模板**：`https://zhuanlan.zhihu.com/api/articles/{articleId}`
- **调用位置**：contents.ts:41
- **其他 query 参数**：无；**无 include**

**代码读取字段**：

| 字段路径 | 证据 | 关系 |
|---|---|---|
| data.error.message / .code | contents.ts:58-59 | 【读】 |
| data.voteup_count / .comment_count / .visit_count | contents.ts:65-67 | 【读】 |
| data.favorite_count / .thanks_count | contents.ts:68 | 【读】 |
| data.reaction.statistics.favorites / .favorite_count | contents.ts:68 | 【读】 |

**小结**：无 include，全部【读】。用于 /:pk/sync-live 回写文章统计与删除检测。

---

## 交叉发现（跨接口）

1. **include 完全相同的两对**：接口 1 的 include 在 sync.ts:80 与 main.ts:264 一致；接口 7 的 include 在 sync.ts:316 与 main.ts:709 一致。
2. **评论接口零 include**（接口 3/4/5）：所有评论字段依赖知乎默认返回面。
3. **collector 与 apify-crawler 已分叉**：收藏夹"收藏数"兜底（sync.ts:363 仍读 thanks_count；main.ts:785 已删）；我的回答逐条详情补统计（sync.ts:104 有，main.ts 已删并注释 main.ts:316-317）。
4. **visit_count 读取形态不一致**：answers/collections/moments 路径有 `reaction.statistics.visit_count` 兜底；member_answers（main.ts:1473）与 member_articles（main.ts:1638）直接 `item.visit_count || 0` 无兜底；后者甚至不在 include 里。
5. **member_articles include 覆盖缺口**：include 只要 7 个字段，代码却读 15 个 include 外字段（visit_count、is_collapsed、is_labeled、label_info、author.\* 等）。
6. **v3 moments 翻页**：只发 `limit=20`，之后每页直接 GET `paging.next` 的完整 URL（游标含 before_id/page_num/offset；代码读 page_num/offset 做断点比较，main.ts:899-904）。
7. **FIELD_AUDIT.md（2026-10-28 真机实测）背景**：接口 1 include 中 annotation_detail、label_info、is_recognized、favorite_count、voteup_count、visit_count、badge[].topics 知乎不返回；真实收藏数在 `reaction.statistics.favorites`；浏览量疑似只在 `question.visit_count`；articles 列表顶层 voteup/favorite/visit 默认不返回（文章赞数恒 0）；followees 计数字段必须带 include。本轮 JSON/MD 只记录代码事实，知乎返回与否以 FIELD_AUDIT 实测为准，下一轮实测比对时合并。
8. **计数口径**：include 项按逗号拆分——接口 1/7 各 32 项（31 标量+1 badge 选择器）、接口 2 为 4、接口 9 为 5、接口 10 为 13、接口 11 为 7。FIELD_AUDIT.md 所述「40 个键」为另一种口径。
9. **unverified 标注**：member_answers 的 `item.title`、member_articles 的 `item.question.title` 来自共用评估器 evaluateForAutoBackup（main.ts:1289），在对应响应中恒为 undefined（由代码结构可证），非"知乎会返回"的证据。
