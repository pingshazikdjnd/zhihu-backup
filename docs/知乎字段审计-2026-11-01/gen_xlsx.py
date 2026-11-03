# -*- coding: utf-8 -*-
import json, os
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

DIR = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(DIR, "30-merged-fields.json"), encoding="utf-8"))
rows = data["rows"]

# ---- aggregate canonical entity/field table ----
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
    key = (r["entity"], r["field"])
    c = canon.setdefault(key, {"entity": r["entity"], "field": r["field"], "types": set(),
                               "contexts": set(), "inc": {}, "sources": set(), "notes": set()})
    if r["type"] and r["type"] != "—":
        c["types"].add(r["type"])
    c["contexts"].add(r["context"])
    b = _bucket(r["context"])
    prev = c["inc"].get(b)
    if (r["include"] == "是") or (prev != "是" and r["include"] == "否"):
        c["inc"][b] = r["include"]
    c["sources"].add(r["source"])
    if r["note"]:
        c["notes"].add(r["note"])

canon_rows = []
for (e, f), c in canon.items():
    inc = "；".join("%s%s" % (b, "★" if v == "是" else "") for b, v in sorted(c["inc"].items()))
    canon_rows.append({
        "实体": e, "字段": f, "类型": "/".join(sorted(c["types"])) or "—",
        "接口数": len(c["contexts"]), "需 include（语境★）": inc or "未验证",
        "出现接口": "；".join(sorted(c["contexts"])),
        "来源": "、".join(sorted(c["sources"])),
        "备注": "；".join(sorted(c["notes"]))[:300],
    })
canon_rows.sort(key=lambda x: (x["实体"], x["字段"]))

wb = Workbook()
HEAD = PatternFill("solid", fgColor="1F4E79")
HEAD_FONT = Font(color="FFFFFF", bold=True, size=10)
THIN = Border(*[Side(style="thin", color="D9D9D9")] * 4)


def style_sheet(ws, widths, freeze="A2"):
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    for c in ws[1]:
        c.fill = HEAD
        c.font = HEAD_FONT
        c.alignment = Alignment(vertical="center", horizontal="center")
    ws.freeze_panes = freeze
    ws.auto_filter.ref = ws.dimensions
    for row in ws.iter_rows(min_row=1):
        for c in row:
            c.border = THIN
            c.alignment = Alignment(vertical="top", wrap_text=False)


# Sheet1 canonical
ws = wb.active
ws.title = "字段总表"
cols = ["实体", "字段", "类型", "接口数", "需 include（语境★）", "出现接口", "来源", "备注"]
ws.append(cols)
for r in canon_rows:
    ws.append([r["实体"], r["字段"], r["类型"], r["接口数"], r["需 include（语境★）"], r["出现接口"], r["来源"], r["备注"]])
style_sheet(ws, [14, 42, 14, 8, 12, 46, 24, 46])

# Sheet2 stats
st = {}
for r in canon_rows:
    s = st.setdefault(r["实体"], {"fields": 0, "inc": 0})
    s["fields"] += 1
    if "★" in r["需 include（语境★）"]:
        s["inc"] += 1
ws2 = wb.create_sheet("按实体统计")
ws2.append(["实体", "去重字段数", "其中含 include 才返回", "说明"])
desc = {
    "answer": "回答（列表 38 键 / 详情 90 字段 / 收藏夹 / 动态 / 推荐流多套形态）",
    "comment": "评论（根评论与子评论，含 author.member 嵌套）",
    "article": "文章（列表 25 键 / 收藏夹形态 / 专栏详情 69 键）",
    "question": "问题（动态内嵌 16 键 + 热榜内嵌）",
    "member": "用户资料（无 include 26 键，带 include 55 键）",
    "followee": "关注的人列表项",
    "follower": "粉丝列表项",
    "favlist": "收藏夹列表项（仅 5 键）",
    "collection": "收藏夹详情",
    "collection_item": "收藏夹条目外层（仅 content/created）",
    "activity": "动态流 data[] 项（v3 activities）",
    "author": "作者卡片（各接口形态不一，61 键无完全重合）",
    "relationship": "关系对象（点赞/感谢状态）",
}
for e, s in sorted(st.items(), key=lambda x: -x[1]["fields"]):
    ws2.append([e, s["fields"], s["inc"], desc.get(e, "")])
ws2.append(["合计", sum(s["fields"] for s in st.values()), sum(s["inc"] for s in st.values()), "按实体去重后字段总数"])
style_sheet(ws2, [16, 14, 16, 70])

# Sheet3 detail
ws3 = wb.create_sheet("明细-按接口")
ws3.append(["实体", "接口/上下文", "字段路径", "类型", "需 include", "出现请求", "来源", "备注"])
for r in rows:
    ws3.append([r["entity"], r["context"], r["field"], r["type"], r["include"], r["seen"], r["source"], r["note"]])
style_sheet(ws3, [12, 44, 42, 14, 12, 22, 24, 40])

# Sheet4 external candidates
ext = json.load(open(os.path.join(DIR, "20-missing-audit.json"), encoding="utf-8"))
ws4 = wb.create_sheet("疑似遗漏-未实测")
ws4.append(["实体", "字段", "来源 URL", "是否实机验证", "说明"])
for c in ext.get("external_candidates", []):
    ws4.append([c.get("entity"), c.get("field"), c.get("source"), "否", c.get("note", "")])
style_sheet(ws4, [12, 34, 60, 14, 60])

# Sheet5 code wants but api missing
ws5 = wb.create_sheet("代码要但接口不给")
ws5.append(["字段/位置", "证据", "影响"])
for c in ext.get("code_wants_but_api_missing", []):
    ws5.append([c.get("field"), c.get("evidence", ""), c.get("impact", "")])
style_sheet(ws5, [40, 70, 70])

# Sheet6 verification
ver = json.load(open(os.path.join(DIR, "21-verification.json"), encoding="utf-8"))
ws6 = wb.create_sheet("抽样复测")
ws6.append(["#", "断言", "结果", "反例/证据"])
for a in ver.get("assertions", []):
    ws6.append([a.get("id"), a.get("claim"), a.get("result"), (a.get("counterexample") or a.get("evidence") or "")[:400]])
style_sheet(ws6, [6, 80, 12, 80])

# Sheet7 conflicts
cf = json.load(open(os.path.join(DIR, "22-conflicts.json"), encoding="utf-8"))
ws7 = wb.create_sheet("新旧审计对账")
ws7.append(["#", "议题", "旧审计说法", "真机结论", "判定"])
for c in cf.get("conflicts", []):
    ws7.append([c.get("id"), c.get("topic"),
                (c.get("old", {}) or {}).get("claim", ""),
                (c.get("new", {}) or {}).get("claim", ""),
                c.get("verdict", "")])
style_sheet(ws7, [6, 50, 60, 60, 18])

out = os.path.join(DIR, "知乎字段总表.xlsx")
wb.save(out)
print("xlsx:", out, "sheets:", wb.sheetnames, "canon rows:", len(canon_rows), "detail rows:", len(rows))
print("stats:", {e: s["fields"] for e, s in st.items()})
