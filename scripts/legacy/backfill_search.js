// 回填 content_md：从 content_html 生成纯文本，使正文搜索对已有数据生效
// 用法: node backfill_search.js          -> 干跑，只统计不写入
//       node backfill_search.js --apply  -> 实际写入
// 可选: node backfill_search.js --apply --db=./data/app.db
const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const APPLY = process.argv.includes("--apply");
const dbArg = process.argv.find(a => a.startsWith("--db="));
const dbPath = path.resolve(__dirname, dbArg ? dbArg.slice(5) : "./data/app.db");
const LIMIT = 4000;

function htmlToPlainText(input) {
  if (!input || typeof input !== "string") return "";
  let text = input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length > LIMIT) text = text.slice(0, LIMIT);
  return text;
}

const db = new DatabaseSync(dbPath, { open: true });
db.exec("PRAGMA journal_mode = WAL;");

const rows = db.prepare(`
  SELECT pk, content_html FROM contents
  WHERE (content_md IS NULL OR content_md = '')
    AND content_html IS NOT NULL AND content_html != ''
`).all();

console.log(`库: ${dbPath}`);
console.log(`待回填: ${rows.length} 条（content_md 为空且有 content_html）`);

let totalBytes = 0;
for (const r of rows) totalBytes += htmlToPlainText(r.content_html).length;
console.log(`预计写入纯文本总量: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);

if (!APPLY) {
  console.log(`\n干跑完成。确认后执行: node backfill_search.js --apply`);
  process.exit(0);
}

const update = db.prepare(`UPDATE contents SET content_md = ? WHERE pk = ?`);
const BATCH = 500;
let done = 0;
db.exec("BEGIN");
for (const r of rows) {
  const text = htmlToPlainText(r.content_html);
  if (text) update.run(text, r.pk);
  done++;
  if (done % BATCH === 0) {
    db.exec("COMMIT");
    db.exec("BEGIN");
    console.log(`进度: ${done}/${rows.length}`);
  }
}
db.exec("COMMIT");
console.log(`✅ 回填完成: ${done} 条`);
