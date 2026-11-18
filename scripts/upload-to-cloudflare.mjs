#!/usr/bin/env node
/**
 * 本地全量备份 → Cloudflare D1 + R2 上云工具（默认纯只读预检）
 *
 * 设计原则：
 *   1. 默认模式（无参数 / --dry-run）100% 只读：只扫描本地 D1/R2 与 bundle 目录，
 *      估算分片数/对象数/耗时，明确打印后续命令；不写任何文件、不发任何网络请求。
 *   2. --export-only：只读读取本地 Miniflare D1/R2，生成
 *        data/cf-upload-bundle/d1-chunks/chunk-NNNN.sql
 *        data/cf-upload-bundle/0000_wipe_remote_tables.sql
 *        data/cf-upload-bundle/r2-manifest.jsonl（零拷贝，直接指向 blobs/<blob_id>）
 *      不复制任何 blob，不占双倍磁盘。
 *   3. --execute-remote --confirm-wipe-remote：两个 flag 缺一不可，才会真正
 *      清空线上 D1/R2 并断点续传导入。每片 SQL / 每个 R2 key 成功后写
 *      data/cf-upload-bundle/upload-progress.json，中断重跑自动跳过已完成项。
 *
 * 安全约定：
 *   - 本地 SQLite 一律 { readonly: true, fileMustExist: true } + PRAGMA query_only = ON；
 *   - 不读取/打印 .env* / .dev.vars / INPUT.json / zhihu_cookie 明文；
 *   - 不打印 CF_API_TOKEN / CF_ACCOUNT_ID 值，只打印“已配置/未配置”；
 *   - 任何 --remote 操作只会在 --execute-remote --confirm-wipe-remote 同时出现时发生。
 *
 * 用法：
 *   node scripts/upload-to-cloudflare.mjs                 # 纯只读预检
 *   node scripts/upload-to-cloudflare.mjs --dry-run       # 同上
 *   node scripts/upload-to-cloudflare.mjs --export-only   # 本地打包到 data/cf-upload-bundle
 *   node scripts/upload-to-cloudflare.mjs --execute-remote --confirm-wipe-remote
 *
 * 可选参数：
 *   --concurrency=16       R2 上传并发（默认 16，wrangler 回退模式内部上限 8）
 *   --chunk-rows=2000      每片最多行数
 *   --chunk-mb=5           每片最多 MB
 *   --skip-r2-wipe         跳过“清空线上 R2 旧对象”（仅 API 凭据缺失时使用）
 *   --force-wipe           即使已有导入进度也重新清空线上（危险，需显式指定）
 *   --json                 预检结果以 JSON 输出（仅 dry-run）
 *   --help
 *
 * 环境变量（仅 execute 模式需要）：
 *   CF_ACCOUNT_ID / CLOUDFLARE_ACCOUNT_ID
 *   CF_API_TOKEN  / CLOUDFLARE_API_TOKEN
 *   未配置时：D1 走 wrangler CLI；R2 上传也回退 wrangler（较慢），
 *   但“清空线上 R2 全部旧对象”无法用 wrangler 3 枚举，需 --skip-r2-wipe。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const WORKER_DIR = path.join(ROOT, "apps", "worker");
const D1_STATE_DIR = path.join(WORKER_DIR, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
const R2_STATE_DIR = path.join(WORKER_DIR, ".wrangler", "state", "v3", "r2", "miniflare-R2BucketObject");
const R2_BLOB_DIR = path.join(WORKER_DIR, ".wrangler", "state", "v3", "r2", "zhihu-backup-storage", "blobs");

const BUNDLE_DIR = path.join(ROOT, "data", "cf-upload-bundle");
const CHUNK_DIR = path.join(BUNDLE_DIR, "d1-chunks");
const WIPE_SQL_PATH = path.join(BUNDLE_DIR, "0000_wipe_remote_tables.sql");
const MANIFEST_PATH = path.join(BUNDLE_DIR, "r2-manifest.jsonl");
const PROGRESS_PATH = path.join(BUNDLE_DIR, "upload-progress.json");
const R2_DONE_LOG = path.join(BUNDLE_DIR, "r2-done.log");
const BUNDLE_META_PATH = path.join(BUNDLE_DIR, "bundle-meta.json");

const DB_NAME = "zhihu-backup";
const BUCKET_NAME = "zhihu-backup-storage";
const CF_API_BASE = "https://api.cloudflare.com/client/v4";

const MAX_STATEMENT_BYTES = 90 * 1024; // D1 单条 SQL 上限 100 KB，留 10 KB 余量
const D1_FREE_DAILY_WRITES = 100_000;  // D1 免费计划每日写入行数
const D1_FREE_DB_LIMIT = 500 * 1024 ** 2; // D1 免费计划单库上限 500 MB

// 导出顺序：严格按外键依赖从父到子
const EXPORT_TABLES = [
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

// 清空顺序：外键逆序
const WIPE_ORDER = [
  "change_events",
  "comment_threads",
  "comment_versions",
  "comments",
  "content_versions",
  "collection_snapshots",
  "collection_items",
  "collections",
  "upvotes",
  "followed_users",
  "sync_runs",
  "image_tasks",
  "contents"
];

// app_settings 采用明确白名单（不是黑名单）：本地导出只允许带 sync_config 这一项运行态配置。
// external_storage_targets / apify_last_run / upvotes_cursor / 各种锁以及未来新增的任何密钥，
// 都不会因为「没想到要过滤」而进入 bundle；本地旧值也就无从覆盖线上运行态。
const APP_SETTINGS_EXPORT_KEYS = ["sync_config"];

// 清空线上 app_settings 时必须保留的键：线上登录凭据、上传口令、外部存储目标、
// 同步策略、断点游标、Apify 运行态、AI 每日预算与分布式同步锁。
// 这些都属于「远端运行态」，清空后不能回填本地值，否则线上会立即失去登录态或锁状态。
const APP_SETTINGS_PRESERVE_ON_WIPE = [
  "zhihu_cookie",
  "fallback_ai_api_key",
  "cookie_write_token",
  "external_storage_targets",
  "sync_config",
  "upvotes_cursor",
  "apify_last_run",
  "ai_daily_neuron_budget",
  "sync_lock"
];

/** 仅导出白名单内的 app_settings 键（纯函数：供回归测试隔离执行） */
function shouldExportAppSetting(key) {
  return APP_SETTINGS_EXPORT_KEYS.includes(String(key));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = {
  dryRun: false,
  exportOnly: false,
  executeRemote: false,
  confirmWipeRemote: false,
  skipR2Wipe: false,
  forceWipe: false,
  json: false,
  help: false,
  concurrency: 16,
  chunkRows: 2000,
  chunkMb: 5
};

for (const arg of argv) {
  if (arg === "--dry-run") opts.dryRun = true;
  else if (arg === "--export-only") opts.exportOnly = true;
  else if (arg === "--execute-remote") opts.executeRemote = true;
  else if (arg === "--confirm-wipe-remote") opts.confirmWipeRemote = true;
  else if (arg === "--skip-r2-wipe") opts.skipR2Wipe = true;
  else if (arg === "--force-wipe") opts.forceWipe = true;
  else if (arg === "--json") opts.json = true;
  else if (arg === "--help" || arg === "-h") opts.help = true;
  else if (arg.startsWith("--concurrency=")) opts.concurrency = Math.max(1, Math.min(64, Number(arg.split("=")[1]) || 16));
  else if (arg.startsWith("--chunk-rows=")) opts.chunkRows = Math.max(1, Number(arg.split("=")[1]) || 2000);
  else if (arg.startsWith("--chunk-mb=")) opts.chunkMb = Math.max(1, Number(arg.split("=")[1]) || 5);
  else {
    console.error(`[FATAL] 未知参数：${arg}（用 --help 查看用法）`);
    process.exit(2);
  }
}

if (!opts.dryRun && !opts.exportOnly && !opts.executeRemote) opts.dryRun = true;

if (opts.help) {
  console.log(`本地备份上云工具

默认（无参数）与 --dry-run：纯只读预检，不写文件、不发网络请求
--export-only：生成 data/cf-upload-bundle 下的 D1 分片 SQL 与 R2 清单
--execute-remote --confirm-wipe-remote：清空线上并断点续传上云（两个 flag 缺一不可）

可选：
  --concurrency=16   R2 上传并发
  --chunk-rows=2000  分片最大行数
  --chunk-mb=5       分片最大 MB
  --skip-r2-wipe     跳过清空线上 R2（无 API 凭据时）
  --force-wipe       已有进度也强制重新清空线上（危险）
  --json             预检 JSON 输出
`);
  process.exit(0);
}

if (opts.exportOnly && opts.executeRemote) {
  console.error("[FATAL] --export-only 与 --execute-remote 不能同时使用。");
  process.exit(2);
}
if (opts.executeRemote && !opts.confirmWipeRemote) {
  console.error("[FATAL] 真上云必须同时提供 --execute-remote 和 --confirm-wipe-remote（双重确认，缺一不可）。");
  console.error("        如果只想本地打包，请使用 --export-only。");
  process.exit(2);
}
if (!opts.executeRemote && opts.confirmWipeRemote) {
  console.error("[FATAL] --confirm-wipe-remote 必须与 --execute-remote 一起使用。");
  process.exit(2);
}

const CHUNK_BYTES = Math.max(1024, opts.chunkMb * 1024 * 1024 - 64 * 1024); // 预留文件头/换行余量，确保成品 ≤ chunkMb
const CONCURRENCY = opts.concurrency;
const WRANGLER_CONCURRENCY = Math.min(CONCURRENCY, 8);

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------
const nf = new Intl.NumberFormat("en-US");
const fmtInt = (n) => nf.format(Number(n) || 0);

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

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return `${m} 分 ${rest} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function discoverSqlite(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sqlite"))
    .map((f) => {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      return { file: p, name: f, size: st.size, mtimeMs: st.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0] || null;
}

function openReadonly(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    db.pragma("query_only = ON");
  } catch {
    /* ignore */
  }
  return db;
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function tableInfo(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
  } catch {
    return [];
  }
}

function tableExists(db, table) {
  try {
    return !!db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
  } catch {
    return false;
  }
}

function safeAll(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return `X'${value.toString("hex")}'`;
  const s = String(value);
  if (s.includes("\u0000")) {
    // 含 NUL 的文本无法放进 SQL 字符串字面量，用 hex 再 CAST 回 TEXT
    return `CAST(X'${Buffer.from(s, "utf8").toString("hex")}' AS TEXT)`;
  }
  return `'${s.replace(/'/g, "''")}'`;
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows 上目标文件被占用时 rename 会失败：退化为直接覆盖
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    fs.writeFileSync(file, content);
    if (err && err.code !== "EPERM" && err.code !== "EEXIST" && err.code !== "EACCES") throw err;
  }
}

// ---------------------------------------------------------------------------
// 本地库探测与统计（只读）
// ---------------------------------------------------------------------------
const d1File = discoverSqlite(D1_STATE_DIR);
const r2File = discoverSqlite(R2_STATE_DIR);

if (!d1File) {
  console.error(`[FATAL] 找不到本地 D1 Miniflare SQLite：${D1_STATE_DIR}`);
  process.exit(1);
}
if (!r2File && !opts.dryRun && !opts.exportOnly) {
  // execute 模式只用 bundle，不依赖本地库；但保持提示
  console.warn("[WARN] 未找到本地 R2 Miniflare SQLite（execute 模式仅使用 bundle，可忽略）");
}

function readTableEstimates(db) {
  const out = [];
  for (const table of EXPORT_TABLES) {
    if (!tableExists(db, table)) continue;
    const cols = tableInfo(db, table);
    if (!cols.length) continue;
    const expr = cols
      .map((c) => `COALESCE(length(CAST(${quoteIdent(c.name)} AS TEXT)), 0)`)
      .join(" + ");
    let row;
    try {
      row = db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(${expr}), 0) AS bytes FROM ${quoteIdent(table)}`).get();
    } catch {
      row = { c: 0, bytes: 0 };
    }
    const overheadPerRow = cols.length * 8 + 24;
    const estimatedSqlBytes = Math.round(row.bytes * 1.12 + row.c * overheadPerRow);
    const byRows = Math.ceil(row.c / opts.chunkRows);
    const byBytes = Math.ceil(estimatedSqlBytes / CHUNK_BYTES);
    out.push({
      table,
      rows: row.c,
      textBytes: row.bytes,
      estimatedSqlBytes,
      estimatedChunks: Math.max(byRows, byBytes)
    });
  }
  return out;
}

function readR2Summary(db) {
  const rows = safeAll(db, "SELECT key, size FROM _mf_objects");
  const summary = {
    totalCount: rows.length,
    totalBytes: 0,
    prefixes: {}
  };
  for (const row of rows) {
    summary.totalBytes += row.size;
    const prefix = String(row.key).split("/")[0] || "(none)";
    if (!summary.prefixes[prefix]) summary.prefixes[prefix] = { count: 0, bytes: 0 };
    summary.prefixes[prefix].count += 1;
    summary.prefixes[prefix].bytes += row.size;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// 模式一：纯只读预检
// ---------------------------------------------------------------------------
if (opts.dryRun) {
  const d1 = openReadonly(d1File.file);
  const r2 = r2File ? openReadonly(r2File.file) : null;

  const tables = readTableEstimates(d1);
  const totalRows = tables.reduce((a, t) => a + t.rows, 0);
  const estimatedSqlBytes = tables.reduce((a, t) => a + t.estimatedSqlBytes, 0);
  const estimatedChunks = tables.reduce((a, t) => a + t.estimatedChunks, 0);
  const r2Summary = r2 ? readR2Summary(r2) : { totalCount: 0, totalBytes: 0, prefixes: {} };

  const pageSize = d1.pragma("page_size", { simple: true }) || 0;
  const pageCount = d1.pragma("page_count", { simple: true }) || 0;
  const d1Bytes = pageSize * pageCount;

  const hasApi = !!(
    (process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID) &&
    (process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN)
  );

  const d1Seconds = estimatedChunks * 4;
  const r2PerSecond = hasApi ? 80 : 2;
  const r2Seconds = Math.ceil(r2Summary.totalCount / r2PerSecond);

  const warnings = [];
  if (totalRows > D1_FREE_DAILY_WRITES) {
    warnings.push(
      `D1 免费计划每日只允许写入 10 万行，本次约 ${fmtInt(totalRows)} 行；单日导入会中途触发限额。` +
        "可升级 Workers Paid，或等 UTC 0 点后重跑同一命令续传（脚本会跳过已完成分片）。"
    );
  }
  if (d1Bytes > D1_FREE_DB_LIMIT * 0.9) {
    warnings.push(
      `本地 D1 已 ${fmtBytes(d1Bytes)}，接近免费计划单库 500 MB 上限（账户总存储 5 GB 不是单库上限）。`
    );
  }
  if (!hasApi) {
    warnings.push(
      "未配置 CF_ACCOUNT_ID + CF_API_TOKEN：R2 上传将逐个 spawn wrangler，约 2 对象/秒；且无法枚举删除线上 R2 旧对象。"
    );
  }

  const bundleExists = fs.existsSync(MANIFEST_PATH) && fs.existsSync(CHUNK_DIR);

  const result = {
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    source: {
      d1Path: d1File.file,
      r2Path: r2File ? r2File.file : null,
      r2BlobDir: R2_BLOB_DIR,
      d1Bytes,
      bundleDir: BUNDLE_DIR,
      bundleExists
    },
    d1: {
      tables,
      totalRows,
      estimatedSqlBytes,
      estimatedChunks,
      chunkRows: opts.chunkRows,
      chunkMb: opts.chunkMb,
      statementMaxBytes: MAX_STATEMENT_BYTES
    },
    r2: r2Summary,
    credentials: {
      accountIdConfigured: !!(process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID),
      apiTokenConfigured: !!(process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN),
      apiMode: hasApi,
      note: hasApi
        ? "R2 走 Cloudflare REST API 直传 + 可枚举删除线上旧对象"
        : "未配置 CF_ACCOUNT_ID/CF_API_TOKEN：R2 上传回退 wrangler（慢），且清空线上 R2 需 --skip-r2-wipe"
    },
    estimates: {
      d1Seconds,
      r2ObjectsPerSecond: r2PerSecond,
      r2Seconds,
      totalSeconds: d1Seconds + r2Seconds
    },
    warnings,
    commands: [
      "node scripts/upload-to-cloudflare.mjs --export-only",
      "node scripts/upload-to-cloudflare.mjs --execute-remote --confirm-wipe-remote"
    ]
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    d1.close();
    if (r2) r2.close();
    process.exit(0);
  }

  console.log("");
  console.log("=".repeat(74));
  console.log("Cloudflare 上云 · 纯只读预检（0 写入 / 0 网络请求）");
  console.log("=".repeat(74));
  console.log(`D1  SQLite：${d1File.file}`);
  if (r2File) console.log(`R2  SQLite：${r2File.file}`);
  console.log(`Bundle 目录：${BUNDLE_DIR}${bundleExists ? "（已存在旧产物，--export-only 会重建）" : "（尚不存在，--export-only 时创建）"}`);
  console.log("");

  console.log("一、D1 分片预估");
  console.log("  表名                     行数        文本量       预估 SQL 体积   预估分片");
  for (const t of tables) {
    console.log(
      `  ${t.table.padEnd(22)} ${fmtInt(t.rows).padStart(10)}  ${fmtBytes(t.textBytes).padStart(10)}  ${fmtBytes(t.estimatedSqlBytes).padStart(13)}  ${String(t.estimatedChunks).padStart(6)}`
    );
  }
  console.log(
    `  合计：${fmtInt(totalRows)} 行，${fmtBytes(estimatedSqlBytes)}，预计 ${fmtInt(estimatedChunks)} 个分片（每片 ≤${opts.chunkRows} 行 / ≤${opts.chunkMb} MB，单条 INSERT ≤90 KB）`
  );
  console.log(`  D1 当前逻辑大小：${fmtBytes(d1Bytes)}（Cloudflare D1 免费 5 GB）`);
  console.log("");

  console.log("二、R2 待上传对象预估（来自本地 _mf_objects 活跃对象，已排除磁盘孤立 blob）");
  for (const [prefix, v] of Object.entries(r2Summary.prefixes).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${prefix.padEnd(16)} ${fmtInt(v.count).padStart(8)} 个  ${fmtBytes(v.bytes)}`);
  }
  console.log(`  合计：${fmtInt(r2Summary.totalCount)} 个对象 / ${fmtBytes(r2Summary.totalBytes)}（Cloudflare R2 免费 10 GB）`);
  console.log("");

  console.log("三、凭据与路径");
  console.log(`  CF_ACCOUNT_ID：${result.credentials.accountIdConfigured ? "已配置" : "未配置"}`);
  console.log(`  CF_API_TOKEN ：${result.credentials.apiTokenConfigured ? "已配置" : "未配置"}`);
  console.log(`  模式：${result.credentials.note}`);
  console.log("");

  console.log("四、耗时粗估");
  console.log(`  D1 导入：约 ${fmtDuration(d1Seconds)}（${fmtInt(estimatedChunks)} 片 × 约 4 秒）`);
  console.log(`  R2 上传：约 ${fmtDuration(r2Seconds)}（${hasApi ? "REST API 约 80 对象/秒" : "wrangler 回退约 2 对象/秒"}）`);
  console.log(`  合计：约 ${fmtDuration(d1Seconds + r2Seconds)}（不含线上清空旧对象的时间）`);
  console.log("");

  console.log("五、风险提示");
  if (!warnings.length) {
    console.log("  未发现容量/凭据风险。");
  } else {
    for (const w of warnings) console.log(`  - ${w}`);
  }
  console.log("");

  console.log("六、后续命令（当前预检没有执行任何一步）");
  console.log("  1) 本地打包（只读本地库，生成 SQL 分片与 R2 清单，不联网）：");
  console.log("     node scripts/upload-to-cloudflare.mjs --export-only");
  console.log("  2) 等人工确认后真上云（清空线上 D1/R2 + 断点续传导入）：");
  console.log("     node scripts/upload-to-cloudflare.mjs --execute-remote --confirm-wipe-remote");
  if (!hasApi) {
    console.log("  注意：未配置 CF_ACCOUNT_ID/CF_API_TOKEN 时，R2 无法枚举线上旧对象，");
    console.log("        执行第 2 步需追加 --skip-r2-wipe，或先配置 API 凭据。");
  }
  console.log("");
  console.log("提示：预检全程只读本地 SQLite，未写文件、未发任何网络请求。");
  console.log("");

  d1.close();
  if (r2) r2.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 模式二：本地打包导出
// ---------------------------------------------------------------------------
if (opts.exportOnly) {
  const startedAt = Date.now();
  fs.mkdirSync(BUNDLE_DIR, { recursive: true });
  fs.mkdirSync(CHUNK_DIR, { recursive: true });

  // 清理旧分片与本轮进度，避免旧 chunk 与旧进度混用
  for (const f of fs.readdirSync(CHUNK_DIR)) {
    if (f.endsWith(".sql")) fs.rmSync(path.join(CHUNK_DIR, f), { force: true });
  }
  fs.rmSync(PROGRESS_PATH, { force: true });
  fs.rmSync(R2_DONE_LOG, { force: true });

  const d1 = openReadonly(d1File.file);
  const r2 = openReadonly(r2File.file);

  console.log("");
  console.log("=".repeat(74));
  console.log("本地打包导出 → data/cf-upload-bundle");
  console.log("=".repeat(74));
  const d1AgeMs = Date.now() - fs.statSync(d1File.file).mtimeMs;
  const r2AgeMs = r2File ? Date.now() - fs.statSync(r2File.file).mtimeMs : Infinity;
  if (d1AgeMs < 60_000 || r2AgeMs < 60_000) {
    console.log("  [WARN] 本地 D1/R2 最近 60 秒内仍有写入，后台扒取可能尚未结束；");
    console.log("         本次导出是“当前时刻的一致快照”，等全量跑完后请重新执行 --export-only。");
  }

  // 单一读事务：拿到跨表一致的 WAL 快照（只读，不阻塞后台扒取）
  d1.exec("BEGIN");
  const chunkMeta = [];
  let chunkSeq = 0;
  let exportedRows = 0;
  let exportedBytes = 0;

  function makeChunkWriter(table, cols) {
    const columnSql = cols.map((c) => quoteIdent(c.name)).join(", ");
    const prefix = `INSERT OR REPLACE INTO ${quoteIdent(table)} (${columnSql}) VALUES\n  `;
    let lines = [];
    let chunkRows = 0;
    let flushedStatementBytes = 0; // 已写入 lines 的完整语句字节数
    let stmtRows = 0;
    let stmtText = "";
    let stmtBytes = 0; // 当前尚未 flush 的语句字节数

    const flushStatement = () => {
      if (!stmtRows) return;
      lines.push(prefix + stmtText + ";");
      flushedStatementBytes += stmtBytes;
      stmtRows = 0;
      stmtText = "";
      stmtBytes = 0;
    };

    const flushChunk = () => {
      flushStatement();
      if (!chunkRows) return;
      chunkSeq += 1;
      const name = `chunk-${String(chunkSeq).padStart(4, "0")}.sql`;
      const file = path.join(CHUNK_DIR, name);
      const body = lines.join("\n");
      const header =
        `-- generated by scripts/upload-to-cloudflare.mjs\n` +
        `-- table=${table} rows=${chunkRows}\n` +
        `-- 注意：本文件可能包含个人内容，请勿提交到 git。\n`;
      const content = header + body + "\n";
      fs.writeFileSync(file, content, "utf8");
      const bytes = Buffer.byteLength(content);
      const sha256 = crypto.createHash("sha256").update(content).digest("hex");
      chunkMeta.push({ file, name, table, rows: chunkRows, bytes, sha256 });
      exportedRows += chunkRows;
      exportedBytes += bytes;
      lines = [];
      chunkRows = 0;
      flushedStatementBytes = 0;
    };

    return {
      addRow(valuesSql) {
        const rowSql = `(${valuesSql})`;
        let pendingText = stmtText + (stmtRows ? ",\n  " : "") + rowSql;
        let pendingBytes = Buffer.byteLength(prefix) + Buffer.byteLength(pendingText) + 1;

        // 单条 INSERT 不超过 90 KB，避免撞 D1 的 100 KB 单语句上限
        if (stmtRows > 0 && (pendingBytes > MAX_STATEMENT_BYTES || stmtRows >= 500)) {
          flushStatement();
          pendingText = rowSql;
          pendingBytes = Buffer.byteLength(prefix) + Buffer.byteLength(pendingText) + 1;
        }
        // 单个分片不超过 N 行 / N MB（含本分片内已 flush 的语句）
        if (
          chunkRows > 0 &&
          (chunkRows >= opts.chunkRows || flushedStatementBytes + pendingBytes > CHUNK_BYTES)
        ) {
          flushChunk();
        }

        stmtText = pendingText;
        stmtRows += 1;
        chunkRows += 1;
        stmtBytes = pendingBytes;

        // 单行就超大的极端情况：允许它独占一个分片
        if (chunkRows === 1 && stmtBytes > CHUNK_BYTES) flushChunk();
      },
      finish() {
        flushChunk();
      }
    };
  }

  try {
    for (const table of EXPORT_TABLES) {
      if (!tableExists(d1, table)) continue;
      const cols = tableInfo(d1, table);
      if (!cols.length) continue;

      const writer = makeChunkWriter(table, cols);
      const rows = d1.prepare(`SELECT * FROM ${quoteIdent(table)} ORDER BY rowid`).iterate();
      let skippedSettings = 0;
      for (const row of rows) {
        if (table === "app_settings" && !shouldExportAppSetting(row.key)) {
          skippedSettings += 1;
          continue;
        }
        const valuesSql = cols.map((c) => sqlLiteral(row[c.name])).join(", ");
        writer.addRow(valuesSql);
      }
      writer.finish();
      if (table === "app_settings" && skippedSettings) {
        console.log(`  app_settings：已跳过 ${skippedSettings} 个非白名单键（不打印键值）`);
      }
    }
    d1.exec("COMMIT");
  } catch (err) {
    try {
      d1.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error(`[FATAL] 导出 D1 失败：${err?.message || err}`);
    d1.close();
    r2.close();
    process.exit(1);
  }

  // 清空线上表数据（保留表结构、d1_migrations 与线上凭据）
  const wipeLines = [];
  wipeLines.push("-- 清空线上 D1 业务数据：按外键逆序 DELETE，保留表结构与 d1_migrations");
  wipeLines.push("-- app_settings 仅保留线上凭据与运行态白名单键，避免上传后 Worker 失去登录态或锁状态");
  wipeLines.push("-- 本文件由 scripts/upload-to-cloudflare.mjs 生成，仅允许人工确认后 --remote 执行");
  wipeLines.push("");
  for (const table of WIPE_ORDER) {
    if (!tableExists(d1, table)) continue;
    wipeLines.push(`DELETE FROM ${quoteIdent(table)};`);
  }
  if (tableExists(d1, "app_settings")) {
    wipeLines.push("");
    wipeLines.push(`-- 保留线上凭据/运行态：${APP_SETTINGS_PRESERVE_ON_WIPE.join(", ")}`);
    wipeLines.push(
      `DELETE FROM app_settings WHERE key NOT IN (${APP_SETTINGS_PRESERVE_ON_WIPE.map((k) => `'${k.replace(/'/g, "''")}'`).join(", ")});`
    );
  }
  wipeLines.push("");
  atomicWrite(WIPE_SQL_PATH, wipeLines.join("\n"));

  // R2 清单（零拷贝）
  const manifestRows = safeAll(
    r2,
    "SELECT key, blob_id, size, etag, http_metadata FROM _mf_objects ORDER BY key"
  );
  const manifestLines = [];
  const missingBlobs = [];
  let manifestBytes = 0;
  const prefixSummary = {};
  for (const row of manifestRows) {
    const blobPath = path.join(R2_BLOB_DIR, row.blob_id || "");
    let diskSize = -1;
    try {
      diskSize = fs.statSync(blobPath).size;
    } catch {
      missingBlobs.push({ key: row.key, blobId: row.blob_id });
      continue;
    }
    let contentType = "application/octet-stream";
    try {
      contentType = JSON.parse(row.http_metadata || "{}").contentType || contentType;
    } catch {
      /* ignore */
    }
    const rec = {
      key: row.key,
      blobPath,
      size: diskSize,
      contentType,
      etag: row.etag || null,
      declaredSize: row.size
    };
    manifestLines.push(JSON.stringify(rec));
    manifestBytes += diskSize;
    const prefix = String(row.key).split("/")[0] || "(none)";
    if (!prefixSummary[prefix]) prefixSummary[prefix] = { count: 0, bytes: 0 };
    prefixSummary[prefix].count += 1;
    prefixSummary[prefix].bytes += diskSize;
  }
  atomicWrite(MANIFEST_PATH, manifestLines.join("\n") + (manifestLines.length ? "\n" : ""));

  const meta = {
    generatedAt: new Date().toISOString(),
    source: { d1Path: d1File.file, r2Path: r2File.file, r2BlobDir: R2_BLOB_DIR },
    d1: {
      tables: chunkMeta.length
        ? [...new Set(chunkMeta.map((c) => c.table))].map((table) => ({
            table,
            chunks: chunkMeta.filter((c) => c.table === table).length,
            rows: chunkMeta.filter((c) => c.table === table).reduce((a, c) => a + c.rows, 0)
          }))
        : [],
      chunkCount: chunkMeta.length,
      totalRows: exportedRows,
      totalSqlBytes: exportedBytes
    },
    r2: {
      count: manifestLines.length,
      bytes: manifestBytes,
      prefixes: prefixSummary,
      missingBlobs
    },
    wipeSql: WIPE_SQL_PATH,
    note: "R2 清单不复制 blob，直接指向本地 blobs/<blob_id>；上传前请确认后台扒取已完全结束"
  };
  atomicWrite(BUNDLE_META_PATH, JSON.stringify(meta, null, 2));

  d1.close();
  r2.close();

  console.log(`  D1 分片：${fmtInt(chunkMeta.length)} 个，${fmtInt(exportedRows)} 行，SQL 约 ${fmtBytes(exportedBytes)}`);
  for (const line of meta.d1.tables) {
    console.log(`    ${line.table.padEnd(22)} ${String(line.chunks).padStart(4)} 片 / ${fmtInt(line.rows)} 行`);
  }
  console.log(`  清空 SQL：${WIPE_SQL_PATH}`);
  console.log(`  R2 清单：${MANIFEST_PATH}（${fmtInt(manifestLines.length)} 个对象 / ${fmtBytes(manifestBytes)}，零拷贝）`);
  for (const [prefix, v] of Object.entries(prefixSummary).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`    ${prefix.padEnd(16)} ${fmtInt(v.count).padStart(8)} 个  ${fmtBytes(v.bytes)}`);
  }
  if (missingBlobs.length) {
    console.log(`  [WARN] ${fmtInt(missingBlobs.length)} 个 _mf_objects 记录的 blob 文件缺失，已从清单排除：`);
    for (const m of missingBlobs.slice(0, 8)) console.log(`    - ${m.key}`);
  }
  console.log("");
  console.log(`完成，用时 ${fmtDuration((Date.now() - startedAt) / 1000)}。`);
  console.log("下一步（等人工确认后再执行）：");
  console.log("  node scripts/upload-to-cloudflare.mjs --execute-remote --confirm-wipe-remote");
  console.log("");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 模式三：真上云（双重 flag 已校验）
// ---------------------------------------------------------------------------
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || "";
const API_TOKEN = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "";
const HAS_API = !!(ACCOUNT_ID && API_TOKEN);

function findWrangler() {
  const candidates = [
    path.join(WORKER_DIR, "node_modules", "wrangler", "bin", "wrangler.js"),
    path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js")
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const WRANGLER_BIN = findWrangler();

function wranglerEnv() {
  const env = { ...process.env };
  if (API_TOKEN) env.CLOUDFLARE_API_TOKEN = API_TOKEN;
  if (ACCOUNT_ID) env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT_ID;
  return env;
}

function runWrangler(args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    if (!WRANGLER_BIN) {
      resolve({ code: -1, stdout: "", stderr: "找不到 wrangler（apps/worker/node_modules/wrangler/bin/wrangler.js）" });
      return;
    }
    const child = spawn(process.execPath, [WRANGLER_BIN, ...args], {
      cwd: WORKER_DIR,
      env: wranglerEnv(),
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const cap = 128 * 1024;
    child.stdout.on("data", (b) => {
      if (stdout.length < cap) stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b) => {
      if (stderr.length < cap) stderr += b.toString("utf8");
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, signal, stdout, stderr });
    });
  });
}

async function withRetry(fn, { attempts = 3, label = "operation", baseDelayMs = 1200 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (err?.fatal) break;
      if (attempt >= attempts) break;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.warn(`  [RETRY] ${label} 第 ${attempt} 次失败：${shortErr(err)}；${Math.round(delay / 1000)} 秒后重试`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function shortErr(err) {
  const msg = err?.message || String(err);
  return msg.replace(/\s+/g, " ").slice(0, 300);
}

async function cfApi(method, apiPath, { body, contentType, timeoutMs = 120000 } = {}) {
  const url = `${CF_API_BASE}${apiPath}`;
  const headers = { Authorization: `Bearer ${API_TOKEN}` };
  if (contentType) headers["Content-Type"] = contentType;

  return withRetry(
    async () => {
      const res = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after") || 5);
        throw new Error(`HTTP 429 限流，retry-after=${retryAfter}s`);
      }
      if (res.status >= 500) throw new Error(`HTTP ${res.status} 服务端错误`);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
        // 4xx（除 429）是权限/参数错误，重试没有意义
        err.fatal = res.status >= 400 && res.status < 500 && res.status !== 429;
        throw err;
      }
      if (method === "DELETE") {
        await res.arrayBuffer().catch(() => null);
        return null;
      }
      const json = await res.json().catch(() => null);
      return json;
    },
    { attempts: method === "DELETE" ? 3 : 4, label: `${method} ${apiPath.split("?")[0].slice(0, 80)}` }
  );
}

function encodeObjectKey(key) {
  return String(key)
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/** 去掉 ETag 外层双引号（纯函数：供回归测试隔离执行） */
function normalizeR2Etag(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^"+|"+$/g, "");
}

/**
 * R2 续传身份：manifest 的 key + 内容 etag，二者缺一不可。
 * - 只有裸 key 不足以证明内容未变（同名 childcomments 可能已被重抓覆盖），返回空串；
 * - 用换行分隔：key 可能含空格/中文/冒号，但不会含换行；etag 也不含换行。
 */
function r2ProgressIdentity(rec) {
  if (!rec || typeof rec !== "object") return "";
  const key = typeof rec.key === "string" ? rec.key : "";
  const etag = normalizeR2Etag(rec.etag);
  if (!key || !etag) return "";
  return `${key}\n${etag}`;
}

/** 本地进度能否证明该 manifest 记录已完成：只认 key+etag 完全一致，裸 key/无 etag 一律不认 */
function isR2DoneForManifest(rec, doneIdentities) {
  const identity = r2ProgressIdentity(rec);
  if (!identity || !doneIdentities) return false;
  if (typeof doneIdentities.has === "function") return doneIdentities.has(identity);
  if (Array.isArray(doneIdentities)) return doneIdentities.includes(identity);
  return false;
}

/** R2_DONE_LOG 新格式（JSON Lines）：只有能构成 key+etag 身份的记录才写入 */
function formatR2DoneLogLine(rec) {
  const identity = r2ProgressIdentity(rec);
  if (!identity) return "";
  return JSON.stringify({ key: String(rec.key), etag: normalizeR2Etag(rec.etag) });
}

/** 解析 R2_DONE_LOG 一行：新格式返回身份；旧纯 key 行/无 etag 行返回空串（按无身份处理） */
function parseR2DoneLogLine(line) {
  const text = String(line || "").trim();
  if (!text || text[0] !== "{") return "";
  try {
    return r2ProgressIdentity(JSON.parse(text));
  } catch {
    return "";
  }
}

/**
 * R2 断点续传跳过判定：只有 manifest 与线上对象都有非空 etag、且去引号后完全一致才可跳过。
 * 仅 size 相同不能证明内容一致（同名 childcomments 可能已被重抓覆盖），
 * etag 缺失/不同都必须重传，绝不据此把内容不同的对象标记为已完成。
 */
function isR2ObjectResumable(manifestRec, remoteObj) {
  const local = normalizeR2Etag(manifestRec && manifestRec.etag);
  const remote = normalizeR2Etag(remoteObj && remoteObj.etag);
  if (!local || !remote) return false;
  return local === remote;
}

async function listRemoteObjects(prefix = "") {
  const objects = [];
  let cursor = "";
  for (let page = 0; page < 10000; page += 1) {
    const qs = new URLSearchParams({ per_page: "1000" });
    if (prefix) qs.set("prefix", prefix);
    if (cursor) qs.set("cursor", cursor);
    const json = await cfApi(
      "GET",
      `/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET_NAME}/objects?${qs.toString()}`
    );
    const result = Array.isArray(json?.result) ? json.result : [];
    objects.push(...result);
    cursor = json?.result_info?.cursor || "";
    if (!cursor || !result.length) break;
  }
  return objects;
}

async function runPool(items, concurrency, handler) {
  let next = 0;
  let aborted = null;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      if (aborted) return;
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try {
        await handler(items[i], i);
      } catch (err) {
        aborted = aborted || err;
        return;
      }
    }
  });
  await Promise.all(workers);
  if (aborted) throw aborted;
}

function loadProgress() {
  try {
    const raw = fs.readFileSync(PROGRESS_PATH, "utf8");
    const p = JSON.parse(raw);
    return {
      version: 1,
      startedAt: p.startedAt || new Date().toISOString(),
      updatedAt: p.updatedAt || null,
      wipe: p.wipe || { r2Done: false, d1Done: false, r2Skipped: false, at: null },
      d1: { chunks: p.d1?.chunks || {} },
      r2: { doneKeys: Array.isArray(p.r2?.doneKeys) ? p.r2.doneKeys : [], uploadedCount: p.r2?.uploadedCount || 0, uploadedBytes: p.r2?.uploadedBytes || 0 }
    };
  } catch {
    return {
      version: 1,
      startedAt: new Date().toISOString(),
      updatedAt: null,
      wipe: { r2Done: false, d1Done: false, r2Skipped: false, at: null },
      d1: { chunks: {} },
      r2: { doneKeys: [], uploadedCount: 0, uploadedBytes: 0 }
    };
  }
}

const progress = loadProgress();
// 旧版 progress 的 doneKeys 是裸 key：原样保留用于 anyImported/计数兼容，
// 但只有 key+etag 身份才会被 isR2DoneForManifest 认可（裸 key 无法证明内容未变）。
const r2Done = new Set(progress.r2.doneKeys.filter((entry) => typeof entry === "string"));
try {
  if (fs.existsSync(R2_DONE_LOG)) {
    for (const line of fs.readFileSync(R2_DONE_LOG, "utf8").split("\n")) {
      const identity = parseR2DoneLogLine(line);
      if (identity) {
        r2Done.add(identity);
        continue;
      }
      const legacyKey = line.trim();
      // 旧日志是纯 key 行：保留用于“已有进度”判断，但绝不参与 manifest 身份匹配。
      // 以 { 开头但解析失败的行按损坏的新格式处理，不当成 key 使用。
      if (legacyKey && legacyKey[0] !== "{") r2Done.add(legacyKey);
    }
  }
} catch {
  /* ignore */
}

let progressDirty = false;
let lastProgressSave = 0;
function saveProgress(force = false) {
  const now = Date.now();
  if (!force && !progressDirty) return;
  if (!force && now - lastProgressSave < 2500) return;
  progress.updatedAt = new Date().toISOString();
  progress.r2.doneKeys = [...r2Done];
  progress.r2.uploadedCount = progress.r2.doneKeys.length;
  atomicWrite(PROGRESS_PATH, JSON.stringify(progress));
  progressDirty = false;
  lastProgressSave = now;
}

function markR2Done(key, bytes, etag) {
  const identity = r2ProgressIdentity({ key, etag });
  if (!identity) {
    // 没有 etag 就没有可验证的内容身份：宁可不记，下次重传，绝不把旧对象当新对象完成
    return false;
  }
  if (r2Done.has(identity)) {
    // 旧版可能同时存过同一个 key 的裸 key 记录，已有 etag 身份后清掉，避免计数重复
    r2Done.delete(key);
    return false;
  }
  r2Done.add(identity);
  r2Done.delete(key);
  const addedBytes = Number(bytes);
  progress.r2.uploadedBytes += Number.isFinite(addedBytes) ? addedBytes : 0;
  progressDirty = true;
  const logLine = formatR2DoneLogLine({ key, etag });
  if (logLine) {
    try {
      fs.appendFileSync(R2_DONE_LOG, `${logLine}\n`);
    } catch {
      /* 日志写失败不影响进度 JSON（会周期性落盘） */
    }
  }
  return true;
}

let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
  console.warn("\n[WARN] 收到 Ctrl+C，正在保存进度后退出...");
  try {
    saveProgress(true);
  } catch {
    /* ignore */
  }
  process.exit(130);
});

// ---- 前置检查 ----
try {
if (!fs.existsSync(MANIFEST_PATH)) {
  console.error(`[FATAL] 找不到 R2 清单：${MANIFEST_PATH}`);
  console.error("        请先执行：node scripts/upload-to-cloudflare.mjs --export-only");
  process.exit(1);
}
const chunkFiles = fs
  .readdirSync(CHUNK_DIR)
  .filter((f) => /^chunk-\d+\.sql$/.test(f))
  .sort();
if (!chunkFiles.length) {
  console.error(`[FATAL] ${CHUNK_DIR} 下没有分片 SQL，请先 --export-only。`);
  process.exit(1);
}
if (!fs.existsSync(WIPE_SQL_PATH)) {
  console.error(`[FATAL] 找不到清空 SQL：${WIPE_SQL_PATH}，请先 --export-only。`);
  process.exit(1);
}

const manifest = fs
  .readFileSync(MANIFEST_PATH, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const manifestByKey = new Map(manifest.map((m) => [m.key, m]));

console.log("");
console.log("=".repeat(74));
console.log("Cloudflare 真上云 · 清空线上 + 断点续传");
console.log("=".repeat(74));
console.log(`D1 分片：${fmtInt(chunkFiles.length)} 个`);
console.log(`R2 对象：${fmtInt(manifest.length)} 个 / ${fmtBytes(manifest.reduce((a, m) => a + m.size, 0))}`);
console.log(`并发：R2 ${HAS_API ? CONCURRENCY : WRANGLER_CONCURRENCY}，模式：${HAS_API ? "Cloudflare REST API" : "wrangler CLI 回退"}`);
console.log(`进度文件：${PROGRESS_PATH}`);
console.log("");

const anyImported =
  Object.keys(progress.d1.chunks).length > 0 || r2Done.size > 0;
const shouldWipe = opts.forceWipe || !progress.wipe?.d1Done || !anyImported;

// ---- 步骤 A：清空线上 ----
if (shouldWipe) {
  console.log("[步骤 A] 清空线上旧数据");

  // 线上即将整体清空：之前的“已导入/已上传”续传记录全部失效，必须清零，
  // 否则步骤 B 会误跳过已记录分片，导致线上只剩空表。
  progress.d1.chunks = {};
  r2Done.clear();
  progress.r2.uploadedBytes = 0;
  progress.wipe.r2Done = false;
  progress.wipe.d1Done = false;
  progress.wipe.r2Skipped = false;
  try {
    fs.rmSync(R2_DONE_LOG, { force: true });
  } catch {
    /* ignore */
  }
  saveProgress(true);

  // A1. 确保线上 schema 已到 0004
  console.log("  A1. wrangler d1 migrations apply --remote ...");
  const mig = await withRetry(
    async () => {
      const r = await runWrangler(["d1", "migrations", "apply", DB_NAME, "--remote", "--yes"], {
        timeoutMs: 10 * 60 * 1000
      });
      if (r.code !== 0) throw new Error(`wrangler 退出码 ${r.code}：${(r.stderr || r.stdout).slice(-800)}`);
      return r;
    },
    { attempts: 2, label: "d1 migrations apply" }
  );
  if (mig.stdout) console.log(`     ${mig.stdout.trim().split("\n").slice(-3).join("\n     ")}`);

  // A2. 清空线上 R2 旧对象
  if (!opts.skipR2Wipe) {
    if (!HAS_API) {
      throw new Error(
        "清空线上 R2 需要 CF_ACCOUNT_ID + CF_API_TOKEN：wrangler 3 没有 r2 object list，无法枚举旧对象。\n" +
          "        请配置 API 凭据，或追加 --skip-r2-wipe（旧对象会残留，仅同名 key 被覆盖）。"
      );
    }
    console.log("  A2. 枚举并删除线上 R2 旧对象 ...");
    const remote = await listRemoteObjects("");
    console.log(`     线上现有 ${fmtInt(remote.length)} 个对象，开始删除（并发 ${CONCURRENCY}）...`);
    let deleted = 0;
    let deleteFailed = 0;
    await runPool(remote, CONCURRENCY, async (obj) => {
      try {
        await cfApi(
          "DELETE",
          `/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET_NAME}/objects/${encodeObjectKey(obj.key)}`
        );
        deleted += 1;
      } catch (err) {
        deleteFailed += 1;
        throw err;
      }
      if (deleted % 500 === 0) console.log(`     已删除 ${fmtInt(deleted)} / ${fmtInt(remote.length)}`);
    });
    console.log(`     R2 删除完成：${fmtInt(deleted)} 个，失败 ${fmtInt(deleteFailed)} 个`);
    progress.wipe.r2Done = true;
    progress.wipe.at = new Date().toISOString();
    saveProgress(true);
  } else {
    console.log("  A2. 已指定 --skip-r2-wipe：跳过清空线上 R2（旧对象可能残留）");
    // 不能把“跳过清空”当成“线上已干净”：否则续传时会把内容已变的同名对象误判为已完成。
    // 续传判定本身也已收紧为 etag 严格一致，但跳过标志仍保持 false，绝不假设线上可信。
    progress.wipe.r2Done = false;
    progress.wipe.r2Skipped = true;
    saveProgress(true);
  }

  // A3. 执行清空 SQL
  console.log("  A3. 执行 0000_wipe_remote_tables.sql ...");
  await withRetry(
    async () => {
      const r = await runWrangler(
        ["d1", "execute", DB_NAME, "--remote", "--file", WIPE_SQL_PATH, "--yes"],
        { timeoutMs: 10 * 60 * 1000 }
      );
      if (r.code !== 0) throw new Error(`wrangler 退出码 ${r.code}：${(r.stderr || r.stdout).slice(-800)}`);
      return r;
    },
    { attempts: 2, label: "d1 wipe" }
  );
  progress.wipe.d1Done = true;
  progress.wipe.at = new Date().toISOString();
  saveProgress(true);
  console.log("  步骤 A 完成。");
} else {
  console.log("[步骤 A] 检测到已有导入进度，跳过清空（如需强制重来请加 --force-wipe）。");
}

// ---- 步骤 B：D1 分片断点续传 ----
console.log("");
console.log("[步骤 B] 导入 D1 分片（断点续传）");
let importedChunks = 0;
let skippedChunks = 0;
for (let i = 0; i < chunkFiles.length; i += 1) {
  if (interrupted) break;
  const name = chunkFiles[i];
  const file = path.join(CHUNK_DIR, name);
  const content = fs.readFileSync(file);
  const sha256 = crypto.createHash("sha256").update(content).digest("hex");
  const done = progress.d1.chunks[name];
  if (done && done.sha256 === sha256) {
    skippedChunks += 1;
    continue;
  }
  const label = `[${i + 1}/${chunkFiles.length}] ${name}`;
  process.stdout.write(`  ${label} ... `);
  const started = Date.now();
  await withRetry(
    async () => {
      const r = await runWrangler(
        ["d1", "execute", DB_NAME, "--remote", "--file", file, "--yes"],
        { timeoutMs: 15 * 60 * 1000 }
      );
      if (r.code !== 0) {
        throw new Error(`wrangler 退出码 ${r.code}：${(r.stderr || r.stdout).slice(-800)}`);
      }
      return r;
    },
    { attempts: 3, label }
  );
  progress.d1.chunks[name] = { sha256, at: new Date().toISOString(), ms: Date.now() - started };
  importedChunks += 1;
  saveProgress(true);
  console.log(`OK（${((Date.now() - started) / 1000).toFixed(1)} 秒）`);
}
console.log(`  D1 完成：新导入 ${fmtInt(importedChunks)} 片，跳过 ${fmtInt(skippedChunks)} 片。`);

// ---- 步骤 C：R2 对象断点续传 ----
console.log("");
console.log("[步骤 C] 上传 R2 对象（断点续传）");

// 若线上已清空且使用 API，先列出线上已有对象；仅 etag 严格一致的对象视为已完成
//（进度文件丢失也能续传，但绝不因 size 相同而跳过内容已变的同名对象）
if (HAS_API && progress.wipe.r2Done && !progress.wipe.r2Skipped) {
  try {
    console.log("  读取线上对象清单用于续传比对 ...");
    const remote = await listRemoteObjects("");
    let matched = 0;
    for (const obj of remote) {
      const m = manifestByKey.get(obj.key);
      if (m && isR2ObjectResumable(m, obj)) {
        const identity = r2ProgressIdentity(m);
        if (!identity) continue;
        // 只有远端 list 返回的 etag 与 manifest 严格一致，才登记 key+etag 身份；
        // 同时清掉旧版裸 key 记录，避免完成计数重复。
        r2Done.add(identity);
        r2Done.delete(m.key);
        matched += 1;
      }
    }
    progressDirty = true;
    console.log(`  线上已有 ${fmtInt(remote.length)} 个对象，其中 ${fmtInt(matched)} 个 etag 与清单一致，将跳过。`);
  } catch (err) {
    console.warn(`  [WARN] 线上对象清单读取失败，改为只信任本地进度文件：${shortErr(err)}`);
  }
}

const todo = manifest.filter((m) => !isR2DoneForManifest(m, r2Done));
const doneForManifest = manifest.length - todo.length;
console.log(`  待上传 ${fmtInt(todo.length)} 个（已完成 ${fmtInt(doneForManifest)} 个）`);
let uploadedCount = 0;
let uploadedBytes = 0;
let lastLog = Date.now();
const uploadStarted = Date.now();
const totalTodoBytes = todo.reduce((a, m) => a + m.size, 0);

async function uploadOne(rec) {
  if (!fs.existsSync(rec.blobPath)) {
    throw new Error(`blob 文件不存在：${rec.blobPath}`);
  }
  if (HAS_API) {
    const body = fs.readFileSync(rec.blobPath);
    await cfApi(
      "PUT",
      `/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET_NAME}/objects/${encodeObjectKey(rec.key)}`,
      { body, contentType: rec.contentType || "application/octet-stream", timeoutMs: 180000 }
    );
  } else {
    const r = await runWrangler(
      [
        "r2",
        "object",
        "put",
        `${BUCKET_NAME}/${rec.key}`,
        "--file",
        rec.blobPath,
        "--content-type",
        rec.contentType || "application/octet-stream"
      ],
      { timeoutMs: 5 * 60 * 1000 }
    );
    if (r.code !== 0) throw new Error(`wrangler 退出码 ${r.code}：${(r.stderr || r.stdout).slice(-500)}`);
  }
  markR2Done(rec.key, rec.size, rec.etag);
  uploadedCount += 1;
  uploadedBytes += rec.size;
  if (Date.now() - lastLog > 3000) {
    const pct = todo.length ? ((uploadedCount / todo.length) * 100).toFixed(1) : "100.0";
    const speed = uploadedBytes / Math.max(1, (Date.now() - uploadStarted) / 1000);
    console.log(
      `     ${fmtInt(uploadedCount)} / ${fmtInt(todo.length)}（${pct}%）  ${fmtBytes(uploadedBytes)}  ${fmtBytes(speed)}/s`
    );
    lastLog = Date.now();
    saveProgress();
  }
}

if (todo.length) {
  await runPool(todo, HAS_API ? CONCURRENCY : WRANGLER_CONCURRENCY, uploadOne);
}
saveProgress(true);
const skippedNow = doneForManifest + Math.max(0, todo.length - uploadedCount);
console.log(
  `  R2 完成：新上传 ${fmtInt(uploadedCount)} 个 / ${fmtBytes(uploadedBytes)}，本轮跳过 ${fmtInt(skippedNow)} 个（含历史已完成）。`
);

console.log("");
console.log("=".repeat(74));
console.log("上云完成");
console.log("=".repeat(74));
console.log(`  总耗时：${fmtDuration((Date.now() - uploadStarted) / 1000 + 0)}（步骤 C 起算）`);
console.log(`  进度文件：${PROGRESS_PATH}`);
console.log("");
console.log("建议线上抽检（只读）：");
console.log(`  cd apps/worker && npx wrangler d1 execute ${DB_NAME} --remote --command "SELECT COUNT(*) FROM contents"`);
console.log("");
} catch (err) {
  console.error("");
  console.error(`[FATAL] 上云中断：${err?.message || err}`);
  console.error("        已完成的 D1 分片 / R2 对象都记录在 upload-progress.json，修复网络或权限后重跑同一命令即可续传。");
  console.error("        若错误为 D1 每日 10 万行写入限额：等 UTC 0 点额度重置后重跑同一命令即可，已导入分片会自动跳过。");
  try {
    saveProgress(true);
  } catch {
    /* ignore */
  }
  process.exit(1);
}
