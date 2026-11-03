# 10 · 真机实测：answers 列表 + answers 详情（2026-11-01）

> 统一请求器直连，共 **5 个请求**（`basic` 金丝雀先行，通过后再发其余 4 个；`wait=3200ms`；关闭 page_fallback，请求数=job 数）。全部 **200**，未出现 403/40353/40362。

## 1. 请求总览

| id | 端点 | status | 条数 | 顶层(answer 对象)字段数 | include 请求字段数 | 请求未返回数 | content 最大长度量级 |
|---|---|---|---|---|---|---|---|
| basic | A members/.../answers（无 include） | 200 | 2 | 21 | 0 | 0 | — |
| proj | B 同A+项目 include | 200 | 2 | 38 | 32 | 11 | ~100 |
| max | C 同A+全量探测 include | 200 | 2 | 38 | 44 | 14 | ~100 |
| detail_inc | D /answers/{id}?include=6项 | 200 | 1 | 23 | 6 | 1 | — |
| detail_basic | E /answers/{id}（无 include） | 200 | 1 | 18 | 0 | 0 | — |

- 列表响应根键：paging、data、need_force_login；detail 响应根层即回答对象（无 data 包裹）；分页键：paging.is_end(boolean)、paging.totals(number)、paging.previous(string)、paging.is_start(boolean)、paging.next(string)。

## 2. 三组 include 的差异

- B(proj) 比 A(basic) **多 17** 个顶层字段：admin_closed_comment、annotation_action、can_comment、collapse_reason、collapsed_by、comment_count、comment_permission、content、excerpt、is_labeled、is_normal、mark_infos、relationship、reshipment_settings、review_info、reward_info、suggest_edit
- C(max) 比 A(basic) **多 17** 个：admin_closed_comment、annotation_action、can_comment、collapse_reason、collapsed_by、comment_count、comment_permission、content、excerpt、is_labeled、is_normal、mark_infos、relationship、reshipment_settings、review_info、reward_info、suggest_edit
- C(max) 比 B(proj) **多 0** 个：（无）
- B(proj) 里 A 也有的字段（include 未带来新面）：0 个；B 请求但 C 没请求的字段：0 个（无）

## 3. include 逐项返回情况

| include 请求的路径 | proj | max | detail_inc |
|---|---|---|---|
| data[].is_normal | ✓ | ✓ | — |
| data[].admin_closed_comment | ✓ | ✓ | — |
| data[].reward_info | ✓ | ✓ | — |
| data[].is_collapsed | ✓ | ✓ | — |
| data[].annotation_action | ✓ | ✓ | — |
| data[].annotation_detail | ✗ | ✗ | — |
| data[].collapse_reason | ✓ | ✓ | — |
| data[].collapsed_by | ✓ | ✓ | — |
| data[].suggest_edit | ✓ | ✓ | — |
| data[].comment_count | ✓ | ✓ | — |
| data[].can_comment | ✓ | ✓ | — |
| data[].content | ✓ | ✓ | — |
| data[].voteup_count | ✗ | ✗ | — |
| data[].reshipment_settings | ✓ | ✓ | — |
| data[].comment_permission | ✓ | ✓ | — |
| data[].mark_infos | ✓ | ✓ | — |
| data[].created_time | ✓ | ✓ | — |
| data[].updated_time | ✓ | ✓ | — |
| data[].review_info | ✓ | ✓ | — |
| data[].question | ✓ | ✓ | — |
| data[].excerpt | ✓ | ✓ | — |
| data[].is_labeled | ✓ | ✓ | — |
| data[].label_info | ✗ | ✗ | — |
| data[].relationship.is_authorized | ✓ | ✓ | — |
| data[].voting | ✗ | ✗ | — |
| data[].is_author | ✗ | ✗ | — |
| data[].is_thanked | ✗ | ✗ | — |
| data[].is_nothelp | ✗ | ✗ | — |
| data[].is_recognized | ✗ | ✗ | — |
| data[].visit_count | ✗ | ✗ | — |
| data[].favorite_count | ✗ | ✗ | — |
| data[].author.badge[?(type=best_answerer)].topics | ✗ | ✗ | — |
| data[].thanks_count | — | ✗ | — |
| data[].author.badge | — | ✓ | — |
| data[].author.headline | — | ✓ | — |
| data[].excerpt_title | — | ✗ | — |
| data[].thumbnail | — | ✓ | — |
| data[].extras | — | ✓ | — |
| data[].answer_type | — | ✓ | — |
| data[].is_copyable | — | ✓ | — |
| data[].content_need_truncated | — | ✓ | — |
| data[].reaction.statistics | — | ✓ | — |
| data[].paid_info | — | ✗ | — |
| data[].endorsements | — | ✓ | — |
| voteup_count | — | — | ✓ |
| comment_count | — | — | ✓ |
| visit_count | — | — | ✓ |
| favorite_count | — | — | ✗ |
| thanks_count | — | — | ✓ |
| reaction | — | — | ✓ |

✓=该次响应中确实出现；✗=请求了但未出现。

## 4. 争议 6 字段（answers 列表内）结论

| 字段 | A basic | B proj | C max | 类型 | 结论 |
|---|---|---|---|---|---|
| data[].voteup_count | ✗ | ✗ | ✗ | — | **include 也拿不到**（proj/max 都请求了仍未返回） |
| data[].favorite_count | ✗ | ✗ | ✗ | — | **include 也拿不到**（proj/max 都请求了仍未返回） |
| data[].visit_count | ✗ | ✗ | ✗ | — | **include 也拿不到**（proj/max 都请求了仍未返回） |
| data[].thanks_count | ✗ | ✗ | ✗ | — | **include 也拿不到**（proj/max 都请求了仍未返回） |
| data[].comment_count | ✗ | ✓ | ✓ | number | 必须 include（A 无、B/C 有） |
| data[].content | ✗ | ✓ | ✓ | string | 必须 include（A 无、B/C 有） |

## 5. reaction.statistics 实际统计项

| 统计键 | basic | proj | max | detail_inc | detail_basic |
|---|---|---|---|---|---|
| applaud_count |  |  |  | ✓ |  |
| bullet_count |  |  |  | ✓ |  |
| comment_count |  |  |  | ✓ |  |
| down_vote_count |  |  |  | ✓ |  |
| favorites | ✓ | ✓ | ✓ | ✓ |  |
| interest_play_count |  |  |  | ✓ |  |
| like_count | ✓ | ✓ | ✓ | ✓ |  |
| plaincontent_like_count |  |  |  | ✓ |  |
| plaincontent_vote_up_count |  |  |  | ✓ |  |
| play_count |  |  |  | ✓ |  |
| pv_count |  |  |  | ✓ |  |
| question_answer_count |  |  |  | ✓ |  |
| question_follower_count |  |  |  | ✓ |  |
| republishers |  |  |  | ✓ |  |
| share_count |  |  |  | ✓ |  |
| subscribe_count |  |  |  | ✓ |  |
| up_vote_count |  |  |  | ✓ |  |

## 6. 逐字段表（数组元素 key 并集，含嵌套）

| 路径 | 类型 | 字符串量级 | basic | proj | max | detail_inc | detail_basic | 需 include |
|---|---|---|---|---|---|---|---|---|
| data[].admin_closed_comment | boolean | — |  | ✓ | ✓ |  |  | 是 |
| data[].annotation_action（恒空） | array | — |  | ✓ | ✓ |  |  | 是 |
| data[].answer_type | string | ≤10 | ✓ | ✓ | ✓ |  |  |  |
| data[].author | object | — | ✓ | ✓ | ✓ |  |  |  |
| data[].author.avatar_url | string | ~100 | ✓ | ✓ | ✓ |  |  |  |
| data[].author.avatar_url_template | string | ~100 | ✓ | ✓ | ✓ |  |  |  |
| data[].author.badge（恒空） | array | — | ✓ | ✓ | ✓ |  |  |  |
| data[].author.badge_v2 | object | — | ✓ | ✓ | ✓ |  |  |  |
| data[].author.badge_v2.detail_badges（恒空） | array | — | ✓ | ✓ | ✓ |  |  |  |
| data[].author.badge_v2.icon | string | ≤10 | ✓ | ✓ | ✓ |  |  |  |
| data[].author.badge_v2.merged_badges（恒空） | array | — | ✓ | ✓ | ✓ |  |  |  |
| data[].author.badge_v2.night_icon | string | ≤10 | ✓ | ✓ | ✓ |  |  |  |
| data[].author.badge_v2.title | string | ≤10 | ✓ | ✓ | ✓ |  |  |  |
| data[].author.gender | number | — | ✓ | ✓ | ✓ |  |  |  |
| data[].author.headline | string | ≤10 | ✓ | ✓ | ✓ |  |  |  |
| data[].author.id | string | ~100 | ✓ | ✓ | ✓ |  |  |  |
| data[].author.is_advertiser | boolean | — | ✓ | ✓ | ✓ |  |  |  |
| data[].author.is_org | boolean | — | ✓ | ✓ | ✓ |  |  |  |
| data[].author.name | string | ≤10 | ✓ | ✓ | ✓ |  |  |  |
| data[].author.type | string | ≤10 | ✓ | ✓ | ✓ |  |  |  |
| data[].author.url | string | ~100 | ✓ | ✓ | ✓ |  |  |  |
| data[].author.url_token | string | ~100 | ✓ | ✓ | ✓ |  |  |  |
| data[].author.user_type | string | ≤10 | ✓ | ✓ | ✓ |  |  |  |
| data[].biz_ext | object | — | ✓ | ✓ | ✓ |  |  |  |
| data[].biz_ext.creation_relationship（恒空） | object | — | ✓ | ✓ | ✓ |  |  |  |
| data[].can_comment | object | — |  | ✓ | ✓ |  |  | 是 |
| data[].can_comment.reason | string | ≤10 |  | ✓ | ✓ |  |  | 是 |
| data[].can_comment.status | boolean | — |  | ✓ | ✓ |  |  | 是 |
| data[].collapse_reason | string | ≤10 |  | ✓ | ✓ |  |  | 是 |
| data[].collapsed_by | string | ≤10 |  | ✓ | ✓ |  |  | 是 |
| data[].comment_count | number | — |  | ✓ | ✓ |  |  | 是 |
| data[].comment_permission | string | ≤10 |  | ✓ | ✓ |  |  | 是 |
| data[].content | string | ~100 |  | ✓ | ✓ |  |  | 是 |
| data[].content_need_truncated | boolean | — | ✓ | ✓ | ✓ |  |  |  |
| data[].created_time | number | — | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements | array | — | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements[].action_url | string | ~100 | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements[].background_color | object | — | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements[].background_color.alpha | number | — | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements[].background_color.group | string | ≤10 | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements[].elements | array | — | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements[].elements[].content | string | ≤10 | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements[].elements[].font_color | object | — | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements[].elements[].font_color.alpha | number | — | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements[].elements[].font_color.group | string | ≤10 | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements[].elements[].font_size | number | — | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements[].elements[].height | number | — | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements[].elements[].image_color | object | — | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements[].elements[].image_color.alpha | number | — | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements[].elements[].image_color.group | string | ≤10 | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements[].elements[].image_key | string | ~100 | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements[].elements[].is_bold | boolean | — | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements[].elements[].max_line | number | — | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements[].elements[].type | string | ≤10 | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements[].elements[].width | number | — | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements[].sub_elements（恒空） | array | — | ✓ | ✓ | ✓ |  |  |  |
| data[].endorsements[].sub_elements_type | string | ~100 | ✓ | ✓ | ✓ |  |  |  |
| data[].excerpt | string | ~100 |  | ✓ | ✓ |  |  | 是 |
| data[].extras | string | ≤10 | ✓ | ✓ | ✓ |  |  |  |
| data[].force_login_when_click_read_more | boolean | — | ✓ | ✓ | ✓ |  |  |  |
| data[].id | string | ~100 | ✓ | ✓ | ✓ |  |  |  |
| data[].is_collapsed | boolean | — | ✓ | ✓ | ✓ |  |  |  |
| data[].is_copyable | boolean | — | ✓ | ✓ | ✓ |  |  |  |
| data[].is_labeled | boolean | — |  | ✓ | ✓ |  |  | 是 |
| data[].is_navigator | boolean | — | ✓ | ✓ | ✓ |  |  |  |
| data[].is_normal | boolean | — |  | ✓ | ✓ |  |  | 是 |
| data[].mark_infos（恒空） | array | — |  | ✓ | ✓ |  |  | 是 |
| data[].navigator_vote | boolean | — | ✓ | ✓ | ✓ |  |  |  |
| data[].question | object | — | ✓ | ✓ | ✓ |  |  |  |
| data[].question.author | object | — |  |  | ✓ |  |  | 是 |
| data[].question.author.avatar_url | string | ~100 |  |  | ✓ |  |  | 是 |
| data[].question.author.avatar_url_template | string | ~100 |  |  | ✓ |  |  | 是 |
| data[].question.author.badge（恒空） | array | — |  |  | ✓ |  |  | 是 |
| data[].question.author.badge_v2 | object | — |  |  | ✓ |  |  | 是 |
| data[].question.author.badge_v2.detail_badges（恒空） | array | — |  |  | ✓ |  |  | 是 |
| data[].question.author.badge_v2.icon | string | ≤10 |  |  | ✓ |  |  | 是 |
| data[].question.author.badge_v2.merged_badges（恒空） | array | — |  |  | ✓ |  |  | 是 |
| data[].question.author.badge_v2.night_icon | string | ≤10 |  |  | ✓ |  |  | 是 |
| data[].question.author.badge_v2.title | string | ≤10 |  |  | ✓ |  |  | 是 |
| data[].question.author.gender | number | — |  |  | ✓ |  |  | 是 |
| data[].question.author.headline | string | ≤10 |  |  | ✓ |  |  | 是 |
| data[].question.author.id | string | ~100 |  |  | ✓ |  |  | 是 |
| data[].question.author.is_advertiser | boolean | — |  |  | ✓ |  |  | 是 |
| data[].question.author.is_org | boolean | — |  |  | ✓ |  |  | 是 |
| data[].question.author.name | string | ≤10 |  |  | ✓ |  |  | 是 |
| data[].question.author.type | string | ≤10 |  |  | ✓ |  |  | 是 |
| data[].question.author.url | string | ~100 |  |  | ✓ |  |  | 是 |
| data[].question.author.url_token | string | ~100 |  |  | ✓ |  |  | 是 |
| data[].question.author.user_type | string | ≤10 |  |  | ✓ |  |  | 是 |
| data[].question.created | number | — | ✓ | ✓ | ✓ |  |  |  |
| data[].question.id | string | ~100 | ✓ | ✓ | ✓ |  |  |  |
| data[].question.question_type | string | ≤10 | ✓ | ✓ | ✓ |  |  |  |
| data[].question.title | string | ~100 | ✓ | ✓ | ✓ |  |  |  |
| data[].question.type | string | ≤10 | ✓ | ✓ | ✓ |  |  |  |
| data[].question.updated_time | number | — | ✓ | ✓ | ✓ |  |  |  |
| data[].question.url | string | ~100 | ✓ | ✓ | ✓ |  |  |  |
| data[].question.visit_count | number | — |  | ✓ |  |  |  | 是 |
| data[].reaction | object | — | ✓ | ✓ | ✓ |  |  |  |
| data[].reaction.relation | object | — | ✓ | ✓ | ✓ |  |  |  |
| data[].reaction.relation.faved | boolean | — | ✓ | ✓ | ✓ |  |  |  |
| data[].reaction.relation.liked | boolean | — | ✓ | ✓ | ✓ |  |  |  |
| data[].reaction.statistics | object | — | ✓ | ✓ | ✓ |  |  |  |
| data[].reaction.statistics.favorites | number | — | ✓ | ✓ | ✓ |  |  |  |
| data[].reaction.statistics.like_count | number | — | ✓ | ✓ | ✓ |  |  |  |
| data[].relationship | object | — |  | ✓ | ✓ |  |  | 是 |
| data[].relationship.is_author | boolean | — |  | ✓ | ✓ |  |  | 是 |
| data[].relationship.is_authorized | boolean | — |  | ✓ | ✓ |  |  | 是 |
| data[].relationship.is_nothelp | boolean | — |  | ✓ | ✓ |  |  | 是 |
| data[].relationship.is_thanked | boolean | — |  | ✓ | ✓ |  |  | 是 |
| data[].relationship.voting | number | — |  | ✓ | ✓ |  |  | 是 |
| data[].reshipment_settings | string | ≤10 |  | ✓ | ✓ |  |  | 是 |
| data[].review_info | object | — |  | ✓ | ✓ |  |  | 是 |
| data[].review_info.is_reviewing | boolean | — |  | ✓ | ✓ |  |  | 是 |
| data[].review_info.tips | string | ≤10 |  | ✓ | ✓ |  |  | 是 |
| data[].review_info.type | string | ≤10 |  | ✓ | ✓ |  |  | 是 |
| data[].reward_info | object | — |  | ✓ | ✓ |  |  | 是 |
| data[].reward_info.can_open_reward | boolean | — |  | ✓ | ✓ |  |  | 是 |
| data[].reward_info.is_rewardable | boolean | — |  | ✓ | ✓ |  |  | 是 |
| data[].reward_info.reward_member_count | number | — |  | ✓ | ✓ |  |  | 是 |
| data[].reward_info.reward_total_money | number | — |  | ✓ | ✓ |  |  | 是 |
| data[].reward_info.tagline | string | ≤10 |  | ✓ | ✓ |  |  | 是 |
| data[].same_video_answers（恒空） | array | — | ✓ | ✓ | ✓ |  |  |  |
| data[].suggest_edit | object | — |  | ✓ | ✓ |  |  | 是 |
| data[].suggest_edit.reason | string | ≤10 |  | ✓ | ✓ |  |  | 是 |
| data[].suggest_edit.status | boolean | — |  | ✓ | ✓ |  |  | 是 |
| data[].suggest_edit.tip | string | ≤10 |  | ✓ | ✓ |  |  | 是 |
| data[].suggest_edit.title | string | ≤10 |  | ✓ | ✓ |  |  | 是 |
| data[].suggest_edit.unnormal_details（恒空） | object | — |  | ✓ | ✓ |  |  | 是 |
| data[].suggest_edit.url | string | ≤10 |  | ✓ | ✓ |  |  | 是 |
| data[].thumbnail | string | ≤10 | ✓ | ✓ | ✓ |  |  |  |
| data[].type | string | ≤10 | ✓ | ✓ | ✓ |  |  |  |
| data[].updated_time | number | — | ✓ | ✓ | ✓ |  |  |  |
| data[].url | string | ~100 | ✓ | ✓ | ✓ |  |  |  |
| data[].vote_next_step | string | ≤10 | ✓ | ✓ | ✓ |  |  |  |
| allow_segment_interaction | number | — |  |  |  | ✓ | ✓ |  |
| answer_type | string | ≤10 |  |  |  | ✓ | ✓ |  |
| author | object | — |  |  |  | ✓ | ✓ |  |
| author.avatar_url | string | ~100 |  |  |  | ✓ | ✓ |  |
| author.avatar_url_template | string | ~100 |  |  |  | ✓ | ✓ |  |
| author.badge（恒空） | array | — |  |  |  | ✓ | ✓ |  |
| author.badge_v2 | object | — |  |  |  | ✓ | ✓ |  |
| author.badge_v2.detail_badges（恒空） | array | — |  |  |  | ✓ | ✓ |  |
| author.badge_v2.icon | string | ≤10 |  |  |  | ✓ | ✓ |  |
| author.badge_v2.merged_badges（恒空） | array | — |  |  |  | ✓ | ✓ |  |
| author.badge_v2.night_icon | string | ≤10 |  |  |  | ✓ | ✓ |  |
| author.badge_v2.title | string | ≤10 |  |  |  | ✓ | ✓ |  |
| author.gender | number | — |  |  |  | ✓ | ✓ |  |
| author.headline | string | ≤10 |  |  |  | ✓ | ✓ |  |
| author.id | string | ~100 |  |  |  | ✓ | ✓ |  |
| author.is_advertiser | boolean | — |  |  |  | ✓ | ✓ |  |
| author.is_org | boolean | — |  |  |  | ✓ | ✓ |  |
| author.is_privacy | boolean | — |  |  |  | ✓ | ✓ |  |
| author.name | string | ≤10 |  |  |  | ✓ | ✓ |  |
| author.type | string | ≤10 |  |  |  | ✓ | ✓ |  |
| author.url | string | ~100 |  |  |  | ✓ | ✓ |  |
| author.url_token | string | ~100 |  |  |  | ✓ | ✓ |  |
| author.user_type | string | ≤10 |  |  |  | ✓ | ✓ |  |
| biz_ext | object | — |  |  |  | ✓ | ✓ |  |
| biz_ext.share_guide | object | — |  |  |  | ✓ | ✓ |  |
| biz_ext.share_guide.has_positive_bubble | boolean | — |  |  |  | ✓ | ✓ |  |
| biz_ext.share_guide.has_time_bubble | boolean | — |  |  |  | ✓ | ✓ |  |
| biz_ext.share_guide.hit_share_guide_cluster | boolean | — |  |  |  | ✓ | ✓ |  |
| comment_count | number | — |  |  |  | ✓ |  | 是 |
| content_need_truncated | boolean | — |  |  |  | ✓ | ✓ |  |
| created_time | number | — |  |  |  | ✓ | ✓ |  |
| extras | string | ≤10 |  |  |  | ✓ | ✓ |  |
| force_login_when_click_read_more | boolean | — |  |  |  | ✓ | ✓ |  |
| id | string | ~100 |  |  |  | ✓ | ✓ |  |
| is_collapsed | boolean | — |  |  |  | ✓ | ✓ |  |
| is_copyable | boolean | — |  |  |  | ✓ | ✓ |  |
| is_jump_native | boolean | — |  |  |  | ✓ | ✓ |  |
| podcast_audio_enter | object | — |  |  |  | ✓ | ✓ |  |
| podcast_audio_enter.action_url | string | ~1k |  |  |  | ✓ | ✓ |  |
| podcast_audio_enter.sub_type | string | ≤10 |  |  |  | ✓ | ✓ |  |
| podcast_audio_enter.text | string | ≤10 |  |  |  | ✓ | ✓ |  |
| podcast_audio_enter.text_color | string | ≤10 |  |  |  | ✓ | ✓ |  |
| podcast_audio_enter.text_size | number | — |  |  |  | ✓ | ✓ |  |
| question | object | — |  |  |  | ✓ | ✓ |  |
| question.created | number | — |  |  |  | ✓ | ✓ |  |
| question.id | string | ~100 |  |  |  | ✓ | ✓ |  |
| question.question_type | string | ≤10 |  |  |  | ✓ | ✓ |  |
| question.relationship（恒空） | object | — |  |  |  | ✓ | ✓ |  |
| question.title | string | ~100 |  |  |  | ✓ | ✓ |  |
| question.type | string | ≤10 |  |  |  | ✓ | ✓ |  |
| question.updated_time | number | — |  |  |  | ✓ | ✓ |  |
| question.url | string | ~100 |  |  |  | ✓ | ✓ |  |
| reaction | object | — |  |  |  | ✓ |  | 是 |
| reaction.image_reactions（恒空） | object | — |  |  |  | ✓ |  | 是 |
| reaction.relation | object | — |  |  |  | ✓ |  | 是 |
| reaction.relation.current_user_is_navigator | boolean | — |  |  |  | ✓ |  | 是 |
| reaction.relation.faved | boolean | — |  |  |  | ✓ |  | 是 |
| reaction.relation.following | boolean | — |  |  |  | ✓ |  | 是 |
| reaction.relation.is_author | boolean | — |  |  |  | ✓ |  | 是 |
| reaction.relation.is_navigator_vote | boolean | — |  |  |  | ✓ |  | 是 |
| reaction.relation.liked | boolean | — |  |  |  | ✓ |  | 是 |
| reaction.relation.subcribed | boolean | — |  |  |  | ✓ |  | 是 |
| reaction.relation.vote | string | ≤10 |  |  |  | ✓ |  | 是 |
| reaction.relation.vote_next_step | string | ≤10 |  |  |  | ✓ |  | 是 |
| reaction.statistics | object | — |  |  |  | ✓ |  | 是 |
| reaction.statistics.applaud_count | number | — |  |  |  | ✓ |  | 是 |
| reaction.statistics.bullet_count | number | — |  |  |  | ✓ |  | 是 |
| reaction.statistics.comment_count | number | — |  |  |  | ✓ |  | 是 |
| reaction.statistics.down_vote_count | number | — |  |  |  | ✓ |  | 是 |
| reaction.statistics.favorites | number | — |  |  |  | ✓ |  | 是 |
| reaction.statistics.interest_play_count | number | — |  |  |  | ✓ |  | 是 |
| reaction.statistics.like_count | number | — |  |  |  | ✓ |  | 是 |
| reaction.statistics.plaincontent_like_count | number | — |  |  |  | ✓ |  | 是 |
| reaction.statistics.plaincontent_vote_up_count | number | — |  |  |  | ✓ |  | 是 |
| reaction.statistics.play_count | number | — |  |  |  | ✓ |  | 是 |
| reaction.statistics.pv_count | number | — |  |  |  | ✓ |  | 是 |
| reaction.statistics.question_answer_count | number | — |  |  |  | ✓ |  | 是 |
| reaction.statistics.question_follower_count | number | — |  |  |  | ✓ |  | 是 |
| reaction.statistics.republishers（恒空） | array | — |  |  |  | ✓ |  | 是 |
| reaction.statistics.share_count | number | — |  |  |  | ✓ |  | 是 |
| reaction.statistics.subscribe_count | number | — |  |  |  | ✓ |  | 是 |
| reaction.statistics.up_vote_count | number | — |  |  |  | ✓ |  | 是 |
| relationship | object | — |  |  |  | ✓ | ✓ |  |
| relationship.upvoted_followees（恒空） | array | — |  |  |  | ✓ | ✓ |  |
| thanks_count | number | — |  |  |  | ✓ |  | 是 |
| type | string | ≤10 |  |  |  | ✓ | ✓ |  |
| updated_time | number | — |  |  |  | ✓ | ✓ |  |
| url | string | ~100 |  |  |  | ✓ | ✓ |  |
| visit_count | number | — |  |  |  | ✓ |  | 是 |
| voteup_count | number | — |  |  |  | ✓ |  | 是 |

## 7. requested_not_returned（include 请求了但响应里没有）

- `data[].annotation_detail`
- `data[].voteup_count`
- `data[].label_info`
- `data[].voting`
- `data[].is_author`
- `data[].is_thanked`
- `data[].is_nothelp`
- `data[].is_recognized`
- `data[].visit_count`
- `data[].favorite_count`
- `data[].author.badge[?(type=best_answerer)].topics`
- `data[].thanks_count`
- `data[].excerpt_title`
- `data[].paid_info`
- `favorite_count`

各请求明细：
- basic: 无
- proj: data[].annotation_detail、data[].voteup_count、data[].label_info、data[].voting、data[].is_author、data[].is_thanked、data[].is_nothelp、data[].is_recognized、data[].visit_count、data[].favorite_count、data[].author.badge[?(type=best_answerer)].topics
- max: data[].voteup_count、data[].visit_count、data[].favorite_count、data[].thanks_count、data[].annotation_detail、data[].label_info、data[].voting、data[].is_author、data[].is_thanked、data[].is_nothelp、data[].is_recognized、data[].excerpt_title、data[].paid_info、data[].author.badge[?(type=best_answerer)].topics
- detail_inc: favorite_count
- detail_basic: 无

## 8. returned_not_requested（没请求却返回了）

- `data[].force_login_when_click_read_more`
- `data[].created_time`
- `data[].is_navigator`
- `data[].biz_ext`
- `data[].biz_ext.creation_relationship`
- `data[].id`
- `data[].is_copyable`
- `data[].reaction`
- `data[].reaction.statistics`
- `data[].reaction.statistics.like_count`
- `data[].reaction.statistics.favorites`
- `data[].reaction.relation`
- `data[].reaction.relation.faved`
- `data[].reaction.relation.liked`
- `data[].is_collapsed`
- `data[].author`
- `data[].author.avatar_url_template`
- `data[].author.badge_v2`
- `data[].author.badge_v2.icon`
- `data[].author.badge_v2.detail_badges`
- `data[].author.badge_v2.night_icon`
- `data[].author.badge_v2.merged_badges`
- `data[].author.badge_v2.title`
- `data[].author.name`
- `data[].author.headline`
- `data[].author.gender`
- `data[].author.user_type`
- `data[].author.url_token`
- `data[].author.is_advertiser`
- `data[].author.avatar_url`
- `data[].author.is_org`
- `data[].author.type`
- `data[].author.url`
- `data[].author.badge`
- `data[].author.id`
- `data[].url`
- `data[].type`
- `data[].question`
- `data[].question.question_type`
- `data[].question.created`
- `data[].question.url`
- `data[].question.title`
- `data[].question.type`
- `data[].question.id`
- `data[].question.updated_time`
- `data[].updated_time`
- `data[].extras`
- `data[].same_video_answers`
- `data[].content_need_truncated`
- `data[].answer_type`
- `data[].vote_next_step`
- `data[].navigator_vote`
- `data[].thumbnail`
- `data[].endorsements`
- `data[].endorsements[].action_url`
- `data[].endorsements[].elements`
- `data[].endorsements[].elements[].image_key`
- `data[].endorsements[].elements[].image_color`
- `data[].endorsements[].elements[].image_color.alpha`
- `data[].endorsements[].elements[].image_color.group`
- `data[].endorsements[].elements[].height`
- `data[].endorsements[].elements[].width`
- `data[].endorsements[].elements[].type`
- `data[].endorsements[].elements[].font_size`
- `data[].endorsements[].elements[].max_line`
- `data[].endorsements[].elements[].content`
- `data[].endorsements[].elements[].is_bold`
- `data[].endorsements[].elements[].font_color`
- `data[].endorsements[].elements[].font_color.alpha`
- `data[].endorsements[].elements[].font_color.group`
- `data[].endorsements[].sub_elements`
- `data[].endorsements[].sub_elements_type`
- `data[].endorsements[].background_color`
- `data[].endorsements[].background_color.alpha`
- `data[].endorsements[].background_color.group`
- `data[].question.visit_count`
- `data[].reward_info.reward_member_count`
- `data[].reward_info.tagline`
- `data[].reward_info.reward_total_money`
- `data[].reward_info.can_open_reward`
- `data[].reward_info.is_rewardable`
- `data[].suggest_edit.status`
- `data[].suggest_edit.reason`
- `data[].suggest_edit.title`
- `data[].suggest_edit.url`
- `data[].suggest_edit.unnormal_details`
- `data[].suggest_edit.tip`
- `data[].relationship`
- `data[].relationship.is_author`
- `data[].relationship.is_thanked`
- `data[].relationship.is_nothelp`
- `data[].relationship.voting`
- `data[].review_info.is_reviewing`
- `data[].review_info.tips`
- `data[].review_info.type`
- `data[].can_comment.status`
- `data[].can_comment.reason`
- `data[].question.author`
- `data[].question.author.avatar_url_template`
- `data[].question.author.badge`
- `data[].question.author.badge_v2`
- `data[].question.author.badge_v2.icon`
- `data[].question.author.badge_v2.detail_badges`
- `data[].question.author.badge_v2.night_icon`
- `data[].question.author.badge_v2.merged_badges`
- `data[].question.author.badge_v2.title`
- `data[].question.author.name`
- `data[].question.author.is_advertiser`
- `data[].question.author.url`
- `data[].question.author.gender`
- `data[].question.author.user_type`
- `data[].question.author.headline`
- `data[].question.author.avatar_url`
- `data[].question.author.is_org`
- `data[].question.author.type`
- `data[].question.author.url_token`
- `data[].question.author.id`
- `allow_segment_interaction`
- `answer_type`
- `author`
- `author.avatar_url`
- `author.avatar_url_template`
- `author.badge`
- `author.badge_v2`
- `author.badge_v2.detail_badges`
- `author.badge_v2.icon`
- `author.badge_v2.merged_badges`
- `author.badge_v2.night_icon`
- `author.badge_v2.title`
- `author.gender`
- `author.headline`
- `author.id`
- `author.is_advertiser`
- `author.is_org`
- `author.is_privacy`
- `author.name`
- `author.type`
- `author.url`
- `author.url_token`
- `author.user_type`
- `biz_ext`
- `biz_ext.share_guide`
- `biz_ext.share_guide.has_positive_bubble`
- `biz_ext.share_guide.has_time_bubble`
- `biz_ext.share_guide.hit_share_guide_cluster`
- `content_need_truncated`
- `created_time`
- `extras`
- `force_login_when_click_read_more`
- `id`
- `is_collapsed`
- `is_copyable`
- `is_jump_native`
- `podcast_audio_enter`
- `podcast_audio_enter.action_url`
- `podcast_audio_enter.sub_type`
- `podcast_audio_enter.text`
- `podcast_audio_enter.text_color`
- `podcast_audio_enter.text_size`
- `question`
- `question.created`
- `question.id`
- `question.question_type`
- `question.relationship`
- `question.title`
- `question.type`
- `question.updated_time`
- `question.url`
- `reaction.image_reactions`
- `reaction.relation`
- `reaction.relation.current_user_is_navigator`
- `reaction.relation.faved`
- `reaction.relation.following`
- `reaction.relation.is_author`
- `reaction.relation.is_navigator_vote`
- `reaction.relation.liked`
- `reaction.relation.subcribed`
- `reaction.relation.vote`
- `reaction.relation.vote_next_step`
- `reaction.statistics`
- `reaction.statistics.applaud_count`
- `reaction.statistics.bullet_count`
- `reaction.statistics.comment_count`
- `reaction.statistics.down_vote_count`
- `reaction.statistics.favorites`
- `reaction.statistics.interest_play_count`
- `reaction.statistics.like_count`
- `reaction.statistics.plaincontent_like_count`
- `reaction.statistics.plaincontent_vote_up_count`
- `reaction.statistics.play_count`
- `reaction.statistics.pv_count`
- `reaction.statistics.question_answer_count`
- `reaction.statistics.question_follower_count`
- `reaction.statistics.republishers`
- `reaction.statistics.share_count`
- `reaction.statistics.subscribe_count`
- `reaction.statistics.up_vote_count`
- `relationship`
- `relationship.upvoted_followees`
- `type`
- `updated_time`
- `url`