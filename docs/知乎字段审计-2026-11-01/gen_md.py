# -*- coding: utf-8 -*-
import json, os
from collections import defaultdict

DIR = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(DIR, "30-merged-fields.json"), encoding="utf-8"))
rows = data["rows"]

import re as _re
def _bucket(ctx):
    if '详情' in ctx: return '详情'
    if 'paging' in ctx or '分页' in ctx: return '分页'
    if 'collections' in ctx or '收藏夹' in ctx: return '收藏夹'
    if 'activities' in ctx: return '动态'
    if 'topstory' in ctx or '热榜' in ctx or '推荐' in ctx: return '推荐流'
    if 'author' in ctx: return '作者'
    if '列表' in ctx or 'favlists' in ctx: return '列表'
    return '其他'

canon = {}
for r in rows:
    f = r["field"]
    if r["entity"] == "collection" and f.startswith("collection."):
        f = f[len("collection."):]
    c = canon.setdefault((r["entity"], f), {"types": set(), "ctx": set(), "inc": {}, "notes": set()})
    if r["type"] and r["type"] != "—":
        c["types"].add(r["type"])
    c["ctx"].add(r["context"])
    b = _bucket(r["context"])
    prev = c["inc"].get(b)
    if (r["include"] == "是") or (prev != "是" and r["include"] == "否"):
        c["inc"][b] = r["include"]
    if r["note"]:
        c["notes"].add(r["note"])

by = defaultdict(list)
for (e, f), c in canon.items():
    inc = "；".join("%s%s" % (b, "★" if v == "是" else ("" if v == "否" else "?")) for b, v in sorted(c["inc"].items()))
    by[e].append((f, "/".join(sorted(c["types"])) or "—", inc, len(c["ctx"])))
for e in by:
    by[e].sort()

order = ["answer", "article", "comment", "question", "member", "followee", "follower",
         "favlist", "collection", "collection_item", "activity", "author", "relationship"]
cn = {"answer": "回答", "article": "文章", "comment": "评论", "question": "问题", "member": "用户",
      "followee": "关注的人", "follower": "粉丝", "favlist": "收藏夹（列表项）", "collection": "收藏夹（详情）",
      "collection_item": "收藏夹条目（外层）", "activity": "动态", "author": "作者卡片", "relationship": "关系对象"}

lines = []
A = lines.append
A("# 知乎字段总表（真机实测 · 2026-11-01）\n")
A("> 数据来源：登录态真机请求 22 个端点（含 include 三组对照）+ 3 个免登录端点；共 %d 行明细、%d 个去重字段。\n" % (len(rows), sum(len(v) for v in by.values())))
A("> ★ 需 include = 不带 include 时该字段不返回。类型 \u201c—\u201d 表示子对象/结构体未逐一判型。\n")

A("## 一、实体总览\n")
A("| 实体 | 中文 | 去重字段数 | 含 include 才返回 | 覆盖接口数 |")
A("|---|---|---:|---:|---:|")
for e in order:
    if e not in by:
        continue
    inc = sum(1 for x in by[e] if "★" in x[2])
    ctx = len({r["context"] for r in rows if r["entity"] == e})
    A("| `%s` | %s | %d | %d | %d |" % (e, cn.get(e, e), len(by[e]), inc, ctx))
A("")

A("## 二、字段明细（按实体）\n")
for e in order:
    if e not in by:
        continue
    items = by[e]
    A("### %s `%s` — %d 字段\n" % (cn.get(e, e), e, len(items)))
    A("| 字段 | 类型 | 需 include（语境★） | 出现接口数 |")
    A("|---|---|:--:|---:|")
    for f, t, inc, n in items:
        mark = inc
        A("| `%s` | %s | %s | %d |" % (f, t, mark, n))
    A("")

# ---- key findings ----
A("## 三、关键结论\n")
A("### 1. 永远拿不到的字段（include 也无效）\n")
A("| 字段 | 接口 | 实测 |")
A("|---|---|---|")
for r in [
    ("`voteup_count` / `favorite_count` / `visit_count` / `thanks_count`", "回答列表", "proj/max 两轮 include 均被忽略，返回体里没有这些键"),
    ("`favorite_count`", "回答详情", "detail_inc 请求了 index 也没有，真实收藏数在 `reaction.statistics.favorites`"),
    ("`favorite_count` / `visit_count` / `thanks_count`", "文章列表与详情", "include 也拿不到；收藏数只能读 `reaction.statistics.favorites`"),
    ("`favorite_count` / `visit_count`", "收藏夹条目", "content 内没有，且该端点整体忽略 include"),
    ("`img_url` / `image_url` / `imageUrl`", "评论", "81 条字段路径里全都不存在（原始 JSON 全文 grep 无）"),
    ("`reply_to_comment_id`", "评论", "不存在；回复关系在 `reply_to_author.member.name` 等嵌套里"),
]:
    A("| %s | %s | %s |" % r)
A("")

A("### 2. 必须 include 才返回的字段\n")
for e in ["answer", "article", "member"]:
    if e in by:
        incs = [f for f, t, i, n in by[e] if "★" in i]
        A("- **%s**（%d 个）：%s" % (cn[e], len(incs), "、".join("`%s`" % x for x in incs[:40]) + ("…" if len(incs) > 40 else "")))
A("")

A("### 3. include 语法陷阱（实测）\n")
A("- 只有 **首项带 `data[*].` 前缀 + 逗号编码成 `%2C`** 才生效；")
A("- 如果写成“原始逗号 + 每项都重复 `data[*].` 前缀”，服务端会**整体静默忽略**整串 include（连 `comment_count`/`content` 都不返回），且不会报错。")
A("- `collections/{id}/items` 与评论接口**整体忽略 include**，请求了也不影响返回。")
A("- `collections/{id}/items` 使用 `limit=50` 会静默返回 `totals=0 / data=[]`，`limit=20` 正常；采集翻页建议 ≤20。\n")

A("### 4. 评论接口的真实字段名（与代码假设不同）\n")
A("| 代码/直觉 | 真实字段 | 说明 |")
A("|---|---|---|")
A("| `likes` / `like_count` | **`vote_count`** | 评论点赞数 |")
A("| `is_top` / `is_featured` | **`top` / `featured`** | 布尔键名无 is_ 前缀 |")
A("| `img_url` | **不存在** | 图片信息在 `attached_info`（不透明字符串） |")
A("| `author.name` | **`author.member.name`** | 评论 author 是 `{role, member{...}}` 两层 |")
A("")

A("### 5. 各接口形态差异（同一实体字段不通用）\n")
A("- **answer**：列表 38 键（带 include）/详情 90 字段/收藏夹 27 键/动态 target 34 键/推荐流 32 键 —— 5 套形态，`reaction.statistics` 只有详情是 17 键全量，列表只有 `{like_count, favorites}`。")
A("- **author**：11 个上下文里 61 个键无任何两组完全一致；`followers_count` vs `follower_count` 两种命名并存。")
A("- **article**：列表 25 键 / 收藏夹形态 14 键 / 专栏详情 69 键；时间字段列表用 `created/updated`，收藏夹也一样，而 answer 用 `created_time/updated_time`。")
A("- **question**：直连 `/api/v4/questions/{id}` 实测 403/10003（缺 x-zse-96 签名），只能从动态/热榜内嵌拿 16~31 字段。")
A("- **pin（想法）**：本次窗口未出现 pin 类型，`/api/v4/pins/{id}` 未验证成功；`votes`/`upvotes` 端点因 403 停止规则未测到。")
A("")

# ---- verification ----
ver = json.load(open(os.path.join(DIR, "21-verification.json"), encoding="utf-8"))
A("## 四、抽样复测（独立重打一遍）\n")
s = ver.get("summary", {})
A("结果：PASS %s / FAIL %s / PARTIAL %s / UNVERIFIED %s\n" % (s.get("pass", "?"), s.get("fail", "?"), s.get("partial", "?"), s.get("unverified", len(ver.get("unverified", [])))))
A("| # | 断言 | 结果 |")
A("|---|---|:--:|")
for a in ver.get("assertions", []):
    A("| %s | %s | **%s** |" % (a.get("id"), a.get("claim", "")[:110], a.get("result")))
A("")

# ---- conflicts ----
cf = json.load(open(os.path.join(DIR, "22-conflicts.json"), encoding="utf-8"))
A("## 五、与旧审计（FIELD_AUDIT.md, 2026-10-28）对账\n")
A("| # | 议题 | 判定 |")
A("|---|---|---|")
for c in cf.get("conflicts", []):
    A("| %s | %s | %s |" % (c.get("id"), c.get("topic", "")[:110], c.get("verdict")))
A("")
A("仍成立 %d 条，已过时 %d 条，新增发现 %d 条。\n" % (
    len(cf.get("still_valid_in_old", [])), len(cf.get("obsolete_in_old", [])), len(cf.get("new_findings_not_in_old", []))))

# ---- external candidates ----
ext = json.load(open(os.path.join(DIR, "20-missing-audit.json"), encoding="utf-8"))
A("## 六、疑似遗漏（外部资料提到、本次未实测）\n")
A("以下 %d 个字段来自公开资料（GitHub 客户端/博客），**本轮真机未观察到**，仅供参考，不要直接写进采集器。\n" % len(ext.get("external_candidates", [])))
A("| 实体 | 字段 | 来源 |")
A("|---|---|---|")
for c in ext.get("external_candidates", [])[:60]:
    A("| %s | `%s` | %s |" % (c.get("entity"), c.get("field"), c.get("source", "")))
A("")

A("## 七、代码要但接口不给（会影响备份）\n")
A("| 位置 | 证据 | 影响 |")
A("|---|---|---|")
for c in ext.get("code_wants_but_api_missing", [])[:30]:
    A("| `%s` | %s | %s |" % (c.get("field"), c.get("evidence", "")[:90], c.get("impact", "")[:90]))
A("")

md = "\n".join(lines)
open(os.path.join(DIR, "字段总表.md"), "w", encoding="utf-8").write(md)
print("md lines:", len(lines), "entities:", len(by))
