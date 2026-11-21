#!/usr/bin/env node
/**
 * 本地历史图片补采（独立只读入口，绝不访问知乎正文/评论/远端 Cloudflare）
 *
 * 背景：
 *   早期同步只在「图片下载成功」时才把正文里的 <img src> 改写成站内路径，
 *   失败则保留 pic*.zhimg.com 外链；后续 P1 改为「入库确定性改写 + image_tasks 队列」，
 *   但历史正文从未补过任务表。结果是：正文 HTML 仍在本地 R2，图片却缺对象。
 *
 * 本脚本只做三件事：
 *   1. 从本地 D1 读 contents 的 pk/content_hash，从本地 R2（wrangler state）读
 *      html/{pk}/{content_hash} 正文（缺失时回退历史键 html/{pk}）；
 *   2. 用与 worker/src/services/images.ts 的 prepareContentImages 完全相同的图片身份规则
 *      （URL pathname 去掉尺寸后缀后的 sha256 + URL 扩展名）算出对象名，
 *      对本地 R2 里还不存在的对象，按 image_tasks 生产结构幂等 INSERT OR IGNORE 入队；
 *   3. 通过 loopback 的本地 Worker /ingest/image-batch 有限批消费任务，最后输出剩余任务数。
 *
 * 硬性边界（本脚本自身实现保证）：
 *   - 只读 contents：绝不 upsert 正文、绝不改 content_hash、绝不写 html/*；
 *   - 已改写成 /api/images/<sha256>.<ext> 的 src 只按对象名核对，绝不会把站内路径
 *     当成图片去重新哈希（原始外链只从本地 image_tasks 行里按 object_key 取回）；
 *   - 写 D1 只用 wrangler d1 execute … --local --file=…（源码中不存在任何远端执行标志）；
 *   - 唯一网络目标是 LOCAL_WORKER_URL 指向的 loopback Worker（启动前校验 host）；
 *   - 临时 SQL 写在系统临时目录，finally 一律删除；日志只打印计数，不打印
 *     图片外链/签名、API_SECRET、HTML 或正文。
 *
 * 用法：
 *   node scripts/repair-local-images.mjs --repair-images
 *   node scripts/repair-local-images.mjs --repair-images --dry-run
 *   node scripts/repair-local-images.mjs --repair-images --image-scan-only
 *   node scripts/repair-local-images.mjs --repair-images --image-batch-size=20 --image-max-batches=5
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WORKER_DIR = path.join(ROOT, "apps", "worker");
const D1_STATE_DIR = path.join(WORKER_DIR, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
const R2_STATE_ROOT = path.join(WORKER_DIR, ".wrangler", "state", "v3", "r2");
const R2_DB_DIR = path.join(R2_STATE_ROOT, "miniflare-R2BucketObject");

/** 本地 Worker 固定端口（与 local-sync / full-local-harvest 一致）：只允许 loopback */
const LOCAL_WORKER_URL = "http://127.0.0.1:18787";
const DB_NAME = "zhihu-backup";

/** 与 worker 生产代码逐字一致的图片常量（静态回归测试会校验两边相等） */
const IMAGE_KEY_PREFIX = "images/";
const IMAGE_API_PREFIX = "/api/images/";
/** 单篇正文最多本地化多少张图：与 prepareContentImages 的上限保持一致 */
const MAX_IMAGES_PER_CONTENT = 50;
const ALLOWED_IMAGE_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg", "heic", "heif"
]);
/** 已改写的站内路径：对象名即 sha256 hex + 扩展名，绝不再当外链二次处理 */
const LOCAL_IMAGE_SRC_RE = /^\/api\/images\/([a-f0-9]{64}\.[a-z0-9]{2,5})$/;

/** 每批 INSERT 语句数：控制单个临时 SQL 文件体积，便于出错时定位 */
const IMAGE_TASK_INSERT_CHUNK = 1000;
/** 单次 /ingest/image-batch 的最长等待：20 张图 × 10 秒超时 / 4 并发 约 50 秒 */
const IMAGE_BATCH_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const opts = {
  // 显式模式标记（与 full-local-harvest --repair-images 同名，便于统一编排）
  repairImages: false,
  // 每批领取张数（1..100）
  imageBatchSize: 20,
  // 最多消费多少批；0 = 持续消费至队列清空或遇到失败
  imageMaxBatches: 0,
  // 只扫描入队，不消费
  imageScanOnly: false,
  // 只扫描统计：不写库、不下载
  dryRun: false,
  help: false
};

for (const arg of process.argv.slice(2)) {
  if (arg === "--repair-images") opts.repairImages = true;
  else if (arg.startsWith("--image-batch-size=")) {
    const n = Number(arg.slice("--image-batch-size=".length));
    const clamped = clampImageBatchSize(n);
    if (clamped !== Math.trunc(n)) {
      console.warn(`[warn] --image-batch-size 只接受 1..100，已按 ${clamped} 执行`);
    }
    opts.imageBatchSize = clamped;
  } else if (arg.startsWith("--image-max-batches=")) {
    const n = Number(arg.slice("--image-max-batches=".length));
    opts.imageMaxBatches = clampImageMaxBatches(n);
    if (opts.imageMaxBatches !== Math.trunc(n)) {
      console.warn("[warn] --image-max-batches 只接受 >=0 的整数，已按 0（不设上限）执行");
    }
  } else if (arg === "--image-scan-only") opts.imageScanOnly = true;
  else if (arg === "--dry-run") opts.dryRun = true;
  else if (arg === "--help" || arg === "-h") opts.help = true;
  else console.warn(`[warn] 忽略未知参数: ${arg}`);
}

// ---------------------------------------------------------------------------
// 图片身份（与 apps/worker/src/services/images.ts 逐字同规则，纯函数无 IO）
// ---------------------------------------------------------------------------
/**
 * 是否知乎图床域名（图片备份只允许 zhimg.com 及其子域的 https 地址）。
 * 与生产 isZhihuImageUrl 同规则：非 https、非法 URL、其他域名一律拒绝。
 */
function isZhihuImageUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return host === "zhimg.com" || host.endsWith(".zhimg.com");
}

/**
 * 图片身份串：只取 pathname，并剥掉知乎图床的尺寸后缀（_720w 等）。
 * 与生产 imageIdentity 逐字一致：子域轮换 / 签名 query / 尺寸抖动都不改变身份。
 */
function imageIdentity(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return url;
  }
  return pathname.replace(/^\/+/, "").replace(/_\d+w(?=\.[^./]+$)/i, "");
}

/** 从 URL 路径后缀推断扩展名；识别不了时返回 null（生产同规则，jpeg 归一成 jpg） */
function extensionFromUrl(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const match = pathname.match(/\.([a-z0-9]+)$/i);
  if (!match) return null;
  const ext = match[1].toLowerCase();
  if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) return null;
  return ext === "jpeg" ? "jpg" : ext;
}

/**
 * 把 <img src> 归一成可抓取的绝对 URL（生产 toFetchableUrl 同规则）：
 * 还原 &amp;、补协议相对地址的 https:、只放行知乎图床 https 地址。
 */
function toFetchableUrl(src) {
  const decoded = src.trim().replace(/&amp;/gi, "&");
  if (!decoded) return null;

  const absolute = decoded.startsWith("//") ? `https:${decoded}` : decoded;
  if (!/^https?:\/\//i.test(absolute)) return null;

  try {
    if (!isZhihuImageUrl(absolute)) return null;
    return new URL(absolute).toString();
  } catch {
    return null;
  }
}

/** 按文档顺序提取 <img src>，相同 URL 只保留一次（生产 extractImgSources 同规则） */
function extractImgSources(html) {
  const seen = new Set();
  const sources = [];
  const tagRe = /<img\b[^>]*>/gi;
  const srcAttrRe = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

  let tagMatch;
  while ((tagMatch = tagRe.exec(html)) !== null) {
    const attrMatch = srcAttrRe.exec(tagMatch[0]);
    if (!attrMatch) continue;
    const src = (attrMatch[1] ?? attrMatch[2] ?? "").trim();
    if (!src || seen.has(src)) continue;
    seen.add(src);
    sources.push(src);
  }
  return sources;
}

/** 与 Worker utils/hash.ts 的 sha256 同结果：UTF-8 字节的 64 位小写 hex */
function sha256Hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 外链 → R2 对象名（含 images/ 前缀）；无扩展名返回 null（保留现状，不猜格式） */
function imageObjectKeyForUrl(url) {
  const ext = extensionFromUrl(url);
  if (!ext) return null;
  return `${IMAGE_KEY_PREFIX}${sha256Hex(imageIdentity(url))}.${ext}`;
}

/** 已改写的站内路径 → 对象名（不含 images/ 前缀）；不是站内路径返回 null */
function localImageObjectName(src) {
  const value = String(src || "").trim();
  if (!value.startsWith(IMAGE_API_PREFIX)) return null;
  const match = LOCAL_IMAGE_SRC_RE.exec(value);
  return match ? match[1] : null;
}

/** 每批张数收敛到 1..100（NaN/非法值退回默认 20） */
function clampImageBatchSize(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 20;
  return Math.min(Math.max(n, 1), 100);
}

/** 批次数收敛到 >=0 的整数；NaN/非法值退回 0（不设上限） */
function clampImageMaxBatches(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(n, 0);
}

/** 只允许 loopback Worker：任何非本机地址都拒绝（防止误连线上 Worker） */
function assertLocalWorkerUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("本地 Worker 地址非法");
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && host !== "[::1]") {
    throw new Error(`拒绝非 loopback 的 Worker 地址：${host}`);
  }
  return parsed.origin;
}

/** 解析 /ingest/image-batch 响应为固定计数结构（缺失/非法一律按 0） */
function normalizeBatchResult(json) {
  const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  };
  return {
    claimed: num(json?.claimed),
    done: num(json?.done),
    failed: num(json?.failed),
    retry: num(json?.retry),
    limit: num(json?.limit)
  };
}

// ---------------------------------------------------------------------------
// 单篇正文 → 图片任务（纯函数：对象存在性与任务行都通过回调注入，便于隔离测试）
// ---------------------------------------------------------------------------
/**
 * 计算一篇正文需要补的图片任务。
 *
 * lookups.objectExists(objectKey) → boolean
 * lookups.findTask(objectKey)     → { imageUrl, status } | null（同 content_pk 下的任务行）
 *
 * 规则：
 *   - 站内路径 /api/images/<sha256>.<ext>：只核对对象是否存在。缺对象时原始外链
 *     只能从本地 image_tasks 行按 object_key 取回（sha256 不可逆），取不到就跳过；
 *     绝不对站内路径重新做哈希/下载。
 *   - 外链：与 prepareContentImages 完全一致地取前 MAX_IMAGES_PER_CONTENT 个可抓取 URL、
 *     按 sha256(pathname 身份) + URL 扩展名算对象名；对象已存在则跳过，否则生成任务。
 *     任务行已存在（pending/processing）时由现有队列消费，不再重复生成。
 */
function planContentImageTasks(html, lookups) {
  const counts = {
    images: 0,
    localPaths: 0,
    localBackedUp: 0,
    localTaskPending: 0,
    externalUrls: 0,
    externalBackedUp: 0,
    externalTaskPending: 0,
    newTasks: 0,
    skipped: {}
  };
  const tasks = [];
  const bump = (reason) => {
    counts.skipped[reason] = (counts.skipped[reason] || 0) + 1;
  };

  if (!html || !/<img\b/i.test(html)) return { tasks, counts };

  const sources = extractImgSources(html);
  counts.images = sources.length;

  // 站内路径先处理：它们不占 prepareContentImages 的 50 张上限
  const externalCandidates = [];
  for (const src of sources) {
    const name = localImageObjectName(src);
    if (name) {
      counts.localPaths += 1;
      const objectKey = `${IMAGE_KEY_PREFIX}${name}`;
      if (lookups.objectExists(objectKey)) {
        counts.localBackedUp += 1;
        continue;
      }
      const row = lookups.findTask(objectKey);
      if (!row) {
        bump("local-path-no-task");
        continue;
      }
      if (row.status === "failed") {
        bump("local-path-failed-task");
        continue;
      }
      if (row.status === "done") {
        bump("local-path-done-without-object");
        continue;
      }
      counts.localTaskPending += 1;
      continue;
    }

    const url = toFetchableUrl(src);
    if (!url) {
      bump("non-zhihu");
      continue;
    }
    externalCandidates.push({ src, url });
  }

  // 与生产一致：先截断到 50，再按扩展名过滤（无扩展名的 URL 也占用名额）
  if (externalCandidates.length > MAX_IMAGES_PER_CONTENT) {
    counts.skipped["over-limit"] = externalCandidates.length - MAX_IMAGES_PER_CONTENT;
  }
  const capped = externalCandidates.slice(0, MAX_IMAGES_PER_CONTENT);
  const planned = new Map();
  for (const target of capped) {
    counts.externalUrls += 1;
    const objectKey = imageObjectKeyForUrl(target.url);
    if (!objectKey) {
      bump("no-extension");
      continue;
    }
    if (lookups.objectExists(objectKey)) {
      counts.externalBackedUp += 1;
      continue;
    }
    const row = lookups.findTask(objectKey);
    if (row?.status === "failed") {
      bump("external-failed-task");
      continue;
    }
    if (row?.status === "done") {
      bump("external-done-without-object");
      continue;
    }
    if (row) {
      counts.externalTaskPending += 1;
      continue;
    }
    if (!planned.has(objectKey)) {
      planned.set(objectKey, { imageUrl: target.url, objectKey });
    }
  }
  counts.newTasks = planned.size;
  for (const task of planned.values()) tasks.push(task);
  return { tasks, counts };
}

// ---------------------------------------------------------------------------
// 日志（只打印计数与状态，绝不打印外链/HTML/密钥）
// ---------------------------------------------------------------------------
function log(...parts) {
  console.log(`[${new Date().toISOString()}] ${parts.join(" ")}`);
}

// ---------------------------------------------------------------------------
// 本地 SQLite（只读）+ R2 blobs
// ---------------------------------------------------------------------------
/** 目录下 mtime 最新的 .sqlite（与 verify-local-harvest 的定位方式一致） */
function newestSqliteFile(dir) {
  if (!fs.existsSync(dir)) return "";
  const candidates = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sqlite"))
    .map((name) => {
      const file = path.join(dir, name);
      return { file, mtimeMs: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.file || "";
}

/** 本地 R2 bucket 的 blobs 目录：优先固定名字，找不到再扫描同层目录 */
function discoverR2BlobDir() {
  const preferred = path.join(R2_STATE_ROOT, "zhihu-backup-storage", "blobs");
  if (fs.existsSync(preferred)) return preferred;
  if (!fs.existsSync(R2_STATE_ROOT)) return "";
  for (const entry of fs.readdirSync(R2_STATE_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "miniflare-R2BucketObject") continue;
    const candidate = path.join(R2_STATE_ROOT, entry.name, "blobs");
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

/** 只读打开本地 D1（query_only 双保险）：本脚本只读 contents/image_tasks 元数据 */
function openLocalD1() {
  const file = newestSqliteFile(D1_STATE_DIR);
  if (!file) throw new Error(`找不到本地 D1 Miniflare SQLite：${D1_STATE_DIR}`);
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 5_000 });
  try {
    db.pragma("query_only = ON");
  } catch {
    /* pragma 失败不影响只读连接本身 */
  }
  return db;
}

/**
 * 只读打开本地 R2（miniflare sqlite + blobs 目录）。
 * 只缓存「对象是否存在」：同一张图在多个正文里重复出现时只查一次 sqlite。
 */
function openLocalR2() {
  const dbFile = newestSqliteFile(R2_DB_DIR);
  if (!dbFile) throw new Error(`找不到本地 R2 Miniflare SQLite：${R2_DB_DIR}`);
  const blobDir = discoverR2BlobDir();
  if (!blobDir) throw new Error(`找不到本地 R2 blobs 目录：${R2_STATE_ROOT}`);

  const db = new Database(dbFile, { readonly: true, fileMustExist: true, timeout: 5_000 });
  try {
    db.pragma("query_only = ON");
  } catch {
    /* pragma 失败不影响只读连接本身 */
  }
  const objectStmt = db.prepare("SELECT blob_id FROM _mf_objects WHERE key = ?");
  // 只缓存「对象是否存在」：正文 HTML 不缓存，逐篇读完即释放，避免几万篇正文驻留内存
  const existsCache = new Map();

  return {
    exists(key) {
      if (existsCache.has(key)) return existsCache.get(key);
      const found = Boolean(objectStmt.get(key));
      existsCache.set(key, found);
      return found;
    },
    readText(key) {
      const row = objectStmt.get(key);
      if (!row || !row.blob_id) return null;
      try {
        return fs.readFileSync(path.join(blobDir, row.blob_id), "utf8");
      } catch {
        return null;
      }
    },
    close() {
      db.close();
    }
  };
}

/** image_tasks 现有行：(content_pk, object_key) → { imageUrl, status } */
function loadImageTaskRows(db) {
  const map = new Map();
  const table = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'image_tasks'")
    .get();
  if (!table) return map;
  const rows = db
    .prepare("SELECT content_pk, object_key, image_url, status FROM image_tasks")
    .all();
  for (const row of rows) {
    map.set(`${row.content_pk}\u0000${row.object_key}`, {
      imageUrl: String(row.image_url || ""),
      status: String(row.status || "")
    });
  }
  return map;
}

/** 当前 image_tasks 状态分布；表不存在时返回空对象 */
function readImageTaskStatusCounts(db) {
  const table = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'image_tasks'")
    .get();
  if (!table) return {};
  const counts = {};
  const rows = db.prepare("SELECT status, COUNT(*) AS c FROM image_tasks GROUP BY status").all();
  for (const row of rows) counts[String(row.status)] = Number(row.c) || 0;
  return counts;
}

// ---------------------------------------------------------------------------
// 子进程 / 本地 Worker 鉴权
// ---------------------------------------------------------------------------
function runChild(command, args, { cwd, env, silent = false, maxCapture = 256 * 1024 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      if (stdout.length < maxCapture) stdout += text;
      if (!silent) process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      if (stderr.length < maxCapture) stderr += text;
      if (!silent) process.stderr.write(text);
    });
    child.on("error", (err) => {
      resolve({ code: 1, stdout, stderr: stderr + String(err?.message || err) });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
    try {
      child.stdin.write("y\n");
      child.stdin.end();
    } catch {
      /* ignore */
    }
  });
}

function wranglerBin() {
  const candidates = [
    path.join(WORKER_DIR, "node_modules", "wrangler", "bin", "wrangler.js"),
    path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js"),
    path.join(ROOT, "node_modules", ".bin", "wrangler")
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return "";
}

function readEnvFile(file) {
  const out = new Map();
  if (!fs.existsSync(file)) return out;
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!out.has(key) && value) out.set(key, value);
  }
  return out;
}

/** 候选密钥：env > .env.local > .dev.vars（值只在内存中使用，绝不打印） */
function secretCandidates() {
  const envLocal = readEnvFile(path.join(ROOT, ".env.local"));
  const devVars = readEnvFile(path.join(WORKER_DIR, ".dev.vars"));
  const list = [
    { value: String(process.env.API_SECRET || "").trim(), source: "env.API_SECRET" },
    { value: String(envLocal.get("API_SECRET") || "").trim(), source: ".env.local" },
    { value: String(devVars.get("API_SECRET") || "").trim(), source: ".dev.vars" }
  ];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item.value || seen.has(item.value)) continue;
    seen.add(item.value);
    out.push(item);
  }
  return out;
}

async function fetchJson(url, init = {}, timeoutMs = 30_000) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON（错误页等） */
  }
  return { res, json };
}

/** 唯一的网络出口：只拼 loopback Worker 的固定路径 */
async function localRequest(pathname, init = {}, secret = "", timeoutMs = 20_000) {
  const headers = { ...(init.headers || {}) };
  if (secret) headers.authorization = `Bearer ${secret}`;
  if (init.body && !headers["content-type"]) headers["content-type"] = "application/json";
  return fetchJson(`${LOCAL_WORKER_URL}${pathname}`, { ...init, headers }, timeoutMs);
}

async function localHealthy() {
  try {
    const { res } = await fetchJson(`${LOCAL_WORKER_URL}/api/stats`, {}, 5_000);
    return res.ok;
  } catch {
    return false;
  }
}

/** 用 /ingest/sync-state 探测哪个候选密钥才是本地 Worker 的 API_SECRET */
async function resolveLocalSecret() {
  const candidates = secretCandidates();
  if (candidates.length === 0) {
    throw new Error("未找到 API_SECRET：请检查 .env.local / apps/worker/.dev.vars 或环境变量");
  }
  if (!(await localHealthy())) {
    throw new Error(
      `本地 Worker 未就绪（${LOCAL_WORKER_URL}/api/stats 无响应）。` +
        `请先按现有流程启动本地 Worker 再重跑（本脚本不会自行拉起服务）`
    );
  }
  for (const candidate of candidates) {
    try {
      const { res } = await localRequest("/ingest/sync-state", {}, candidate.value, 10_000);
      if (res.ok) {
        log(`[auth] 已校验本地 Worker API_SECRET（来源: ${candidate.source}，值不落日志）`);
        return candidate;
      }
    } catch {
      /* 尝试下一个候选 */
    }
  }
  throw new Error(
    "本地 Worker 拒绝所有候选 API_SECRET（401）。请确认 apps/worker/.dev.vars 与 .env.local 中的 API_SECRET 一致"
  );
}

// ---------------------------------------------------------------------------
// 扫描：本地 D1 contents + 本地 R2 正文 HTML → 计划任务
// ---------------------------------------------------------------------------
function scanContents(r2, taskRows) {
  const db = openLocalD1();
  const totals = {
    contents: 0,
    htmlRead: 0,
    legacyHtml: 0,
    htmlMissing: 0,
    emptyContent: 0,
    badPk: 0,
    images: 0,
    localPaths: 0,
    localBackedUp: 0,
    localTaskPending: 0,
    externalUrls: 0,
    externalBackedUp: 0,
    externalTaskPending: 0,
    newTasks: 0,
    skipped: {}
  };
  const tasks = [];

  try {
    const rows = db
      .prepare("SELECT pk, content_hash FROM contents WHERE is_deleted = 0 ORDER BY pk")
      .all();
    totals.contents = rows.length;

    let processed = 0;
    for (const row of rows) {
      processed += 1;
      const pk = String(row.pk || "");
      const hash = String(row.content_hash || "");
      // content_hash 为空串的正文本来就不写 R2 对象，不算缺失
      if (!hash) {
        totals.emptyContent += 1;
        continue;
      }
      if (!/^(answer|article|pin):\d+$/.test(pk)) {
        totals.badPk += 1;
        continue;
      }

      let html = r2.readText(`html/${pk}/${hash}`);
      if (html === null) {
        html = r2.readText(`html/${pk}`);
        if (html !== null) totals.legacyHtml += 1;
      }
      if (html === null) {
        totals.htmlMissing += 1;
        continue;
      }
      totals.htmlRead += 1;

      const plan = planContentImageTasks(html, {
        objectExists: (objectKey) => r2.exists(objectKey),
        findTask: (objectKey) => taskRows.get(`${pk}\u0000${objectKey}`) || null
      });

      totals.images += plan.counts.images;
      totals.localPaths += plan.counts.localPaths;
      totals.localBackedUp += plan.counts.localBackedUp;
      totals.localTaskPending += plan.counts.localTaskPending;
      totals.externalUrls += plan.counts.externalUrls;
      totals.externalBackedUp += plan.counts.externalBackedUp;
      totals.externalTaskPending += plan.counts.externalTaskPending;
      totals.newTasks += plan.counts.newTasks;
      for (const [reason, count] of Object.entries(plan.counts.skipped)) {
        totals.skipped[reason] = (totals.skipped[reason] || 0) + count;
      }
      for (const task of plan.tasks) {
        tasks.push({ contentPk: pk, imageUrl: task.imageUrl, objectKey: task.objectKey });
      }

      if (processed % 2000 === 0) {
        log(`[scan] ${processed}/${rows.length} 篇，已计划任务 ${tasks.length} 个`);
      }
    }
  } finally {
    db.close();
  }

  return { totals, tasks };
}

function printScanSummary(totals) {
  log(
    `[scan] 内容 ${totals.contents} 篇：读取正文 ${totals.htmlRead} 篇` +
      `（其中旧键 html/{pk} 回退 ${totals.legacyHtml} 篇）、正文缺失 ${totals.htmlMissing} 篇、` +
      `空正文跳过 ${totals.emptyContent} 篇、脏 pk ${totals.badPk} 篇`
  );
  log(
    `[scan] <img> 唯一 src ${totals.images} 个：站内路径 ${totals.localPaths}` +
      `（对象存在 ${totals.localBackedUp}、已有待处理任务 ${totals.localTaskPending}）、` +
      `知乎外链 ${totals.externalUrls}（对象已存在 ${totals.externalBackedUp}、已有待处理任务 ${totals.externalTaskPending}）`
  );
  const reasons = Object.entries(totals.skipped)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${count}`);
  log(
    `[plan] 本轮需入队 ${totals.newTasks} 个图片任务；跳过/保留现状 ${reasons.length ? reasons.join(" / ") : "0"}`
  );
}

// ---------------------------------------------------------------------------
// 写库：幂等 INSERT OR IGNORE（wrangler 本地 SQL，绝不触碰远端）
// ---------------------------------------------------------------------------
function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function insertImageTasks(tasks, tempDir) {
  if (!tasks.length) return 0;
  const bin = wranglerBin();
  if (!bin) throw new Error("找不到 wrangler：请先在仓库根目录执行 pnpm install");

  const now = new Date().toISOString();
  let submitted = 0;
  for (let i = 0; i < tasks.length; i += IMAGE_TASK_INSERT_CHUNK) {
    const chunk = tasks.slice(i, i + IMAGE_TASK_INSERT_CHUNK);
    const sqlPath = path.join(tempDir, `image-tasks-${Math.floor(i / IMAGE_TASK_INSERT_CHUNK) + 1}.sql`);
    // 与生产 enqueueImageTasks 的新插行完全一致：pending / attempts=0 / 同一时间戳
    const sql = chunk
      .map(
        (task) =>
          "INSERT OR IGNORE INTO image_tasks " +
          "(content_pk, image_url, object_key, status, attempts, created_at, updated_at) " +
          `VALUES (${sqlLiteral(task.contentPk)}, ${sqlLiteral(task.imageUrl)}, ` +
          `${sqlLiteral(task.objectKey)}, 'pending', 0, ${sqlLiteral(now)}, ${sqlLiteral(now)});`
      )
      .join("\n");
    try {
      fs.writeFileSync(sqlPath, sql, { encoding: "utf8", mode: 0o600 });
      // silent：SQL 文件里有带签名的图片外链，wrangler 输出不回显到控制台
      const result = await runChild(
        process.execPath,
        [bin, "d1", "execute", DB_NAME, "--local", "--yes", `--file=${sqlPath}`],
        { cwd: WORKER_DIR, silent: true }
      );
      if (result.code !== 0) {
        const detail = String(result.stderr || "").replace(/\s+/g, " ").slice(0, 300);
        throw new Error(
          `本地 D1 写入 image_tasks 失败（退出码 ${result.code}）${detail ? `: ${detail}` : ""}`
        );
      }
      submitted += chunk.length;
      log(`[enqueue] 已提交 ${submitted}/${tasks.length} 条 INSERT OR IGNORE`);
    } finally {
      try {
        fs.rmSync(sqlPath, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  return submitted;
}

// ---------------------------------------------------------------------------
// 消费：有限批调用本地 Worker /ingest/image-batch
// ---------------------------------------------------------------------------
async function consumeImageBatches(secret) {
  let batches = 0;
  let claimed = 0;
  let done = 0;
  let failed = 0;
  let retry = 0;

  for (;;) {
    if (opts.imageMaxBatches > 0 && batches >= opts.imageMaxBatches) {
      log(`[consume] 已达到 --image-max-batches=${opts.imageMaxBatches}，停止消费`);
      break;
    }
    const { res, json } = await localRequest(
      "/ingest/image-batch",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: opts.imageBatchSize })
      },
      secret.value,
      IMAGE_BATCH_TIMEOUT_MS
    );
    if (!res.ok) {
      const reason = json && typeof json.error === "string" ? `: ${json.error}` : "";
      throw new Error(`/ingest/image-batch 失败（HTTP ${res.status}）${reason}`);
    }

    const one = normalizeBatchResult(json);
    batches += 1;
    claimed += one.claimed;
    done += one.done;
    failed += one.failed;
    retry += one.retry;
    log(
      `[consume] 批次 ${batches}: 领取 ${one.claimed} / 成功 ${one.done} / 重试 ${one.retry} / 失败 ${one.failed}`
    );

    // 终止条件（缺一不可地避免死循环）：
    // 1) 队列已空；2) 本批一张都没成功（失败/重试）→ 立即停，避免连续打图床；
    // 3) 达到 --image-max-batches 上限（循环开头判断）。
    // 不按 one.claimed < opts.imageBatchSize 早停，避免服务端钳制上限或并发领取短批时误退出。
    if (one.claimed === 0) {
      log("[consume] 队列已空，停止消费");
      break;
    }
    if (one.done === 0) {
      log("[consume] 本批无成功下载（全部失败/重试），停止消费，避免连续打图床");
      break;
    }
  }

  log(
    `[consume] 累计：批次 ${batches} / 领取 ${claimed} / 成功 ${done} / 重试 ${retry} / 失败 ${failed}`
  );
}

// ---------------------------------------------------------------------------
// 汇报：剩余任务数
// ---------------------------------------------------------------------------
function reportRemaining() {
  const db = openLocalD1();
  let counts = {};
  try {
    counts = readImageTaskStatusCounts(db);
  } finally {
    db.close();
  }
  const pending = Number(counts.pending || 0);
  const processing = Number(counts.processing || 0);
  const failed = Number(counts.failed || 0);
  const doneCount = Number(counts.done || 0);
  log(
    `[remaining] image_tasks: pending ${pending} / processing ${processing} / failed ${failed} / done ${doneCount}` +
      `（剩余待消费 ${pending + processing}）`
  );
  return { pending, processing, failed, done: doneCount };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function printHelp() {
  console.log(
    [
      "本地历史图片补采（独立入口，只读本地 D1/R2，不访问知乎正文/评论/远端 Cloudflare）",
      "",
      "作用：按 worker 生产图片身份规则（URL pathname 去尺寸后缀后的 sha256 + 扩展名）",
      "      从本地已落盘正文重建 image_tasks，再有限批调用本地 Worker /ingest/image-batch。",
      "",
      "用法：",
      "  node scripts/repair-local-images.mjs --repair-images",
      "  node scripts/repair-local-images.mjs --repair-images --dry-run         只扫描统计，不写库、不下载",
      "  node scripts/repair-local-images.mjs --repair-images --image-scan-only 只扫描入队，不消费",
      "",
      "可选参数：",
      "  --image-batch-size=20      每批领取张数（1..100，默认 20）",
      "  --image-max-batches=0      最多消费多少批；0=持续消费至队列清空或遇到失败（默认 0）",
      "  --image-scan-only          仅扫描并入队，不调用 /ingest/image-batch",
      "  --dry-run                  仅扫描统计：不写 image_tasks、不下载、不调用 Worker",
      "  --help                     显示本帮助",
      "",
      "必须显式传 --repair-images 才会执行（避免误跑全量补图）。",
      "",
      "边界：不 upsert 正文、不改 content_hash、不写 R2 html 对象；写库只用",
      "      wrangler d1 execute --local；图片只从本地 Worker（loopback）批量下载。"
    ].join("\n")
  );
}

async function main() {
  if (opts.help) {
    printHelp();
    return;
  }
  if (!opts.repairImages) {
    console.error("[fatal] 必须显式传 --repair-images 才会执行（避免误跑全量补图）");
    printHelp();
    process.exitCode = 2;
    return;
  }
  assertLocalWorkerUrl(LOCAL_WORKER_URL);
  log("=== 本地历史图片补采（只读正文 + 本地 D1/R2 → image_tasks）===");
  log(
    `[opts] dry-run=${opts.dryRun} scan-only=${opts.imageScanOnly} ` +
      `batch-size=${opts.imageBatchSize} max-batches=${opts.imageMaxBatches}`
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zhihu-image-repair-"));
  let r2 = null;
  try {
    r2 = openLocalR2();
    const db = openLocalD1();
    let taskRows;
    try {
      taskRows = loadImageTaskRows(db);
    } finally {
      db.close();
    }

    const { totals, tasks } = scanContents(r2, taskRows);
    printScanSummary(totals);

    if (opts.dryRun) {
      log("[dry-run] 仅扫描统计：未写 image_tasks、未下载、未调用本地 Worker");
      reportRemaining();
      return;
    }

    if (tasks.length > 0) {
      await insertImageTasks(tasks, tempDir);
    } else {
      log("[enqueue] 没有需要新入队的图片任务");
    }

    if (opts.imageScanOnly) {
      log("[scan-only] 已入队，未调用 /ingest/image-batch");
      reportRemaining();
      return;
    }

    const secret = await resolveLocalSecret();
    await consumeImageBatches(secret);
    reportRemaining();
  } finally {
    if (r2) r2.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error(`[fatal] 图片补采失败: ${err?.message || err}`);
  process.exitCode = 1;
});
