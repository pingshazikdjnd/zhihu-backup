# 14 · 真机实测：用户实体（members / followees / followers / me）

> 方法：`.fieldprobe/fetch.mjs`（Playwright 带 Cookie，真实浏览器上下文），2026-11-01。共 **6 个请求全部 200**，间隔 >3s，未触发 403/40353/40362。被测账号为项目既定账号（url_token `yang-xu-heng-94`，公开资料：1 男 / 湖北荆州 / 高等教育行业 / 长江大学）。原始响应留存 `tmp/out-14-{A,B,B2,C,D,E}.json`。
>
> 与 JSON 版 `14-live-members.json` 内容一致；本文补充类型表与逐项对照。

## 0. 请求清单

| # | id | 端点 | include | 状态 | 耗时 |
|---|---|---|---|---|---|
| 1 | A_member_noinc | `/api/v4/members/{token}` | 无 | 200 | 254ms |
| 2 | B_member_inc_datastar | 同 A | 36 项，**带 `data[*].` 前缀**（任务原文形式） | 200 | 339ms |
| 3 | B2_member_inc_plain | 同 A | 36 项，**裸字段名**（无前缀） | 200 | 244ms |
| 4 | C_followees_inc | `/members/{token}/followees?limit=2&offset=0` | `data[*].answer_count,articles_count,follower_count,headline,avatar_url,name,url_token,description` | 200 | 277ms |
| 5 | D_followers_noinc | `/members/{token}/followers?limit=2&offset=0` | 无 | 200 | 232ms |
| 6 | E_me | `/api/v4/me` | 无 | 200 | 298ms |

**键数**：A=26，B=B2=55，C 列表项=30，D 列表项=20，E(me)=46。

---

## 1. 用户对象字段全集（`/api/v4/members/{token}`）

### 1.1 默认返回（A，26 键）

| 字段 | 类型 | 实测值示例 |
|---|---|---|
| id | string | `744002f4…`（32 位 hash） |
| url_token | string | `yang-xu-heng-94` |
| name | string | 昵称 |
| use_default_avatar | boolean | false |
| avatar_url | string | `https://picx.zhimg.com/v2-…_xl.jpg` |
| avatar_url_template | string | 同上 `_l.jpg` 版 |
| is_org | boolean | false |
| type | string | `"people"` |
| url | string | `https://www.zhihu.com/api/v4/people/{token}` |
| user_type | string | `"people"` |
| headline | string | `""` |
| headline_render | string | `""` |
| gender ⚠️ | number | `1`（-1 未知 / 0 女 / 1 男，列表项实测见 -1） |
| is_advertiser | boolean | false |
| ip_info ⚠️ | string\|null | `"IP 属地湖北"`（**列表项恒 null**） |
| vip_info | object | 见 1.3 |
| kvip_info | object | `{is_vip:false}`（列表项多 `target_url`） |
| project_count | number | 0 |
| available_medals_count | number | 0 |
| org_verify_status | null | null |
| is_realname ⚠️ | boolean | true（实名状态） |
| has_applying_column | boolean | false |
| is_new_rename | boolean | false |
| has_agent_content | boolean | false |
| ai_assistant_info | null | null |
| extra | null | null |

⚠️ = 涉隐私（见 §4）。

**关键结论：默认 26 键中没有任何计数字段**——answer_count / articles_count / follower_count / following_count / voteup_count / thanked_count / favorited_count / question_count / pins_count / logs_count **全部不在**，必须 include。gender、ip_info、is_realname 是默认返回。

### 1.2 include 是否生效（对比 A / B / B2）

- **生效**：B（55 键）= A（26 键）+ 29 个新键；A 的键一个不少。
- **两种语法等价**：B（`data[*].` 前缀，任务原文形式）与 B2（裸字段名）返回键集**逐键一致**——单对象端点不强制 `data[*].` 前缀（与列表端点习惯不同）。
- **请求 36 项 → 顶层返回 31 项**（其中 8 项 headline/avatar_url/avatar_url_template/name/url_token/gender/user_type/is_org 本就是默认字段）。

| include 请求项 | 返回情况 |
|---|---|
| answer_count, articles_count, follower_count, following_count, voteup_count, thanked_count, favorited_count, question_count, pins_count, logs_count | ✅ 全部以 number 顶层键返回（按字段序：562/22/1209/102/36246/19277/18908/96/21/457） |
| headline, description, avatar_url, avatar_url_template, badge, name, url_token, gender, user_type, is_org | ✅ 返回（前 4 与 name/url_token/gender/user_type/is_org 本就默认；badge=[] 数组） |
| is_following, is_followed, is_blocking, is_blocked | ✅ boolean 返回（实测 false×4） |
| locations, business, employments, educations, cover_url, marked_answers_text, account_status | ✅ 返回（结构见 1.3） |
| **relationship** | ❌ 未返回 |
| **school / company / job** | ❌ 不是顶层键——是 `educations[].school`、`employments[].company/job` 的 include 别名（educations[0].school 实测返回；本账号 employments 为空数组） |
| **is_bind_phone** | ❌ 未返回（手机号相关对他人端点被抑制） |
| （未请求但赠送） | `badge_v2`、`follower_count_text/_num/_unit`、`following_count_num/_unit`（string 型展示文案） |

### 1.3 嵌套结构（实测）

- `vip_info`: `{is_vip:bool, vip_type:number, rename_days:string, entrance_v2:null, rename_frequency:number, rename_await_days:number}`
- `kvip_info`: `{is_vip:bool}`；**列表项**多 `target_url:string`
- `badge`: 数组（本账号空）；`badge_v2`: `{title:string, merged_badges:[], detail_badges:[], icon:string, night_icon:string}`
- topic 对象（locations[]/business/educations[].school/.major 共用）：`{id:string, type:"topic", url, name, avatar_url}`
- `locations`: topic 数组（实测：荆州）；`business`: topic\|null（实测：高等教育）；`employments`: 数组（本账号空，预期项含 company/job topic）
- `educations`: `{school:topic, major:topic}` 数组（实测：长江大学/电子信息工程）
- `account_status`: 数组（本账号空，账号处置状态类）

---

## 2. followees / followers 列表

### 2.1 paging（两接口同构）

```json
{ "is_end":false, "is_start":true,
  "next":"…limit=2&offset=2",     // 完整 URL，可直连
  "previous":"…limit=2&offset=0",
  "totals":102 }                   // followees=102（=following_count），followers=1209（=follower_count）
```

### 2.2 followees 列表项（带 include，30 键 = 条目并集，两条目键集一致）

默认面（与 D 相同的 20 键）＋ include 生效 3 项 ＋ 未请求也返回 4 项：

| 分组 | 字段 |
|---|---|
| 默认 20 | id, url_token, name, use_default_avatar, avatar_url, avatar_url_template, is_org, type, url, user_type, headline, headline_render, gender, is_advertiser, ip_info(null), vip_info, kvip_info(+target_url), available_medals_count, is_realname, has_applying_column |
| include 生效 | follower_count(number), follower_count_text/_num/_unit(string), answer_count(number), articles_count(number)（headline/avatar_url/name/url_token 本就默认） |
| 未请求赠送 | badge([]), badge_v2{}, **is_following(true)**, is_followed(false) |
| include 请求但未返回 | **description** ❌ |

### 2.3 followers 列表项（无 include，20 键）

即上表"默认 20"。**没有** badge/badge_v2/is_following/is_followed/任何计数字段——对比可知：badge、is_following/is_followed 在 followees 的出现与 include 是否存在相关（followers 无 include 即无），但不能排除是 followees 端点固有（未单测无 include 的 followees）。

列表项均无 project_count/org_verify_status/is_new_rename/has_agent_content/ai_assistant_info/extra（detail 才有）。

---

## 3. `/api/v4/me` vs `/members/{token}`

me 无 include（46 键）对比 member 无 include（26 键）：

**me 多（23）**：answer_count, question_count, articles_count, columns_count, zvideo_count, favorite_count, pins_count, voteup_count, thanked_count, line_comment_count, line_like_count, line_comment_only_count, uid(string, 数字型用户ID), default_notifications_count, follow_notifications_count, vote_thank_notifications_count, messages_count, creation_count, has_add_baike_summary_permission, editor_info(["bio"]), can_create_sub_account, account_type(number), sub_account_control_status(number)

**member 多（3）**：project_count, is_new_rename, has_agent_content

若与 **member 带 include（B，55 键）** 比：me 仍独有 17 键（上表 23 去掉 answer_count/question_count/articles_count/pins_count/voteup_count/thanked_count）；member 独有 26 键（description, badge, badge_v2, account_status, is_following/is_followed/is_blocking/is_blocked, follower_count(+text/num/unit), following_count(+num/unit), project_count, favorited_count, logs_count, marked_answers_text, business, locations, employments, educations, cover_url, is_new_rename, has_agent_content）。

**易混淆口径**：`favorite_count`（me 默认返回，=13，我的收藏夹数）≠ `favorited_count`（member include，=18908，内容被收藏数）。me 默认**没有** follower_count/following_count/favorited_count/logs_count。

---

## 4. 隐私字段（汇总备份时排除在备份表外）

| 字段 | 类别 | 实测下发 | 处置 |
|---|---|---|---|
| gender | 性别 | ✅ 默认（detail+列表） | 排除 |
| ip_info | 位置（IP 属地） | ✅ 默认（detail；列表恒 null） | 排除 |
| locations | 位置（所在地） | include | 排除 |
| business | 职业（行业） | include | 排除 |
| employments | 职业（含 company/job 子对象） | include（本账号空） | 排除 |
| educations | 教育（含 school/major 子对象） | include | 排除 |
| school / company / job | 教育/职业（include 别名，挂 educations/employments 下） | include | 排除（备份表只存顶层键时天然不落，仍显式标注） |
| is_bind_phone | 手机号 | ❌ include 请求了未下发 | 预防性排除 |
| email / phone_number | 邮箱/手机号 | ❌ 本轮全部响应未出现 | 预防性排除 |
| is_realname | 实名状态（超出任务六类清单，涉个人身份） | ✅ 默认（detail+列表） | 建议一并排除 |

---

## 5. 结论要点

1. **计数必须 include**：members/{token} 默认 0 个计数字段；36 项 include 后 55 键。`data[*].` 前缀与裸字段名两种语法单对象端点均可。
2. include 盲区：relationship、is_bind_phone 拿不到；description 在 followees 列表 include 中被忽略；school/company/job 是嵌套别名不是顶层键。
3. followees/followers 均为 `{data, paging}`，paging.totals 可直接当关注/粉丝总数用（与 include 计数一致）。
4. me 与 member 是两套字段面：备份"我的账号"用 me（含 uid/通知计数/editor_info），备份"任意用户"用 members+include（含粉丝/被收藏/职业教育资料）；两者交集不含 follower_count/following_count/favorited_count/logs_count。
5. 隐私排除清单 13 项（见 §4），其中实测下发的 7 类（gender/ip_info/locations/business/employments/educations/is_realname）为备份表必须排除项。
