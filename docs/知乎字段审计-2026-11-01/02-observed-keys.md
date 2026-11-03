# 02 · 知乎实测字段清单（观察证据）

扫描日期：2026-11-01 · 全程只读（G:/gemini zhihu 未做任何修改）· 不含任何 Cookie/token/用户值

## 一、证据总量

| 组别 | 文件 | 性质 | 条数 |
|---|---|---|---|
| 1 | `data/plan-verify-b/articles-probe.json` | **真机实测**（知乎 `/api/v4/members/{username}/articles`，无 include，HTTP 200） | 2 条 item，各 21 个顶层 key |
| 2 | `data/plan-verify-b/articles-probe2.json` | **真机实测**（同接口带 `include`，HTTP 200） | 2 条 item，各 22 个顶层 key |
| 3 | `data/plan-verify-a/verify-metrics.json` | **真机实测**（phase2：articles/answers/favlists 有无字段结论） | 4 组测量 |
| 4 | `data/plan-verify-b/r2-proto/root-*.json`（抽样 5/500） | 合成原型数据（**非知乎返回**） | 15 个 key path |
| 5 | `data/plan-verify-b/harness/c1~c3.json` | 项目自造 camelCase 固件（**非知乎返回**） | 23 个 key path |
| 6 | `data/**/*.log`（16 个） | 无知乎原始响应字段（**not found**，详见下） | 0 |
| 7 | `data/schema.sql` + `data/app.db`（sqlite3 -readonly） | 项目自建 10 张表（**非知乎返回**） | 10 表 |

即：**知乎真实返回过的字段证据共 3 处**（probe、probe2、verify-metrics），全部指向真机请求；r2-proto 与 c1-c3 只是项目内部数据形状，不能当知乎证据。

## 二、articles 接口实测 key 清单（两次探测）

无 include（probe，21 个）：
`updated, force_login_when_click_read_more, copyright_permission, endorsements, excerpt, article_type, is_navigator, navigator_vote, id, vote_next_step, reaction, paid_info, author, url, comment_permission, title, created, content_need_truncated, image_url, excerpt_title, type`

带 include（probe2，22 个）：上述全部 **+ `content`**

嵌套实测：`items[].reaction.statistics = {like_count, favorites}`、`items[].reaction.relation`、`paging = {is_end, totals}`。

类型实测：`id`/`title` 为 string；`type` = "article"；`created`/`updated` 为**秒级**时间戳（1e9+ 量级）；`excerpt` 为 string（实测 len 157/120）。

## 三、两次探测差异（字段不稳定的直接证据）

- 仅 probe2 有：**`content`**（1 处，实测 len 14891 / 54835）
- 仅 probe1 有：无（0 处）
- 共有：21 个
- 补充结论：同一次探测内部各 item 的 keys 完全一致（两次都是 2 条 item 集合相同）→ 稳定性差异由**请求参数**（include）决定，而非随机抖动；不带 include 时 `content`、`voteup_count`、`comment_count` 都不会出现。

## 四、verify-metrics.json（plan-verify-a）的实测结论

- articles 无 include：有 `reaction`(statistics=[favorites,like_count])；**无** voteup_count / favorite_count / visit_count / thanks_count / comment_count
- articles 带 code include：有 `voteup_count`、`comment_count`；`created`/`updated` 为 number
- answers 带 include：有 `comment_count`；`question` 含 `visit_count`；**无** voteup_count/favorite_count/visit_count/thanks_count
- favlists：仅 5 个字段 `id, is_public, title, type, url`；**无** updated_time / item_count
- phase1 评论采样：`is_end=true`，roots=20，partial=true

## 五、日志与 R2 blob：not found

16 个 `*.log`（paging-verify、glm-verify-a/b、fix-verify、fix4-verify、plan-verify-a/b）grep 后均为同步脚本控制台输出 + wrangler 请求日志（`POST /ingest/content` ×1979 等）+ D1 内部 ZodError（harness/dev2.log，校验的是 D1 batch 而非知乎字段），**没有打印任何知乎响应体**。plan-verify-b 的 4 个 miniflare R2 blob 仅存原始 HTML（抽查为 "hello world 第一版" 测试文本）。

## 六、项目自建表（schema.sql ≡ app.db 实测，非知乎返回）

- `contents`: pk, source_type, source_id, source_url, title, author_name, author_url_token, author_avatar, author_headline, question_id, question_title, content_html, content_md, excerpt, voteup_count, comment_count, favorite_count, visit_count, is_collapsed, is_labeled, label_info, created_time, updated_time, content_hash, first_seen_at, last_seen_at, is_deleted, deleted_at
- `content_versions`: id, content_pk, version_hash, title, content_html, content_md, excerpt, voteup_count, comment_count, snapshot_at
- `comments`: id, content_pk, parent_comment_id, author_name, author_avatar, be_replied, content_md, img_url, time_text, location, likes, is_author, is_top, is_featured, comment_hash, first_seen_at, last_seen_at, is_deleted, deleted_at
- `comment_versions`: id, comment_id, content_pk, version_hash, content_md, img_url, likes, snapshot_at
- `collections`: id, title, owner_token, first_seen_at, last_seen_at, updated_time
- `collection_items`: id, collection_id, content_pk, source_type, source_id, title, author_name, source_url, first_seen_at, last_seen_at, is_removed, removed_at
- `collection_snapshots`: id, collection_id, snapshot_at, item_count, added_count, removed_count
- `sync_runs`: id, job_type, status, message, started_at, finished_at
- `change_events`: id, event_type, entity_type, entity_pk, content_pk, summary, payload_json, created_at
- `upvotes`: id, content_pk, first_seen_at, last_seen_at, upvote_time

app.db（361MB，sqlite3 -readonly 校验）与 schema.sql 一致；实测行数：contents=29689、content_versions=34642、comments=3610、comment_versions=4129、collections=13、collection_items=1091、collection_snapshots=164、change_events=85524、sync_runs=11、upvotes=28971。

## 七、证据可回指

- 真机探测脚本：`G:/gemini zhihu/data/plan-verify-b/fetch-articles.mjs`（注释明确"绝不打印 cookie"，只输出字段名/类型/时间戳量级，与 probe 文件内容互证）
- r2-proto 结构对应：`G:/gemini zhihu/data/plan-verify-b/proto-schema.sql`
- 输出明细（JSON）：`C:/Users/lixueshu/.zcode/workspace/draft-282a22d6-6c50-4cd4-b066-81fbd9865666/zhihu-fields/02-observed-keys.json`
