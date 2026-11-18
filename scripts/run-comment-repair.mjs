#!/usr/bin/env node
/**
 * 第 4 步：带断点续传与风控自动冷却的存量评论补采编排脚本。
 *
 * 改进点（相比直接裸跑 full-local-harvest.mjs --repair-comments）：
 *   1. 在 candidate 查询中排除已满足 `roots + children >= comment_count` 的条目（跳过约 1,579 条已完整内容）；
 *   2. 维护持久化断点 `logs/repair-comments-progress.json`，记录已完成 PK，遇 40352 冷却或中断重启后不重复跑第 1 批；
 *   3. 自动管理单实例本地 Worker（避开被占用的 18787 端口，动态选择 18789..18799 空闲回环端口），直接传给爬虫 `apiUrl`；
 *   4. 遇 40352 / partial_risk_controlled / code=2 自动停 Worker 冷却 `--cooldown-seconds` 后继续下一轮。
 *
 * 安全约束：
 *   - 绝不向 stdout、stderr、日志或进度文件打印 Cookie / API_SECRET 明文；
 *   - 每次调用爬虫前后清理临时 INPUT.json；
 *   - 只连本地 127.0.0.1 Worker。
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WORKER_DIR = path.join(ROOT, "apps", "worker");
const WRANGLER_BIN = path.join(WORKER_DIR, "node_modules", "wrangler", "bin", "wrangler.js");
const CRAWLER_ENTRY = path.join(ROOT, "apps", "apify-crawler", "dist", "main.js");
const D1_STATE_DIR = path.join(WORKER_DIR, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
const PROGRESS_PATH = path.join(ROOT, "logs", "repair-comments-progress.json");
const LOCK_PATH = path.join(ROOT, "logs", "repair-comments.lock");
const RUNTIME_DIR = path.join(ROOT, "logs", "repair-comments-runtime");
const STORAGE_DIR = path.join(RUNTIME_DIR, "storage");
const KV_DEFAULT_DIR = path.join(STORAGE_DIR, "key_value_stores", "default");
const INPUT_JSON_PATH = path.join(KV_DEFAULT_DIR, "INPUT.json");

const opts = {
  dryRun: false,
  batchSize: 200,
  max: 0,
  cooldownSeconds: 600,
  maxCooldowns: 200,
  preferredPort: 18789,
  resetProgress: false,
  help: false
};

for (const arg of process.argv.slice(2)) {
  if (arg === "--dry-run") opts.dryRun = true;
  else if (arg === "--reset-progress") opts.resetProgress = true;
  else if (arg === "--help" || arg === "-h") opts.help = true;
  else if (arg.startsWith("--batch-size=")) opts.batchSize = Math.max(1, Number(arg.slice(13)) || 200);
  else if (arg.startsWith("--max=")) opts.max = Math.max(0, Number(arg.slice(6)) || 0);
  else if (arg.startsWith("--cooldown-seconds=")) opts.cooldownSeconds = Math.max(30, Number(arg.slice(19)) || 600);
  else if (arg.startsWith("--max-cooldowns=")) opts.maxCooldowns = Math.max(0, Number(arg.slice(16)) || 200);
  else if (arg.startsWith("--port=")) opts.preferredPort = Math.max(1024, Math.min(65535, Number(arg.slice(7)) || 18789));
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
    out.set(key, value);
  }
  return out;
}

function resolveCredentials(d1) {
  const rootEnv = readEnvFile(path.join(ROOT, ".env"));
  const rootEnvLocal = readEnvFile(path.join(ROOT, ".env.local"));
  const workerDevVars = readEnvFile(path.join(WORKER_DIR, ".dev.vars"));

  const cookieRow = d1.prepare("SELECT value FROM app_settings WHERE key='zhihu_cookie'").get();
  const userRow = d1.prepare("SELECT value FROM app_settings WHERE key='zhihu_username'").get();
  const cookie = String(
    rootEnv.get("ZHIHU_COOKIE_STRING") || rootEnvLocal.get("ZHIHU_COOKIE_STRING") || cookieRow?.value || ""
  ).trim();
  const username = String(
    rootEnv.get("ZHIHU_USERNAME") ||
      rootEnvLocal.get("ZHIHU_USERNAME") ||
      workerDevVars.get("ZHIHU_USERNAME") ||
      userRow?.value ||
      "yang-xu-heng-94"
  ).trim();

  const secrets = [];
  for (const cand of [
    process.env.API_SECRET,
    rootEnvLocal.get("API_SECRET"),
    workerDevVars.get("API_SECRET"),
    rootEnv.get("API_SECRET")
  ]) {
    const v = String(cand || "").trim();
    if (v && !secrets.includes(v)) secrets.push(v);
  }
  return { cookie, username, secrets };
}

function scanCandidates(d1) {
  const rows = d1
    .prepare(
      `
      SELECT
        c.pk,
        c.comment_count AS commentCount,
        COALESCE(cm.roots, 0) AS roots,
        COALESCE(ct.children, 0) AS children
      FROM contents c
      LEFT JOIN (
        SELECT content_pk,
               SUM(CASE WHEN parent_comment_id IS NULL AND is_deleted = 0 THEN 1 ELSE 0 END) AS roots
        FROM comments
        GROUP BY content_pk
      ) cm ON cm.content_pk = c.pk
      LEFT JOIN (
        SELECT content_pk, COALESCE(SUM(child_count), 0) AS children
        FROM comment_threads
        GROUP BY content_pk
      ) ct ON ct.content_pk = c.pk
      WHERE c.is_deleted = 0
        AND c.source_type IN ('answer', 'article')
        AND (
          (c.comment_count > 0 AND COALESCE(cm.roots, 0) < c.comment_count / 3.0 AND COALESCE(cm.roots, 0) < 50)
          OR (c.comment_count > 20 AND COALESCE(cm.roots, 0) = 20)
        )
      ORDER BY
        CASE
          WHEN COALESCE(cm.roots, 0) = 0 THEN 0
          WHEN COALESCE(cm.roots, 0) = 20 THEN 1
          ELSE 2
        END ASC,
        c.comment_count DESC,
        c.pk ASC
    `
    )
    .all();

  let skippedAlreadyComplete = 0;
  const targets = [];
  for (const r of rows) {
    if (Number(r.roots) + Number(r.children) >= Number(r.commentCount)) {
      skippedAlreadyComplete += 1;
      continue;
    }
    targets.push(r);
  }
  return { totalMatched: rows.length, skippedAlreadyComplete, targets };
}

function loadProgress() {
  if (opts.resetProgress || !fs.existsSync(PROGRESS_PATH)) {
    return {
      updatedAt: null,
      completedPks: [],
      skippedClosedPks: [],
      skippedPks: [],
      stats: { batchesRun: 0, cooldowns: 0 }
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(PROGRESS_PATH, "utf8"));
    return {
      updatedAt: parsed?.updatedAt || null,
      completedPks: Array.isArray(parsed?.completedPks) ? parsed.completedPks : [],
      skippedClosedPks: Array.isArray(parsed?.skippedClosedPks) ? parsed.skippedClosedPks : [],
      skippedPks: Array.isArray(parsed?.skippedPks) ? parsed.skippedPks : [],
      stats: {
        batchesRun: Number(parsed?.stats?.batchesRun || 0),
        cooldowns: Number(parsed?.stats?.cooldowns || 0)
      }
    };
  } catch {
    return {
      updatedAt: null,
      completedPks: [],
      skippedClosedPks: [],
      skippedPks: [],
      stats: { batchesRun: 0, cooldowns: 0 }
    };
  }
}

function saveProgress(progress) {
  fs.mkdirSync(path.dirname(PROGRESS_PATH), { recursive: true });
  progress.updatedAt = new Date().toISOString();
  const tmpPath = `${PROGRESS_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(progress, null, 2), "utf8");
  fs.renameSync(tmpPath, PROGRESS_PATH);
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function pickWorkerPort(startPort) {
  for (let p = startPort; p < startPort + 20; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`端口 ${startPort}..${startPort + 19} 均不可用`);
}

async function startLocalWorker(port) {
  const proc = spawn(process.execPath, [WRANGLER_BIN, "dev", "--local", "--port", String(port)], {
    cwd: WORKER_DIR,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let dead = false;
  let exitCode = null;
  let errTail = "";
  proc.on("exit", (code) => {
    dead = true;
    exitCode = code;
  });
  proc.stderr.on("data", (d) => {
    errTail = (errTail + d.toString()).slice(-3000);
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline && !dead) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(500);
  }
  if (!ready) {
    stopLocalWorker(proc);
    throw new Error(`本地 Worker (${baseUrl}) 启动失败 (exit=${exitCode}): ${errTail}`);
  }
  return { proc, baseUrl, isDead: () => dead };
}

function stopLocalWorker(proc) {
  if (!proc?.pid) return;
  try {
    execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
}

async function resolveWorkerSecret(baseUrl, candidates) {
  for (const s of candidates) {
    try {
      const res = await fetch(`${baseUrl}/ingest/sync-state`, {
        headers: { authorization: `Bearer ${s}` },
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) return s;
    } catch {}
  }
  throw new Error("本地 Worker API_SECRET 校验失败（请检查 apps/worker/.dev.vars 或 .env）");
}

function isRiskText(line) {
  if (/^(?:ℹ️|🩹\s*评论补采进度)/.test(line.trim())) {
    return false;
  }
  if (/\b40352\b|circuitBroken|riskExhausted|风控\/熔断提前中止|zhihu_auth_failed|zhihu_request_failed|ingest_failed|crawler_error/.test(line)) {
    return true;
  }
  if (/partial_risk_controlled/.test(line)) {
    // 仅当「重试耗尽 是」或中止未跑完才算真风控冷却；单条偶发网络异常（重试耗尽 否）不空等 600s
    return !/重试耗尽\s*否/.test(line);
  }
  return false;
}

function isAuthFailText(text) {
  return /zhihu_auth_failed|Cookie 已失效|HTTP 401/.test(text);
}

function isCaptchaBlockText(text) {
  return /\b40352\b|account\/unhuman|触发人机验证\s*40352/i.test(String(text || ""));
}

async function verifyCookieValid(cookie) {
  try {
    const res = await fetch("https://www.zhihu.com/api/v4/me", {
      headers: {
        cookie,
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        accept: "application/json, text/plain, */*"
      },
      signal: AbortSignal.timeout(10_000)
    });
    return { status: res.status, valid: res.status === 200 };
  } catch {
    return { status: 0, valid: true };
  }
}

function runCrawlerBatch(batchPks, { baseUrl, secret, username, cookie, onItemDone }) {
  fs.mkdirSync(KV_DEFAULT_DIR, { recursive: true });
  const payload = {
    runType: "repair-comments",
    isFast: false,
    apiUrl: baseUrl,
    apiSecret: secret,
    zhihuUsername: username,
    cookieString: cookie,
    repairTargets: batchPks
  };
  fs.writeFileSync(INPUT_JSON_PATH, JSON.stringify(payload, null, 2), "utf8");

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CRAWLER_ENTRY], {
      cwd: ROOT,
      env: {
        ...process.env,
        API_URL: baseUrl,
        WORKER_URL: baseUrl,
        API_SECRET: secret,
        UNLIMITED_LOCAL_WRITES: "1",
        APIFY_LOCAL_STORAGE_DIR: STORAGE_DIR,
        CRAWLEE_STORAGE_DIR: STORAGE_DIR
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let allText = "";
    const warnedPks = new Set();
    const closedPks = new Set();
    const completedOrder = [];
    const closedOrder = [];
    let haltedByRisk = false;
    let stdoutBuf = "";
    let stderrBuf = "";

    const handleLine = (line) => {
      if (!haltedByRisk && isRiskText(line)) {
        haltedByRisk = true;
      }
      const closedMatch = /评论区已关闭，跳过\s*\(((?:answer|article):[^)\s]+)\)/.exec(line);
      if (closedMatch) {
        closedPks.add(closedMatch[1]);
      }
      const warnMatch = /⚠️.*?\(((?:answer|article):[^)\s]+)/.exec(line);
      if (warnMatch) {
        warnedPks.add(warnMatch[1]);
      }
      const progMatch = /🩹\s*评论补采进度\s*\d+\/\d+（((?:answer|article):[^）]+)）(?:\[status=(ok|closed|failed)\])?/.exec(line);
      if (progMatch && !haltedByRisk) {
        const pk = progMatch[1];
        const explicitStatus = progMatch[2] || "";
        if (explicitStatus === "failed") {
          warnedPks.add(pk);
          return;
        }
        if (explicitStatus === "closed") {
          closedPks.add(pk);
        }
        if (!warnedPks.has(pk)) {
          const kind = explicitStatus === "closed" || closedPks.has(pk) ? "closed" : "completed";
          if (kind === "closed") closedOrder.push(pk);
          else completedOrder.push(pk);
          if (typeof onItemDone === "function") onItemDone(kind, pk);
        }
      }
    };

    const processLines = (chunkStr, streamOut, isStderr) => {
      streamOut.write(chunkStr);
      allText = (allText + chunkStr).slice(-256 * 1024);
      const combined = (isStderr ? stderrBuf : stdoutBuf) + chunkStr;
      const lines = combined.split(/\r?\n/);
      const tail = lines.pop() ?? "";
      if (isStderr) stderrBuf = tail;
      else stdoutBuf = tail;
      for (const line of lines) handleLine(line);
    };

    child.stdout.on("data", (d) => processLines(d.toString(), process.stdout, false));
    child.stderr.on("data", (d) => processLines(d.toString(), process.stderr, true));
    child.on("close", (code) => {
      if (stdoutBuf) handleLine(stdoutBuf);
      if (stderrBuf) handleLine(stderrBuf);
      try {
        fs.rmSync(INPUT_JSON_PATH, { force: true });
      } catch {}
      resolve({
        code: code ?? 1,
        tail: allText,
        completedOrder,
        closedOrder,
        warnedPks,
        haltedByRisk: haltedByRisk || code === 2
      });
    });
  });
}

let lockToken = "";

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  lockToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const writeAtomic = () => {
    fs.writeFileSync(
      LOCK_PATH,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: lockToken }),
      { encoding: "utf8", flag: "wx" }
    );
  };
  try {
    writeAtomic();
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    let alive = false;
    try {
      const prev = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
      if (prev?.pid && prev.pid !== process.pid) {
        try {
          process.kill(prev.pid, 0);
          alive = true;
        } catch (killErr) {
          if (killErr?.code !== "ESRCH") alive = true;
        }
        if (alive) {
          throw new Error(`已有评论补采进程正在运行 (PID=${prev.pid})`);
        }
      }
    } catch (readErr) {
      if (readErr?.message?.includes("正在运行")) throw readErr;
    }
    // 确认前进程已死后删旧锁再用 wx 原子重建，防止多进程并发穿透
    fs.rmSync(LOCK_PATH, { force: true });
    writeAtomic();
  }
}

function releaseLock() {
  try {
    const data = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
    if (!data || data.pid !== process.pid || !lockToken || data.token !== lockToken) return;
    fs.rmSync(LOCK_PATH, { force: true });
  } catch {}
}

async function main() {
  if (opts.help) {
    console.log(
      "用法: node scripts/run-comment-repair.mjs [--dry-run] [--batch-size=200] [--max=0] [--cooldown-seconds=600] [--max-cooldowns=200] [--port=18789] [--reset-progress]"
    );
    return;
  }

  if (!fs.existsSync(CRAWLER_ENTRY)) {
    throw new Error("未找到 apps/apify-crawler/dist/main.js，请先执行 pnpm --filter apify-crawler build");
  }
  const d1Path = discoverSqlite(D1_STATE_DIR);
  if (!d1Path) throw new Error("找不到本地 D1 SQLite 文件");

  const d1 = new Database(d1Path, { readonly: true, fileMustExist: true, timeout: 10_000 });
  d1.pragma("query_only = ON");
  let creds, scan;
  try {
    creds = resolveCredentials(d1);
    scan = scanCandidates(d1);
  } finally {
    d1.close();
  }

  const progress = loadProgress();
  const completedSet = new Set(progress.completedPks);
  const skippedClosedSet = new Set(progress.skippedClosedPks);
  const skippedSet = new Set(progress.skippedPks);
  const sessionDeferredSet = new Set();
  const allRemaining = scan.targets.filter(
    (t) => !completedSet.has(t.pk) && !skippedClosedSet.has(t.pk) && !skippedSet.has(t.pk)
  );
  const targetSlice = opts.max > 0 ? allRemaining.slice(0, opts.max) : allRemaining;
  const totalBatches = Math.ceil(targetSlice.length / opts.batchSize);

  log(
    `[scan] SQL匹配=${scan.totalMatched} | 跳过已完整(roots+children>=comment_count)=${scan.skippedAlreadyComplete} | ` +
      `真实待补采=${scan.targets.length} | 断点已完成=${completedSet.size} | 闭评跳过=${skippedClosedSet.size} | 异常跳过=${skippedSet.size} | 本轮剩余=${targetSlice.length} (${totalBatches}批 × ${opts.batchSize})`
  );

  if (opts.dryRun) {
    log("[dry-run] 只读预检完成，未启动 Worker 或访问知乎。");
    return;
  }

  if (!creds.cookie) throw new Error("未找到 ZHIHU_COOKIE_STRING");
  if (targetSlice.length === 0) {
    log("✅ 评论补采断点队列已全部完成，无需继续。");
    return;
  }

  acquireLock();
  let worker = null;
  let secret = "";

  const ensureWorker = async () => {
    if (worker && !worker.isDead()) return;
    const port = await pickWorkerPort(opts.preferredPort);
    log(`[worker] 正在端口 ${port} 启动单实例本地 Worker...`);
    worker = await startLocalWorker(port);
    secret = await resolveWorkerSecret(worker.baseUrl, creds.secrets);
    log(`[worker] 本地 Worker 就绪 (${worker.baseUrl})，账号=${creds.username}`);
  };

  const cleanupWorker = () => {
    if (worker) {
      stopLocalWorker(worker.proc);
      worker = null;
      log("[worker] 本地 Worker 已停止。");
    }
  };

  let progressDirty = false;
  let unsavedCount = 0;

  let cleaningUp = false;
  const handleSignal = (signal) => {
    if (cleaningUp) return;
    cleaningUp = true;
    log(`[signal] 收到 ${signal}，正在保存断点并清理 INPUT.json、Worker 与锁...`);
    try {
      if (progressDirty) saveProgress(progress);
    } catch {}
    try {
      fs.rmSync(INPUT_JSON_PATH, { force: true });
    } catch {}
    cleanupWorker();
    releaseLock();
    process.exit(130);
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  const markItemDone = (kind, pk) => {
    if (kind === "closed") {
      if (!skippedClosedSet.has(pk) && !completedSet.has(pk)) {
        skippedClosedSet.add(pk);
        progress.skippedClosedPks.push(pk);
        progressDirty = true;
        unsavedCount += 1;
      }
    } else if (!completedSet.has(pk) && !skippedClosedSet.has(pk)) {
      completedSet.add(pk);
      progress.completedPks.push(pk);
      progressDirty = true;
      unsavedCount += 1;
    }
    if (unsavedCount >= 5) {
      saveProgress(progress);
      progressDirty = false;
      unsavedCount = 0;
    }
  };

  try {
    let cooldownRounds = 0;
    let consecutiveZeroProgressRisks = 0;
    let batchNo = 0;

    while (true) {
      const pending = targetSlice.filter(
        (x) =>
          !completedSet.has(x.pk) &&
          !skippedClosedSet.has(x.pk) &&
          !skippedSet.has(x.pk) &&
          !sessionDeferredSet.has(x.pk)
      );
      if (pending.length === 0) break;

      await ensureWorker();

      const batchObjs = pending.slice(0, opts.batchSize);
      const batchPks = batchObjs.map((x) => x.pk);
      batchNo += 1;
      const estBatchesLeft = Math.ceil(pending.length / opts.batchSize);
      log(
        `[batch ${batchNo} | 剩余 ${pending.length} (~${estBatchesLeft}批)] 下发 ${batchPks.length} 条（已完成=${completedSet.size}, 闭评跳过=${skippedClosedSet.size}, 异常跳过=${skippedSet.size} / 总目标=${scan.targets.length}）`
      );

      let batchNewlySaved = 0;
      const beforeCompleted = completedSet.size;
      const beforeClosed = skippedClosedSet.size;
      const result = await runCrawlerBatch(batchPks, {
        baseUrl: worker.baseUrl,
        secret,
        username: creds.username,
        cookie: creds.cookie,
        onItemDone: (kind, pk) => {
          markItemDone(kind, pk);
        }
      });

      for (const pk of result.completedOrder) markItemDone("completed", pk);
      for (const pk of result.closedOrder) markItemDone("closed", pk);
      const newlyCompleted = completedSet.size - beforeCompleted;
      const newlyClosed = skippedClosedSet.size - beforeClosed;
      batchNewlySaved = newlyCompleted + newlyClosed;
      const newlySaved = batchNewlySaved;
      progress.stats.batchesRun += 1;
      progressDirty = true;

      if (isAuthFailText(result.tail)) {
        const chk = await verifyCookieValid(creds.cookie);
        if (chk.status === 401) {
          saveProgress(progress);
          throw new Error("知乎 /api/v4/me 返回 401，Cookie 已失效，停止补采（已保存最新断点）");
        }
        log(`[auth-check] 出现认证告警但 /api/v4/me 返回 HTTP ${chk.status}，Cookie 仍有效，按风控冷却处理`);
      }

      const riskHit = result.haltedByRisk || result.code !== 0;
      if (!riskHit && result.warnedPks.size > 0) {
        for (const pk of result.warnedPks) {
          if (!completedSet.has(pk) && !skippedClosedSet.has(pk)) {
            sessionDeferredSet.add(pk);
            log(`[batch ${batchNo}] 单条告警 (${pk}) 暂不写入完成/永久跳过，本轮先延后，留待后续启动重试`);
          }
        }
      }
      saveProgress(progress);

      if (riskHit) {
        log(
          `[batch ${batchNo}] 遇到中断/风控 (code=${result.code}, risk=${result.haltedByRisk})，` +
            `本批安全落断点 完成${newlyCompleted}/闭评${newlyClosed}，累计 已完成=${completedSet.size} / 闭评跳过=${skippedClosedSet.size}`
        );

        if (isCaptchaBlockText(result.tail)) {
          saveProgress(progress);
          progressDirty = false;
          throw new Error(
            "检测到知乎 40352 人机验证，已立即保存最新断点并安全停机；请先在浏览器打开知乎完成验证，再重新运行继续"
          );
        }

        if (newlySaved === 0) consecutiveZeroProgressRisks += 1;
        else consecutiveZeroProgressRisks = 0;

        if (consecutiveZeroProgressRisks >= 3) {
          throw new Error("连续 3 轮零进展触发风控/失败，已停止并保留断点");
        }
        if (cooldownRounds >= opts.maxCooldowns) {
          throw new Error(`已达最大冷却轮次 (${opts.maxCooldowns})，已停止并保留断点`);
        }

        cooldownRounds += 1;
        progress.stats.cooldowns += 1;
        saveProgress(progress);
        progressDirty = false;
        cleanupWorker();
        log(`[cooldown ${cooldownRounds}/${opts.maxCooldowns}] 暂停 ${opts.cooldownSeconds}s 等待风控滑窗冷却后自动续跑...`);
        await sleep(opts.cooldownSeconds * 1000);
        continue;
      }

      saveProgress(progress);
      progressDirty = false;
      unsavedCount = 0;
      consecutiveZeroProgressRisks = 0;
      log(
        `[batch ${batchNo}] 完成（本批落断点 完成${newlyCompleted} / 闭评跳过${newlyClosed} / 总${batchPks.length}，累计 已完成=${completedSet.size}，闭评跳过=${skippedClosedSet.size}，异常跳过=${skippedSet.size}）`
      );
    }

    log(`🎉 第 4 步评论补采队列执行完成！累计已核销断点 ${completedSet.size} 条，跳过 ${skippedSet.size} 条。`);
  } finally {
    if (progressDirty) saveProgress(progress);
    cleanupWorker();
    releaseLock();
  }
}

main().catch((err) => {
  console.error(`[fatal] ${err?.message || err}`);
  process.exitCode = 1;
});
