#!/usr/bin/env node
/**
 * 路线 A：纯 Node 并发补采本地图片（绕开 workerd 批量下载 OOM）
 *
 * 严格对齐生产逻辑：
 *   - URL 校验、尺寸后缀、10MB 体积上限、MIME 规则与 apps/worker/src/services/images.ts 一致；
 *   - 状态机（pending / processing / done / failed, MAX_ATTEMPTS=3）与 image-tasks.ts 一致；
 *   - R2 _mf_objects 与 blobs/<blob_id> 写入格式与 Miniflare v3 / upload-to-cloudflare.mjs 一致。
 *
 * 安全约束：
 *   - 写模式启动前检查本地无 workerd 进程占用 SQLite；
 *   - 绝不在日志/异常中打印带签名的 image_url、Cookie 或密钥。
 *
 * 用法：
 *   node scripts/download-images-direct.mjs --dry-run
 *   node scripts/download-images-direct.mjs --limit=10
 *   node scripts/download-images-direct.mjs --concurrency=12
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WORKER_DIR = path.join(ROOT, "apps", "worker");
const D1_STATE_DIR = path.join(WORKER_DIR, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
const R2_STATE_ROOT = path.join(WORKER_DIR, ".wrangler", "state", "v3", "r2");
const R2_DB_DIR = path.join(R2_STATE_ROOT, "miniflare-R2BucketObject");

const IMAGE_KEY_PREFIX = "images/";
const IMAGE_OBJECT_KEY_RE = /^images\/[a-f0-9]{64}\.[a-z0-9]{2,5}$/;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_TASK_ATTEMPTS = 3;
const PROCESSING_STALE_MS = 10 * 60 * 1000;
const SIZE_VARIANT_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);
const VALID_IMAGE_QUALITIES = new Set(["original", "high", "compressed"]);

const CONTENT_TYPE_BY_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  heic: "image/heic",
  heif: "image/heif"
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const opts = {
  dryRun: false,
  reconcileOnly: false,
  skipReconcile: false,
  limit: 0,
  concurrency: 12,
  timeoutMs: 15_000,
  retryFailed: false,
  help: false
};

for (const arg of process.argv.slice(2)) {
  if (arg === "--dry-run") opts.dryRun = true;
  else if (arg === "--reconcile-only") opts.reconcileOnly = true;
  else if (arg === "--skip-reconcile") opts.skipReconcile = true;
  else if (arg === "--retry-failed") opts.retryFailed = true;
  else if (arg === "--help" || arg === "-h") opts.help = true;
  else if (arg.startsWith("--limit=")) {
    const n = Math.trunc(Number(arg.slice("--limit=".length)));
    opts.limit = Number.isFinite(n) && n > 0 ? n : 0;
  } else if (arg.startsWith("--concurrency=")) {
    const n = Math.trunc(Number(arg.slice("--concurrency=".length)));
    opts.concurrency = Number.isFinite(n) ? Math.min(Math.max(n, 1), 32) : 12;
  } else if (arg.startsWith("--timeout-ms=")) {
    const n = Math.trunc(Number(arg.slice("--timeout-ms=".length)));
    opts.timeoutMs = Number.isFinite(n) && n >= 1000 ? n : 15_000;
  } else {
    console.error(`[fatal] 未知参数: ${arg}`);
    process.exit(2);
  }
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function discoverSqlite(dir) {
  if (!fs.existsSync(dir)) return "";
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sqlite"))
    .map((f) => {
      const file = path.join(dir, f);
      return { file, mtimeMs: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.file || "";
}

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

function assertNoWorkerdRunning() {
  if (process.platform === "win32") {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq workerd.exe", "/NH"], {
      encoding: "utf8"
    });
    if (/workerd\.exe/i.test(out)) {
      throw new Error("检测到 workerd.exe 正在运行，请先停止本地 wrangler dev 再写入 Miniflare SQLite");
    }
    return;
  }
  try {
    const out = execFileSync("pgrep", ["-x", "workerd"], { encoding: "utf8" });
    if (out.trim()) {
      throw new Error("检测到 workerd 正在运行，请先停止本地 wrangler dev 再写入 Miniflare SQLite");
    }
  } catch (err) {
    if (err && err.status === 1) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 生产等价工具函数（与 apps/worker/src/services/images.ts 一致）
// ---------------------------------------------------------------------------
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

function contentTypeForImageName(name) {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return CONTENT_TYPE_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}

function applySizeVariant(url, quality) {
  if (quality === "original") return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const pathname = parsed.pathname;
  const stripped = pathname.replace(/_\d+w(?=\.[^./]+$)/i, "");
  const dot = stripped.lastIndexOf(".");
  const slash = stripped.lastIndexOf("/");
  if (dot <= slash) return url;
  const ext = stripped.slice(dot + 1).toLowerCase();
  if (!SIZE_VARIANT_EXTENSIONS.has(ext)) return url;
  const suffix = quality === "high" ? "_1440w" : "_720w";
  const nextPath = `${stripped.slice(0, dot)}${suffix}${stripped.slice(dot)}`;
  if (nextPath === pathname) return url;
  parsed.pathname = nextPath;
  return parsed.toString();
}

function readImageQuality(d1, r2, blobDir) {
  try {
    const row = r2.prepare("SELECT blob_id FROM _mf_objects WHERE key = 'config/sync_config.json'").get();
    if (row?.blob_id) {
      const cfg = JSON.parse(fs.readFileSync(path.join(blobDir, row.blob_id), "utf8"));
      if (VALID_IMAGE_QUALITIES.has(cfg?.imageQuality)) return cfg.imageQuality;
    }
  } catch {
    /* ignore */
  }
  try {
    const row = d1.prepare("SELECT value FROM app_settings WHERE key = 'sync_config'").get();
    if (row?.value) {
      const cfg = JSON.parse(row.value);
      if (VALID_IMAGE_QUALITIES.has(cfg?.imageQuality)) return cfg.imageQuality;
    }
  } catch {
    /* ignore */
  }
  return "original";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readResponseWithLimit(res, maxBytes) {
  const declared = Number(res.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return { ok: false, reason: `content-length ${declared} exceeds ${maxBytes}` };
  }
  if (!res.body) {
    return { ok: false, reason: "empty body" };
  }

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: `body exceeds ${maxBytes} bytes` };
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    return { ok: false, reason: `stream error: ${err?.message || "unknown"}` };
  } finally {
    reader.releaseLock();
  }
  if (total === 0) return { ok: false, reason: "empty body" };
  return { ok: true, buffer: Buffer.concat(chunks, total) };
}

async function fetchSingleCandidate(url, timeoutMs) {
  let res;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
      headers: {
        accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5"
      }
    });
  } catch (err) {
    const code = err?.cause?.code || err?.name || "fetch_error";
    return { ok: false, transient: true, reason: `network ${code}` };
  }

  if (res.status >= 300 && res.status < 400) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return { ok: false, transient: false, reason: `redirect HTTP ${res.status}` };
  }
  if (!res.ok) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    const transient = res.status === 429 || res.status >= 500;
    return { ok: false, transient, reason: `HTTP ${res.status}` };
  }

  const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (contentType && !contentType.startsWith("image/") && contentType !== "application/octet-stream") {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return { ok: false, transient: false, reason: `non-image content-type: ${contentType}` };
  }

  const body = await readResponseWithLimit(res, MAX_IMAGE_BYTES);
  if (!body.ok) {
    return { ok: false, transient: false, reason: body.reason };
  }

  return { ok: true, buffer: body.buffer, contentType };
}

async function downloadGroupImage(group, quality, timeoutMs) {
  let lastReason = "download failed";
  for (const sourceUrl of group.urls) {
    if (!isZhihuImageUrl(sourceUrl)) {
      lastReason = "non-zhihu url";
      continue;
    }
    const variantUrl = applySizeVariant(sourceUrl, quality);
    const candidates = variantUrl === sourceUrl ? [sourceUrl] : [variantUrl, sourceUrl];
    for (const candidate of candidates) {
      let attempt = await fetchSingleCandidate(candidate, timeoutMs);
      if (!attempt.ok && attempt.transient) {
        await sleep(500);
        attempt = await fetchSingleCandidate(candidate, timeoutMs);
      }
      if (attempt.ok) {
        return {
          ok: true,
          buffer: attempt.buffer,
          contentType: attempt.contentType,
          sourceUrl
        };
      }
      lastReason = attempt.reason;
    }
  }
  return { ok: false, reason: lastReason };
}

function buildBlobId() {
  const rand = crypto.randomBytes(32).toString("hex");
  const ts = Date.now().toString(16).padStart(16, "0");
  return `${rand}${ts}`;
}

function writeBlobAtomic(blobDir, blobId, buffer) {
  const target = path.join(blobDir, blobId);
  const tmp = path.join(blobDir, `${blobId}.tmp-${process.pid}`);
  try {
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function buildR2Row(objectKey, blobId, buffer, contentType, quality, sourceUrl) {
  const objectName = objectKey.slice(IMAGE_KEY_PREFIX.length);
  const resolvedType = contentType || contentTypeForImageName(objectName);
  return {
    key: objectKey,
    blob_id: blobId,
    version: crypto.randomBytes(16).toString("hex"),
    size: buffer.byteLength,
    etag: crypto.createHash("md5").update(buffer).digest("hex"),
    uploaded: Date.now(),
    checksums: "{}",
    http_metadata: JSON.stringify({ contentType: resolvedType }),
    custom_metadata: JSON.stringify({
      kind: "image",
      quality,
      sourceUrl: sourceUrl.slice(0, 900)
    })
  };
}

function printHelp() {
  console.log(`路线 A：纯 Node 并发补采本地图片

用法：
  node scripts/download-images-direct.mjs --dry-run
  node scripts/download-images-direct.mjs --limit=10
  node scripts/download-images-direct.mjs --concurrency=12

参数：
  --dry-run          只读扫描并统计待下载与可核销数，不修改任何文件
  --reconcile-only   仅把 R2 已存在对象的任务标记为 done，不发网络请求
  --skip-reconcile   跳过核销已有 R2 对象（适合只做小样本下载测试）
  --limit=N          本次最多下载 N 个唯一 object_key（0 = 不限）
  --concurrency=N    并发下载数（1..32，默认 12）
  --timeout-ms=N     单图下载超时毫秒数（默认 15000）
  --retry-failed     同时重试 status='failed' 的任务
  --help             显示帮助
`);
}

async function main() {
  if (opts.help) {
    printHelp();
    return;
  }

  const d1Path = discoverSqlite(D1_STATE_DIR);
  const r2Path = discoverSqlite(R2_DB_DIR);
  const blobDir = discoverR2BlobDir();
  if (!d1Path || !r2Path || !blobDir) {
    throw new Error(`找不到本地 Miniflare SQLite/blobs（d1=${Boolean(d1Path)}, r2=${Boolean(r2Path)}, blobs=${Boolean(blobDir)}）`);
  }

  if (!opts.dryRun) {
    assertNoWorkerdRunning();
  }

  const d1 = new Database(d1Path, opts.dryRun ? { readonly: true, fileMustExist: true, timeout: 10_000 } : { fileMustExist: true, timeout: 10_000 });
  const r2 = new Database(r2Path, opts.dryRun ? { readonly: true, fileMustExist: true, timeout: 10_000 } : { fileMustExist: true, timeout: 10_000 });
  if (opts.dryRun) {
    d1.pragma("query_only = ON");
    r2.pragma("query_only = ON");
  }

  try {
    const quality = readImageQuality(d1, r2, blobDir);
    const staleBefore = new Date(Date.now() - PROCESSING_STALE_MS).toISOString();
    const whereClause = opts.retryFailed
      ? "status = 'pending' OR status = 'failed' OR (status = 'processing' AND updated_at < ?)"
      : "status = 'pending' OR (status = 'processing' AND updated_at < ?)";

    const taskRows = d1
      .prepare(`SELECT id, image_url, object_key, status, attempts FROM image_tasks WHERE ${whereClause} ORDER BY id`)
      .all(staleBefore);

    const existingR2Rows = r2
      .prepare("SELECT key, blob_id, size FROM _mf_objects WHERE key LIKE 'images/%'")
      .all();
    const validR2Keys = new Set();
    for (const row of existingR2Rows) {
      if (!row.blob_id) continue;
      try {
        const st = fs.statSync(path.join(blobDir, row.blob_id));
        if (st.isFile() && st.size > 0 && st.size === row.size) {
          validR2Keys.add(row.key);
        }
      } catch {
        /* blob 缺失则视为需重新下载 */
      }
    }

    const reconcileIds = [];
    const groupsMap = new Map();
    let invalidKeyCount = 0;

    for (const row of taskRows) {
      if (!IMAGE_OBJECT_KEY_RE.test(row.object_key)) {
        invalidKeyCount += 1;
        continue;
      }
      if (validR2Keys.has(row.object_key)) {
        reconcileIds.push(row.id);
        continue;
      }
      let group = groupsMap.get(row.object_key);
      if (!group) {
        group = { objectKey: row.object_key, tasks: [], urls: [] };
        groupsMap.set(row.object_key, group);
      }
      // --retry-failed 重试历史失败行时重置起点 attempts，确保仍享有完整 3 次重试预算
      const startAttempts =
        row.status === "failed"
          ? 0
          : Math.min(Math.max(0, Number(row.attempts) || 0), MAX_IMAGE_TASK_ATTEMPTS - 1);
      group.tasks.push({ id: row.id, attempts: startAttempts });
      if (row.image_url && !group.urls.includes(row.image_url)) {
        group.urls.push(row.image_url);
      }
    }

    const allGroups = Array.from(groupsMap.values());
    const targetGroups = opts.limit > 0 ? allGroups.slice(0, opts.limit) : allGroups;

    log(
      `[scan] quality=${quality} 待处理任务行=${taskRows.length}，已在R2可核销行=${reconcileIds.length}，` +
        `待下载唯一对象=${allGroups.length}（本次计划=${targetGroups.length}），非法key=${invalidKeyCount}`
    );

    if (opts.dryRun) {
      log("[dry-run] 只读统计完成，未写入任何数据。");
      return;
    }

    if (!opts.skipReconcile && reconcileIds.length > 0) {
      const now = new Date().toISOString();
      const stmtReconcile = d1.prepare(
        "UPDATE image_tasks SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?"
      );
      const tx = d1.transaction((ids) => {
        for (const id of ids) stmtReconcile.run(now, id);
      });
      tx(reconcileIds);
      log(`[reconcile] 已将 ${reconcileIds.length} 条已在 R2 的任务行核销为 done`);
    }

    if (opts.reconcileOnly || targetGroups.length === 0) {
      log("[done] 无需下载更多图片。");
      return;
    }

    const stmtPutR2 = r2.prepare(`
      INSERT OR REPLACE INTO _mf_objects
        (key, blob_id, version, size, etag, uploaded, checksums, http_metadata, custom_metadata)
      VALUES
        (@key, @blob_id, @version, @size, @etag, @uploaded, @checksums, @http_metadata, @custom_metadata)
    `);
    const stmtMarkDone = d1.prepare(
      "UPDATE image_tasks SET status = 'done', attempts = ?, last_error = NULL, updated_at = ? WHERE id = ?"
    );
    const stmtMarkRetry = d1.prepare(
      "UPDATE image_tasks SET status = 'pending', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?"
    );
    const stmtMarkFailed = d1.prepare(
      "UPDATE image_tasks SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?"
    );

    const pendingR2Commits = [];
    const pendingD1Commits = [];
    const FLUSH_BATCH_SIZE = 20;

    function flushPendingCommits() {
      if (pendingR2Commits.length > 0) {
        const items = pendingR2Commits.splice(0, pendingR2Commits.length);
        const txR2 = r2.transaction((rows) => {
          for (const r of rows) stmtPutR2.run(r);
        });
        txR2(items);
      }
      if (pendingD1Commits.length > 0) {
        const items = pendingD1Commits.splice(0, pendingD1Commits.length);
        const txD1 = d1.transaction((ops) => {
          for (const op of ops) {
            for (const t of op.tasks) {
              const nextAttempts = t.attempts + 1;
              if (op.ok) {
                stmtMarkDone.run(nextAttempts, op.now, t.id);
              } else if (nextAttempts >= MAX_IMAGE_TASK_ATTEMPTS) {
                stmtMarkFailed.run(nextAttempts, op.reason, op.now, t.id);
              } else {
                stmtMarkRetry.run(nextAttempts, op.reason, op.now, t.id);
              }
            }
          }
        });
        txD1(items);
      }
    }

    let cursor = 0;
    let processedObjects = 0;
    let succeededObjects = 0;
    let failedObjects = 0;
    let succeededRows = 0;
    let failedRows = 0;
    let downloadedBytes = 0;
    const sampleKeys = [];
    const failureReasons = new Map();
    const startedAt = Date.now();

    async function worker() {
      for (;;) {
        const idx = cursor;
        cursor += 1;
        if (idx >= targetGroups.length) return;

        const group = targetGroups[idx];
        const res = await downloadGroupImage(group, quality, opts.timeoutMs);
        const now = new Date().toISOString();

        if (res.ok) {
          const blobId = buildBlobId();
          writeBlobAtomic(blobDir, blobId, res.buffer);
          const r2Row = buildR2Row(
            group.objectKey,
            blobId,
            res.buffer,
            res.contentType,
            quality,
            res.sourceUrl
          );
          pendingR2Commits.push(r2Row);
          pendingD1Commits.push({ ok: true, tasks: group.tasks, now });
          succeededObjects += 1;
          succeededRows += group.tasks.length;
          downloadedBytes += res.buffer.byteLength;
          if (sampleKeys.length < 15) {
            sampleKeys.push({
              key: group.objectKey,
              size: r2Row.size,
              etag: r2Row.etag,
              http_metadata: r2Row.http_metadata
            });
          }
        } else {
          const reason = String(res.reason || "download failed").slice(0, 500);
          pendingD1Commits.push({ ok: false, tasks: group.tasks, reason, now });
          failedObjects += 1;
          failedRows += group.tasks.length;
          failureReasons.set(reason, (failureReasons.get(reason) || 0) + 1);
        }

        processedObjects += 1;
        if (pendingR2Commits.length >= FLUSH_BATCH_SIZE || pendingD1Commits.length >= FLUSH_BATCH_SIZE) {
          flushPendingCommits();
        }
        if (processedObjects % 500 === 0 || processedObjects === targetGroups.length) {
          const elapsedSec = Math.max(1, (Date.now() - startedAt) / 1000);
          const rate = (processedObjects / elapsedSec).toFixed(1);
          const mb = (downloadedBytes / (1024 * 1024)).toFixed(2);
          log(
            `[progress] ${processedObjects}/${targetGroups.length} 对象 | 成功 ${succeededObjects} (${succeededRows}行) | ` +
              `失败 ${failedObjects} (${failedRows}行) | ${mb} MB | ${rate} obj/s`
          );
        }
      }
    }

    const workers = Array.from({ length: Math.min(opts.concurrency, targetGroups.length) }, () => worker());
    await Promise.all(workers);
    flushPendingCommits();

    const statusRows = d1.prepare("SELECT status, COUNT(*) AS c FROM image_tasks GROUP BY status").all();
    log(`[summary] 本轮完成：成功 ${succeededObjects} 对象 / ${succeededRows} 行，失败 ${failedObjects} 对象 / ${failedRows} 行`);
    log(`[summary] 当前 D1 image_tasks 分布：${JSON.stringify(statusRows)}`);

    if (opts.limit > 0 && sampleKeys.length > 0) {
      log(`[samples] 本次落盘样本（共 ${sampleKeys.length} 条）：`);
      for (const s of sampleKeys) {
        console.log(`  ${s.key} size=${s.size} etag=${s.etag} http_metadata=${s.http_metadata}`);
      }
    }
    if (failureReasons.size > 0) {
      const topReasons = Array.from(failureReasons.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      log(`[failures] 失败原因统计：${JSON.stringify(topReasons)}`);
    }
  } finally {
    d1.close();
    r2.close();
  }
}

main().catch((err) => {
  console.error(`[fatal] ${err?.message || err}`);
  process.exitCode = 1;
});
