#!/usr/bin/env node
/**
 * 本地全量重扒总控脚本（分阶段断点守护，零 Apify 额度消耗）
 *
 * 为什么要单独一个脚本：
 *   local-sync.mjs 面向「日常增量同步 + 云端 Worker」，而全量重扒需要在**全新空白本地
 *   D1/R2** 上把 5 个阶段（关注名录 → 我的回答+文章 → 收藏夹 → 关注答主 → 赞同历史）
 *   一次性跑完，每个阶段都可能耗时几十分钟到几小时，中途风控/断电/重启后必须能接着跑。
 *
 * 用法：
 *   node scripts/full-local-harvest.mjs --init-fresh      # 备份旧 state + 建空表 + 写入 cookie/策略
 *   node scripts/full-local-harvest.mjs                   # 从断点继续未完成的阶段
 *   node scripts/full-local-harvest.mjs --reset-progress  # 重置阶段进度（数据不清空）
 *   node scripts/full-local-harvest.mjs --only=stage3_collections_full
 *   node scripts/full-local-harvest.mjs --from=stage4_following_full
 *   node scripts/full-local-harvest.mjs --cooldown-seconds=600  # 覆盖风控冷却秒数（默认 600，最多 12 轮）
 *   node scripts/full-local-harvest.mjs --repair-comments      # 独立运维入口：补采存量被 v4 截断的评论
 *
 * 存量评论补采（--repair-comments）：
 *   修复前的 v4 根评论端点对高评论回答假 is_end，存量内容只入库第一页 20 条根评论。
 *   本模式从本地 D1 查出「根评论数 < 评论总数/3 且根评论 < 50」的 answer/article，
 *   每 50 条一批交给爬虫 runType=repair-comments 全量重抓（翻到 is_end + 删除对账）。
 *   它不写进度文件、不参与 stage1-5 状态机，默认不运行，必须显式传参触发；
 *   中途被风控打断或进程退出后重跑同一条命令即可，已补齐的内容会因根评论数增长自动从清单消失。
 *
 * 风控冷却续跑：
 *   任意阶段返回 partial_risk_controlled（知乎临时风控 40352）时不会直接退出，
 *   而是打印断点信息、休息 --cooldown-seconds（默认 600 秒）后自动续跑同一阶段；
 *   已入库的正文/评论会因 prevCommentCount 或 historyDone / upvotes_cursor 断点
 *   自动 0 请求秒跳过。只有冷却重跑后 0 条新进展且立即再次撞风控，才提示用户
 *   去浏览器完成一次知乎滑块验证。
 *
 * 安全约定（硬性）：
 *   - 脚本只在内存中持有知乎 cookie 与 API_SECRET，绝不打印明文；
 *   - 绝不做任何 --remote / 线上 D1/R2 写操作；线上仅只读拉取一次 /ingest/sync-state；
 *   - .env.local / .dev.vars / INPUT.json 只做按键取值，不输出内容；
 *   - 临时 INPUT.json 与临时 SQL 文件在进程退出前（finally）一律删除。
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WORKER_DIR = path.join(ROOT, "apps", "worker");
const CRAWLER_DIR = path.join(ROOT, "apps", "apify-crawler");
const LOGS_DIR = path.join(ROOT, "logs");
const DATA_DIR = path.join(ROOT, "data");
const RUNTIME_DIR = path.join(DATA_DIR, "harvest-runtime");
const STORAGE_DIR = path.join(RUNTIME_DIR, "storage");
const KV_DEFAULT_DIR = path.join(STORAGE_DIR, "key_value_stores", "default");
const INPUT_JSON_PATH = path.join(KV_DEFAULT_DIR, "INPUT.json");
const PROGRESS_PATH = path.join(LOGS_DIR, "full-harvest-progress.json");
const LOG_PATH = path.join(LOGS_DIR, "full-harvest.log");
const CHILD_LOG_PATH = path.join(LOGS_DIR, "full-harvest-child.log");
const LOCK_PATH = path.join(LOGS_DIR, "full-harvest.lock");
const WRANGLER_STATE_DIR = path.join(WORKER_DIR, ".wrangler", "state");

/** 本地 Worker 固定端口：与 local-sync / 本地开发约定一致 */
const LOCAL_WORKER_URL = "http://127.0.0.1:18787";
const DB_NAME = "zhihu-backup";

/** 用户的黄金全量策略：只有 upvotes 用 hot（2.9 万条赞同基数太大，每篇前 20 热评+内联楼中楼） */
const GOLDEN_POLICY = Object.freeze({
  commentsMyAnswers: "full",
  commentsCollections: "full",
  commentsFollowing: "full",
  commentsUpvotes: "hot",
  followingSensitivity: "standard"
});

const STAGES = [
  {
    id: "stage1_following_list",
    runType: "following-list",
    title: "同步全部关注答主名录",
    note: "写 R2 + D1 关注名录（含 sync_mode / 断点），耗时约 1 分钟"
  },
  {
    id: "stage2_my_answers_articles",
    runType: "answers",
    title: "本人全部回答 + 全部专栏文章",
    note: "不带 --fast：全量正文 + 全部根评论 + 全部楼中楼"
  },
  {
    id: "stage3_collections_full",
    runType: "collections",
    title: "15 个收藏夹全部精华内容",
    note: "不带 --fast：全量正文 + 全部根评论 + 全部楼中楼"
  },
  {
    id: "stage4_following_full",
    runType: "following",
    title: "102 位关注答主最热前 60 篇 + 高危高质内容",
    note: "不带 --fast：全量正文 + 全部根评论 + 全部楼中楼；AI 复核上限已放宽到 500 次"
  },
  {
    id: "stage5_upvotes_all",
    runType: "upvotes",
    title: "全部历史赞同内容",
    note: "每篇前 20 条热评 + 内联楼中楼；风控冷却后自动从 upvotes_cursor 续跑，最多 12 轮"
  }
];

const STAGE_IDS = new Set(STAGES.map(s => s.id));

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const opts = {
  initFresh: false,
  resetProgress: false,
  only: "",
  from: "",
  build: true,
  // 存量评论补采（独立运维入口）：默认关闭，必须显式 --repair-comments 才跑
  repairComments: false,
  repairBatchSize: 50,
  // 单次最多补采多少条（0=不限制）：先小批量试跑、确认风控表现后再全量
  repairMax: 0,
  // 知乎 40352 滑窗风控冷却：默认休息 10 分钟再自动续跑
  cooldownSeconds: 600,
  waitWorkerSeconds: 120,
  help: false
};

for (const arg of process.argv.slice(2)) {
  if (arg === "--init-fresh" || arg === "--init") opts.initFresh = true;
  else if (arg === "--reset-progress") opts.resetProgress = true;
  else if (arg.startsWith("--only=")) opts.only = arg.slice("--only=".length).trim();
  else if (arg.startsWith("--from=")) opts.from = arg.slice("--from=".length).trim();
  else if (arg === "--skip-build") opts.build = false;
  else if (arg === "--repair-comments") opts.repairComments = true;
  else if (arg.startsWith("--repair-batch-size=")) {
    const n = Number(arg.slice("--repair-batch-size=".length));
    if (Number.isFinite(n) && n > 0) opts.repairBatchSize = Math.trunc(n);
  } else if (arg.startsWith("--repair-max=")) {
    const n = Number(arg.slice("--repair-max=".length));
    if (Number.isFinite(n) && n >= 0) opts.repairMax = Math.trunc(n);
  } else if (arg.startsWith("--cooldown-seconds=")) {
    const n = Number(arg.slice("--cooldown-seconds=".length));
    if (Number.isFinite(n) && n >= 0) opts.cooldownSeconds = Math.trunc(n);
  } else if (arg.startsWith("--rest-seconds=")) {
    // 兼容旧参数：等价于 --cooldown-seconds（赞同阶段旧语义已合并到统一冷却）
    const n = Number(arg.slice("--rest-seconds=".length));
    if (Number.isFinite(n) && n >= 0) opts.cooldownSeconds = Math.trunc(n);
  } else if (arg.startsWith("--wait-worker-seconds=")) {
    const n = Number(arg.slice("--wait-worker-seconds=".length));
    if (Number.isFinite(n) && n >= 0) opts.waitWorkerSeconds = Math.trunc(n);
  } else if (arg === "--help" || arg === "-h") opts.help = true;
  else console.warn(`⚠️ 忽略未知参数: ${arg}`);
}

// ---------------------------------------------------------------------------
// 日志 / 进度文件
// ---------------------------------------------------------------------------
function ensureDirs() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.mkdirSync(KV_DEFAULT_DIR, { recursive: true });
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + "\n", "utf8");
  } catch { /* 日志落盘失败不影响抓取 */ }
}

function emptyProgress() {
  const stages = {};
  for (const stage of STAGES) {
    stages[stage.id] = {
      title: stage.title,
      runType: stage.runType,
      note: stage.note,
      status: "pending",
      attempts: 0,
      rounds: [],
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      statsAfter: null
    };
  }
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    localWorkerUrl: LOCAL_WORKER_URL,
    policy: { ...GOLDEN_POLICY },
    currentStage: null,
    latestStats: null,
    init: null,
    stages
  };
}

function readProgress() {
  if (!fs.existsSync(PROGRESS_PATH)) return emptyProgress();
  let text = "";
  try {
    text = fs.readFileSync(PROGRESS_PATH, "utf8");
  } catch (err) {
    console.warn(`⚠️ 读取进度文件失败（${err?.code || err?.message || err}），本轮按空进度继续`);
    return emptyProgress();
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !parsed.stages) {
      throw new Error("进度文件结构无效（缺少 stages）");
    }
    // 兼容旧文件：补齐新增阶段/字段
    const base = emptyProgress();
    for (const stage of STAGES) {
      if (!parsed.stages[stage.id]) parsed.stages[stage.id] = base.stages[stage.id];
    }
    return { ...base, ...parsed, stages: { ...base.stages, ...parsed.stages } };
  } catch (err) {
    // 解析失败不能直接丢掉旧进度：先备份损坏文件，方便人工恢复
    const backup = `${PROGRESS_PATH}.corrupt-${timestampSlug()}.bak`;
    try {
      fs.copyFileSync(PROGRESS_PATH, backup);
      console.warn(`⚠️ 进度文件解析失败（${err?.message || err}），已备份到 ${backup}，本轮按空进度继续`);
    } catch (copyErr) {
      console.warn(
        `⚠️ 进度文件解析失败（${err?.message || err}），且备份失败（${copyErr?.message || copyErr}），本轮按空进度继续`
      );
    }
    return emptyProgress();
  }
}

/** Windows 上文件被杀毒/索引短暂占用时 rename 会 EPERM/EACCES/EBUSY，同步重试几次 */
function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* 阻塞等待：writeProgress 是同步函数 */ }
}

// 心跳直接复用最近一次写入的 progress 对象，避免读盘失败时用空进度覆盖真实断点
let latestProgress = null;

function writeProgress(progress) {
  latestProgress = progress;
  progress.updatedAt = new Date().toISOString();
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const tmp = `${PROGRESS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(progress, null, 2), "utf8");
  const maxAttempts = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, PROGRESS_PATH);
      return;
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      sleepSync(50);
    }
  }
}

// ---------------------------------------------------------------------------
// 环境变量（只按键取值，绝不打印内容）
// ---------------------------------------------------------------------------
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

const envLocal = readEnvFile(path.join(ROOT, ".env.local"));
// .dev.vars 是本地 Worker 自己的密钥文件：只按 key 取值用于本地鉴权，绝不输出
const devVars = readEnvFile(path.join(WORKER_DIR, ".dev.vars"));

const ONLINE_WORKER_URL = String(envLocal.get("WORKER_URL") || process.env.WORKER_URL || "")
  .trim()
  .replace(/\/+$/, "");
const ZHIHU_USERNAME = String(
  envLocal.get("ZHIHU_USERNAME") || process.env.ZHIHU_USERNAME || ""
).trim();

/** 候选密钥：env > .env.local > .dev.vars，按顺序去重（值只在内存中使用） */
function secretCandidates() {
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

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------
async function fetchJson(url, init = {}, timeoutMs = 30_000) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch { /* 非 JSON（HTML 错误页等） */ }
  return { res, json, text };
}

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

async function waitForLocalWorker(seconds) {
  const deadline = Date.now() + Math.max(0, seconds) * 1000;
  let announced = false;
  while (Date.now() <= deadline) {
    if (await localHealthy()) return true;
    if (!announced) {
      log(`⏳ 等待本地 Worker 启动（${LOCAL_WORKER_URL}，最多 ${seconds}s）...`);
      announced = true;
    }
    await sleep(3_000);
  }
  return localHealthy();
}

/** 用 /ingest/sync-state 探测哪个候选密钥才是本地 Worker 的 API_SECRET（绝不打日志输出密钥） */
async function resolveLocalSecret() {
  const candidates = secretCandidates();
  if (candidates.length === 0) {
    throw new Error("未找到 API_SECRET：请检查 .env.local / apps/worker/.dev.vars 或环境变量");
  }
  if (!(await localHealthy())) {
    // Worker 没起时无法探测：默认用 .env.local（与 local-sync 一致），等 Worker 起来后再校验
    return candidates[0];
  }
  for (const candidate of candidates) {
    try {
      const { res } = await localRequest("/ingest/sync-state", {}, candidate.value, 10_000);
      if (res.ok) {
        log(`🔑 已校验本地 Worker API_SECRET（来源: ${candidate.source}，值不落日志）`);
        return candidate;
      }
    } catch { /* 尝试下一个候选 */ }
  }
  throw new Error(
    "本地 Worker 拒绝所有候选 API_SECRET（401）。请确认 apps/worker/.dev.vars 与 .env.local 中的 API_SECRET 一致"
  );
}

async function fetchStats(secret = "") {
  try {
    const { res, json } = await localRequest("/api/stats", {}, secret, 15_000);
    if (!res.ok || !json || typeof json !== "object") return null;
    return {
      contents: Number(json.total_contents) || 0,
      answers: Number(json.total_answers) || 0,
      articles: Number(json.total_articles) || 0,
      comments: Number(json.total_comments) || 0,
      collections: Number(json.total_collections) || 0,
      collection_items: Number(json.total_collection_items) || 0,
      upvotes: Number(json.total_upvotes) || 0
    };
  } catch {
    return null;
  }
}

function formatStats(stats) {
  if (!stats) return "统计暂不可用";
  return (
    `内容 ${stats.contents} / 回答 ${stats.answers} / 文章 ${stats.articles} / ` +
    `评论 ${stats.comments} / 收藏夹 ${stats.collections}（条目 ${stats.collection_items}）/ 赞同 ${stats.upvotes}`
  );
}

async function fetchLocalSyncState(secret) {
  const { res, json } = await localRequest("/ingest/sync-state", {}, secret, 15_000);
  if (!res.ok || !json) return null;
  return {
    cookieString: typeof json.cookieString === "string" ? json.cookieString : "",
    zhihuUsername: typeof json.zhihuUsername === "string" ? json.zhihuUsername : "",
    upvotesCursor: typeof json.upvotesCursor === "string" ? json.upvotesCursor : null,
    // 断点续跑的关键状态：history_done / resume_offset / full 模式用户列表。
    // 少了这两项，重启后已完成的答主会被重新扫一遍，full 模式用户的 resumeOffset 也会丢。
    followedProgress:
      json.followedProgress && typeof json.followedProgress === "object" ? json.followedProgress : {},
    fullModeUsers: Array.isArray(json.fullModeUsers)
      ? json.fullModeUsers.filter(token => typeof token === "string" && token)
      : []
  };
}

// ---------------------------------------------------------------------------
// 子进程
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 子进程输出同时落盘（追加）：控制台仍实时输出；silent 子进程可能含凭据，不落盘 */
function appendChildLog(text) {
  if (!text) return;
  try {
    fs.appendFileSync(CHILD_LOG_PATH, text, "utf8");
  } catch { /* 子进程日志落盘失败不影响抓取 */ }
}

function runChild(command, args, { cwd, env, timeoutMs = 0, silent = false, maxCapture = 256 * 1024 } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      // stdin 保持管道：wrangler 交互确认可以直接喂 y
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    // 长时间抓取会输出海量日志：默认只在内存保留前 256KB（wrangler 校验/错误定位足够），
    // 其余仍实时透传到控制台，避免几小时的全量抓取把脚本内存撑爆。
    // 本地 D1 导出类查询（--json）结果可能有几百 KB，调用方可通过 maxCapture 显式放宽。
    // 另外单独滚动保留最后 128KB，用于识别 main.ts 结束时的 partial_risk_controlled 终态标记
    const MAX_CAPTURE = maxCapture;
    const MAX_TAIL = 128 * 1024;
    let tail = "";
    const pushTail = text => {
      tail = (tail + text).slice(-MAX_TAIL);
    };
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }, timeoutMs);
    }
    child.stdout.on("data", chunk => {
      const text = String(chunk);
      if (stdout.length < MAX_CAPTURE) stdout += text;
      pushTail(text);
      if (!silent) {
        process.stdout.write(text);
        appendChildLog(text);
      }
    });
    child.stderr.on("data", chunk => {
      const text = String(chunk);
      if (stderr.length < MAX_CAPTURE) stderr += text;
      pushTail(text);
      if (!silent) {
        process.stderr.write(text);
        appendChildLog(text);
      }
    });
    child.on("error", err => {
      if (timer) clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr + String(err?.message || err), tail });
    });
    child.on("close", code => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr, tail });
    });
    // wrangler 的确认提示：非交互环境下直接回 y
    try { child.stdin.write("y\n"); child.stdin.end(); } catch { /* ignore */ }
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

async function runWrangler(args, label) {
  const bin = wranglerBin();
  if (!bin) throw new Error("找不到 wrangler：请先在仓库根目录执行 pnpm install");
  log(`🛠️ ${label}...`);
  // 绝对禁止 --remote：所有 wrangler 调用都由本脚本固定带上 --local
  const result = await runChild(process.execPath, [bin, ...args], { cwd: WORKER_DIR });
  if (result.code !== 0) {
    throw new Error(`${label} 失败（退出码 ${result.code}）`);
  }
  log(`✅ ${label} 完成`);
  return result;
}

// ---------------------------------------------------------------------------
// --init-fresh：备份旧 state → 建空表 → 写入真实 cookie 与黄金策略
// ---------------------------------------------------------------------------
function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function backupWranglerState() {
  if (!fs.existsSync(WRANGLER_STATE_DIR)) {
    log("ℹ️ 未发现旧 .wrangler/state（本来就是全新环境），跳过备份");
    return null;
  }
  const backupDir = path.join(DATA_DIR, `backup-wrangler-state-${timestampSlug()}`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    fs.renameSync(WRANGLER_STATE_DIR, backupDir);
  } catch (err) {
    throw new Error(
      `备份旧 .wrangler/state 失败（${err?.code || err?.message || err}）。` +
        "本地 Worker 很可能仍在运行，请先停止 wrangler dev / 本地 Worker 再执行 --init-fresh"
    );
  }
  log(`📦 旧本地 D1/R2 状态已安全移动到备份目录：${backupDir}`);
  return backupDir;
}

async function applyLocalMigrations() {
  // 0000~0004 建空表：显式 --local，绝不允许 --remote
  await runWrangler(
    ["d1", "migrations", "apply", DB_NAME, "--local"],
    "在全新空白本地 D1 上执行 migrations"
  );
}

async function fetchOnlineSyncStateOnce() {
  if (!ONLINE_WORKER_URL) {
    throw new Error("缺少线上 WORKER_URL（.env.local 或环境变量），无法只读拉取知乎 Cookie");
  }
  const candidates = secretCandidates();
  if (candidates.length === 0) {
    throw new Error("缺少 API_SECRET，无法只读拉取线上 /ingest/sync-state");
  }
  log(`🌐 只读拉取线上同步状态（${ONLINE_WORKER_URL}/ingest/sync-state，仅内存传递，不打印明文）...`);
  let lastStatus = 0;
  for (const candidate of candidates) {
    try {
      const { res, json } = await fetchJson(
        `${ONLINE_WORKER_URL}/ingest/sync-state`,
        { headers: { authorization: `Bearer ${candidate.value}`, connection: "close" } },
        45_000
      );
      lastStatus = res.status;
      if (!res.ok || !json) continue;
      const cookieString = typeof json.cookieString === "string" ? json.cookieString : "";
      const zhihuUsername = typeof json.zhihuUsername === "string" ? json.zhihuUsername : "";
      if (!cookieString) continue;
      log(
        `✅ 已读取线上 Cookie（${cookieString.split(";").filter(s => s.trim()).length} 项）` +
          `与用户名 ${zhihuUsername || ZHIHU_USERNAME || "(未提供)"}（值不落日志）`
      );
      return { cookieString, zhihuUsername };
    } catch { /* 尝试下一个候选密钥 */ }
  }
  throw new Error(
    `无法从线上读取同步状态（最后一次 HTTP ${lastStatus || "网络错误"}）：请确认 .env.local 的 WORKER_URL/API_SECRET 有效`
  );
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * 把 cookie 与黄金策略直接写进本地全新 D1。
 * cookie 只出现在临时 SQL 文件里，写完立即删除；全程不打印明文。
 * （D1 execute 只打印执行结果，不回显 SQL 内容）
 */
async function writeLocalD1State(cookieString) {
  const bin = wranglerBin();
  if (!bin) throw new Error("找不到 wrangler：请先在仓库根目录执行 pnpm install");
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const sqlPath = path.join(RUNTIME_DIR, `.init-${process.pid}-${Date.now()}.sql`);
  const now = new Date().toISOString();
  const syncConfigJson = JSON.stringify(GOLDEN_POLICY);
  const sql = [
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('zhihu_cookie', ${sqlLiteral(cookieString)}, ${sqlLiteral(now)})`,
    `ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('sync_config', ${sqlLiteral(syncConfigJson)}, ${sqlLiteral(now)})`,
    `ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
    ""
  ].join("\n");
  try {
    fs.writeFileSync(sqlPath, sql, { encoding: "utf8", mode: 0o600 });
    // silent：SQL 文件里含 cookie 明文，wrangler 输出一律不回显到控制台
    const result = await runChild(
      process.execPath,
      [bin, "d1", "execute", DB_NAME, "--local", "--yes", `--file=${sqlPath}`],
      { cwd: WORKER_DIR, silent: true }
    );
    if (result.code !== 0) {
      // 只打印长度受限的 stderr（不含 SQL 内容），便于定位 migrations 未执行等问题
      const detail = String(result.stderr || "").replace(/\s+/g, " ").slice(0, 300);
      throw new Error(`写入本地 D1 失败（wrangler 退出码 ${result.code}）${detail ? `: ${detail}` : ""}`);
    }
  } finally {
    try { fs.rmSync(sqlPath, { force: true }); } catch { /* ignore */ }
  }
  // 校验：只打印长度与布尔，不打印内容
  const verify = await runChild(
    process.execPath,
    [
      bin,
      "d1",
      "execute",
      DB_NAME,
      "--local",
      "--yes",
      "--json",
      "--command",
      "SELECT key, length(value) AS len FROM app_settings WHERE key IN ('zhihu_cookie','sync_config')"
    ],
    { cwd: WORKER_DIR, silent: true }
  );
  const text = `${verify.stdout}\n${verify.stderr}`;
  const cookieLen = /"key"\s*:\s*"zhihu_cookie"[\s\S]{0,80}?"len"\s*:\s*(\d+)/.exec(text);
  const cfgLen = /"key"\s*:\s*"sync_config"[\s\S]{0,80}?"len"\s*:\s*(\d+)/.exec(text);
  log(
    `✅ 本地 D1 写入校验：zhihu_cookie ${cookieLen ? `长度 ${cookieLen[1]}` : "已写入"}；` +
      `sync_config ${cfgLen ? `长度 ${cfgLen[1]}` : "已写入"}`
  );
}

/** 本地 Worker 已启动时，通过正式接口再写一次 R2 副本（D1 已由 SQL 写入） */
async function pushPolicyToWorker(secret) {
  try {
    const { res, json } = await localRequest(
      "/api/auth/settings",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...GOLDEN_POLICY })
      },
      secret,
      20_000
    );
    if (!res.ok) {
      log(`⚠️ 通过本地 Worker 写入 R2 策略失败（HTTP ${res.status}），D1 策略已生效，可稍后在网页重试`);
      return false;
    }
    const cfg = json?.syncConfig || {};
    log(
      `✅ 黄金策略已同步到本地 D1/R2：` +
        `收藏夹=${cfg.commentsCollections || "?"}、关注=${cfg.commentsFollowing || "?"}、` +
        `我的回答=${cfg.commentsMyAnswers || "?"}、赞同=${cfg.commentsUpvotes || "?"}、` +
        `敏感度=${cfg.followingSensitivity || "?"}`
    );
    return true;
  } catch (err) {
    log(`⚠️ 同步策略到本地 Worker 失败：${err?.message || err}（D1 已直接写入，抓取不受影响）`);
    return false;
  }
}

async function runInitFresh(progress) {
  const initInfo = { startedAt: new Date().toISOString(), backupDir: null, cookieWritten: false };

  // 1. 备份旧 state（移动而非删除，绝不丢用户旧数据）
  initInfo.backupDir = await backupWranglerState();

  // 2. 全新空白本地 D1 执行 0000~0004 建表
  await applyLocalMigrations();

  // 3. 线上只读拉取一次真实 cookie / username（内存传递）
  const remote = await fetchOnlineSyncStateOnce();
  const cookieString = remote.cookieString || String(process.env.ZHIHU_COOKIE || "").trim();
  if (!cookieString) {
    throw new Error("线上 sync-state 未返回 cookieString，且环境变量 ZHIHU_COOKIE 为空");
  }

  // 4. 写入本地全新 D1（cookie + 黄金策略）
  await writeLocalD1State(cookieString);
  initInfo.cookieWritten = true;

  // 5. 若本地 Worker 已经在跑，顺便把策略写进 R2；否则阶段启动前会再补写
  if (await localHealthy()) {
    try {
      const secret = await resolveLocalSecret();
      await pushPolicyToWorker(secret.value);
    } catch { /* 阶段启动前还会再试 */ }
  } else {
    log("ℹ️ 本地 Worker 尚未启动：R2 策略副本将在阶段运行前自动补写");
  }

  initInfo.finishedAt = new Date().toISOString();
  progress.init = initInfo;
  progress.policy = { ...GOLDEN_POLICY };
  // 全新库：所有阶段状态归零
  for (const stage of STAGES) {
    progress.stages[stage.id].status = "pending";
    progress.stages[stage.id].attempts = 0;
    progress.stages[stage.id].rounds = [];
    progress.stages[stage.id].startedAt = null;
    progress.stages[stage.id].finishedAt = null;
    progress.stages[stage.id].exitCode = null;
    progress.stages[stage.id].statsAfter = null;
  }
  progress.currentStage = null;
  writeProgress(progress);

  log("🎯 全新空白本地库初始化完成（旧数据已备份，未删除任何文件）");
}

// ---------------------------------------------------------------------------
// 阶段执行
// ---------------------------------------------------------------------------
// 爬虫终态标记：main.ts 在「部分被风控」「零数据入库失败」等场景会打印这些关键字，
// 而退出码可能仍是 0（只要求有部分数据入库）。必须靠输出识别，
// 否则一个被风控打断的阶段会被误标 completed，重跑时直接跳过、永久漏数据。
const FATAL_RISK_MARKERS = [
  "zhihu_auth_failed",
  "zhihu_request_failed",
  "ingest_failed",
  "crawler_error"
];

/**
 * 判断阶段是否存在未恢复的单条失败/风控（终态应视为未完成）：
 * main.ts 本轮只要有任一条 401/403/429/5xx/风控空页在重试后仍未恢复，
 * 就会打印 partial_risk_controlled 并带上「未恢复请求失败 N 次」。
 * 旧版爬虫（现有 dist）只输出「重试耗尽 是/否」：为兼容仍按该字段兜底。
 */
function isExhaustedPartialRisk(output) {
  const text = String(output || "");
  if (!text.includes("partial_risk_controlled")) return false;
  const unresolved = /未恢复请求失败\s*(\d+)\s*次/.exec(text);
  if (unresolved) return Number(unresolved[1]) > 0;
  return !text.includes("重试耗尽 否");
}

function detectRiskTerminal(output) {
  const text = String(output || "");
  if (FATAL_RISK_MARKERS.some(marker => text.includes(marker))) return true;
  return isExhaustedPartialRisk(text);
}

function detectRiskMarkers(output) {
  const text = String(output || "");
  const hits = FATAL_RISK_MARKERS.filter(marker => text.includes(marker));
  if (isExhaustedPartialRisk(text)) hits.push("partial_risk_controlled(unresolved)");
  return hits;
}

// ---------------------------------------------------------------------------
// 风控冷却续跑
// ---------------------------------------------------------------------------
// 知乎 40352（/account/unhuman）是滑窗风控：实测固定 300ms 楼中楼 + 350ms 根评论
// 连续请求 1 小时就会触发。停 10 分钟让滑窗清零后重跑时，已入库的正文/评论会因为
// prevCommentCount === commentCount（或 historyDone / upvotes_cursor 断点）自动 0 次
// 评论请求秒跳过，直接从上次中断的那一条往后抓——所以临时 partial_risk_controlled
// 不应该直接杀掉整个守护进程，而应冷却后自动续跑。
const MAX_COOLDOWN_ROUNDS = 12;
// 「冷却后立即再撞风控」判定：真正的滑窗风控在重跑后很快再次 40352；
// 若一轮已经认真跑了 5 分钟以上才被打断，说明风控在渐进收紧，值得继续冷却重试
const IMMEDIATE_RISK_MS = 5 * 60 * 1000;
const PARTIAL_RISK_MARKER = "partial_risk_controlled";

function isPartialRisk(code, tail) {
  return code === 0 && isExhaustedPartialRisk(tail);
}

/** 识别知乎 40352 人机验证（响应体摘要被 safeText 截断时，code 或 redirect 任一出现即判定） */
function isUnhumanRisk(tail) {
  return /40352|account\/unhuman|unhuman/i.test(String(tail || ""));
}

/** 本轮正向进展：contents / comments / collection_items / upvotes 任一增长 */
function diffStatsProgress(before, after) {
  if (!after) return { grown: [], comparable: false };
  if (!before) return { grown: ["stats_unavailable_before"], comparable: false };
  const grown = [];
  for (const key of ["contents", "comments", "collection_items", "upvotes"]) {
    const delta = (after[key] || 0) - (before[key] || 0);
    if (delta > 0) grown.push(`${key}+${delta}`);
  }
  return { grown, comparable: true };
}

function humanVerificationHint() {
  return (
    "知乎要求浏览器人机验证（40352），请在浏览器打开一次 www.zhihu.com 完成滑块后重跑脚本即可无缝继续" +
    "（已入库的正文与评论会 0 请求秒跳过，从上次断点接着抓）；若滑块后仍失败，请检查知乎 Cookie 是否已过期"
  );
}

function buildCrawlerInput(stage, ctx) {
  return {
    runType: stage.runType,
    // 全量模式绝不带 --fast
    isFast: false,
    apiUrl: LOCAL_WORKER_URL,
    apiSecret: ctx.secret,
    zhihuUsername: ctx.zhihuUsername,
    cookieString: ctx.cookieString,
    syncConfig: { ...GOLDEN_POLICY },
    ...(stage.runType === "upvotes" && ctx.upvotesCursor ? { upvotesCursor: ctx.upvotesCursor } : {}),
    ...(stage.runType === "following" && ctx.followedProgress ? { followedProgress: ctx.followedProgress } : {}),
    ...(stage.runType === "following" && Array.isArray(ctx.fullModeUsers) && ctx.fullModeUsers.length > 0
      ? { fullModeUsers: ctx.fullModeUsers }
      : {})
  };
}

async function buildCrawlerOnce() {
  const tscBin = path.join(CRAWLER_DIR, "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(tscBin)) {
    log("⚠️ 找不到本地 typescript，跳过编译（直接使用现有 dist/main.js）");
    return;
  }
  const distMain = path.join(CRAWLER_DIR, "dist", "main.js");
  log("🛠️ 编译 apps/apify-crawler（tsc）...");
  const result = await runChild(process.execPath, [tscBin], { cwd: CRAWLER_DIR });
  if (result.code !== 0) throw new Error(`编译爬虫失败（退出码 ${result.code}）`);
  if (!fs.existsSync(distMain)) throw new Error("编译完成但 dist/main.js 不存在");
  log("✅ 爬虫编译完成");
}

async function runCrawlerStage(stage, ctx) {
  const payload = buildCrawlerInput(stage, ctx);
  fs.mkdirSync(KV_DEFAULT_DIR, { recursive: true });
  fs.writeFileSync(INPUT_JSON_PATH, JSON.stringify(payload, null, 2), "utf8");
  log(
    `🚀 启动阶段 ${stage.id}（runType=${stage.runType}, isFast=false）` +
      (payload.upvotesCursor ? " · 携带 upvotes_cursor 断点续跑" : "")
  );
  try {
    const result = await runChild(process.execPath, ["dist/main.js"], {
      cwd: CRAWLER_DIR,
      env: {
        // 统一注入：本地 Worker 地址 + 本地密钥 + 无限写开关
        WORKER_URL: LOCAL_WORKER_URL,
        API_SECRET: ctx.secret,
        UNLIMITED_LOCAL_WRITES: "1",
        APIFY_LOCAL_STORAGE_DIR: STORAGE_DIR,
        CRAWLEE_STORAGE_DIR: STORAGE_DIR
      }
    });
    // tail 是最后 128KB 输出：足够识别 ending 处的 partial_risk_controlled 等终态标记
    return { code: result.code, tail: result.tail };
  } finally {
    // 明文凭据（cookie / apiSecret）随 INPUT.json 立即清除
    try { fs.rmSync(INPUT_JSON_PATH, { force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// 存量评论补采（--repair-comments，独立运维入口）
// ---------------------------------------------------------------------------
/**
 * 只读查询本地 D1（固定 --local，绝不允许 --remote）。
 * --json 结果可能几百 KB，单独放宽内存抓取上限，并静默执行（不把大段 JSON 回显到控制台）。
 */
async function queryLocalD1Json(sql, label) {
  const bin = wranglerBin();
  if (!bin) throw new Error("找不到 wrangler：请先在仓库根目录执行 pnpm install");
  const result = await runChild(
    process.execPath,
    [bin, "d1", "execute", DB_NAME, "--local", "--yes", "--json", "--command", sql],
    { cwd: WORKER_DIR, silent: true, maxCapture: 8 * 1024 * 1024 }
  );
  if (result.code !== 0) {
    const detail = String(result.stderr || "").replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`本地 D1 查询失败（${label}，退出码 ${result.code}）${detail ? `: ${detail}` : ""}`);
  }
  const text = String(result.stdout || "");
  const start = text.search(/\[\s*[{[]/);
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error(`本地 D1 查询结果不是 JSON（${label}）`);
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new Error(`本地 D1 查询结果解析失败（${label}）: ${err?.message || err}`);
  }
  // wrangler --json 输出形如 [{ results: [...], success, meta }]，兼容旧版本的扁平数组
  if (!Array.isArray(parsed)) throw new Error(`本地 D1 查询结果结构异常（${label}）`);
  const first = parsed[0];
  if (Array.isArray(first)) return first;
  if (first && Array.isArray(first.results)) return first.results;
  return [];
}

/**
 * 补采候选：根评论数明显少于评论总数的 answer/article。
 * 判定与爬虫 shouldSyncCommentsDeep 保持一致（roots * 3 < comment_count 且 roots < 50），
 * 上限 50 同时保证「根评论本来就多、只是回复占比高」的正常内容不会被反复补采。
 */
const REPAIR_CANDIDATE_SQL = [
  "SELECT c.pk AS pk",
  "FROM contents c",
  "LEFT JOIN (",
  "  SELECT content_pk AS cp, COUNT(*) AS roots",
  "  FROM comments",
  "  WHERE parent_comment_id IS NULL AND is_deleted = 0",
  "  GROUP BY content_pk",
  ") r ON r.cp = c.pk",
  "WHERE c.is_deleted = 0",
  "  AND c.source_type IN ('answer', 'article')",
  "  AND c.comment_count > 0",
  "  AND COALESCE(r.roots, 0) * 3 < c.comment_count",
  "  AND COALESCE(r.roots, 0) < 50",
  "ORDER BY c.pk"
].join("\n");

async function queryRepairCommentTargets() {
  log("🔎 从本地 D1 查询待补采内容（根评论数 < 评论总数/3 且根评论 < 50）...");
  const rows = await queryLocalD1Json(REPAIR_CANDIDATE_SQL, "补采候选清单");
  const targets = [];
  for (const row of rows) {
    const pk = String(row?.pk || "").trim();
    // 只下发 answer/article 且 id 干净的目标，脏数据不进爬虫子进程
    if (/^(answer|article):\d+$/.test(pk)) targets.push(pk);
  }
  return targets;
}

/** 解析爬虫终态里的「本轮评论补采：成功 X 条 / 跳过 Y 条 / 失败 Z 条」汇总行 */
function parseRepairSummary(tail) {
  const m = /本轮评论补采：成功 (\d+) 条 \/ 跳过 (\d+) 条 \/ 失败 (\d+) 条/.exec(String(tail || ""));
  if (!m) return null;
  return { ok: Number(m[1]), skipped: Number(m[2]), failed: Number(m[3]) };
}

/** 用一批 repairTargets 启动一次爬虫子进程（runType=repair-comments） */
async function runRepairBatch(batch, ctx) {
  const payload = {
    runType: "repair-comments",
    isFast: false,
    apiUrl: LOCAL_WORKER_URL,
    apiSecret: ctx.secret,
    zhihuUsername: ctx.zhihuUsername,
    cookieString: ctx.cookieString,
    syncConfig: { ...GOLDEN_POLICY },
    repairTargets: batch
  };
  fs.mkdirSync(KV_DEFAULT_DIR, { recursive: true });
  fs.writeFileSync(INPUT_JSON_PATH, JSON.stringify(payload, null, 2), "utf8");
  try {
    const result = await runChild(process.execPath, ["dist/main.js"], {
      cwd: CRAWLER_DIR,
      env: {
        WORKER_URL: LOCAL_WORKER_URL,
        API_SECRET: ctx.secret,
        UNLIMITED_LOCAL_WRITES: "1",
        APIFY_LOCAL_STORAGE_DIR: STORAGE_DIR,
        CRAWLEE_STORAGE_DIR: STORAGE_DIR
      }
    });
    return { code: result.code, tail: result.tail };
  } finally {
    // 明文凭据（cookie / apiSecret）随 INPUT.json 立即清除
    try { fs.rmSync(INPUT_JSON_PATH, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * 存量评论补采主流程：分批下发 → 每批结束检查风控/失败 → 命中即停。
 * 不写 full-harvest-progress.json：补采是独立运维操作，不能污染 stage1-5 的状态机。
 * 重跑同一命令即可续跑——已补齐的内容根评论数增长后会自动从候选清单消失。
 */
async function runRepairCommentsMode(ctx) {
  const allTargets = await queryRepairCommentTargets();
  if (allTargets.length === 0) {
    log("✅ 没有需要补采的内容（所有内容根评论数与评论总数匹配）");
    return true;
  }
  const limit = opts.repairMax > 0 ? Math.min(opts.repairMax, allTargets.length) : allTargets.length;
  const targets = allTargets.slice(0, limit);
  const batchSize = Math.max(1, opts.repairBatchSize);
  const batches = Math.ceil(targets.length / batchSize);
  log(
    `🩹 待补采 ${allTargets.length} 条，本轮处理 ${targets.length} 条，分 ${batches} 批` +
      `（每批 ${batchSize} 条，full 模式重抓根评论+楼中楼）`
  );

  let processed = 0;
  let okTotal = 0;
  let skippedTotal = 0;
  let failedTotal = 0;
  let completed = true;

  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize);
    const batchNo = Math.floor(i / batchSize) + 1;
    log(`🩹 补采批次 ${batchNo}/${batches}：${batch.length} 条`);
    const { code, tail } = await runRepairBatch(batch, ctx);
    const parsed = parseRepairSummary(tail);
    if (parsed) {
      okTotal += parsed.ok;
      skippedTotal += parsed.skipped;
      failedTotal += parsed.failed;
    }
    processed += batch.length;

    // code 2 = 连续失败断路器；partial_risk_controlled 末尾标记 = 被知乎风控中断
    const riskTerminal = code === 2 || detectRiskTerminal(tail);
    if (riskTerminal) {
      completed = false;
      log(
        `⛔ 补采批次 ${batchNo} 被风控/熔断中断（退出码 ${code}），已入库部分保留；` +
          `建议按 ${Math.max(1, Math.round(opts.cooldownSeconds / 60))} 分钟冷却后重跑 --repair-comments，` +
          `剩余目标会自动继续`
      );
      break;
    }
    if (code !== 0) {
      completed = false;
      const markers = detectRiskMarkers(tail);
      log(
        `❌ 补采批次 ${batchNo} 失败（退出码 ${code}${markers.length ? `，命中标记 ${markers.join(" / ")}` : ""}），` +
          `停止后续批次；修复后重跑 --repair-comments 继续`
      );
      break;
    }
    log(
      `✅ 补采批次 ${batchNo} 完成` +
        (parsed ? `（成功 ${parsed.ok} / 跳过 ${parsed.skipped} / 失败 ${parsed.failed}）` : "")
    );
  }

  const remaining = await queryRepairCommentTargets().catch(() => null);
  log("════════════════════════════════════════════════════════");
  log(
    `📊 评论补采结束：下发 ${processed}/${targets.length} 条；` +
      `爬虫汇总 成功 ${okTotal} / 跳过 ${skippedTotal} / 失败 ${failedTotal} 条`
  );
  if (!remaining) {
    log("ℹ️ 本次未能复核剩余待补采数（D1 查询失败，不影响已入库数据）");
  } else if (remaining.length === 0) {
    log("✅ 本地 D1 候选清单已清空：本轮补采内容根评论数均已达到判定阈值");
  } else {
    log(
      `🔁 本地 D1 仍有 ${remaining.length} 条待补采（含本轮失败/未下发的目标），` +
        `重跑 --repair-comments 继续`
    );
  }
  log("════════════════════════════════════════════════════════");
  return completed;
}

/**
 * 执行单个阶段，遇到知乎临时风控（partial_risk_controlled）时冷却续跑：
 *   1. 本轮相比本轮开始前 /api/stats 有正向进展（contents / comments /
 *      collection_items / upvotes 任一增长）→ 冷却后继续；
 *   2. 没有进展但冷却轮数未超上限 → 也给一次机会继续（风控可能在滑窗尾巴上）；
 *   3. 冷却 10 分钟重跑后仍然 0 条新进展、且很快再次被风控打断
 *      → 判定需要浏览器滑块，暂停退出并打印明确提示；
 *   4. 每个阶段最多自动冷却续跑 MAX_COOLDOWN_ROUNDS 轮。
 */
async function runStageWithCooldown(stage, ctx, progress) {
  const entry = progress.stages[stage.id];
  const isUpvotes = stage.runType === "upvotes";
  entry.status = "running";
  entry.startedAt = entry.startedAt || new Date().toISOString();
  entry.finishedAt = null;
  entry.exitCode = null;
  progress.currentStage = stage.id;
  writeProgress(progress);
  log(`▶️ 开始 ${stage.id}：${stage.title}（${stage.note}）`);

  // 连续「0 条新进展」的次数：只有冷却后的再次 0 进展才判定需要人工滑块验证
  let zeroGrowthStreak = 0;

  for (let round = 1; round <= MAX_COOLDOWN_ROUNDS; round++) {
    // 赞同阶段与关注阶段每轮都重新读取最新断点（upvotes_cursor / followedProgress），
    // 确保上一轮已完成摸底的关注答主 0 请求秒跳过、赞同从最新游标续跑
    const latestState = await fetchLocalSyncState(ctx.secret).catch(() => null);
    if (latestState) {
      ctx.followedProgress = latestState.followedProgress || undefined;
      ctx.fullModeUsers = Array.isArray(latestState.fullModeUsers) ? latestState.fullModeUsers : [];
      if (latestState.cookieString) ctx.cookieString = latestState.cookieString;
    }
    if (isUpvotes) {
      const cursor = latestState?.upvotesCursor || null;
      ctx.upvotesCursor = cursor || undefined;
      log(
        `🔁 ${stage.id} 第 ${round}/${MAX_COOLDOWN_ROUNDS} 轮 | 起始游标: ` +
          (cursor ? "已保存断点（续跑）" : "无（从最新动态开始）")
      );
    } else if (round > 1) {
      log(`🔁 ${stage.id} 第 ${round}/${MAX_COOLDOWN_ROUNDS} 轮 | 冷却后续跑，已入库条目会自动 0 请求秒跳过`);
    }

    const statsBefore = await fetchStats(ctx.secret);
    entry.attempts = (entry.attempts || 0) + 1;
    const roundStartedAt = Date.now();
    const { code, tail } = await runCrawlerStage(stage, ctx);
    const roundMs = Date.now() - roundStartedAt;
    const riskTerminal = detectRiskTerminal(tail);
    const partialRisk = isPartialRisk(code, tail);
    const statsAfter = await fetchStats(ctx.secret);
    // 赞同阶段以 upvotes_cursor 是否清空为完成标准；其他阶段以退出码 + 终态标记判断
    const remainingCursor = isUpvotes
      ? (await fetchLocalSyncState(ctx.secret).catch(() => null))?.upvotesCursor || null
      : null;
    const { grown, comparable } = diffStatsProgress(statsBefore, statsAfter);

    entry.exitCode = code;
    entry.riskTerminal = riskTerminal;
    entry.statsAfter = statsAfter;
    progress.latestStats = statsAfter;
    entry.rounds = Array.isArray(entry.rounds) ? entry.rounds : [];
    entry.rounds.push({
      round,
      exitCode: code,
      riskTerminal,
      partialRisk,
      grewBy: grown,
      durationMs: roundMs,
      cursorBefore: isUpvotes ? (ctx.upvotesCursor ? "saved" : null) : undefined,
      cursorAfter: remainingCursor ? "saved" : null,
      finishedAt: new Date().toISOString(),
      stats: statsAfter
    });
    writeProgress(progress);
    log(
      `📊 ${stage.id} 第 ${round} 轮结束（退出码 ${code}${riskTerminal ? "，终态标记 partial" : ""}）| ${formatStats(statsAfter)}` +
        ` | 本轮进展: ${grown.length > 0 ? grown.join(" / ") : "无新增"}`
    );

    // 完成判定：赞同阶段必须「退出码 0 + 游标已清空（明确翻到历史末尾）」，
    // 所有阶段都必须没有未恢复的单条失败/风控终态标记，否则冷却续跑补抓。
    const cursorSettled = !isUpvotes || !remainingCursor;
    if (code === 0 && cursorSettled && !riskTerminal) {
      entry.status = "completed";
      entry.finishedAt = new Date().toISOString();
      progress.currentStage = null;
      writeProgress(progress);
      log(`✅ 阶段完成 ${stage.id} | ${formatStats(statsAfter)}`);
      return { ok: true, code };
    }

    // 值得冷却续跑的终态：
    //   - 任意阶段：有数据入库但被风控打断（partial_risk_controlled）
    //   - 赞同阶段：沿用既有「风控/异常退出未追平断点就重试」语义
    const riskish = partialRisk || (isUpvotes && (riskTerminal || code === 0));

    if (!riskish) {
      entry.status = code === 0 ? "partial" : "failed";
      entry.finishedAt = new Date().toISOString();
      progress.currentStage = null;
      writeProgress(progress);
      if (code !== 0) {
        log(`❌ 阶段失败 ${stage.id}（退出码 ${code}）| ${formatStats(statsAfter)}`);
      } else {
        log(`⚠️ 阶段异常终态 ${stage.id}（退出码 0 但出现风控/失败标记）| ${formatStats(statsAfter)}`);
      }
      const markers = detectRiskMarkers(tail);
      log(
        `⛔ 该终态不是临时风控冷却能解决的（命中标记: ${markers.join(" / ") || "退出码异常"}），` +
          `已保存断点，请修复后重跑本脚本自动续跑`
      );
      return { ok: false, code };
    }

    // 进展统计：stats 取不到时保守按「有进展」处理，避免误判成需要人工滑块而提前退出
    if (comparable) {
      if (grown.length > 0) zeroGrowthStreak = 0;
      else zeroGrowthStreak++;
    } else {
      zeroGrowthStreak = 0;
    }

    const unhuman = isUnhumanRisk(tail);
    const immediate = roundMs < IMMEDIATE_RISK_MS;
    if (zeroGrowthStreak >= 2 && immediate) {
      entry.status = "paused";
      entry.finishedAt = new Date().toISOString();
      progress.currentStage = null;
      writeProgress(progress);
      log(
        `⛔ 阶段 ${stage.id} 冷却后重跑仍 0 条新进展，且在 ${Math.max(1, Math.round(roundMs / 1000))} 秒内` +
          `再次被风控打断（第 ${round}/${MAX_COOLDOWN_ROUNDS} 轮）`
      );
      log(`🖐️ ${humanVerificationHint()}`);
      return { ok: false, code };
    }

    if (round === MAX_COOLDOWN_ROUNDS) {
      entry.status = "failed";
      entry.finishedAt = new Date().toISOString();
      progress.currentStage = null;
      writeProgress(progress);
      log(
        `❌ ${stage.id} 已连续 ${MAX_COOLDOWN_ROUNDS} 轮冷却续跑仍未完成，断点已保存，` +
          `请稍后重跑本脚本自动续跑`
      );
      return { ok: false, code };
    }

    const waitSec = opts.cooldownSeconds;
    const waitMin = Math.max(1, Math.round(waitSec / 60));
    log(
      `⏳ 阶段 ${stage.id} 触发知乎临时风控冷却，已安全入库本批数据，` +
        `休息 ${waitMin} 分钟让知乎滑窗清零后自动续跑（第 ${round}/${MAX_COOLDOWN_ROUNDS} 轮）...`
    );
    if (unhuman) {
      log(`   已识别到 40352 / account/unhuman 人机验证标记；若冷却续跑仍失败，请在浏览器完成一次滑块`);
    }
    await sleep(waitSec * 1000);
  }

  return { ok: false, code: 1 };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function printHelp() {
  console.log(
    [
      "本地全量重扒总控脚本",
      "",
      "用法：",
      "  node scripts/full-local-harvest.mjs --init-fresh   备份旧 .wrangler/state + 建空表 + 写入 cookie/黄金策略",
      "  node scripts/full-local-harvest.mjs                从断点继续未完成阶段",
      "  node scripts/full-local-harvest.mjs --reset-progress",
      "  node scripts/full-local-harvest.mjs --only=stage4_following_full",
      "  node scripts/full-local-harvest.mjs --from=stage3_collections_full",
      "  node scripts/full-local-harvest.mjs --repair-comments   补采存量被 v4 截断的评论（独立运维入口，不写阶段进度）",
      "",
      "可选参数：",
      "  --skip-build                跳过爬虫编译（直接使用现有 dist/main.js）",
      "  --repair-batch-size=50      补采每批下发的内容条数（默认 50）",
      "  --repair-max=0              单次补采最多处理多少条（0=不限制，便于先小批量试跑）",
      `  --cooldown-seconds=600      知乎临时风控（partial_risk_controlled）冷却秒数（默认 600 秒，最多 12 轮）`,
      "  --wait-worker-seconds=120   等待本地 Worker 就绪的秒数（默认 120）",
      "",
      `阶段：`,
      ...STAGES.map(s => `  ${s.id}  ${s.title}`)
    ].join("\n")
  );
}

function selectStages() {
  if (opts.only && !STAGE_IDS.has(opts.only)) {
    throw new Error(`未知 --only=${opts.only}；可用：${[...STAGE_IDS].join(" / ")}`);
  }
  if (opts.from && !STAGE_IDS.has(opts.from)) {
    throw new Error(`未知 --from=${opts.from}；可用：${[...STAGE_IDS].join(" / ")}`);
  }
  if (opts.only) return STAGES.filter(s => s.id === opts.only);
  if (opts.from) {
    const fromIdx = STAGES.findIndex(s => s.id === opts.from);
    return STAGES.slice(fromIdx);
  }
  return STAGES;
}

function resetProgress(progress) {
  for (const stage of STAGES) {
    const entry = progress.stages[stage.id];
    entry.status = "pending";
    entry.attempts = 0;
    entry.rounds = [];
    entry.startedAt = null;
    entry.finishedAt = null;
    entry.exitCode = null;
    entry.statsAfter = null;
  }
  progress.currentStage = null;
  writeProgress(progress);
}

// ---------------------------------------------------------------------------
// 单实例锁 / 心跳
// ---------------------------------------------------------------------------
let lockAcquired = false;

/**
 * logs/full-harvest.lock 单实例锁：
 * - 锁存在且 pid 仍存活 → 打印信息并退出非零，避免两个全量任务同时打知乎；
 * - pid 已不存在（ESRCH）→ 旧进程异常退出留下的陈旧锁，直接覆盖；
 * - 无权限探测（EPERM）说明进程很可能仍存在，按存活处理。
 */
function acquireInstanceLock() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  if (fs.existsSync(LOCK_PATH)) {
    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
    } catch { /* 锁内容损坏按陈旧锁处理 */ }
    const pid = Number(holder?.pid);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        console.error(
          `❌ 已有全量采集进程在运行（pid ${pid}，启动于 ${holder?.startedAt || "未知"}）。` +
            `确认其已退出后可删除 ${LOCK_PATH} 再重试`
        );
        return false;
      } catch (err) {
        if (err?.code !== "ESRCH") {
          console.error(
            `❌ 无法确认锁持有进程（pid ${pid}）是否已退出（${err?.code || err?.message}），为避免并发抓取本次退出`
          );
          return false;
        }
      }
    }
    console.warn(`⚠️ 发现陈旧锁（pid ${pid || "未知"} 已不存在），覆盖 ${LOCK_PATH}`);
  }
  fs.writeFileSync(
    LOCK_PATH,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
  lockAcquired = true;

  const cleanup = () => releaseInstanceLock();
  process.once("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.once(sig, () => {
      cleanup();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
  return true;
}

function releaseInstanceLock() {
  if (!lockAcquired) return;
  lockAcquired = false;
  try {
    const holder = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
    if (Number(holder?.pid) === process.pid) fs.rmSync(LOCK_PATH, { force: true });
  } catch { /* 锁已被删除/损坏：无需处理 */ }
}

let heartbeatTimer = null;

/** 每 60 秒刷新 progress.heartbeatAt，便于外部判断全量任务是否还活着 */
function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (!latestProgress) return;
    latestProgress.heartbeatAt = new Date().toISOString();
    try {
      writeProgress(latestProgress);
    } catch (err) {
      console.warn(`⚠️ 心跳写入进度失败: ${err?.message || err}`);
    }
  }, 60_000);
  heartbeatTimer.unref();
}

function stopHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function main() {
  if (opts.help) {
    printHelp();
    return;
  }
  if (!acquireInstanceLock()) {
    process.exitCode = 1;
    return;
  }
  process.once("exit", stopHeartbeat);
  startHeartbeat();
  ensureDirs();
  log("════════════════════════════════════════════════════════");
  log("🧭 本地全量重扒总控启动");
  log(`   本地 Worker: ${LOCAL_WORKER_URL}`);
  log(`   阶段：${selectStages().map(s => s.id).join(" → ")}`);
  log("════════════════════════════════════════════════════════");

  let progress = readProgress();
  latestProgress = progress;
  if (opts.resetProgress) {
    resetProgress(progress);
    log("♻️ 已重置阶段进度（本地数据不清空）");
  }

  // 1. 全新空白库初始化
  if (opts.initFresh) {
    await runInitFresh(progress);
    progress = readProgress();
  }

  // 2. 等本地 Worker 就绪（migrations / 重启后由主流程负责拉起）
  if (opts.initFresh && !(await localHealthy())) {
    // --init-fresh 允许在 Worker 停机状态下独立完成：初始化已落地，启动 Worker 后重跑即可继续
    log("🎯 初始化已完成；本地 Worker 尚未启动，本次仅完成初始化。");
    log("👉 下一步：启动本地 Worker（http://127.0.0.1:18787）后再次执行本脚本，将自动从 stage1 开始全量抓取。");
    process.exitCode = 0;
    return;
  }
  if (!(await waitForLocalWorker(opts.waitWorkerSeconds))) {
    throw new Error(
      `本地 Worker 未就绪（${LOCAL_WORKER_URL}/api/stats 无响应）。请先执行 ` +
        `"pnpm --filter worker dev" 或现有本地 Worker 启动流程后再重跑本脚本`
    );
  }
  const localSecret = await resolveLocalSecret();

  // 3. 黄金策略补写（init-fresh 时若 Worker 未启动，R2 副本在这里补上；日常重跑也无害）
  await pushPolicyToWorker(localSecret.value);

  // 4. 拉 cookie / username：优先本地 D1（init-fresh 已写入），否则回退线上只读
  let localState = await fetchLocalSyncState(localSecret.value).catch(() => null);
  let cookieString = localState?.cookieString || "";
  let zhihuUsername = localState?.zhihuUsername || ZHIHU_USERNAME;
  if (!cookieString) {
    log("⚠️ 本地 D1 中没有可用 cookie，回退到线上只读拉取一次（仅内存传递）");
    const remote = await fetchOnlineSyncStateOnce();
    cookieString = remote.cookieString;
    zhihuUsername = zhihuUsername || remote.zhihuUsername;
  }
  if (!cookieString) throw new Error("本地与线上都没有可用知乎 Cookie，请先在网页端更新 Cookie");
  if (!zhihuUsername) throw new Error("缺少知乎用户名 ZHIHU_USERNAME（.env.local 或 wrangler.toml）");
  log(`✅ 抓取账号: ${zhihuUsername}（cookie 已在内存中就绪，明文不落日志）`);

  // 5. 编译爬虫（全量重扒前确保 dist 是最新代码，含 full 楼中楼翻页与无限写开关）
  if (opts.build) await buildCrawlerOnce();

  // 6. 按顺序执行阶段（completed 自动跳过；失败即停，重跑自动续）
  const ctx = {
    secret: localSecret.value,
    cookieString,
    zhihuUsername,
    upvotesCursor: localState?.upvotesCursor || undefined,
    // 断点状态必须带到子进程：history_done 的答主秒跳过，full 模式用户从 resumeOffset 续跑
    followedProgress: localState?.followedProgress || undefined,
    fullModeUsers: Array.isArray(localState?.fullModeUsers) ? localState.fullModeUsers : []
  };

  // 5.5 存量评论补采：独立运维入口，只有显式 --repair-comments 才触发。
  // 不写进度文件、不参与 stage1-5 状态机，避免每次全量重扒都重抓几千条存量内容。
  if (opts.repairComments) {
    const ok = await runRepairCommentsMode(ctx);
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const stages = selectStages();
  let failed = false;
  for (const stage of stages) {
    const entry = progress.stages[stage.id];
    if (entry.status === "completed") {
      log(`⏭️ 跳过已完成阶段 ${stage.id}`);
      continue;
    }
    const result = await runStageWithCooldown(stage, ctx, progress);
    if (!result.ok) {
      failed = true;
      // 断点守护：当前阶段失败就不再往后跑，避免「关注答主/赞同」在数据不完整时被标记完成
      log(`⛔ 阶段 ${stage.id} 未完成，后续阶段暂停。修复后重跑本脚本会自动从这里继续。`);
      break;
    }
  }

  const finalStats = await fetchStats(localSecret.value);
  progress.latestStats = finalStats;
  writeProgress(progress);
  log("════════════════════════════════════════════════════════");
  log(`🏁 本轮结束 | ${formatStats(finalStats)}`);
  log(`📄 进度文件: ${PROGRESS_PATH}`);
  log(`📄 运行日志: ${LOG_PATH}`);
  log("════════════════════════════════════════════════════════");
  process.exitCode = failed ? 1 : 0;
}

main().catch(err => {
  log(`❌ 全量抓取编排失败: ${err?.message || err}`);
  process.exitCode = 1;
});
