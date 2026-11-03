# 15 实机字段探查：想法(pin) / 问题(question) / 点赞(votes)

日期：2026-11-01　请求器：`apps/collector/.fieldprobe/fetch.mjs`（登录态 Cookie）
实际发出 3 个 jobs（4 次 HTTP 尝试，其中 C 的页内回退多 1 次）；第 3 个请求命中 403，按规则立即停止，D/E 未发出。

## 请求与状态码

| # | id | 端点 | 状态 | 说明 |
|---|----|------|------|------|
| 1 | A_activities | `GET /api/v3/moments/yang-xu-heng-94/activities?limit=2&offset=0` | 200 | limit=2 被忽略，实返 7 条 |
| 2 | B_answer_detail | `GET /api/v4/answers/2099601120591090045` | 200 | 窗口内无 pin，用 answer 详情替代 |
| 3 | C_question_plain | `GET /api/v4/questions/1930419064976685049` | **403** | code 10003「请求参数异常，请升级客户端后重试」；页内回退同样 403 |
| 4 | D_question_include | 同 C + include=data[*].visit_count,... | 未发出 | 停止规则 |
| 5 | E_votes | `GET /api/v4/members/yang-xu-heng-94/votes?limit=2&offset=0` | 未发出 | 停止规则 |
| 6 | E_upvotes | `GET /api/v4/members/yang-xu-heng-94/upvotes?limit=2&offset=0` | 未发出 | 停止规则 |

**停止原因**：403/10003 直连与登录态页内 fetch 均复现，属签名类拦截（大概率缺 x-zse-96），非 40353/40362 封禁，但按「403 立即停止」执行。

## 1. A activities（200）

顶层仅 `data` + `paging`（7 条，`is_end:false`）。

- `data[]` 字段并集（9 键）：`id, type, target, verb, created_time, interaction, actor, action_text, is_sticky`
  - `type` 全为 `feed`；`verb` 全为 `MEMBER_VOTEUP_ANSWER`；`action_text`＝「赞同了回答」；`interaction`＝`{can_show_sticker}`；`is_sticky`＝false
  - `actor`（16 键）：`id, name, headline, type, user_type, url, url_token, avatar_url, gender, is_following, is_followed, is_org, badge, badge_v2, vip_info, kvip_info`
- `target.type` 取值分布：`answer × 7`（pin 0、article 0）
- `target.answer`（34 键）：`id, type, url, voteup_count, thanks_count, question, updated_time, created_time, author, comment_permission, is_copyable, comment_count, can_comment, content, excerpt, excerpt_new, preview_type, preview_text, relationship, reaction_instruction, relevant_info, reshipment_settings, answer_type, paid_info, attachment, is_navigator, navigator_vote, vote_next_step, mark_infos, content_need_truncated, force_login_when_click_read_more, segment_infos, allow_segment_interaction, endorsements`
  - 内嵌 `question`（16 键）：`id, title, url, type, question_type, created, answer_count, comment_count, follower_count, detail, excerpt, bound_topic_ids, relationship, is_following, author, reaction_instruction`（**无 visit_count / updated / topics**）
  - 内嵌 `relationship`：`voting, is_thanked, is_nothelp, upvoted_followee_ids`
- 翻页：`paging.next` 为 `...activities?offset=<最后一条 created_time(毫秒)>&page_num=1`，游标是时间戳而非数字偏移；`limit` 参数无效。

## 2. B 想法(pin)详情

- **没有 pin**：最新 7 条动态 target.type 全为 `answer`，也无 `article`，按预案改用 answer 详情，`pin_keys` 为空。
- `/api/v4/answers/{id}` 详情为精简形态，19 键：`allow_segment_interaction, answer_type, author, biz_ext, content_need_truncated, created_time, extras, force_login_when_click_read_more, id, is_collapsed, is_copyable, is_jump_native, podcast_audio_enter, question, relationship, segment_infos, type, updated_time, url`
- 对比：activities 内嵌 target.answer（34 键）比详情端点多了 `content/excerpt/voteup_count/thanks_count/comment_count/can_comment/comment_permission/relevant_info/endorsements` 等；详情端点独有 `biz_ext/extras/is_collapsed/is_jump_native/podcast_audio_enter`。抽取实体优先用 activities 内嵌 target。

## 3. C/D question 端点

- C 裸请求即 **403 / code 10003**，登录态页内 fetch 同样 403 → 该端点需要签名头（x-zse-96 之类），本次未能取得 question 直连字段集。
- D（include 生效性）未测试。
- 间接观察：activities 内嵌的 target.question 默认自带 `answer_count/comment_count/follower_count/detail/excerpt/bound_topic_ids/is_following/relationship`，但**没有 visit_count / updated / topics**；`visit_count` 与 include 扩展是否可取仍未知。

## 4. E 点赞/收藏端点

- votes 与 upvotes 均**未测试**（403 停止规则先触发），哪个可用、返回字段均未知。

## 5. 项目覆盖度

| 实体 | 端点 | 项目覆盖 | 本次实机 |
|------|------|----------|----------|
| activities | `GET /api/v3/moments/{url_token}/activities` | **covered**（项目现用） | 200，字段已录 |
| pins | `GET /api/v4/pins/{id}` | not covered | 未能测（窗口无 pin） |
| questions | `GET /api/v4/questions/{id}` | not covered | 403/10003，需签名方案 |
| votes | `GET /api/v4/members/{token}/votes` / `upvotes` | not covered | 未测（停止规则） |

## 结论与建议

1. activities 是唯一无签名可直连的用户动态源，且内嵌 answer（34 键）/question（16 键）字段最全，应作为主要数据入口。
2. questions 直连端点需签名（403/10003）；如需 question 扩展字段，短期可依赖 activities 内嵌 question，长期需引入 x-zse-96 签名或改走 question 页面 SSR 数据。
3. pin / votes 端点本次未获数据，留待后续低风险窗口补测。
