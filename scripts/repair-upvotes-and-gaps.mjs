#!/usr/bin/env node
/**
 * 第 3 步低频节流补抓脚本：
 *   1. 补回第 4 轮缺 R2 HTML 的非空正文（如 answer:82356058）；
 *   2. 复核并补全第 5 轮赞同中被截断/疑似截断的正文全文（仅在全文确实更长或新增图片时写回）；
 *   3. 从赞同动态头部增量重扫，覆盖 2026-11-12 之后的新增赞同（保持跳过 pin）；
 *   4. 从 2024-12-01 时间戳游标局部回扫 2024-11（11-01 ~ 11-30）低谷是否漏段。
 *
 * 安全约束：
 *   - 只连本地 loopback Worker（127.0.0.1:18787）；
 *   - 绝不在任何日志、进度文件或报错中打印 Cookie / API_SECRET 明文；
 *   - 低频随机抖动节流 + 遇 403/429/40352 自动暂停冷却，支持断点续传。
 *
 * 用法：
 *   node scripts/repair-upvotes-and-gaps.mjs --dry-run
 *   node scripts/repair-upvotes-and-gaps.mjs
 *   node scripts/repair-upvotes-and-gaps.mjs --task=nov2024
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WORKER_DIR = path.join(ROOT, "apps", "worker");
const D1_STATE_DIR = path.join(WORKER_DIR, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
const R2_STATE_ROOT = path.join(WORKER_DIR, ".wrangler", "state", "v3", "r2");
const R2_DB_DIR = path.join(R2_STATE_ROOT, "miniflare-R2BucketObject");
const PROGRESS_PATH = path.join(ROOT, "logs", "repair-upvotes-progress.json");

const WORKER_PORT = (() => {
  const raw = Number(process.env.LOCAL_WORKER_PORT || 18787);
  return Number.isInteger(raw) && raw >= 1024 && raw <= 65535 ? raw : 18787;
})();
const LOCAL_WORKER_URL = `http://127.0.0.1:${WORKER_PORT}`;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const opts = {
  dryRun: false,
  task: "all",
  includeWithPunct: false,
  help: false
};

for (const arg of process.argv.slice(2)) {
  if (arg === "--dry-run") opts.dryRun = true;
  else if (arg === "--include-with-punct") opts.includeWithPunct = true;
  else if (arg === "--help" || arg === "-h") opts.help = true;
  else if (arg.startsWith("--task=")) opts.task = arg.slice("--task=".length);
  else {
    console.error(`[fatal] 未知参数: ${arg}`);
    process.exit(2);
  }
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitterSleep(minMs, maxMs) {
  return sleep(Math.floor(minMs + Math.random() * (maxMs - minMs)));
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
  return "";
}

function readEnvFile(file) {
  const out = new Map();
  if (!fs.existsSync(file)) return out;
  const text = fs.readFileSync(file, "utf8");
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

function resolveCookieAndUser(d1) {
  const envMain = readEnvFile(path.join(ROOT, ".env"));
  const envLocal = readEnvFile(path.join(ROOT, ".env.local"));
  const devVars = readEnvFile(path.join(WORKER_DIR, ".dev.vars"));

  let cookie =
    String(process.env.ZHIHU_COOKIE_STRING || "").trim() ||
    String(envMain.get("ZHIHU_COOKIE_STRING") || "").trim() ||
    String(envLocal.get("ZHIHU_COOKIE_STRING") || "").trim();
  if (!cookie) {
    const row = d1.prepare("SELECT value FROM app_settings WHERE key = 'zhihu_cookie'").get();
    cookie = String(row?.value || "").trim();
  }
  const username =
    String(process.env.ZHIHU_USERNAME || "").trim() ||
    String(envMain.get("ZHIHU_USERNAME") || "").trim() ||
    String(envLocal.get("ZHIHU_USERNAME") || "").trim() ||
    String(devVars.get("ZHIHU_USERNAME") || "").trim() ||
    "yang-xu-heng-94";

  const secretCandidates = [
    String(process.env.API_SECRET || "").trim(),
    String(envLocal.get("API_SECRET") || "").trim(),
    String(devVars.get("API_SECRET") || "").trim()
  ].filter(Boolean);

  return { cookie, username, secretCandidates };
}

function cleanHtml(html) {
  if (typeof html !== "string") return "";
  let cleaned = html.replace(/<img([^>]*)>/g, (match, attrs) => {
    const realSrc = attrs.match(/data-(?:original|actualsrc)="([^"]+)"/);
    if (!realSrc) return match;
    const src = realSrc[1];
    if (/\ssrc="[^"]*"/.test(attrs)) {
      return `<img${attrs.replace(/\ssrc="[^"]*"/, ` src="${src}"`)}>`;
    }
    return `<img${attrs} src="${src}">`;
  });
  cleaned = cleaned.replace(/\sdata-pid="[^"]*"/g, "");
  return cleaned;
}

function htmlToPlain(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function countImgTags(html) {
  const m = String(html || "").match(/<img\b/gi);
  return m ? m.length : 0;
}

function isPlainTruncatedCandidate(plain, excerpt, includeWithPunct) {
  const p = String(plain || "").replace(/\s+/g, " ").trim();
  const ex = String(excerpt || "").replace(/\s+/g, " ").trim();
  if (!p) return Boolean(ex);
  if (!ex || p.length < 150) return false;
  if (p.length > 350) return false;

  const sp = p.replace(/[.…]+$/, "").trim();
  const se = ex.replace(/[.…]+$/, "").trim();
  const endsWithEllipsis = p.endsWith("...") || p.endsWith("…");
  const endsWithPunct = /[。！？.!?…）」』】"”'’]$/.test(p);

  if (sp === se && (endsWithEllipsis || !endsWithPunct || (includeWithPunct && p.length >= 180))) {
    return true;
  }
  if (p.length <= 250 && endsWithEllipsis && se.length >= 50 && sp.slice(0, 50) === se.slice(0, 50)) {
    return true;
  }
  if (
    p.length >= 170 &&
    p.length <= 235 &&
    !endsWithPunct &&
    se.length >= 50 &&
    sp.slice(0, 50) === se.slice(0, 50)
  ) {
    return true;
  }
  return false;
}

function isUpvotesTargetTruncated(target, cleanedHtml) {
  if (target?.content_need_truncated === true) return true;
  return isPlainTruncatedCandidate(htmlToPlain(cleanedHtml), target?.excerpt || "", false);
}

const toIsoOrNull = (sec) => (sec ? new Date(sec * 1000).toISOString() : "");

async function zhihuFetchJson(url, cookie, { allow404 = false, label = "zhihu" } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: {
          cookie,
          "user-agent": UA,
          accept: "application/json, text/plain, */*"
        },
        signal: AbortSignal.timeout(20_000)
      });
    } catch (err) {
      if (attempt < 2) {
        log(`[warn] ${label} 网络异常 (${err?.message || "err"})，暂停 15 秒重试`);
        await sleep(15_000);
        continue;
      }
      throw new Error(`${label} 网络失败`);
    }

    if (res.status === 404 && allow404) {
      return { status: 404, json: null };
    }
    if (res.status === 401) {
      throw new Error(`${label} 返回 401（Cookie 已失效）`);
    }
    if (res.status === 403 || res.status === 429 || res.status >= 500) {
      const bodyText = await res.text().catch(() => "");
      const has40352 = /40352|unhuman/i.test(bodyText);
      if (attempt < 2) {
        const waitMs = has40352 ? 60_000 : 30_000;
        log(`[risk] ${label} HTTP ${res.status}${has40352 ? " (40352 风控)" : ""}，冷却 ${waitMs / 1000}s 后重试`);
        await sleep(waitMs);
        continue;
      }
      throw new Error(`${label} HTTP ${res.status}${has40352 ? " (40352)" : ""}`);
    }
    if (!res.ok) {
      throw new Error(`${label} HTTP ${res.status}`);
    }
    const json = await res.json();
    return { status: res.status, json };
  }
  throw new Error(`${label} 重试耗尽`);
}

async function fetchFullDetail(sourceType, sourceId, cookie) {
  await jitterSleep(550, 950);
  const url =
    sourceType === "answer"
      ? `https://www.zhihu.com/api/v4/answers/${sourceId}?include=content,excerpt,content_need_truncated,voteup_count,visit_count,comment_count,favorite_count,question,author,is_collapsed,is_labeled,label_info`
      : `https://zhuanlan.zhihu.com/api/articles/${sourceId}`;
  const { status, json } = await zhihuFetchJson(url, cookie, {
    allow404: true,
    label: `detail ${sourceType}:${sourceId}`
  });
  if (status === 404 || !json) return null;
  return json;
}

function buildContentPayloadFromDetail(sourceType, sourceId, item) {
  const title =
    sourceType === "answer"
      ? item.question?.title || "未知问题"
      : item.title || "未知文章";
  const hasQuestionId = item.question?.id != null && String(item.question.id).trim() !== "";
  const sourceUrl =
    sourceType === "answer"
      ? hasQuestionId
        ? `https://www.zhihu.com/question/${item.question.id}/answer/${sourceId}`
        : `https://www.zhihu.com/answer/${sourceId}`
      : `https://zhuanlan.zhihu.com/p/${sourceId}`;
  return {
    sourceType,
    sourceId: String(sourceId),
    title,
    sourceUrl,
    author: {
      name: item.author?.name,
      urlToken: item.author?.url_token,
      avatarUrl: item.author?.avatar_url,
      headline: item.author?.headline
    },
    question:
      sourceType === "answer" && hasQuestionId
        ? { id: String(item.question.id), title: item.question?.title }
        : undefined,
    contentHtml: cleanHtml(item.content),
    contentMd: "",
    excerpt: item.excerpt || item.excerpt_title || "",
    voteupCount: Number(item.voteup_count ?? item.reaction?.statistics?.like_count ?? 0) || 0,
    commentCount: Number(item.comment_count ?? 0) || 0,
    favoriteCount: Number(item.favorite_count ?? item.reaction?.statistics?.favorites ?? 0) || 0,
    visitCount: Number(item.visit_count ?? 0) || 0,
    isCollapsed: Boolean(item.is_collapsed),
    isLabeled: Boolean(item.is_labeled),
    labelInfo: item.label_info ? JSON.stringify(item.label_info) : "",
    createdTime: toIsoOrNull(item.created ?? item.created_time),
    updatedTime: toIsoOrNull(item.updated ?? item.updated_time)
  };
}

async function resolveWorkerSecret(secretCandidates) {
  const health = await fetch(`${LOCAL_WORKER_URL}/api/stats`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!health || !health.ok) {
    throw new Error(`本地 Worker 未就绪 (${LOCAL_WORKER_URL})，请先启动单实例 wrangler dev --local --port 18787`);
  }
  for (const s of secretCandidates) {
    const r = await fetch(`${LOCAL_WORKER_URL}/ingest/sync-state`, {
      headers: { authorization: `Bearer ${s}` },
      signal: AbortSignal.timeout(5000)
    }).catch(() => null);
    if (r && r.ok) return s;
  }
  throw new Error("本地 Worker API_SECRET 校验失败");
}

async function postWorker(pathname, body, secret) {
  const res = await fetch(`${LOCAL_WORKER_URL}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${pathname} -> HTTP ${res.status} ${txt.slice(0, 200)}`);
  }
  return res.json();
}

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_PATH)) {
      return JSON.parse(fs.readFileSync(PROGRESS_PATH, "utf8"));
    }
  } catch {
    /* ignore */
  }
  return { checkedTruncatedPks: [], repairedHtmlPks: [], updatedAt: null };
}

function saveProgress(progress) {
  fs.mkdirSync(path.dirname(PROGRESS_PATH), { recursive: true });
  progress.updatedAt = new Date().toISOString();
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), "utf8");
}

function scanCandidates(d1, r2, blobDir) {
  const stmtObj = r2.prepare("SELECT blob_id FROM _mf_objects WHERE key = ?");
  const readR2Html = (pk, hash) => {
    let row = stmtObj.get(`html/${pk}/${hash}`);
    if (!row) row = stmtObj.get(`html/${pk}`);
    if (!row?.blob_id) return null;
    try {
      return fs.readFileSync(path.join(blobDir, row.blob_id), "utf8");
    } catch {
      return null;
    }
  };

  // 1. 缺非空 R2 HTML 的内容
  const allNonEmpty = d1
    .prepare(
      "SELECT pk, source_type, source_id, content_hash FROM contents WHERE is_deleted = 0 AND content_hash != '' AND content_hash != ?"
    )
    .all(EMPTY_SHA256);
  const missingHtml = [];
  for (const row of allNonEmpty) {
    const hasExact = stmtObj.get(`html/${row.pk}/${row.content_hash}`);
    const hasLegacy = stmtObj.get(`html/${row.pk}`);
    if (!hasExact && !hasLegacy) {
      missingHtml.push(row);
    }
  }

  // 2. 第 5 轮截断/疑似截断候选（读取 <= 350 字赞同的 R2 HTML 精确校验）
  const upvoteRows = d1
    .prepare(`
      SELECT c.pk, c.source_type, c.source_id, c.excerpt, c.content_hash, c.content_md
      FROM upvotes u
      JOIN contents c ON c.pk = u.content_pk
      WHERE c.is_deleted = 0 AND c.source_type IN ('answer', 'article')
    `)
    .all();

  const truncatedCandidates = [];
  for (const row of upvoteRows) {
    const mdLen = String(row.content_md || "").length;
    if (mdLen > 450) continue;
    const html = row.content_hash ? readR2Html(row.pk, row.content_hash) : null;
    const plain = html !== null ? htmlToPlain(html) : String(row.content_md || "").replace(/\s+/g, " ").trim();
    if (isPlainTruncatedCandidate(plain, row.excerpt, opts.includeWithPunct)) {
      truncatedCandidates.push({
        pk: row.pk,
        sourceType: row.source_type,
        sourceId: row.source_id,
        dbPlainLen: plain.length,
        dbImgCount: html ? countImgTags(html) : 0
      });
    }
  }

  // 3. 已有 upvotes 对账集合
  const upvotePairs = new Set();
  const upvoteRowsAll = d1.prepare("SELECT content_pk, upvote_time FROM upvotes").all();
  for (const r of upvoteRowsAll) {
    upvotePairs.add(`${r.content_pk}\u0000${r.upvote_time}`);
  }
  const maxUpvoteRow = d1.prepare("SELECT MAX(upvote_time) AS t FROM upvotes").get();

  return {
    missingHtml,
    truncatedCandidates,
    upvotePairs,
    maxUpvoteTime: maxUpvoteRow?.t || ""
  };
}

async function main() {
  if (opts.help) {
    console.log("用法: node scripts/repair-upvotes-and-gaps.mjs [--dry-run] [--task=all|html|truncated|incremental|nov2024] [--include-with-punct]");
    return;
  }

  const d1Path = discoverSqlite(D1_STATE_DIR);
  const r2Path = discoverSqlite(R2_DB_DIR);
  const blobDir = discoverR2BlobDir();
  if (!d1Path || !r2Path || !blobDir) {
    throw new Error("找不到本地 D1/R2 SQLite 或 blobs 目录");
  }

  const d1 = new Database(d1Path, { readonly: true, fileMustExist: true, timeout: 10_000 });
  const r2 = new Database(r2Path, { readonly: true, fileMustExist: true, timeout: 10_000 });
  d1.pragma("query_only = ON");
  r2.pragma("query_only = ON");

  let cookie, username, secretCandidates, scan;
  try {
    ({ cookie, username, secretCandidates } = resolveCookieAndUser(d1));
    scan = scanCandidates(d1, r2, blobDir);
  } finally {
    d1.close();
    r2.close();
  }

  const progress = loadProgress();
  const checkedSet = new Set(progress.checkedTruncatedPks || []);
  const remainingTruncated = scan.truncatedCandidates.filter((c) => !checkedSet.has(c.pk));

  log(
    `[scan] 缺R2_HTML=${scan.missingHtml.length} 篇 (${scan.missingHtml.map((x) => x.pk).join(",") || "无"}) | ` +
      `截断/疑似截断候选=${scan.truncatedCandidates.length} 篇（未复核=${remainingTruncated.length} 篇）| ` +
      `当前最新赞同=${scan.maxUpvoteTime}`
  );

  if (opts.dryRun) {
    log("[dry-run] 只读预检完成，未访问知乎或本地 Worker。");
    return;
  }

  if (!cookie) throw new Error("未找到 ZHIHU_COOKIE_STRING");
  const secret = await resolveWorkerSecret(secretCandidates);
  log(`[auth] 已连接本地 Worker，账号=${username}（Cookie/密钥不落日志）`);

  const runTask = (name) => opts.task === "all" || opts.task === name;

  // Task 1: 补回缺 R2 HTML 的非空内容
  if (runTask("html") && scan.missingHtml.length > 0) {
    log(`[task:html] 开始补回 ${scan.missingHtml.length} 篇缺失 R2 HTML 的内容...`);
    let ok = 0;
    for (const row of scan.missingHtml) {
      if (row.source_type !== "answer" && row.source_type !== "article") continue;
      const detail = await fetchFullDetail(row.source_type, row.source_id, cookie);
      if (!detail || !detail.content) {
        log(`[task:html] ${row.pk} 远端已不可用（404/空内容），跳过`);
        continue;
      }
      const payload = buildContentPayloadFromDetail(row.source_type, row.source_id, detail);
      await postWorker("/ingest/content", payload, secret);
      ok += 1;
      progress.repairedHtmlPks.push(row.pk);
      saveProgress(progress);
      log(`[task:html] 已补回 ${row.pk} (len=${payload.contentHtml.length})`);
    }
    log(`[task:html] 完成，补回 ${ok}/${scan.missingHtml.length} 篇`);
  }

  // Task 2: 复核并修复第 5 轮截断/疑似截断赞同正文
  if (runTask("truncated") && remainingTruncated.length > 0) {
    log(`[task:truncated] 开始低频复核 ${remainingTruncated.length} 篇候选...`);
    let checked = 0;
    let updated = 0;
    let notFound = 0;
    for (const item of remainingTruncated) {
      const detail = await fetchFullDetail(item.sourceType, item.sourceId, cookie);
      checked += 1;
      if (!detail || !detail.content) {
        notFound += 1;
        checkedSet.add(item.pk);
        progress.checkedTruncatedPks.push(item.pk);
        if (checked % 20 === 0) saveProgress(progress);
        continue;
      }
      const payload = buildContentPayloadFromDetail(item.sourceType, item.sourceId, detail);
      const apiPlainLen = htmlToPlain(payload.contentHtml).length;
      const apiImgCount = countImgTags(payload.contentHtml);
      const needsUpdate = apiPlainLen > item.dbPlainLen + 10 || apiImgCount > item.dbImgCount;
      if (needsUpdate) {
        await postWorker("/ingest/content", payload, secret);
        updated += 1;
        log(`[task:truncated] 修复全文 ${item.pk}: ${item.dbPlainLen} -> ${apiPlainLen} 字 (imgs ${item.dbImgCount}->${apiImgCount})`);
      }
      checkedSet.add(item.pk);
      progress.checkedTruncatedPks.push(item.pk);
      if (checked % 25 === 0 || checked === remainingTruncated.length) {
        saveProgress(progress);
        log(`[task:truncated] 进度 ${checked}/${remainingTruncated.length} | 已修复 ${updated} | 404/空 ${notFound}`);
      }
    }
    saveProgress(progress);
    log(`[task:truncated] 完成：复核 ${checked} 篇，实际修复全文 ${updated} 篇，远端 404/空 ${notFound} 篇`);
  }

  // Task 3: 增量重扫第 5 轮头部（覆盖 2026-11-12 之后新增赞同，保持跳过 pin）
  if (runTask("incremental")) {
    log("[task:incremental] 开始增量扫描赞同动态头部（保持跳过 pin）...");
    let nextUrl = `https://www.zhihu.com/api/v3/moments/${username}/activities?limit=20`;
    let page = 0;
    let consecutiveExisting = 0;
    let newUpvotes = 0;
    let truncatedFixed = 0;
    let skippedPin = 0;

    while (nextUrl && page < 50) {
      await jitterSleep(700, 1200);
      const { json } = await zhihuFetchJson(nextUrl, cookie, { label: `incremental page ${page + 1}` });
      page += 1;
      const items = Array.isArray(json?.data) ? json.data : [];
      if (items.length === 0) break;

      let stop = false;
      for (const it of items) {
        if (!it?.action_text || !it.action_text.includes("赞同")) continue;
        const target = it.target;
        if (!target || !target.id) continue;
        if (target.type !== "answer" && target.type !== "article") {
          if (target.type === "pin") skippedPin += 1;
          continue;
        }
        const sourceType = target.type;
        const sourceId = String(target.id);
        const pk = `${sourceType}:${sourceId}`;
        const upvoteTime = toIsoOrNull(it.created_time);
        if (!upvoteTime) continue;

        if (scan.upvotePairs.has(`${pk}\u0000${upvoteTime}`)) {
          consecutiveExisting += 1;
          if (consecutiveExisting >= 20) {
            stop = true;
            break;
          }
          continue;
        }
        consecutiveExisting = 0;

        let cleanedHtml = cleanHtml(target.content);
        let payload = buildContentPayloadFromDetail(sourceType, sourceId, target);
        if (isUpvotesTargetTruncated(target, cleanedHtml)) {
          const detail = await fetchFullDetail(sourceType, sourceId, cookie);
          if (detail && detail.content) {
            payload = buildContentPayloadFromDetail(sourceType, sourceId, detail);
            truncatedFixed += 1;
          }
        }
        await postWorker("/ingest/content", payload, secret);
        await postWorker("/ingest/upvote", { contentPk: pk, upvoteTime }, secret);
        scan.upvotePairs.add(`${pk}\u0000${upvoteTime}`);
        newUpvotes += 1;
      }

      if (stop || json?.paging?.is_end) break;
      nextUrl = json?.paging?.next || "";
    }
    log(`[task:incremental] 完成：翻页 ${page} 页，新增赞同 ${newUpvotes} 条（其中触发全文回源 ${truncatedFixed} 条），跳过 pin ${skippedPin} 条`);
  }

  // Task 4: 从 2024-12-01 时间戳游标局部复核 2024-11 低谷是否漏段
  if (runTask("nov2024")) {
    log("[task:nov2024] 开始从 2024-12-01T05:00:00Z 游标局部复核 2024-11 赞同区间...");
    const START_OFFSET = Date.parse("2024-12-01T05:00:00Z"); // 1733029200000
    const STOP_SEC = Date.parse("2024-10-31T00:00:00Z") / 1000;
    let nextUrl = `https://www.zhihu.com/api/v3/moments/${username}/activities?offset=${START_OFFSET}&limit=20`;
    let page = 0;
    let seenActivities = 0;
    let novTotalUpvotes = 0;
    let novSkippedPin = 0;
    let novAdded = 0;
    let reachBeforeNov = false;

    while (nextUrl && page < 30 && !reachBeforeNov) {
      await jitterSleep(700, 1200);
      const { json } = await zhihuFetchJson(nextUrl, cookie, { label: `nov2024 page ${page + 1}` });
      page += 1;
      const items = Array.isArray(json?.data) ? json.data : [];
      if (items.length === 0) break;

      for (const it of items) {
        seenActivities += 1;
        const tsSec = Number(it?.created_time || 0);
        if (tsSec > 0 && tsSec < STOP_SEC) {
          reachBeforeNov = true;
          break;
        }
        if (!it?.action_text || !it.action_text.includes("赞同")) continue;
        const upvoteTime = toIsoOrNull(tsSec);
        const isInNov = upvoteTime >= "2024-11-01T00:00:00.000Z" && upvoteTime < "2024-12-01T00:00:00.000Z";
        const target = it.target;
        if (!target || !target.id) continue;
        if (target.type !== "answer" && target.type !== "article") {
          if (isInNov && target.type === "pin") novSkippedPin += 1;
          continue;
        }
        if (isInNov) novTotalUpvotes += 1;

        const sourceType = target.type;
        const sourceId = String(target.id);
        const pk = `${sourceType}:${sourceId}`;
        if (!upvoteTime || scan.upvotePairs.has(`${pk}\u0000${upvoteTime}`)) continue;

        let cleanedHtml = cleanHtml(target.content);
        let payload = buildContentPayloadFromDetail(sourceType, sourceId, target);
        if (isUpvotesTargetTruncated(target, cleanedHtml)) {
          const detail = await fetchFullDetail(sourceType, sourceId, cookie);
          if (detail && detail.content) {
            payload = buildContentPayloadFromDetail(sourceType, sourceId, detail);
          }
        }
        await postWorker("/ingest/content", payload, secret);
        await postWorker("/ingest/upvote", { contentPk: pk, upvoteTime }, secret);
        scan.upvotePairs.add(`${pk}\u0000${upvoteTime}`);
        novAdded += 1;
      }

      if (json?.paging?.is_end) break;
      nextUrl = json?.paging?.next || "";
    }
    log(
      `[task:nov2024] 复核完成：共扫 ${page} 页 / ${seenActivities} 条动态，` +
        `2024-11 窗口内共有 answer/article 赞同 ${novTotalUpvotes} 条（pin ${novSkippedPin} 条），` +
        `补齐此前缺失赞同 ${novAdded} 条`
    );
  }
}

main().catch((err) => {
  console.error(`[fatal] ${err?.message || err}`);
  process.exitCode = 1;
});
