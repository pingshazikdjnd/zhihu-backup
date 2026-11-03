# 20 · 真机字段清单遗漏审计（20-missing-audit）

- 日期：2026-11-01　性质：**只读审计**，未改动 `G:/gemini zhihu` 与任何真机产物
- 输入：`10-live-answers` / `11-live-comments` / `12-live-articles` / `14-live-members` / `15-live-pins-questions` / `01-endpoints-include`（代码 include 原文） / `03-open-endpoints`（hot-list question、recommend answer 103 路径）
- 方法：以各真机 JSON 的 item_keys / fields 路径并集为准，跨接口求差；外部候选全部给出处 URL 且 `verified_live=false`；无证据的猜测一律不写
- 机器可读版：`20-missing-audit.json`（本文件为表格摘要）

---

## 1. 实体间互补检查（各接口字段并集 + 仅单一接口出现的字段）

### 1.1 answer（4 个实测上下文，并集 54 键）

| 上下文 | 键数 | 仅此处有（only_in_one） |
|---|---|---|
| answers 列表（members/{u}/answers，basic∪proj∪max） | 38 | admin_closed_comment, annotation_action, collapse_reason, collapsed_by, is_normal, review_info, reward_info, same_video_answers, suggest_edit, thumbnail |
| answer 详情（/answers/{id}，detail_inc∪detail_basic∪15B） | 24 | is_jump_native, podcast_audio_enter, visit_count |
| activities 的 target.answer（v3 动态流） | 34 | attachment, paid_info, reaction_instruction, relevant_info |
| recommend 的 target（api.zhihu.com/topstory/recommend，103 路径） | 28 | favorite_count, visited_count |

要点：**没有任何一个接口能单独拿到全部 54 键**。最关键的互补对：`voteup_count/thanks_count` 只在详情与 activities target 有（列表 include 也要不到）；`visit_count` 只在详情；`visited_count`（注意拼写）只在推荐流；`favorite_count` 顶层只在推荐流；评论/折叠/审核类键只在列表 include。`content` 只在列表（include）与 activities target，**answer 详情端点反而不带 content**。

### 1.2 comment（根评论 R / 子评论 B，并集 31 键）

| 上下文 | 键数 | 仅此处有 |
|---|---|---|
| root_comments（答案根评论） | 29 | allow_vote, censor_status, child_comment_count, child_comments, collapsed, disliked, featured, reviewing |
| child_comments（楼中楼） | 23 | extra_info, replies_count |

与 11 号报告结论一致：根/子各有独占键，拿全评论必须两个接口都调。

### 1.3 article（列表 / zhuanlan 详情，并集 70 键）

| 上下文 | 键数 | 仅此处有 |
|---|---|---|
| articles 列表（members/{u}/articles，A∪B∪C） | 25 | paid_info（恒 `{}`） |
| zhuanlan 详情（zhuanlan.zhihu.com/api/articles/{id}） | 69 | 45 键（state, status, topics, column, favlists_count, tipjarors_count, settings, share_text, ip_info, image_width/height, is_favorited, liked_count, republishers, upvoted_followees, voting …完整清单见 JSON） |

要点：`topics/column` 写进列表 include 也被忽略、只有详情给；`favorite_count` 两侧顶层都没有（靠 `statistics.favorites`/详情 `favlists_count`）；`visit_count/thanks_count` 两侧皆无（见 §4）。

### 1.4 member（6 个实测上下文，并集 72 键）

| 上下文 | 键数 | 仅此处有（节选） |
|---|---|---|
| member 详情（/members/{token}，无 include∪36 项 include） | 55 | account_status, business, cover_url, description, educations, employments, favorited_count, following_count(+num/unit), is_blocking, is_blocked, locations, logs_count, marked_answers_text, project_count, has_agent_content, is_new_rename |
| me（/api/v4/me） | 46 | uid, columns_count, zvideo_count, favorite_count(收藏夹数), line_comment_count, line_like_count, line_comment_only_count, creation_count, editor_info, 4 个通知计数, account_type, can_create_sub_account, sub_account_control_status |
| followees 列表（带 include） | 30 | （相对集）follower_count(+text/num/unit), answer_count, articles_count, badge, badge_v2, is_following, is_followed |
| followers 列表（无 include） | 20 | —（最薄面） |
| activities actor | 16 | —（精简卡片） |
| comment author.member | 16 | role 在包装层；member 内含 vip_info 但无 badge_v2 |

要点：me 的 `uid/columns_count/zvideo_count/favorite_count/通知计数/editor_info` 只能走 me；`follower_count/following_count/favorited_count/logs_count` 只能走 member+include；两者互不覆盖。

### 1.5 question（5 个实测上下文，并集 18 键）

| 上下文 | 键数 | 仅此处有 |
|---|---|---|
| answers 列表内嵌 question | 9 | visit_count |
| answer 详情内嵌 question | 8 | — |
| activities 内嵌 question（16 键） | 16 | reaction_instruction |
| hot-list 的 target（question） | 12 | — |
| recommend 内嵌 question | 15 | — |

要点：`answer_count/comment_count/follower_count` 只在 feed 三处；`visit_count` 只在 answers 列表 include；`updated_time` 只在 answers 两处（**activities 的 question 无更新时间**）；`detail/excerpt` 只在 feed 三处。

### 1.6 feed 项（activities / hot-list / recommend 外层，并集 21 键）

| 上下文 | 键数 | 仅此处有 |
|---|---|---|
| activities data[] | 9 | action_text, actor, interaction, is_sticky |
| hot-list data[] | 11 | card_id, card_label, children, debut, detail_text, style_type, trend |
| recommend data[] | 10 | action_card, brief, offset, updated_time |

---

## 2. 嵌套对象跨接口一致性

| 对象 | 不一致结论 |
|---|---|
| author / member | 11 个上下文 61 键并集，**无两个上下文完全一致**。① `is_privacy` 仅 answer 详情 author；② 推荐流用 `followers_count`、member 系用 `follower_count`（同义不同名）；③ `vip_info/kvip_info` 只在评论 member、activities actor、member 端点与 `collections/items` 的 answer/article author 出现，**10/12 的 answers/article 列表 author 不带 vip**（`13-live-collections` 已实测收藏夹条目 `answer.author.vip_info` 存在）；④ `badge_v2` 在 answers/article author、activities actor、member 有，评论 member 只有 badge 无 badge_v2，hot-list author 8 键最简（无 gender/badge/vip）；⑤ `ip_info` 仅 member 端点（detail 为 string，列表恒 null）；⑥ 评论 author 是唯一 `{role, member}` 两层包装；⑦ `uid/description/exposed_medal` 仅 zhuanlan 详情 author；⑧ badge 元素形状仅 recommend question.author 实证 `{description,type}`，其余端点恒空数组；⑨ 列表 kvip_info 多 `target_url`，member_detail 没有 |
| question | 见 §1.5 要点：计数键、visit_count、updated_time、detail/excerpt、relationship 三种形状（answer_detail 恒空 / activities 4 键 / recommend is_author）全都不一致 |
| reaction | 列表与推荐流恒 2+2 键（statistics{like_count,favorites}+relation{faved,liked}）；全量仅详情（answer 17 键 / article 18 键 statistics、10 键 relation、image_reactions）；浏览量命名分叉：recommend 用 `visited_count`，其他用 `visit_count` |
| paging | 标准 v4 5 键；**child_comments 无 is_start**；v3 activities 仅 `{is_end,need_force_login,next}`（无 previous/totals，游标是时间戳+page_num） |
| badge / badge_v2 | badge_v2 内层 `{title,merged_badges,detail_badges,icon,night_icon}` 在 answers author 与 member detail 一致；评论 member、recommend author 无 badge_v2 |
| topic | member 内嵌 `{id,type:"topic",url,name,avatar_url}`；zhuanlan 详情 `{id,name,url}`；feed 三处只用 `bound_topic_ids`（纯 number 数组） |

---

## 3. 外部资料补漏（全部 `verified_live=false`，真机未出现过）

| 实体 | 字段 | 来源 | 备注 |
|---|---|---|---|
| member | following_topic_count / following_question_count / following_favlists_count / following_columns_count | [yifei.me 知乎 API v4 整理](https://yifei.me/note/460) | 关注类计数，36 项 include 未请求过 |
| member | avatar_hue / commercial_question_count / included_answers_count / included_articles_count | 同上 | |
| member | marked_answers_count / mutual_followees_count | [maxuewei2/zhihu-crawler 分析知乎API.md](https://github.com/maxuewei2/zhihu-crawler/blob/master/%E5%88%86%E6%9E%90%E7%9F%A5%E4%B9%8EAPI.md) | `_text` 版已实测，`_count` 版未实测 |
| member | vote_to_count / vote_from_count / thank_to_count / thank_from_count | [maxuewei2](https://github.com/maxuewei2/zhihu-crawler/blob/master/%E5%88%86%E6%9E%90%E7%9F%A5%E4%B9%8EAPI.md) + [yifei.me](https://yifei.me/note/460) | 投出/收到的赞与感谢 |
| member | hosted_live_count / participated_live_count / allow_message / message_thread_token | 同上 | Live/私信类 |
| member | is_active, is_force_renamed, is_bind_sina, is_privacy_protected, sina_weibo_url, sina_weibo_name, show_sina_weibo, is_org_createpin_white_user, industry_category, org_name, org_homepage | [yifei.me](https://yifei.me/note/460) | 隐私/组织类，按 14 号报告策略不建议进备份 |
| answer | is_sticky / editable_content / collapsed_counts / reviewing_comments_count | [yifei.me](https://yifei.me/note/460) + [RSSHub zhihu/question.ts](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/zhihu/question.ts) | 公开 include 原文里都有，真机 answers 端点未请求过 |
| answer | paid_info_content / settings.table_of_content.enabled / mark_infos[].url | [RSSHub zhihu/question.ts](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/zhihu/question.ts) | mark_infos 真机恒空数组，元素未验证 |
| answer | hermes_label | [YaoZeyuan/ZhihuHelp_archived #89](https://github.com/YaoZeyuan/ZhihuHelp_archived/issues/89) | 话题精华 include |
| answer | author.follower_count | [RSSHub zhihu/question.ts](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/zhihu/question.ts) | 真机回答 author 不带粉丝数；`author.vip_info` 已在 `13-live-collections` 的收藏夹 answer.author 实测观测到，不再列为遗漏 |
| article | hermes_label / annotation_detail | [YaoZeyuan #89](https://github.com/YaoZeyuan/ZhihuHelp_archived/issues/89) | 真机文章只有 annotation_action |
| article | upvoted_followees / voting（列表 include 项） | [phiedulxp notebook include 原文](https://notebook.community/phiedulxp/quora-mining/notebook/zhihu-api) | 详情端点倒是有，列表未请求 |
| question | topics（对象数组，非仅 bound_topic_ids）/ collapsed_answer_count / status / can_comment / thumbnail_info | [zly2006/zhihu-plus-plus Question 模型](https://github.com/zly2006/zhihu-plus-plus/commit/7a5285311300aa75aa3605bb3ceb5386a44f807c) | 直连 /questions/{id} 403，未能验证 |
| pin | content（块数组 text/image/video/link，video 含 playlist）/ created+updated / excerpt_title / origin_pin（转发原文）/ tags | [RSSHub zhihu/pin/utils.ts](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/zhihu/pin/utils.ts) + [people.ts](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/zhihu/pin/people.ts) | pin 实体真机零样本 |
| pin | 端点：`api.zhihu.com/pins/{token}/moments`、`/api/v4/pins/{id}` | [RSSHub](https://github.com/DIYgod/RSSHub/blob/master/lib/routes/zhihu/pin/people.ts) + [RSSHub Discussion #18136](https://github.com/DIYgod/RSSHub/discussions/18136) | |
| comment | （无外部候选） | [yifei.me 评论字段表](https://yifei.me/note/460) | 文档字段集 ⊆ 真机 31 键 |

> **favlist 已补测（`13-live-collections`）**：`members/{u}/favlists` 列表项 5 键（id/title/type/is_public/url）；`collections/{id}` 详情 18 键（含 `answer_count`/`follower_count`/`creator`，**`creator` 仅详情存在**）；`collections/{id}/items` 外层 2 键（content/created），content 分 answer 27 键 / article 14 键。`is_public` 在列表项即实测存在。旧“收藏夹实体真机零样本”表述作废。

注：yifei.me 还记载旧版评论端点 `/api/v4/{answers|articles|questions}/ID/comments`（与 root_comments 不同路径）与移动端 `api.zhihu.com` 前缀，属端点级信息不是字段。[RSSHub Discussion #18136](https://github.com/DIYgod/RSSHub/discussions/18136) 另给出免 Cookie 的 `api.zhihu.com/appview/api/v4/{answers,questions}/{id}` 备选路径，可作 question 403 的候选绕行方案（未实测）。

---

## 4. 代码要但接口不给（代码假设 vs 真机事实）

| # | 字段 | 证据 | 影响 |
|---|---|---|---|
| 1 | answers_list.voteup_count | sync.ts:98/main.ts:318 读取；10 号报告 proj/max include 请求仍未返回 | 列表赞同数恒 undefined；只能逐条 detail（实测可返回）或 activities target |
| 2 | answers_list.favorite_count | sync.ts:99；include 未返回；真实值在 reaction.statistics.favorites | 字段名恒缺；sync.ts:363 的 thanks_count 兜底实为感谢数（口径错误） |
| 3 | answers_list.visit_count | sync.ts:100、main.ts:1473 直读；include 未返回 | 列表层浏览量拿不到；main.ts:1473 恒 0 |
| 4 | answers_list.thanks_count | max include 未返回；仅 detail include 有 | 感谢数需逐条 detail |
| 5 | answers_list.label_info / annotation_detail | include 请求未返回 | 标注信息备份缺 |
| 6 | answers_list.{voting,is_author,is_thanked,is_nothelp,is_recognized}（顶层） | include 未返回；实测位置在 relationship.* | 顶层读取恒 undefined |
| 7 | answers_list.author.badge[].topics | include 请求未返回；badge 恒空数组 | 优秀回答者徽章无法备份 |
| 8 | reaction.statistics.upvote_count | 多处读取该拼写；真机所有端点只有 up_vote_count（详情） | 赞同数兜底死代码（拼写错） |
| 9 | reaction.statistics.favorite_count | 真机 5 个 statistics 上下文均无此键，真实键为 favorites | 收藏数兜底死代码 |
| 10 | reaction.statistics.visit_count | 真机所有 statistics（含文章详情 18 键）均无 | 浏览量兜底全失效 |
| 11 | answer_detail.favorite_count | detail_inc include 请求未返回；zhuanlan 顶层也无 | 只能走 /answers/{id}/favlists 的 paging.totals（未实测）或 statistics.favorites |
| 12 | articles_list.visit_count | 12 号报告：include 忽略、详情无、statistics 无 | **文章浏览量任何端点都拿不到** |
| 13 | articles_list.thanks_count | 列表 include 忽略；详情只有 tipjarors_count | 文章感谢数无法备份 |
| 14 | articles_list.{is_collapsed,label_info} | main.ts:1661-1662 读取；列表 25 键无 | 恒 undefined |
| 15 | article_detail_zhuanlan.{favorite_count,thanks_count,visit_count} | contents.ts:65-68 读取；实际键为 favlists_count/tipjarors_count | sync-live 统计回写三字段恒 undefined |
| 16 | activities.target.{favorite_count,visit_count} | sync.ts:479-480 读取；target 34 键无 | v3 动态流统计恒 undefined |
| 17 | activities.target.reaction.* | target 无 reaction 对象（仅 reaction_instruction） | 兜底链第二级失效 |
| 18 | activities.target.{is_collapsed,is_labeled,label_info} | sync.ts:481-483 读取；target 34 键无 | 动态流折叠/标注状态缺失 |
| 19 | comments.reply_to_comment_id | sync.ts:188、main.ts:430、contents.ts:148 读取；**11 号报告 81 条观测路径（根+子）无此键** | 楼中楼回复定位只能靠 reply_to_author.member.name |
| 20 | comments.reaction.statistics.like_count | 评论对象无 reaction 对象 | 兜底死代码（vote_count 正常） |
| 21 | comments.{img,imageUrl,image_url} | main.ts:224 三处传入；11 号报告 grep 三键均不存在，attached_info 是不透明串 | **评论图片备份恒空输出** |

---

## 5. 判定

### 5.1 各实体"已实测 / 疑似遗漏"

| 实体 | 已实测字段数（跨接口并集） | 疑似遗漏数 | 说明 |
|---|---|---|---|
| answer | 54 | 9 | 外部候选 9（is_sticky、editable_content、collapsed_counts、reviewing_comments_count、paid_info_content、mark_infos[].url、settings.table_of_content.enabled、hermes_label、author.follower_count）；`author.vip_info` 已在 13-live-collections 实测，移除 |
| comment | 31 | 2 | 代码要但接口不给 2（reply_to_comment_id、img*），外部候选 0 |
| article | 70 | 5 | 外部候选 3 + 代码缺口 2 组（visit_count/thanks_count、zhuanlan 三统计键） |
| member | 72 | 18 | 外部候选 18（计数/资料类）；另有 11 个隐私/组织类候选按 14 号策略不计入 |
| question | 18 | 5 | 外部候选 5（topics、collapsed_answer_count、status、can_comment、thumbnail_info）；直连端点 403 未验证 |
| pin | **0** | 6+ | 实体零样本；外部候选 6 + 端点 2 条 |
| favlist | **18** | 0 | 13-live-collections 已实测：favlists 列表项 5 键 + collections/{id} 详情 18 键（creator 仅详情存在）；collections/{id}/items 亦已实测 |
| feed/动态项 | 21 | 3 | 代码缺口 3 组（target 统计、reaction、折叠状态） |

零实测端点：`/api/v4/questions/{id}`（403/10003 需签名）、`/api/v4/pins/*`、`/api/v4/members/{u}/votes|upvotes`、`/api/v4/answers/{id}/favlists`、`/api/v4/articles/{id}/root_comments`（404，文章评论真实端点未知）。`/api/v4/members/{u}/favlists` 与 `/api/v4/collections/{id}/items` 已在 `13-live-collections` 实测，移出零实测清单。

### 5.2 最可能导致备份数据缺失的 Top 5

1. **answers 列表四统计键**（voteup_count / visit_count / favorite_count / thanks_count）include 也拿不到——列表统计全靠逐条 detail 补齐，任何跳过该步骤的同步都会让赞同/浏览/收藏/感谢归零。
2. **comments.reply_to_comment_id 与 comments.img***：三处代码在读、真机 81 条路径不存在——楼中楼回复关系退化为仅名字、评论图片备份恒空。
3. **article 的 visit_count/thanks_count**：列表与 zhuanlan 详情都不存在——文章浏览/感谢数无法备份；favorite_count 只能走 statistics.favorites/favlists_count，代码读的顶层键全部落空。
4. **reaction.statistics 三个伪键兜底**（upvote_count/favorite_count/visit_count）：任何真机响应中都不存在，所有 fallback 死代码；推荐流还把浏览量改名为 visited_count，跨源聚合时口径会错。
5. **pin / votes / question 直连三端点零实测**（403 需签名或未测）——这些实体的备份字段集仍未知；favlists 与 collections/{id}/items 已在 13-live-collections 实测（列表项 5 键、详情 18 键、条目外层 content/created）；question 目前只能靠 activities 内嵌 16 键面（无 updated_time/visit_count/topics）。
