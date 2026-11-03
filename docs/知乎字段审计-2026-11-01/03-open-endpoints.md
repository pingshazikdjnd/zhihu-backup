# 知乎免登录开放接口实测报告（03-open-endpoints）

- 实测时间：2026-11-01
- 方法：先 curl（Chrome UA、无 Cookie）打全部端点；凡非 200 再用 Playwright 真实打开 https://www.zhihu.com/ 后 page.evaluate(fetch) 复核（credentials=include，自动带站点 Cookie 但无 x-zse-96 签名头）。全部为 GET，未登录。
- 结论：共测 9 个端点（7 个指定 + 2 个加测），**免登录可通 3 个，被拦 6 个**。

## 汇总表

| # | URL | via | HTTP | error.code | 判定 |
|---|-----|-----|------|-----------|------|
| 1 | `https://api.zhihu.com/topstory/hot-list?limit=50` | curl | 200 | - | **通（200）** |
| 2 | `https://api.zhihu.com/topstory/hot-lists/total?limit=50` | curl | 200 | - | **通（200）** |
| 3 | `https://www.zhihu.com/api/v4/search_v3?t=general&q=test&correction=1&offset=0&limit=20` | page-fetch | 403 | 40353 | 封 |
| 4 | `https://www.zhihu.com/api/v4/questions/19554697` | curl | 403 | 10003 | 封 |
| 5 | `https://www.zhihu.com/api/v4/answers/1000221950` | curl | 403 | 40353 | 封 |
| 6 | `https://www.zhihu.com/api/v4/members/yang-xu-heng-94/answers?limit=1&offset=0` | page-fetch | 403 | 40353 | 封 |
| 7 | `https://www.zhihu.com/api/v4/feed/topstory/recommend?limit=5` | curl | 404 | - | 封 |
| 8 | `https://www.zhihu.com/api/v3/feed/topstory/recommend?limit=5` | curl | 401 | 101 | 封（加测） |
| 9 | `https://api.zhihu.com/topstory/recommend?limit=5` | curl | 200 | - | **通（200）** |

## 免登录可通的接口

1. `https://api.zhihu.com/topstory/hot-list?limit=50`（curl 直连 200，limit=50 实际返回 30 条）
2. `https://api.zhihu.com/topstory/hot-lists/total?limit=50`（curl 直连 200，返回 30 条，结构与 #1 完全一致）
3. `https://api.zhihu.com/topstory/recommend?limit=5`（加测，curl 直连 200；limit=10 也只返回 6 条）

> 三个可用接口全部在 `api.zhihu.com` 域；`www.zhihu.com/api/v4` 下实测无一可用。

### https://api.zhihu.com/topstory/hot-list?limit=50

- status: 200（via curl） sample_size: 30
- 顶层 keys: `data`, `paging`, `fresh_text`, `display_num`, `display_first`, `fb_bill_main_rise`, `head_zone`, `head_zones`, `prefer_hot_topics_top_card`
- 备注: 热搜榜主榜，limit=50 实际返回 30 条；target 全部为 question 类型
- 返回体前 300 字符:

```
{"data":[{"type":"hot_list_feed","style_type":"10","id":"0_1793528940.577692","card_id":"Q_2098799350503699522","card_label":{"type":"boiling","icon":"https://pic1.zhimg.com/80/v2-a8ec286ae756c2ab8377774b27f8ebc7_1440w.png","night_icon":"https://pic1.zhimg.com/80/v2-022e7c409e51515f784aa70403aef8d4_
```

#### 字段树（数组取全部元素 key 并集，`[]` 表示数组位，嵌套至 7 层）

```json
{
 "data[].type": "string",
 "data[].style_type": "string",
 "data[].id": "string",
 "data[].card_id": "string",
 "data[].card_label.type": "string",
 "data[].card_label.icon": "string",
 "data[].card_label.night_icon": "string",
 "data[].target.id": "number",
 "data[].target.title": "string",
 "data[].target.url": "string",
 "data[].target.type": "string",
 "data[].target.created": "number",
 "data[].target.answer_count": "number",
 "data[].target.follower_count": "number",
 "data[].target.author.type": "string",
 "data[].target.author.user_type": "string",
 "data[].target.author.id": "string",
 "data[].target.author.url_token": "string",
 "data[].target.author.url": "string",
 "data[].target.author.name": "string",
 "data[].target.author.headline": "string",
 "data[].target.author.avatar_url": "string",
 "data[].target.bound_topic_ids": "array<number>",
 "data[].target.comment_count": "number",
 "data[].target.is_following": "boolean",
 "data[].target.excerpt": "string",
 "data[].attached_info": "string",
 "data[].detail_text": "string",
 "data[].trend": "number",
 "data[].debut": "boolean",
 "data[].children[].type": "string",
 "data[].children[].thumbnail": "string",
 "paging.is_end": "boolean",
 "paging.is_start": "boolean",
 "paging.next": "string",
 "paging.previous": "string",
 "paging.totals": "number",
 "fresh_text": "string",
 "display_num": "number",
 "display_first": "boolean",
 "fb_bill_main_rise": "number",
 "head_zone.type": "string",
 "head_zone.data[].id": "string",
 "head_zone.data[].link_url": "string",
 "head_zone.data[].title": "string",
 "head_zone.data[].source_type": "number",
 "head_zone.data[].attached_info": "string",
 "head_zone.data[].tag": "string",
 "head_zone.data[].tag_bg_color": "string",
 "head_zones[].type": "string",
 "head_zones[].data[].id": "string",
 "head_zones[].data[].link_url": "string",
 "head_zones[].data[].title": "string",
 "head_zones[].data[].source_type": "number",
 "head_zones[].data[].attached_info": "string",
 "head_zones[].data[].tag": "string",
 "head_zones[].data[].tag_bg_color": "string",
 "prefer_hot_topics_top_card": "boolean"
}
```

#### data[].target（type = question，顶层字段 12 个，字段路径 19 条）

```json
{
 "data[].target.id": "number",
 "data[].target.title": "string",
 "data[].target.url": "string",
 "data[].target.type": "string",
 "data[].target.created": "number",
 "data[].target.answer_count": "number",
 "data[].target.follower_count": "number",
 "data[].target.author.type": "string",
 "data[].target.author.user_type": "string",
 "data[].target.author.id": "string",
 "data[].target.author.url_token": "string",
 "data[].target.author.url": "string",
 "data[].target.author.name": "string",
 "data[].target.author.headline": "string",
 "data[].target.author.avatar_url": "string",
 "data[].target.bound_topic_ids": "array<number>",
 "data[].target.comment_count": "number",
 "data[].target.is_following": "boolean",
 "data[].target.excerpt": "string"
}
```

### https://api.zhihu.com/topstory/hot-lists/total?limit=50

- status: 200（via curl） sample_size: 30
- 顶层 keys: `data`, `paging`, `fresh_text`, `display_num`, `display_first`, `fb_bill_main_rise`, `head_zone`, `head_zones`, `prefer_hot_topics_top_card`
- 备注: 全站热榜聚合，limit=50 实际返回 30 条；结构与 #1 完全一致，target 全部为 question 类型
- 返回体前 300 字符:

```
{"data":[{"type":"hot_list_feed","style_type":"1","id":"0_1793528941.67582","card_id":"Q_2098799350503699522","card_label":{"type":"boiling","icon":"https://pic1.zhimg.com/80/v2-a8ec286ae756c2ab8377774b27f8ebc7_1440w.png","night_icon":"https://pic1.zhimg.com/80/v2-022e7c409e51515f784aa70403aef8d4_14
```

#### 字段树（数组取全部元素 key 并集，`[]` 表示数组位，嵌套至 7 层）

```json
{
 "data[].type": "string",
 "data[].style_type": "string",
 "data[].id": "string",
 "data[].card_id": "string",
 "data[].card_label.type": "string",
 "data[].card_label.icon": "string",
 "data[].card_label.night_icon": "string",
 "data[].target.id": "number",
 "data[].target.title": "string",
 "data[].target.url": "string",
 "data[].target.type": "string",
 "data[].target.created": "number",
 "data[].target.answer_count": "number",
 "data[].target.follower_count": "number",
 "data[].target.author.type": "string",
 "data[].target.author.user_type": "string",
 "data[].target.author.id": "string",
 "data[].target.author.url_token": "string",
 "data[].target.author.url": "string",
 "data[].target.author.name": "string",
 "data[].target.author.headline": "string",
 "data[].target.author.avatar_url": "string",
 "data[].target.bound_topic_ids": "array<number>",
 "data[].target.comment_count": "number",
 "data[].target.is_following": "boolean",
 "data[].target.excerpt": "string",
 "data[].attached_info": "string",
 "data[].detail_text": "string",
 "data[].trend": "number",
 "data[].debut": "boolean",
 "data[].children[].type": "string",
 "data[].children[].thumbnail": "string",
 "paging.is_end": "boolean",
 "paging.is_start": "boolean",
 "paging.next": "string",
 "paging.previous": "string",
 "paging.totals": "number",
 "fresh_text": "string",
 "display_num": "number",
 "display_first": "boolean",
 "fb_bill_main_rise": "number",
 "head_zone.type": "string",
 "head_zone.data[].id": "string",
 "head_zone.data[].link_url": "string",
 "head_zone.data[].title": "string",
 "head_zone.data[].source_type": "number",
 "head_zone.data[].attached_info": "string",
 "head_zone.data[].tag": "string",
 "head_zone.data[].tag_bg_color": "string",
 "head_zones[].type": "string",
 "head_zones[].data[].id": "string",
 "head_zones[].data[].link_url": "string",
 "head_zones[].data[].title": "string",
 "head_zones[].data[].source_type": "number",
 "head_zones[].data[].attached_info": "string",
 "head_zones[].data[].tag": "string",
 "head_zones[].data[].tag_bg_color": "string",
 "prefer_hot_topics_top_card": "boolean"
}
```

#### data[].target（type = question，顶层字段 12 个，字段路径 19 条）

```json
{
 "data[].target.id": "number",
 "data[].target.title": "string",
 "data[].target.url": "string",
 "data[].target.type": "string",
 "data[].target.created": "number",
 "data[].target.answer_count": "number",
 "data[].target.follower_count": "number",
 "data[].target.author.type": "string",
 "data[].target.author.user_type": "string",
 "data[].target.author.id": "string",
 "data[].target.author.url_token": "string",
 "data[].target.author.url": "string",
 "data[].target.author.name": "string",
 "data[].target.author.headline": "string",
 "data[].target.author.avatar_url": "string",
 "data[].target.bound_topic_ids": "array<number>",
 "data[].target.comment_count": "number",
 "data[].target.is_following": "boolean",
 "data[].target.excerpt": "string"
}
```

### https://api.zhihu.com/topstory/recommend?limit=5

- status: 200（via curl） sample_size: 6
- 顶层 keys: `dataV1`, `data`, `styles`, `feed_request_id`, `fresh_text`, `paging`, `extra`
- 备注: 加测：匿名推荐流。limit=5 与 limit=10 均返回 6 条，target 全部为 answer 类型（target 树合并了 limit=10 样本）
- 返回体前 300 字符:

```
{"dataV1":[{"action_card":false,"attached_info":"CrUFCL7w4IyyldienQEQBBoJODAyODQ4ODU2ILq8hdcGKLEIMERAAEooChNUU19TT1VSQ0VfRkVFRFJFX1Y1EgEwGAAgADoKeyJyYXciOiIifUorChZUU19TT1VSQ0VfRkVFRFJFX01TX1YzEgEwGAAgADoKeyJyYXciOiIifVoJMTAzMTE4NjY5YiBiYTAxZGIzYjlkNDNlNTI3ZDc2ZTdkNjljNDkzMGFkNXITMjA5ODcyMzI2MzY4NTg
```

#### 字段树（数组取全部元素 key 并集，`[]` 表示数组位，嵌套至 7 层）

```json
{
 "dataV1[].action_card": "boolean",
 "dataV1[].attached_info": "string",
 "dataV1[].brief": "string",
 "dataV1[].created_time": "number",
 "dataV1[].id": "string",
 "dataV1[].offset": "number",
 "dataV1[].target.allow_segment_interaction": "boolean",
 "dataV1[].target.answer_type": "string",
 "dataV1[].target.author.avatar_url": "string",
 "dataV1[].target.author.followers_count": "number",
 "dataV1[].target.author.gender": "number",
 "dataV1[].target.author.headline": "string",
 "dataV1[].target.author.id": "string",
 "dataV1[].target.author.is_followed": "boolean",
 "dataV1[].target.author.is_following": "boolean",
 "dataV1[].target.author.is_org": "boolean",
 "dataV1[].target.author.name": "string",
 "dataV1[].target.author.url": "string",
 "dataV1[].target.author.url_token": "string",
 "dataV1[].target.author.user_type": "string",
 "dataV1[].target.comment_count": "number",
 "dataV1[].target.content": "string",
 "dataV1[].target.created_time": "number",
 "dataV1[].target.excerpt": "string",
 "dataV1[].target.excerpt_new": "string",
 "dataV1[].target.favorite_count": "number",
 "dataV1[].target.id": "string",
 "dataV1[].target.is_copyable": "boolean",
 "dataV1[].target.is_labeled": "boolean",
 "dataV1[].target.is_navigator": "boolean",
 "dataV1[].target.navigator_vote": "boolean",
 "dataV1[].target.preview_text": "string",
 "dataV1[].target.preview_type": "string",
 "dataV1[].target.question.answer_count": "number",
 "dataV1[].target.question.author.avatar_url": "string",
 "dataV1[].target.question.author.badge[].description": "string",
 "dataV1[].target.question.author.badge[].type": "string",
 "dataV1[].target.question.author.followers_count": "number",
 "dataV1[].target.question.author.gender": "number",
 "dataV1[].target.question.author.headline": "string",
 "dataV1[].target.question.author.id": "string",
 "dataV1[].target.question.author.is_followed": "boolean",
 "dataV1[].target.question.author.is_following": "boolean",
 "dataV1[].target.question.author.is_org": "boolean",
 "dataV1[].target.question.author.name": "string",
 "dataV1[].target.question.author.url": "string",
 "dataV1[].target.question.author.url_token": "string",
 "dataV1[].target.question.author.user_type": "string",
 "dataV1[].target.question.bound_topic_ids": "array<number>",
 "dataV1[].target.question.comment_count": "number",
 "dataV1[].target.question.created": "number",
 "dataV1[].target.question.detail": "string",
 "dataV1[].target.question.excerpt": "string",
 "dataV1[].target.question.follower_count": "number",
 "dataV1[].target.question.id": "string",
 "dataV1[].target.question.is_following": "boolean",
 "dataV1[].target.question.question_type": "string",
 "dataV1[].target.question.relationship.is_author": "boolean",
 "dataV1[].target.question.title": "string",
 "dataV1[].target.question.type": "string",
 "dataV1[].target.question.url": "string",
 "dataV1[].target.reaction.relation.faved": "boolean",
 "dataV1[].target.reaction.relation.liked": "boolean",
 "dataV1[].target.reaction.statistics.favorites": "number",
 "dataV1[].target.reaction.statistics.like_count": "number",
 "dataV1[].target.relationship.is_nothelp": "boolean",
 "dataV1[].target.relationship.is_thanked": "boolean",
 "dataV1[].target.relationship.voting": "number",
 "dataV1[].target.reshipment_settings": "string",
 "dataV1[].target.segment_infos[].marks[].end_index": "number",
 "dataV1[].target.segment_infos[].marks[].seg_info.comment_count": "number",
 "dataV1[].target.segment_infos[].marks[].seg_info.is_like": "boolean",
 "dataV1[].target.segment_infos[].marks[].seg_info.is_span": "boolean",
 "dataV1[].target.segment_infos[].marks[].seg_info.like_count": "number",
 "dataV1[].target.segment_infos[].marks[].seg_info.my_comment_count": "number",
 "dataV1[].target.segment_infos[].marks[].seg_info.seg_ids": "array<string>",
 "dataV1[].target.segment_infos[].marks[].start_index": "number",
 "dataV1[].target.segment_infos[].pid": "string",
 "dataV1[].target.segment_infos[].text": "string",
 "dataV1[].target.thanks_count": "number",
 "dataV1[].target.type": "string",
 "dataV1[].target.updated_time": "number",
 "dataV1[].target.url": "string",
 "dataV1[].target.visited_count": "number",
 "dataV1[].target.vote_next_step": "string",
 "dataV1[].target.voteup_count": "number",
 "dataV1[].type": "string",
 "dataV1[].updated_time": "number",
 "dataV1[].verb": "string",
 "data[].action_card": "boolean",
 "data[].attached_info": "string",
 "data[].brief": "string",
 "data[].created_time": "number",
 "data[].id": "string",
 "data[].offset": "number",
 "data[].target.allow_segment_interaction": "boolean",
 "data[].target.answer_type": "string",
 "data[].target.author.avatar_url": "string",
 "data[].target.author.followers_count": "number",
 "data[].target.author.gender": "number",
 "data[].target.author.headline": "string",
 "data[].target.author.id": "string",
 "data[].target.author.is_followed": "boolean",
 "data[].target.author.is_following": "boolean",
 "data[].target.author.is_org": "boolean",
 "data[].target.author.name": "string",
 "data[].target.author.url": "string",
 "data[].target.author.url_token": "string",
 "data[].target.author.user_type": "string",
 "data[].target.comment_count": "number",
 "data[].target.content": "string",
 "data[].target.created_time": "number",
 "data[].target.excerpt": "string",
 "data[].target.excerpt_new": "string",
 "data[].target.favorite_count": "number",
 "data[].target.id": "string",
 "data[].target.is_copyable": "boolean",
 "data[].target.is_labeled": "boolean",
 "data[].target.is_navigator": "boolean",
 "data[].target.navigator_vote": "boolean",
 "data[].target.preview_text": "string",
 "data[].target.preview_type": "string",
 "data[].target.question.answer_count": "number",
 "data[].target.question.author.avatar_url": "string",
 "data[].target.question.author.badge[].description": "string",
 "data[].target.question.author.badge[].type": "string",
 "data[].target.question.author.followers_count": "number",
 "data[].target.question.author.gender": "number",
 "data[].target.question.author.headline": "string",
 "data[].target.question.author.id": "string",
 "data[].target.question.author.is_followed": "boolean",
 "data[].target.question.author.is_following": "boolean",
 "data[].target.question.author.is_org": "boolean",
 "data[].target.question.author.name": "string",
 "data[].target.question.author.url": "string",
 "data[].target.question.author.url_token": "string",
 "data[].target.question.author.user_type": "string",
 "data[].target.question.bound_topic_ids": "array<number>",
 "data[].target.question.comment_count": "number",
 "data[].target.question.created": "number",
 "data[].target.question.detail": "string",
 "data[].target.question.excerpt": "string",
 "data[].target.question.follower_count": "number",
 "data[].target.question.id": "string",
 "data[].target.question.is_following": "boolean",
 "data[].target.question.question_type": "string",
 "data[].target.question.relationship.is_author": "boolean",
 "data[].target.question.title": "string",
 "data[].target.question.type": "string",
 "data[].target.question.url": "string",
 "data[].target.reaction.relation.faved": "boolean",
 "data[].target.reaction.relation.liked": "boolean",
 "data[].target.reaction.statistics.favorites": "number",
 "data[].target.reaction.statistics.like_count": "number",
 "data[].target.relationship.is_nothelp": "boolean",
 "data[].target.relationship.is_thanked": "boolean",
 "data[].target.relationship.voting": "number",
 "data[].target.reshipment_settings": "string",
 "data[].target.segment_infos[].marks[].end_index": "number",
 "data[].target.segment_infos[].marks[].seg_info.comment_count": "number",
 "data[].target.segment_infos[].marks[].seg_info.is_like": "boolean",
 "data[].target.segment_infos[].marks[].seg_info.is_span": "boolean",
 "data[].target.segment_infos[].marks[].seg_info.like_count": "number",
 "data[].target.segment_infos[].marks[].seg_info.my_comment_count": "number",
 "data[].target.segment_infos[].marks[].seg_info.seg_ids": "array<string>",
 "data[].target.segment_infos[].marks[].start_index": "number",
 "data[].target.segment_infos[].pid": "string",
 "data[].target.segment_infos[].text": "string",
 "data[].target.thanks_count": "number",
 "data[].target.type": "string",
 "data[].target.updated_time": "number",
 "data[].target.url": "string",
 "data[].target.visited_count": "number",
 "data[].target.vote_next_step": "string",
 "data[].target.voteup_count": "number",
 "data[].type": "string",
 "data[].updated_time": "number",
 "data[].verb": "string",
 "styles": "array(empty)",
 "feed_request_id": "string",
 "fresh_text": "string",
 "paging.is_end": "boolean",
 "paging.is_start": "boolean",
 "paging.next": "string",
 "paging.previous": "string",
 "paging.totals": "number",
 "extra.is_hit_new14_limit": "boolean"
}
```

#### data[].target（type = answer，顶层字段 32 个，字段路径 103 条）

```json
{
 "dataV1[].target.allow_segment_interaction": "boolean",
 "dataV1[].target.answer_type": "string",
 "dataV1[].target.author.avatar_url": "string",
 "dataV1[].target.author.followers_count": "number",
 "dataV1[].target.author.gender": "number",
 "dataV1[].target.author.headline": "string",
 "dataV1[].target.author.id": "string",
 "dataV1[].target.author.is_followed": "boolean",
 "dataV1[].target.author.is_following": "boolean",
 "dataV1[].target.author.is_org": "boolean",
 "dataV1[].target.author.name": "string",
 "dataV1[].target.author.url": "string",
 "dataV1[].target.author.url_token": "string",
 "dataV1[].target.author.user_type": "string",
 "dataV1[].target.comment_count": "number",
 "dataV1[].target.content": "string",
 "dataV1[].target.created_time": "number",
 "dataV1[].target.excerpt": "string",
 "dataV1[].target.excerpt_new": "string",
 "dataV1[].target.favorite_count": "number",
 "dataV1[].target.id": "string",
 "dataV1[].target.is_copyable": "boolean",
 "dataV1[].target.is_labeled": "boolean",
 "dataV1[].target.is_navigator": "boolean",
 "dataV1[].target.navigator_vote": "boolean",
 "dataV1[].target.preview_text": "string",
 "dataV1[].target.preview_type": "string",
 "dataV1[].target.question.answer_count": "number",
 "dataV1[].target.question.author.avatar_url": "string",
 "dataV1[].target.question.author.badge[].description": "string",
 "dataV1[].target.question.author.badge[].type": "string",
 "dataV1[].target.question.author.followers_count": "number",
 "dataV1[].target.question.author.gender": "number",
 "dataV1[].target.question.author.headline": "string",
 "dataV1[].target.question.author.id": "string",
 "dataV1[].target.question.author.is_followed": "boolean",
 "dataV1[].target.question.author.is_following": "boolean",
 "dataV1[].target.question.author.is_org": "boolean",
 "dataV1[].target.question.author.name": "string",
 "dataV1[].target.question.author.url": "string",
 "dataV1[].target.question.author.url_token": "string",
 "dataV1[].target.question.author.user_type": "string",
 "dataV1[].target.question.bound_topic_ids": "array<number>",
 "dataV1[].target.question.comment_count": "number",
 "dataV1[].target.question.created": "number",
 "dataV1[].target.question.detail": "string",
 "dataV1[].target.question.excerpt": "string",
 "dataV1[].target.question.follower_count": "number",
 "dataV1[].target.question.id": "string",
 "dataV1[].target.question.is_following": "boolean",
 "dataV1[].target.question.question_type": "string",
 "dataV1[].target.question.relationship.is_author": "boolean",
 "dataV1[].target.question.title": "string",
 "dataV1[].target.question.type": "string",
 "dataV1[].target.question.url": "string",
 "dataV1[].target.reaction.relation.faved": "boolean",
 "dataV1[].target.reaction.relation.liked": "boolean",
 "dataV1[].target.reaction.statistics.favorites": "number",
 "dataV1[].target.reaction.statistics.like_count": "number",
 "dataV1[].target.relationship.is_nothelp": "boolean",
 "dataV1[].target.relationship.is_thanked": "boolean",
 "dataV1[].target.relationship.voting": "number",
 "dataV1[].target.reshipment_settings": "string",
 "dataV1[].target.segment_infos[].marks[].end_index": "number",
 "dataV1[].target.segment_infos[].marks[].seg_info.comment_count": "number",
 "dataV1[].target.segment_infos[].marks[].seg_info.is_like": "boolean",
 "dataV1[].target.segment_infos[].marks[].seg_info.is_span": "boolean",
 "dataV1[].target.segment_infos[].marks[].seg_info.like_count": "number",
 "dataV1[].target.segment_infos[].marks[].seg_info.my_comment_count": "number",
 "dataV1[].target.segment_infos[].marks[].seg_info.seg_ids": "array<string>",
 "dataV1[].target.segment_infos[].marks[].start_index": "number",
 "dataV1[].target.segment_infos[].pid": "string",
 "dataV1[].target.segment_infos[].text": "string",
 "dataV1[].target.thanks_count": "number",
 "dataV1[].target.type": "string",
 "dataV1[].target.updated_time": "number",
 "dataV1[].target.url": "string",
 "dataV1[].target.visited_count": "number",
 "dataV1[].target.vote_next_step": "string",
 "dataV1[].target.voteup_count": "number",
 "dataV1[].target.endorsements[].action_url": "string",
 "dataV1[].target.endorsements[].background_color.alpha": "number",
 "dataV1[].target.endorsements[].background_color.group": "string",
 "dataV1[].target.endorsements[].elements[].height": "number",
 "dataV1[].target.endorsements[].elements[].image_color.alpha": "number",
 "dataV1[].target.endorsements[].elements[].image_color.group": "string",
 "dataV1[].target.endorsements[].elements[].image_key": "string",
 "dataV1[].target.endorsements[].elements[].type": "string",
 "dataV1[].target.endorsements[].elements[].width": "number",
 "dataV1[].target.endorsements[].elements[].content": "string",
 "dataV1[].target.endorsements[].elements[].font_color.alpha": "number",
 "dataV1[].target.endorsements[].elements[].font_color.group": "string",
 "dataV1[].target.endorsements[].elements[].font_size": "number",
 "dataV1[].target.endorsements[].elements[].is_bold": "boolean",
 "dataV1[].target.endorsements[].elements[].max_line": "number",
 "dataV1[].target.endorsements[].sub_elements": "array(empty)",
 "dataV1[].target.endorsements[].sub_elements_type": "string",
 "dataV1[].target.endorsements[].za.block_text": "string",
 "dataV1[].target.endorsements[].za.text": "string",
 "dataV1[].target.endorsements[].za.type": "string",
 "dataV1[].target.thumbnail": "string",
 "dataV1[].target.thumbnails": "array<string>",
 "dataV1[].target.paid_info.content": "string"
}
```

## 被拦的接口（含关键 error.code / message 原文）

### https://www.zhihu.com/api/v4/search_v3?t=general&q=test&correction=1&offset=0&limit=20

- 最终判定: HTTP 403（via page-fetch）
- error.code: **40353**
- message: 请您登录后查看更多专业优质内容。
  - curl → 400，body: `{"HitLabels":null}
`
  - page-fetch → 403 / code 40353，body: `{"error":{"need_login":true,"redirect":"https:\/\/www.zhihu.com\/account\/unhuman?type=U4E3Z1&need_login=true&session=1182845323adfe718c794a1211233cd3&next=%2Fsignin","code":40353,"message":"请您登录后查看更多专业优质内容。"}}
`
- 解读: curl 直连返回非常规 400 {"HitLabels":null}；页面内 fetch 返回 403/40353 need_login，判定为登录墙

### https://www.zhihu.com/api/v4/questions/19554697

- 最终判定: HTTP 403（via curl）
- error.code: **10003**
- message: 请求参数异常，请升级客户端后重试。
  - curl → 403 / code 10003，body: `{"error":{"message":"请求参数异常，请升级客户端后重试。","code":10003}}
`
  - page-fetch → 403 / code 10003，body: `{"error":{"message":"请求参数异常，请升级客户端后重试。","code":10003}}
`
- 解读: error 10003『请求参数异常，请升级客户端后重试』：页面内手动 fetch 同样 403，说明该接口强制校验 x-zse-96 签名，属签名缺失而非接口关闭/登录问题

### https://www.zhihu.com/api/v4/answers/1000221950

- 最终判定: HTTP 403（via curl）
- error.code: **40353**
- message: 请您登录后查看更多专业优质内容。
  - curl → 403 / code 40353，body: `{"error":{"need_login":true,"redirect":"https:\/\/www.zhihu.com\/account\/unhuman?type=U4E3Z1&need_login=true&session=1ce9a9031c2c4ada8f26899c98abc35e&next=%2Fsignin","code":40353,"message":"请您登录后查看更多专业优质内容。"}}
`
  - page-fetch → 403 / code 40353，body: `{"error":{"need_login":true,"redirect":"https:\/\/www.zhihu.com\/account\/unhuman?type=U4E3Z1&need_login=true&session=1182845323adfe718c794a1211233cd3&next=%2Fsignin","code":40353,"message":"请您登录后查看更多专业优质内容。"}}
`
- 解读: error 40353 need_login=true，未登录限制

### https://www.zhihu.com/api/v4/members/yang-xu-heng-94/answers?limit=1&offset=0

- 最终判定: HTTP 403（via page-fetch）
- error.code: **40353**
- message: 请您登录后查看更多专业优质内容。
  - curl → 401 / code 602，body: `{"error": {"message": "第三方应用独立请求时，无此操作权限", "code": 602, "name": "AuthenticationInvalidClient"}}`
  - page-fetch → 403 / code 40353，body: `{"error":{"need_login":true,"redirect":"https:\/\/www.zhihu.com\/account\/unhuman?type=U4E3Z1&need_login=true&session=1182845323adfe718c794a1211233cd3&next=%2Fsignin","code":40353,"message":"请您登录后查看更多专业优质内容。"}}
`
- 解读: curl 直连报 401/602『第三方应用独立请求时，无此操作权限』(AuthenticationInvalidClient)；页面内（带 cookie、无签名头）报 403/40353 need_login，判定为登录墙

### https://www.zhihu.com/api/v4/feed/topstory/recommend?limit=5

- 最终判定: HTTP 404（via curl）
- error.code: **-**
- message: (非 JSON 错误体)
  - curl → 404，body: `404 page not found
`
  - page-fetch → 404，body: `404 page not found
`
- 解读: 该路径在 www.zhihu.com/api/v4 下不存在（404 page not found，纯文本非 JSON），curl 与页面 fetch 一致

### https://www.zhihu.com/api/v3/feed/topstory/recommend?limit=5

- 最终判定: HTTP 401（via curl）（加测）
- error.code: **101**，name: `AuthenticationError`
- message: 身份未经过验证
  - curl → 401 / code 101，body: `{"error":{"code":101,"name":"AuthenticationError","message":"身份未经过验证"}}
`
  - page-fetch → 401 / code 101，body: `{"error":{"code":101,"name":"AuthenticationError","message":"身份未经过验证"}}
`
- 解读: 加测：v3 路径真实存在，但 401/101『身份未经过验证』(AuthenticationError)，纯登录墙

## 关键结论（供采集器设计参考）

- error.code=10003『请求参数异常，请升级客户端后重试』= 缺 x-zse-96 签名（页面上下文手动 fetch 仍 403），接口本身存在
- error.code=40353 need_login=true = 未登录限制（匿名硬墙）
- error.code=602 = 客户端认证无效；error.code=101 = 身份未经过验证（均为登录墙）
- 免登录可访问的三个接口全部在 api.zhihu.com 域；www.zhihu.com/api/v4 下实测全部被拦（404/401/403）
- 免登录样本中 target 只出现 question（hot-list）与 answer（recommend）两种类型，article 类型 target 未出现

> 字段树口径：数组节点取样本内全部元素对象 key 的并集；`[]` 表示该层为数组；值为 JSON 类型名；`array<x>` 表示纯值数组。