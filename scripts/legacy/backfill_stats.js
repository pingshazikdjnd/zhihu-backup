// 回填统计字段：历史数据 visit_count/favorite_count 大面积为 0（7月抓取时知乎 API 不返回）
// 用法:
//   node backfill_stats.js --limit=20        -> 先试跑 20 条
//   node backfill_stats.js                   -> 全量回填（visit_count=0 的 answer）
// 天然断点续跑：刷过的不再是 0，中断后重跑会从未刷的继续。
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const env = fs.readFileSync(path.resolve(__dirname, ".env"), "utf8");
const COOKIE = (env.match(/^ZHIHU_COOKIE_STRING=(.*)$/m) || [])[1] || "";
if (!COOKIE) { console.error("❌ .env 里没有 ZHIHU_COOKIE_STRING"); process.exit(1); }

const LIMIT = (() => {
  const a = process.argv.find(x => x.startsWith("--limit="));
  return a ? parseInt(a.slice(8), 10) : Infinity;
})();
const DELAY_MS = 800;
const HEADERS = {
  cookie: COOKIE,
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
};

const db = new DatabaseSync(path.resolve(__dirname, "./data/app.db"), { open: true });
db.exec("PRAGMA journal_mode = WAL;");

const rows = db.prepare(`
  SELECT pk, source_id, title, voteup_count, comment_count, favorite_count, visit_count
  FROM contents
  WHERE is_deleted = 0 AND source_type = 'answer' AND (visit_count = 0 OR favorite_count = 0)
  ORDER BY voteup_count DESC
`).all();

const targets = rows.slice(0, LIMIT === Infinity ? rows.length : LIMIT);
console.log(`待回填: ${rows.length} 条（本次处理 ${targets.length} 条）`);

const update = db.prepare(`
  UPDATE contents SET voteup_count = ?, comment_count = ?, favorite_count = ?, visit_count = ? WHERE pk = ?
`);

const getJson = async url => {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return { error: res.status };
  return await res.json();
};

(async () => {
  let ok = 0, fail = 0, skipped = 0;
  for (let i = 0; i < targets.length; i++) {
    const r = targets[i];
    try {
      const d = await getJson(`https://www.zhihu.com/api/v4/answers/${r.source_id}?include=voteup_count,comment_count,visit_count,favorite_count`);
      if (d.error) {
        if (d.error === 404 || d.error === 410) {
          db.prepare(`UPDATE contents SET is_deleted = 1 WHERE pk = ?`).run(r.pk);
          console.log(`[${i + 1}/${targets.length}] 🗑️ ${r.source_id} 已删除，标记`);
        } else {
          fail++;
          console.log(`[${i + 1}/${targets.length}] ⚠️ ${r.source_id} HTTP ${d.error}${d.error === 403 || d.error === 401 ? "（Cookie/风控）" : ""}`);
        }
      } else {
        // 线上 favorite_count 经常 undefined → 用 favlists 的 totals 兜底
        let fav = d.favorite_count || 0;
        if (fav === 0) {
          const fl = await getJson(`https://www.zhihu.com/api/v4/answers/${r.source_id}/favlists?limit=1&offset=0`);
          if (!fl.error && fl.paging && typeof fl.paging.totals === "number") fav = fl.paging.totals;
          await new Promise(x => setTimeout(x, 300));
        }
        // 只覆盖有值的字段，防止错误响应清掉已有数据
        const v = {
          voteup: d.voteup_count > 0 ? d.voteup_count : r.voteup_count,
          comment: d.comment_count > 0 ? d.comment_count : r.comment_count,
          fav: fav > 0 ? fav : r.favorite_count,
          visit: d.visit_count > 0 ? d.visit_count : r.visit_count
        };
        if (d.voteup_count === undefined && d.visit_count === undefined) {
          skipped++;
          console.log(`[${i + 1}/${targets.length}] ⏭️ ${r.source_id} 无数据返回，跳过`);
        } else {
          update.run(v.voteup, v.comment, v.fav, v.visit, r.pk);
          ok++;
          if (ok % 50 === 0 || i === targets.length - 1) {
            console.log(`[${i + 1}/${targets.length}] ✅ ${r.title.slice(0, 20)} | 👍${v.voteup} 💬${v.comment} ⭐${v.fav} 👁️${v.visit}`);
          }
        }
      }
    } catch (e) {
      fail++;
      console.log(`[${i + 1}/${targets.length}] ❌ ${r.source_id} ${e.message}`);
    }
    await new Promise(x => setTimeout(x, DELAY_MS));
  }
  console.log(`\n完成: 成功 ${ok} / 失败 ${fail} / 跳过 ${skipped}`);
  db.close();
})();
