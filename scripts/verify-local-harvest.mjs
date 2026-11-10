#!/usr/bin/env node
/**
 * 本地全量扒取体检器（100% 只读）
 *
 * 作用：
 *   1. D1 核心表统计（内容 / 评论 / 收藏 / 关注 / 赞同 / 变更事件）；
 *   2. D1 ↔ 本地 Miniflare R2 跨库对账（正文 HTML、楼中楼 JSON 是否真实落盘）；
 *   3. Cloudflare D1 5 GB / R2 10 GB / Class A 100 万次 免费额度实算；
 *   4. 中文体检报告，支持 --json。
 *
 * 安全铁律（本脚本硬性遵守）：
 *   - 所有 SQLite 均以 { readonly: true, fileMustExist: true } 只读打开，并额外
 *     PRAGMA query_only = ON；绝不执行 INSERT/UPDATE/DELETE/DDL；
 *   - 不读取、不打印 .env* / .dev.vars / INPUT.json / zhihu_cookie 任何明文；
 *   - 不发起任何网络请求，不调用 wrangler，不接触线上 Cloudflare。
 *
 * 用法：
 *   node scripts/verify-local-harvest.mjs
 *   node scripts/verify-local-harvest.mjs --json
 *
 * 退出码：
 *   0 = 体检完成（即使发现缺失也返回 0，缺失详情见报告）
 *   1 = 无法定位/打开本地 D1 或 R2 SQLite
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const WORKER_DIR = path.join(ROOT, "apps", "worker");
const D1_STATE_DIR = path.join(WORKER_DIR, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
const R2_STATE_DIR = path.join(WORKER_DIR, ".wrangler", "state", "v3", "r2", "miniflare-R2BucketObject");
const R2_BLOB_DIR = path.join(WORKER_DIR, ".wrangler", "state", "v3", "r2", "zhihu-backup-storage", "blobs");

const D1_FREE_LIMIT = 5 * 1024 ** 3;   // Cloudflare D1 免费账户总存储 5 GB
const D1_FREE_DB_LIMIT = 500 * 1024 ** 2; // 免费计划单个数据库上限 500 MB（比 5 GB 更紧）
const D1_FREE_DAILY_WRITES = 100_000;  // 免费计划每日写入行数上限
const R2_FREE_LIMIT = 10 * 1024 ** 3;  // Cloudflare R2 免费 10 GB-month
const R2_FREE_CLASS_A = 1_000_000;     // 每月 100 万次 Class A

const JSON_OUT = process.argv.slice(2).includes("--json");

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
const nf = new Intl.NumberFormat("en-US");

function fmtInt(n) {
  return nf.format(Number(n) || 0);
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x.toFixed(2)} ${units[i]}`;
}

function fmtPct(part, total, digits = 4) {
  if (!total) return "0.00%";
  return `${((Number(part) || 0) / total * 100).toFixed(digits)}%`;
}

function section(title) {
  console.log("");
  console.log("=".repeat(74));
  console.log(title);
  console.log("=".repeat(74));
}

function item(label, value, note = "") {
  console.log(`  ${label}：${value}${note ? `   （${note}）` : ""}`);
}

function discoverSqlite(dir) {
  if (!fs.existsSync(dir)) return { file: null, candidates: [] };
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sqlite"))
    .map((f) => {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      return { file: p, name: f, size: st.size, mtimeMs: st.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { file: candidates[0] || null, candidates };
}

function openReadonly(file) {
  const db = new Database(file, {
    readonly: true,
    fileMustExist: true,
    timeout: 5000
  });
  // 双保险：连接级只读，任何写语句都会直接被 SQLite 拒绝
  try {
    db.pragma("query_only = ON");
  } catch {
    /* pragma 失败不影响只读打开本身 */
  }
  return db;
}

function tableExists(db, name) {
  return !!db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
}

function safeGet(db, sql, params = []) {
  try {
    return db.prepare(sql).get(...params);
  } catch {
    return null;
  }
}

function safeAll(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function sampleArray(arr, n) {
  const a = arr.slice();
  const out = [];
  const k = Math.min(n, a.length);
  for (let i = 0; i < k; i += 1) {
    const j = i + Math.floor(Math.random() * (a.length - i));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
    out.push(a[i]);
  }
  return out;
}

/**
 * 汇总所有「已检查」条目的落盘异常（纯函数，无 IO；由安全回归测试提取后隔离执行）。
 *
 * 只统计真正检查过的对象：
 *   - html：missing / zeroSize / blobMissing / sizeMismatch
 *   - threads：missing / zeroSize / blobMissing / parseFailures / childCountMismatch
 *   - childJsonSample：missingBlob / parseFailures
 * 未抓完的线程（child_count=0、thread_hash 为空、尚未进入 threadRows）不在检查范围，
 * 不能被当作损坏统计；missing 中可能混有刚写入、R2 PUT 尚未完成的在途对象，
 * 仅作为 inFlightHint 提示，统计上仍然算异常，不能据此宣称 100% 落盘。
 */
function summarizeReconAnomalies(recon) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const h = (recon && recon.html) || {};
  const t = (recon && recon.threads) || {};
  const c = (recon && recon.childJsonSample) || {};
  const html = {
    missing: num(h.missing),
    zeroSize: num(h.zeroSize),
    blobMissing: num(h.blobMissing),
    sizeMismatch: num(h.sizeMismatch)
  };
  html.total = html.missing + html.zeroSize + html.blobMissing + html.sizeMismatch;
  const threads = {
    missing: num(t.missing),
    zeroSize: num(t.zeroSize),
    blobMissing: num(t.blobMissing),
    parseFailures: num(t.parseFailures),
    childCountMismatch: num(t.childCountMismatch)
  };
  threads.total =
    threads.missing + threads.zeroSize + threads.blobMissing + threads.parseFailures + threads.childCountMismatch;
  const childJsonSample = {
    missingBlob: num(c.missingBlob),
    parseFailures: num(c.parseFailures)
  };
  childJsonSample.total = childJsonSample.missingBlob + childJsonSample.parseFailures;
  const total = html.total + threads.total + childJsonSample.total;
  return {
    total,
    damaged: total > 0,
    inFlightHint: num(h.missingLikelyInFlight) + num(t.missingLikelyInFlight),
    html,
    threads,
    childJsonSample
  };
}

function readWranglerUsername() {
  try {
    const p = path.join(WORKER_DIR, "wrangler.toml");
    const txt = fs.readFileSync(p, "utf8");
    const m = txt.match(/^\s*ZHIHU_USERNAME\s*=\s*"([^"]*)"/m);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// 打开本地库
// ---------------------------------------------------------------------------
const d1Found = discoverSqlite(D1_STATE_DIR);
const r2Found = discoverSqlite(R2_STATE_DIR);

if (!d1Found.file) {
  console.error(`[FATAL] 找不到本地 D1 Miniflare SQLite：${D1_STATE_DIR}`);
  process.exit(1);
}
if (!r2Found.file) {
  console.error(`[FATAL] 找不到本地 R2 Miniflare SQLite：${R2_STATE_DIR}`);
  process.exit(1);
}

const d1 = openReadonly(d1Found.file.file);
const r2 = openReadonly(r2Found.file.file);

// ---------------------------------------------------------------------------
// R2 对象索引
// ---------------------------------------------------------------------------
const r2ObjectRows = safeAll(r2, "SELECT key, blob_id, size, uploaded, http_metadata FROM _mf_objects");
const r2Objects = new Map();
for (const row of r2ObjectRows) r2Objects.set(row.key, row);

const blobStatCache = new Map();
function blobStatus(obj) {
  if (!obj || !obj.blob_id) return { ok: false, reason: "no_blob_id" };
  if (blobStatCache.has(obj.blob_id)) return blobStatCache.get(obj.blob_id);
  let result;
  try {
    const st = fs.statSync(path.join(R2_BLOB_DIR, obj.blob_id));
    if (st.size <= 0) result = { ok: false, reason: "zero_byte", diskSize: st.size };
    else if (st.size !== obj.size) result = { ok: false, reason: "size_mismatch", diskSize: st.size };
    else result = { ok: true, diskSize: st.size };
  } catch {
    result = { ok: false, reason: "blob_missing" };
  }
  blobStatCache.set(obj.blob_id, result);
  return result;
}

function readObjectText(obj) {
  const p = path.join(R2_BLOB_DIR, obj.blob_id);
  return fs.readFileSync(p, "utf8");
}

// ---------------------------------------------------------------------------
// 1. D1 核心表统计
// ---------------------------------------------------------------------------
const has = (t) => tableExists(d1, t);
const myToken = readWranglerUsername();

const contentsTotal = safeGet(d1, "SELECT COUNT(*) AS c FROM contents")?.c ?? 0;
const byType = safeAll(
  d1,
  "SELECT source_type, COUNT(*) AS c FROM contents GROUP BY source_type ORDER BY c DESC"
);
const contentsWithVotes =
  safeGet(d1, "SELECT COUNT(*) AS c FROM contents WHERE voteup_count > 0")?.c ?? 0;
const contentsEmptyTitle =
  safeGet(d1, "SELECT COUNT(*) AS c FROM contents WHERE title IS NULL OR TRIM(title) = ''")?.c ?? 0;
const contentsDeleted = safeGet(d1, "SELECT COUNT(*) AS c FROM contents WHERE is_deleted = 1")?.c ?? 0;
const contentsMine = myToken
  ? safeGet(d1, "SELECT COUNT(*) AS c FROM contents WHERE author_url_token = ?", [myToken])?.c ?? 0
  : null;
const contentsFollowedAuthors =
  has("followed_users")
    ? safeGet(
        d1,
        "SELECT COUNT(*) AS c FROM contents WHERE author_url_token IN (SELECT url_token FROM followed_users)"
      )?.c ?? 0
    : 0;
const contentsInCollections =
  has("collection_items")
    ? safeGet(
        d1,
        "SELECT COUNT(DISTINCT content_pk) AS c FROM collection_items WHERE is_removed = 0"
      )?.c ?? 0
    : 0;
const contentsUpvoted =
  has("upvotes") ? safeGet(d1, "SELECT COUNT(DISTINCT content_pk) AS c FROM upvotes")?.c ?? 0 : 0;

const commentsTotal = safeGet(d1, "SELECT COUNT(*) AS c FROM comments")?.c ?? 0;
const commentsRoots =
  safeGet(d1, "SELECT COUNT(*) AS c FROM comments WHERE parent_comment_id IS NULL")?.c ?? 0;
const commentsChildren =
  safeGet(d1, "SELECT COUNT(*) AS c FROM comments WHERE parent_comment_id IS NOT NULL")?.c ?? 0;
const commentsDeleted = safeGet(d1, "SELECT COUNT(*) AS c FROM comments WHERE is_deleted = 1")?.c ?? 0;
const commentsOrphan =
  safeGet(d1, "SELECT COUNT(*) AS c FROM comments WHERE content_pk NOT IN (SELECT pk FROM contents)")?.c ?? 0;

const threadsTotal = has("comment_threads")
  ? safeGet(d1, "SELECT COUNT(*) AS c FROM comment_threads")?.c ?? 0
  : 0;
const threadAgg = has("comment_threads")
  ? safeGet(
      d1,
      `SELECT COUNT(*) AS c,
              COALESCE(SUM(child_count), 0) AS children,
              COALESCE(SUM(CASE WHEN is_complete = 1 THEN 1 ELSE 0 END), 0) AS complete,
              COALESCE(SUM(CASE WHEN thread_hash = '' THEN 1 ELSE 0 END), 0) AS empty_hash
         FROM comment_threads
        WHERE child_count > 0`
    )
  : null;
const threadOrphan = has("comment_threads")
  ? safeGet(
      d1,
      "SELECT COUNT(*) AS c FROM comment_threads WHERE content_pk NOT IN (SELECT pk FROM contents)"
    )?.c ?? 0
  : 0;

const collectionsTotal = has("collections")
  ? safeGet(d1, "SELECT COUNT(*) AS c FROM collections")?.c ?? 0
  : 0;
const collectionItems = has("collection_items")
  ? safeGet(
      d1,
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN is_removed = 0 THEN 1 ELSE 0 END), 0) AS active
         FROM collection_items`
    )
  : null;

const upvotesTotal = has("upvotes") ? safeGet(d1, "SELECT COUNT(*) AS c FROM upvotes")?.c ?? 0 : 0;
const followedAgg = has("followed_users")
  ? safeGet(
      d1,
      `SELECT COUNT(*) AS c,
              COALESCE(SUM(CASE WHEN sync_mode = 'full' THEN 1 ELSE 0 END), 0) AS full_mode,
              COALESCE(SUM(CASE WHEN is_unfollowed = 1 THEN 1 ELSE 0 END), 0) AS unfollowed,
              COALESCE(SUM(CASE WHEN last_synced_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS ever_synced
         FROM followed_users`
    )
  : null;
const changeEventsTotal = has("change_events")
  ? safeGet(d1, "SELECT COUNT(*) AS c FROM change_events")?.c ?? 0
  : 0;

// 全量导入到线上 D1 需要写入的总行数（用于对照免费计划每日 10 万行写入额度）
const IMPORT_ROW_TABLES = [
  "contents",
  "image_tasks",
  "content_versions",
  "comments",
  "comment_versions",
  "comment_threads",
  "collections",
  "collection_items",
  "collection_snapshots",
  "upvotes",
  "followed_users",
  "change_events",
  "app_settings",
  "sync_runs"
];
const importRowCounts = {};
let importRowsTotal = 0;
for (const t of IMPORT_ROW_TABLES) {
  if (!has(t)) continue;
  const c = safeGet(d1, `SELECT COUNT(*) AS c FROM ${t}`)?.c ?? 0;
  importRowCounts[t] = c;
  importRowsTotal += c;
}

// R2 meta/followed_users.json：history_done / resume_offset 进度（只统计，不打印内容）
let followedMeta = { exists: false, users: 0, historyDone: 0, notHistoryDone: 0, resumePending: 0, error: "" };
try {
  const metaObj = r2Objects.get("meta/followed_users.json");
  if (metaObj) {
    const parsed = JSON.parse(readObjectText(metaObj));
    const list = Array.isArray(parsed) ? parsed : Object.values(parsed || {});
    followedMeta.exists = true;
    followedMeta.users = list.length;
    followedMeta.historyDone = list.filter((u) => u && u.history_done === true).length;
    followedMeta.notHistoryDone = list.filter((u) => !u || u.history_done !== true).length;
    followedMeta.resumePending = list.filter(
      (u) => u && u.history_done !== true && Number(u.resume_offset || 0) > 0
    ).length;
  }
} catch (err) {
  followedMeta.error = err?.message || String(err);
}

// ---------------------------------------------------------------------------
// 2. D1 ↔ R2 对账
// ---------------------------------------------------------------------------
const IN_FLIGHT_WINDOW_MS = 10 * 60 * 1000;
const nowMs = Date.now();
/** sha256("")：正文为空时 Worker 不会写 R2 对象（ingest.ts 只在 htmlToStore 非空时 PUT） */
const EMPTY_CONTENT_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const contentRows = safeAll(
  d1,
  "SELECT pk, content_hash, last_seen_at FROM contents ORDER BY pk"
);
const htmlRefs = new Set();
const htmlRecon = {
  checked: 0,
  ok: 0,
  emptyContentNoObject: 0,
  legacyKeyFallback: 0,
  missing: 0,
  missingLikelyInFlight: 0,
  zeroSize: 0,
  blobMissing: 0,
  sizeMismatch: 0,
  missingSamples: []
};

for (const row of contentRows) {
  htmlRecon.checked += 1;
  // 空正文（content_hash 为空串的 sha256）本就不会写 R2，不算缺失
  if (row.content_hash === EMPTY_CONTENT_SHA256) {
    htmlRecon.emptyContentNoObject += 1;
    continue;
  }
  const hashKey = `html/${row.pk}/${row.content_hash}`;
  const legacyKey = `html/${row.pk}`;
  let obj = r2Objects.get(hashKey);
  let usedLegacy = false;
  if (!obj) {
    obj = r2Objects.get(legacyKey);
    usedLegacy = !!obj;
  }
  htmlRefs.add(hashKey);
  htmlRefs.add(legacyKey);

  if (!obj) {
    htmlRecon.missing += 1;
    const seen = Date.parse(row.last_seen_at || "");
    const inFlight = Number.isFinite(seen) && nowMs - seen <= IN_FLIGHT_WINDOW_MS;
    if (inFlight) htmlRecon.missingLikelyInFlight += 1;
    if (htmlRecon.missingSamples.length < 8) {
      htmlRecon.missingSamples.push({
        pk: row.pk,
        key: hashKey,
        lastSeenAt: row.last_seen_at,
        likelyInFlight: inFlight
      });
    }
    continue;
  }

  if (usedLegacy) htmlRecon.legacyKeyFallback += 1;
  const bs = blobStatus(obj);
  if (bs.ok) {
    htmlRecon.ok += 1;
  } else if (bs.reason === "zero_byte") {
    htmlRecon.zeroSize += 1;
  } else if (bs.reason === "blob_missing") {
    htmlRecon.blobMissing += 1;
  } else if (bs.reason === "size_mismatch") {
    htmlRecon.sizeMismatch += 1;
  } else {
    htmlRecon.blobMissing += 1;
  }
}

const threadRows = has("comment_threads")
  ? safeAll(
      d1,
      `SELECT root_id, content_pk, r2_key, child_count, thread_hash, synced_at
         FROM comment_threads
        WHERE child_count > 0 AND thread_hash <> ''
        ORDER BY root_id`
    )
  : [];
const threadRefs = new Set();
const threadRecon = {
  checked: 0,
  ok: 0,
  missing: 0,
  missingLikelyInFlight: 0,
  zeroSize: 0,
  blobMissing: 0,
  parseFailures: 0,
  sampled: 0,
  childCountMismatch: 0,
  missingSamples: [],
  parseFailureSamples: []
};

for (const row of threadRows) {
  threadRecon.checked += 1;
  const key = row.r2_key || `childcomments/${row.root_id}.json`;
  threadRefs.add(key);
  const obj = r2Objects.get(key);
  if (!obj) {
    threadRecon.missing += 1;
    // 用线程自身的 synced_at 判断是否刚写入、R2 PUT 尚未完成
    const seen = Date.parse(row.synced_at || "");
    const inFlight = Number.isFinite(seen) && nowMs - seen <= IN_FLIGHT_WINDOW_MS;
    if (inFlight) threadRecon.missingLikelyInFlight += 1;
    if (threadRecon.missingSamples.length < 8) {
      threadRecon.missingSamples.push({
        rootId: row.root_id,
        key,
        syncedAt: row.synced_at,
        likelyInFlight: inFlight
      });
    }
    continue;
  }
  const bs = blobStatus(obj);
  if (bs.ok) threadRecon.ok += 1;
  else if (bs.reason === "zero_byte") threadRecon.zeroSize += 1;
  else threadRecon.blobMissing += 1;
}

// 随机抽 50 个 comment_threads 对应对象，校验 JSON 可解析 + children 数组
const threadSample = sampleArray(
  threadRows.filter((r) => r2Objects.has(r.r2_key || `childcomments/${r.root_id}.json`)),
  50
);
for (const row of threadSample) {
  threadRecon.sampled += 1;
  const obj = r2Objects.get(row.r2_key || `childcomments/${row.root_id}.json`);
  try {
    const parsed = JSON.parse(readObjectText(obj));
    const children = Array.isArray(parsed) ? parsed : parsed?.children;
    if (!Array.isArray(children)) throw new Error("缺少 children 数组");
    if (Number(row.child_count) !== children.length) threadRecon.childCountMismatch += 1;
  } catch (err) {
    threadRecon.parseFailures += 1;
    if (threadRecon.parseFailureSamples.length < 8) {
      threadRecon.parseFailureSamples.push({
        rootId: row.root_id,
        key: row.r2_key,
        error: err?.message || String(err)
      });
    }
  }
}

// 独立随机抽 50 个 childcomments/*.json（覆盖没有 comment_threads 行的历史对象）
const childKeys = [...r2Objects.keys()].filter((k) => k.startsWith("childcomments/"));
const childSample = sampleArray(childKeys, 50);
const childJsonSample = {
  checked: 0,
  ok: 0,
  parseFailures: 0,
  missingBlob: 0,
  failureSamples: []
};
for (const key of childSample) {
  childJsonSample.checked += 1;
  const obj = r2Objects.get(key);
  const bs = blobStatus(obj);
  if (!bs.ok) {
    childJsonSample.missingBlob += 1;
    if (childJsonSample.failureSamples.length < 8) {
      childJsonSample.failureSamples.push({ key, error: bs.reason });
    }
    continue;
  }
  try {
    const parsed = JSON.parse(readObjectText(obj));
    const children = Array.isArray(parsed) ? parsed : parsed?.children;
    if (!Array.isArray(children)) throw new Error("缺少 children 数组");
    childJsonSample.ok += 1;
  } catch (err) {
    childJsonSample.parseFailures += 1;
    if (childJsonSample.failureSamples.length < 8) {
      childJsonSample.failureSamples.push({ key, error: err?.message || String(err) });
    }
  }
}

// 反向核对：R2 里有、D1 当前记录未引用的对象（历史版本/孤儿）
let htmlExtraCount = 0;
let htmlExtraBytes = 0;
let childExtraCount = 0;
let childExtraBytes = 0;
let metaCount = 0;
let metaBytes = 0;
for (const obj of r2Objects.values()) {
  if (obj.key.startsWith("html/")) {
    if (!htmlRefs.has(obj.key)) {
      htmlExtraCount += 1;
      htmlExtraBytes += obj.size;
    }
  } else if (obj.key.startsWith("childcomments/")) {
    if (!threadRefs.has(obj.key)) {
      childExtraCount += 1;
      childExtraBytes += obj.size;
    }
  } else if (obj.key.startsWith("meta/")) {
    metaCount += 1;
    metaBytes += obj.size;
  }
}

// ---------------------------------------------------------------------------
// 3. 容量实算
// ---------------------------------------------------------------------------
const pageSize = d1.pragma("page_size", { simple: true }) || 0;
const pageCount = d1.pragma("page_count", { simple: true }) || 0;
const freelistCount = d1.pragma("freelist_count", { simple: true }) || 0;
const d1LogicalBytes = pageSize * pageCount;
const d1UsedBytes = pageSize * Math.max(0, pageCount - freelistCount);

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

const d1MainFileBytes = fileSize(d1Found.file.file);
const d1WalBytes = fileSize(`${d1Found.file.file}-wal`);
const d1ShmBytes = fileSize(`${d1Found.file.file}-shm`);
const d1EffectiveBytes = d1LogicalBytes + d1WalBytes;

let r2ActiveBytes = 0;
let r2ActiveCount = 0;
const r2Prefix = { html: { count: 0, bytes: 0 }, childcomments: { count: 0, bytes: 0 }, meta: { count: 0, bytes: 0 }, other: { count: 0, bytes: 0 } };
for (const obj of r2Objects.values()) {
  r2ActiveBytes += obj.size;
  r2ActiveCount += 1;
  const prefix = obj.key.split("/")[0];
  const bucket = r2Prefix[prefix] || r2Prefix.other;
  bucket.count += 1;
  bucket.bytes += obj.size;
}

let diskBlobCount = 0;
let diskBlobBytes = 0;
try {
  for (const f of fs.readdirSync(R2_BLOB_DIR)) {
    const st = fs.statSync(path.join(R2_BLOB_DIR, f));
    if (!st.isFile()) continue;
    diskBlobCount += 1;
    diskBlobBytes += st.size;
  }
} catch {
  /* blobs 目录不存在时保持 0 */
}
const referencedBlobIds = new Set();
for (const obj of r2Objects.values()) if (obj.blob_id) referencedBlobIds.add(obj.blob_id);
const orphanBlobCount = Math.max(0, diskBlobCount - referencedBlobIds.size);
const orphanBlobBytes = Math.max(0, diskBlobBytes - r2ActiveBytes);

// 上云 Class A 估算：1 次 PUT / 对象；全量替换还需各 1 次 DELETE 旧对象（最坏 2×）
const classAUploadOnly = r2ActiveCount;
const classAWorstCase = r2ActiveCount * 2;

// 已检查项异常汇总：只有 total=0 才能声称 100% 落盘 / 具备上云条件
const reconSummary = summarizeReconAnomalies({
  html: htmlRecon,
  threads: threadRecon,
  childJsonSample
});

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
const report = {
  generatedAt: new Date().toISOString(),
  source: {
    d1Path: d1Found.file.file,
    d1Candidates: d1Found.candidates.map((c) => ({ name: c.name, size: c.size, mtimeMs: c.mtimeMs })),
    r2Path: r2Found.file.file,
    r2BlobDir: R2_BLOB_DIR,
    myToken: myToken || null
  },
  d1: {
    contentsTotal,
    byType,
    contentsWithVotes,
    contentsEmptyTitle,
    contentsDeleted,
    contentsMine,
    contentsFollowedAuthors,
    contentsInCollections,
    contentsUpvoted,
    commentsTotal,
    commentsRoots,
    commentsChildrenInD1: commentsChildren,
    commentsDeleted,
    commentsOrphan,
    threadsTotal,
    threadChildrenSum: threadAgg?.children ?? 0,
    threadsWithChildren: threadAgg?.c ?? 0,
    threadsComplete: threadAgg?.complete ?? 0,
    threadsEmptyHash: threadAgg?.empty_hash ?? 0,
    threadOrphan,
    collectionsTotal,
    collectionItemsTotal: collectionItems?.total ?? 0,
    collectionItemsActive: collectionItems?.active ?? 0,
    upvotesTotal,
    followedUsersTotal: followedAgg?.c ?? 0,
    followedUsersFullMode: followedAgg?.full_mode ?? 0,
    followedUsersUnfollowed: followedAgg?.unfollowed ?? 0,
    followedUsersEverSynced: followedAgg?.ever_synced ?? 0,
    changeEventsTotal,
    followedMeta
  },
  reconciliation: {
    summary: reconSummary,
    html: htmlRecon,
    threads: threadRecon,
    childJsonSample,
    extras: {
      htmlExtraCount,
      htmlExtraBytes,
      childExtraCount,
      childExtraBytes,
      metaCount,
      metaBytes
    }
  },
  capacity: {
    d1PageSize: pageSize,
    d1PageCount: pageCount,
    d1FreelistCount: freelistCount,
    d1LogicalBytes,
    d1UsedBytes,
    d1MainFileBytes,
    d1WalBytes,
    d1ShmBytes,
    d1EffectiveBytes,
    d1FreeLimit: D1_FREE_LIMIT,
    d1Percent: d1EffectiveBytes / D1_FREE_LIMIT * 100,
    d1FreeDbLimit: D1_FREE_DB_LIMIT,
    d1FreeDbPercent: d1EffectiveBytes / D1_FREE_DB_LIMIT * 100,
    importRowsTotal,
    importRowCounts,
    d1FreeDailyWrites: D1_FREE_DAILY_WRITES,
    d1DailyWritePercent: importRowsTotal / D1_FREE_DAILY_WRITES * 100,
    r2ActiveCount,
    r2ActiveBytes,
    r2FreeLimit: R2_FREE_LIMIT,
    r2Percent: r2ActiveBytes / R2_FREE_LIMIT * 100,
    r2Prefix,
    diskBlobCount,
    diskBlobBytes,
    orphanBlobCount,
    orphanBlobBytes,
    classAUploadOnly,
    classAWorstCase,
    classAFreeLimit: R2_FREE_CLASS_A,
    classAPercentUploadOnly: classAUploadOnly / R2_FREE_CLASS_A * 100,
    classAPercentWorstCase: classAWorstCase / R2_FREE_CLASS_A * 100
  }
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
  d1.close();
  r2.close();
  process.exit(0);
}

console.log("");
console.log("知乎备份 · 本地全量扒取体检报告（只读）");
console.log(`生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`);
console.log(`D1  SQLite：${d1Found.file.file}`);
if (d1Found.candidates.length > 1) {
  console.log(`  注意：发现 ${d1Found.candidates.length} 个 D1 sqlite，已选用 mtime 最新的一个；其余：${d1Found.candidates.slice(1).map((c) => c.name).join(", ")}`);
}
console.log(`R2  SQLite：${r2Found.file.file}`);
console.log(`R2  blobs ：${R2_BLOB_DIR}`);

section("一、D1 核心表统计");
item("contents 总数", fmtInt(contentsTotal));
item("  按 source_type", byType.map((r) => `${r.source_type}=${fmtInt(r.c)}`).join("  |  ") || "无数据");
if (contentsMine !== null) {
  item("  本人创作", `${fmtInt(contentsMine)} 篇`, `author_url_token=${myToken}`);
  item("  他人内容", `${fmtInt(Math.max(0, contentsTotal - contentsMine))} 篇`);
} else {
  item("  本人创作", "未识别", "wrangler.toml 未读到 ZHIHU_USERNAME，仅按总量统计");
}
item("  收藏夹内他人内容", `${fmtInt(contentsInCollections)} 篇`, "collection_items 去重 content_pk");
item("  关注答主内容", `${fmtInt(contentsFollowedAuthors)} 篇`, "author_url_token ∈ followed_users");
item("  赞同历史内容", `${fmtInt(contentsUpvoted)} 篇`, "upvotes 去重 content_pk");
item("  voteup_count > 0", `${fmtInt(contentsWithVotes)} 篇`, fmtPct(contentsWithVotes, contentsTotal, 2));
item("  title 为空", fmtInt(contentsEmptyTitle), fmtPct(contentsEmptyTitle, contentsTotal, 2));
item("  已标记删除", fmtInt(contentsDeleted));

item("comments 总数", fmtInt(commentsTotal), `根评论 ${fmtInt(commentsRoots)} / D1 子评论 ${fmtInt(commentsChildren)}`);
item("  已删除评论", fmtInt(commentsDeleted));
item("  孤儿评论", fmtInt(commentsOrphan), commentsOrphan === 0 ? "正常" : "content_pk 不在 contents 中");
item("comment_threads 线程", `${fmtInt(threadsTotal)} 个`, `child_count>0 的 ${fmtInt(threadAgg?.c ?? 0)} 个`);
item("  线程内子评论总数", fmtInt(threadAgg?.children ?? 0), "D1 comments 表只存根评论，子评论在 R2");
item("  已抓全线程", `${fmtInt(threadAgg?.complete ?? 0)} 个`, fmtPct(threadAgg?.complete ?? 0, threadAgg?.c ?? 0, 2));
item("  thread_hash 为空", fmtInt(threadAgg?.empty_hash ?? 0), "尚未成功写入 R2 的在途行");
item("  孤儿线程", fmtInt(threadOrphan), threadOrphan === 0 ? "正常" : "content_pk 不在 contents 中");

item("collections 收藏夹", fmtInt(collectionsTotal));
item("collection_items 条目", `${fmtInt(collectionItems?.total ?? 0)} 条`, `有效 ${fmtInt(collectionItems?.active ?? 0)} 条`);
item("upvotes 赞同记录", fmtInt(upvotesTotal));
if (followedAgg) {
  item(
    "followed_users 关注答主",
    `${fmtInt(followedAgg.c)} 人`,
    `full 模式 ${fmtInt(followedAgg.full_mode)} / 已取关 ${fmtInt(followedAgg.unfollowed)} / 有 last_synced_at ${fmtInt(followedAgg.ever_synced)}`
  );
}
if (followedMeta.exists) {
  item(
    "R2 followed_users.json 进度",
    `${fmtInt(followedMeta.historyDone)} / ${fmtInt(followedMeta.users)} 人 history_done`,
    `待续跑 ${fmtInt(followedMeta.resumePending)} 人`
  );
  item(
    "R2 followed_users.json 未完成",
    `${fmtInt(followedMeta.notHistoryDone)} 人 history_done=false`,
    followedMeta.notHistoryDone === 0 ? "全部完成首次历史摸底" : "重启后仍需继续扫描（含未存断点的答主）"
  );
} else {
  item("R2 followed_users.json", "未找到或不可解析", followedMeta.error || "");
}
item("change_events 变更事件", fmtInt(changeEventsTotal));

section("二、D1 ↔ 本地 R2 跨库对账（核心）");
item(
  "正文 HTML 对象",
  `${fmtInt(htmlRecon.ok)} / ${fmtInt(htmlRecon.checked - htmlRecon.emptyContentNoObject)} 篇真实存在`,
  `缺失 ${fmtInt(htmlRecon.missing)} 篇（疑似在途 ${fmtInt(htmlRecon.missingLikelyInFlight)}）；空正文无需对象 ${fmtInt(htmlRecon.emptyContentNoObject)} 篇`
);
if (htmlRecon.legacyKeyFallback) {
  item("  旧键 html/{pk} 回退命中", fmtInt(htmlRecon.legacyKeyFallback), "没有 content_hash 后缀的历史对象");
}
if (htmlRecon.zeroSize || htmlRecon.blobMissing || htmlRecon.sizeMismatch) {
  item(
    "  异常对象",
    `0 字节 ${fmtInt(htmlRecon.zeroSize)} / blobs 缺失 ${fmtInt(htmlRecon.blobMissing)} / 字节数不符 ${fmtInt(htmlRecon.sizeMismatch)}`
  );
}
if (htmlRecon.missingSamples.length) {
  console.log("  缺失样例（含是否疑似在途）：");
  for (const s of htmlRecon.missingSamples) {
    console.log(`    - ${s.pk}  key=${s.key}  last_seen=${s.lastSeenAt || "-"}  ${s.likelyInFlight ? "疑似在途" : "需复核"}`);
  }
}

item(
  "楼中楼 JSON 对象",
  `${fmtInt(threadRecon.ok)} / ${fmtInt(threadRecon.checked)} 个线程真实存在`,
  `缺失 ${fmtInt(threadRecon.missing)} 个（疑似在途 ${fmtInt(threadRecon.missingLikelyInFlight)}）`
);
if (threadRecon.zeroSize || threadRecon.blobMissing) {
  item("  异常对象", `0 字节 ${fmtInt(threadRecon.zeroSize)} / blobs 缺失 ${fmtInt(threadRecon.blobMissing)}`);
}
if (threadRecon.missingSamples.length) {
  console.log("  缺失样例：");
  for (const s of threadRecon.missingSamples) {
    console.log(`    - root=${s.rootId}  key=${s.key}  ${s.likelyInFlight ? "疑似在途" : "需复核"}`);
  }
}
item(
  "随机抽样 50 个线程 JSON",
  `可解析 ${fmtInt(threadRecon.sampled - threadRecon.parseFailures)} / ${fmtInt(threadRecon.sampled)}`,
  `child_count 与 children.length 不一致 ${fmtInt(threadRecon.childCountMismatch)} 个（删除评论会导致，属正常）`
);
if (threadRecon.parseFailures) {
  for (const s of threadRecon.parseFailureSamples) {
    console.log(`    - 解析失败 root=${s.rootId} key=${s.key} :: ${s.error}`);
  }
}
item(
  "独立抽样 50 个 childcomments/*.json",
  `可解析 ${fmtInt(childJsonSample.ok)} / ${fmtInt(childJsonSample.checked)}`,
  `blobs 缺失 ${fmtInt(childJsonSample.missingBlob)} / JSON 解析失败 ${fmtInt(childJsonSample.parseFailures)}`
);
if (childJsonSample.failureSamples.length) {
  for (const s of childJsonSample.failureSamples) {
    console.log(`    - ${s.key} :: ${s.error}`);
  }
}

item(
  "R2 历史/多余正文对象",
  `${fmtInt(htmlExtraCount)} 个`,
  `${fmtBytes(htmlExtraBytes)}，content_hash 变更后保留的不可变旧版本，不影响使用`
);
item(
  "R2 无 D1 线程行的楼中楼对象",
  `${fmtInt(childExtraCount)} 个`,
  fmtBytes(childExtraBytes)
);
item("R2 meta 对象", `${fmtInt(metaCount)} 个`, fmtBytes(metaBytes));

const reconCritical = reconSummary.total;
console.log("");
if (reconCritical === 0) {
  console.log("  对账结论：已检查的正文与楼中楼对象全部落盘通过，可安全进入打包上云阶段。");
} else {
  console.log(`  对账结论：发现 ${fmtInt(reconCritical)} 个已检查异常（缺失 / 0 字节 / blob 缺失 / 尺寸不符 / 解析失败 / child_count 不一致），`);
  console.log("            属于损坏或数据不一致，当前状态不可用于打包上云。");
  if (reconSummary.inFlightHint > 0) {
    console.log(
      `            其中 ${fmtInt(reconSummary.inFlightHint)} 个缺失标注为疑似在途；仍需等扒取结束后复查，不能全部归因于在途。`
    );
  }
}

section("三、Cloudflare 免费额度容量实算");
item(
  "D1 逻辑页大小",
  fmtBytes(d1LogicalBytes),
  `page_size=${pageSize} × page_count=${fmtInt(pageCount)}，freelist ${fmtInt(freelistCount)} 页`
);
item("D1 有效页大小", fmtBytes(d1UsedBytes), "扣除 freelist 空闲页");
item(
  "D1 磁盘文件",
  `主库 ${fmtBytes(d1MainFileBytes)} + WAL ${fmtBytes(d1WalBytes)} + SHM ${fmtBytes(d1ShmBytes)}`
);
item(
  "D1 计费估算（含 WAL）",
  `${fmtBytes(d1EffectiveBytes)}`,
  `占 5 GB 账户总存储 ${fmtPct(d1EffectiveBytes, D1_FREE_LIMIT, 4)}`
);
item(
  "D1 免费单库上限（更紧）",
  `${fmtBytes(d1EffectiveBytes)} / 500 MB`,
  `使用 ${fmtPct(d1EffectiveBytes, D1_FREE_DB_LIMIT, 2)}`
);
item(
  "D1 全量导入行数",
  `${fmtInt(importRowsTotal)} 行`,
  `免费计划每日写入 10 万行，占 ${fmtPct(importRowsTotal, D1_FREE_DAILY_WRITES, 2)}`
);
if (importRowsTotal > D1_FREE_DAILY_WRITES) {
  console.log(
    `  [注意] 一次性导入约 ${fmtInt(importRowsTotal)} 行，超过 D1 免费计划每日 10 万行写入额度；` +
      "需升级 Workers Paid，或分两天续传（上云脚本支持断点续传）。"
  );
}
if (d1EffectiveBytes > D1_FREE_DB_LIMIT * 0.9) {
  console.log("  [注意] 本地 D1 已接近免费计划 500 MB 单库上限，线上导入前需评估是否升级 Workers Paid。");
}
item(
  "R2 活跃对象（_mf_objects）",
  `${fmtInt(r2ActiveCount)} 个 / ${fmtBytes(r2ActiveBytes)}`,
  `占 10 GB 免费额度 ${fmtPct(r2ActiveBytes, R2_FREE_LIMIT, 4)}`
);
item(
  "  按前缀",
  `html ${fmtInt(r2Prefix.html.count)} 个 ${fmtBytes(r2Prefix.html.bytes)}  |  childcomments ${fmtInt(r2Prefix.childcomments.count)} 个 ${fmtBytes(r2Prefix.childcomments.bytes)}  |  meta ${fmtInt(r2Prefix.meta.count)} 个 ${fmtBytes(r2Prefix.meta.bytes)}`
);
item(
  "R2 blobs 磁盘实际",
  `${fmtInt(diskBlobCount)} 个文件 / ${fmtBytes(diskBlobBytes)}`,
  `已覆盖但未清理的孤立 blob ${fmtInt(orphanBlobCount)} 个 ${fmtBytes(orphanBlobBytes)}`
);
item(
  "R2 Class A 写入估算",
  `仅上传 ${fmtInt(classAUploadOnly)} 次`,
  `占每月 100 万次 ${fmtPct(classAUploadOnly, R2_FREE_CLASS_A, 2)}`
);
item(
  "  全量替换最坏情况",
  `${fmtInt(classAWorstCase)} 次（旧对象 DELETE + 新对象 PUT）`,
  `占 ${fmtPct(classAWorstCase, R2_FREE_CLASS_A, 2)}`
);

section("四、结论");
const d1Pct = d1EffectiveBytes / D1_FREE_LIMIT * 100;
const r2Pct = r2ActiveBytes / R2_FREE_LIMIT * 100;
console.log(`  1. D1 当前 ${fmtBytes(d1EffectiveBytes)}，5 GB 账户总存储使用 ${d1Pct.toFixed(4)}%，单库 500 MB 上限使用 ${(d1EffectiveBytes / D1_FREE_DB_LIMIT * 100).toFixed(2)}%。`);
console.log(`  2. R2 当前 ${fmtInt(r2ActiveCount)} 个活跃对象 / ${fmtBytes(r2ActiveBytes)}，10 GB 免费额度使用 ${r2Pct.toFixed(4)}%。`);
console.log(`  3. 上云一次全量 PUT 约 ${fmtInt(classAUploadOnly)} 次 Class A，仅占每月 100 万次的 ${(classAUploadOnly / 10_000).toFixed(2)}%。`);
console.log(`  4. 全量导入约 ${fmtInt(importRowsTotal)} 行；D1 免费计划每日写入 10 万行，单日导入会受限，需升级 Workers Paid 或分两天续传。`);
if (reconCritical === 0) {
  console.log("  5. 已检查的正文 / 楼中楼对象对账全部通过，本地库具备上云条件（仍需等扒取全部结束并人工确认）。");
} else {
  console.log(`  5. 发现 ${fmtInt(reconCritical)} 个已检查异常（损坏 / 数据不一致），不满足上云条件；请修复后重跑本脚本复查。`);
}
console.log("");
console.log("提示：本脚本全程只读，未写入任何 SQLite / 文件，未发起任何网络请求。");
console.log("");

d1.close();
r2.close();
