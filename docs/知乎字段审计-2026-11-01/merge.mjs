// Merge all field-audit outputs into one normalized table.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// 以脚本自身所在目录为基准，仓库内可直接复现运行
const DIR = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(fs.readFileSync(`${DIR}/${f}`, "utf8"));
// "ABSENT"/"ABSENT（...）" 表示该字段在该接口不存在，不能当成已观测字段写入总表
const isAbsent = (v) => typeof v === "string" && v.trim().toUpperCase().startsWith("ABSENT");

const rows = [];
const add = (o) => rows.push({
  entity: o.entity,
  context: o.context,
  field: o.field,
  type: o.type || "",
  include: o.include === true ? "是" : o.include === false ? "否" : "未验证",
  seen: Array.isArray(o.seen) ? o.seen.join("/") : (o.seen || ""),
  source: o.source,
  note: o.note || "",
});

// ---------- 10 answers ----------
{
  const j = read("10-live-answers.json");
  const suffix = (p) => p.replace(/^data\[\]\.?/, "");
  for (const f of j.fields) {
    const isList = f.path.startsWith("data[].");
    add({
      entity: "answer",
      context: isList ? "GET /api/v4/members/{u}/answers（列表）" : "GET /api/v4/answers/{id}（详情）",
      field: suffix(f.path),
      type: f.type,
      include: f.include_required,
      seen: f.seen_in,
      source: "10-live-answers",
      note: [f.note, f.always_empty ? "恒空数组" : "", f.str_len ? `str_len ${f.str_len}` : ""].filter(Boolean).join("；"),
    });
  }
}

// ---------- 11 comments ----------
{
  const j = read("11-live-comments.json");
  for (const f of j.fields) {
    add({
      entity: "comment",
      context: "GET /api/v4/answers/{id}/root_comments ・ /comments/{id}/child_comments",
      field: f.path,
      type: f.type,
      include: false,
      seen: f.seen_in,
      source: "11-live-comments",
      note: [f.note, "评论接口忽略 include"].filter(Boolean).join("；"),
    });
  }
  for (const p of j.paging_keys) add({ entity: "comment", context: "评论 paging", field: `paging.${p}`, type: "—", include: false, source: "11-live-comments" });
  for (const a of j.author_keys) add({ entity: "comment", context: "评论 author 对象", field: `author.${a}`, type: "—", include: false, source: "11-live-comments" });
}

// ---------- 12 articles ----------
{
  const j = read("12-live-articles.json");
  for (const f of j.fields) {
    add({
      entity: "article",
      context: "GET /api/v4/members/{u}/articles（列表）",
      field: f.path.replace(/^data\[\]\.?/, ""),
      type: f.type,
      include: f.include_required,
      seen: f.seen_in,
      source: "12-live-articles",
      note: f.note || "",
    });
  }
  for (const p of j.paging_fields) {
    // observed === false 表示该键在响应里根本没有出现（如文章 paging.is_end）
    if (p.observed === false) continue;
    add({ entity: "article", context: "文章 paging", field: p.path, type: p.type, include: false, source: "12-live-articles", note: "" });
  }
}

// ---------- 13 collections ----------
{
  const j = read("13-live-collections.json");
  const groups = [
    ["favlist_item", "favlist", "GET /api/v4/members/{u}/favlists（列表项）"],
    ["favlists_paging", "favlist", "GET /api/v4/members/{u}/favlists（paging）"],
    ["outer_item", "collection_item", "GET /api/v4/collections/{id}/items（外层）"],
    ["items_paging", "collection_item", "GET /api/v4/collections/{id}/items（paging）"],
    ["content.answer", "answer", "GET /api/v4/collections/{id}/items（content.answer）"],
    ["content.article", "article", "GET /api/v4/collections/{id}/items（content.article）"],
    ["collection_detail_E", "collection", "GET /api/v4/collections/{id}（详情）"],
  ];
  const parse = (v) => {
    if (typeof v !== "string") return { type: "", note: String(v).slice(0, 120) };
    const m = v.match(/^([A-Za-z0-9_\- |]+?)\s*(?:\((.*)\))?$/);
    if (!m) return { type: v.slice(0, 40), note: "" };
    return { type: m[1].trim(), note: (m[2] || "").slice(0, 120) };
  };
  for (const [key, entity, context] of groups) {
    const obj = j.fields[key];
    if (!obj || typeof obj !== "object") continue;
    for (const [k, v] of Object.entries(obj)) {
      if (k === "wrapper") continue;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v)) {
          if (isAbsent(v2)) continue;
          const p = parse(v2);
          add({ entity, context, field: `${k}.${k2}`, type: p.type, include: false, source: "13-live-collections", note: p.note });
        }
      } else {
        // ABSENT（include 请求也不下发）是"已确认不存在"，不是观测到的字段
        if (isAbsent(v)) continue;
        const p = parse(v);
        add({ entity, context, field: k, type: p.type, include: false, source: "13-live-collections", note: p.note });
      }
    }
  }
}

// ---------- 14 members ----------
{
  const j = read("14-live-members.json");
  const base = new Set(j.member_keys);
  const all = new Set([...j.member_keys, ...j.member_keys_with_include]);
  for (const k of all) {
    add({ entity: "member", context: "GET /api/v4/members/{token}", field: k, type: "—", include: !base.has(k), seen: base.has(k) ? "无 include 与 include 均返回" : "仅 include 后返回", source: "14-live-members" });
  }
  for (const k of j.followee_keys) add({ entity: "followee", context: "GET /api/v4/members/{u}/followees", field: k, type: "—", include: "未验证", source: "14-live-members" });
  for (const k of j.follower_keys) add({ entity: "follower", context: "GET /api/v4/members/{u}/followers", field: k, type: "—", include: "未验证", source: "14-live-members" });
  for (const k of j.me_vs_member_diff?.only_me || []) add({ entity: "member", context: "GET /api/v4/me（仅 me 有）", field: k, type: "—", include: "未验证", source: "14-live-members" });
}

// ---------- 15 activities ----------
{
  const j = read("15-live-pins-questions.json");
  for (const k of j.activity_keys) add({ entity: "activity", context: "GET /api/v3/moments/{u}/activities", field: k, type: "—", include: false, source: "15-live-pins-questions" });
  for (const k of j.activity_subobject_keys?.actor || []) add({ entity: "author", context: "activities.actor", field: k, type: "—", include: false, source: "15-live-pins-questions" });
  for (const k of j.target_keys_by_type?.answer || []) add({ entity: "answer", context: "activities.target（answer）", field: k, type: "—", include: false, source: "15-live-pins-questions" });
  for (const k of j.target_keys_by_type?.["answer.question"] || []) add({ entity: "question", context: "activities.target.question", field: k, type: "—", include: false, source: "15-live-pins-questions" });
  for (const k of j.target_keys_by_type?.["answer.author"] || []) add({ entity: "author", context: "activities.target.author", field: k, type: "—", include: false, source: "15-live-pins-questions" });
  for (const k of j.target_keys_by_type?.["answer.relationship"] || []) add({ entity: "relationship", context: "activities.target.relationship", field: k, type: "—", include: false, source: "15-live-pins-questions" });
  for (const k of j.answer_detail_keys || []) add({ entity: "answer", context: "answers/{id} 精简形态（经 activities 取样）", field: k, type: "—", include: false, source: "15-live-pins-questions" });
}

// ---------- 03 open endpoints ----------
{
  const j = read("03-open-endpoints.json");
  for (const e of j.endpoints) {
    if (e.status !== 200 || !e.field_tree) continue;
    const ctx = `GET ${new URL(e.url).host}${new URL(e.url).pathname}`;
    // 热榜的 data[].target 是 question 实体（不是 answer）：
    // 若按 answer 归类会把 title/created/answer_count/follower_count 等错挂 38 行。
    const isHotList = /\/topstory\/hot-lists?(?:\/|$)/.test(new URL(e.url).pathname);
    for (const [path, type] of Object.entries(e.field_tree)) {
      if (isHotList && path.includes(".target.") && !path.includes(".card_label")) {
        add({ entity: "question", context: `${ctx}（热榜 target=question）`, field: path.split(".target.")[1], type: String(type), include: false, source: "03-open-endpoints" });
      } else if (path.includes(".target.question.")) {
        add({ entity: "question", context: `${ctx}（target.question）`, field: path.split(".target.question.")[1], type: String(type), include: false, source: "03-open-endpoints" });
      } else if (path.includes(".target.") && !path.includes(".card_label")) {
        add({ entity: "answer", context: `${ctx}（target）`, field: path.split(".target.")[1], type: String(type), include: false, source: "03-open-endpoints" });
      }
    }
  }
}

// normalize collection.* prefix
for (const r of rows) {
  if (r.entity === "collection" && r.field.startsWith("collection.")) r.field = r.field.slice("collection.".length);
}

// ---------- dedupe ----------
const seen = new Set();
const merged = rows.filter((r) => {
  const k = `${r.entity}|${r.context}|${r.field}|${r.type}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

// ---------- stats ----------
const byEntity = {};
for (const r of merged) {
  const e = (byEntity[r.entity] ||= { fields: new Set(), contexts: new Set(), includeCount: 0 });
  e.fields.add(r.field);
  e.contexts.add(r.context);
  if (r.include === "是") e.includeCount++;
}
const stats = Object.entries(byEntity).map(([entity, v]) => ({
  entity,
  unique_fields: v.fields.size,
  rows: merged.filter((r) => r.entity === entity).length,
  contexts: v.contexts.size,
  include_required_rows: v.includeCount,
}));

fs.writeFileSync(`${DIR}/30-merged-fields.json`, JSON.stringify({ generated: new Date().toISOString(), rows: merged, stats }, null, 2));

// CSV
const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
const header = ["实体", "接口/上下文", "字段路径", "类型", "需 include", "出现请求", "来源", "备注"];
const csv = [header.map(esc).join(","), ...merged.map((r) => [r.entity, r.context, r.field, r.type, r.include, r.seen, r.source, r.note].map(esc).join(","))].join("\n");
fs.writeFileSync(`${DIR}/字段总表.csv`, "\uFEFF" + csv);

console.log("rows:", merged.length, "entities:", stats.length);
console.log(stats.map((s) => `${s.entity}:${s.unique_fields}`).join("  "));
