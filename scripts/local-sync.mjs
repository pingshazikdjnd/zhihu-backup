#!/usr/bin/env node
/**
 * 本地全量/断点续传同步脚本（不消耗 Apify 额度）
 *
 * 工作流：
 * 1. 读取项目根目录 .env.local（或环境变量）中的 WORKER_URL、API_SECRET 与代理配置
 * 2. 若未显式开启 NODE_USE_ENV_PROXY 且配置了 HTTPS_PROXY，自动携带 --use-env-proxy 重启自身，
 *    使 Node fetch 访问 *.workers.dev 自动走代理，而 Playwright 抓知乎走国内直连（防风控）
 * 3. 请求线上 Worker 的 GET /ingest/sync-state，自动获取：
 *    - D1 中最新的 zhihu_cookie（网页端扫码/更新后自动生效）
 *    - 当前赞同断点游标 upvotes_cursor（从上次中断处继续向旧历史翻页）
 *    - 知乎用户名 zhihuUsername
 * 4. 写入 apps/apify-crawler/storage/key_value_stores/default/INPUT.json
 * 5. 在本地拉起 Playwright Chromium 直接执行 apps/apify-crawler/dist/main.js
 *
 * 用法：
 *   pnpm sync:upvotes                            # 仅跑赞同历史断点补全（推荐首次追平用）
 *   pnpm sync:local                              # 全量同步（回答+收藏+赞同断点续传）
 *   node scripts/local-sync.mjs --fast           # 快速增量模式
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CRAWLER_DIR = path.join(ROOT, "apps", "apify-crawler");

// 1. 加载 .env.local（如果存在）
const envPath = path.join(ROOT, ".env.local");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

// 若配置了 HTTPS_PROXY 但当前进程未开启 --use-env-proxy，自动带 --use-env-proxy 重启自身
if (process.env.HTTPS_PROXY && !process.env.__LOCAL_SYNC_PROXY_BOOTSTRAPPED) {
  const child = spawn(
    process.execPath,
    ["--use-env-proxy", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_USE_ENV_PROXY: "1",
        __LOCAL_SYNC_PROXY_BOOTSTRAPPED: "1"
      }
    }
  );
  child.on("exit", code => process.exit(code ?? 0));
  await new Promise(() => {});
}

// 解析命令行参数
const args = process.argv.slice(2);
let runType = "all";
let isFast = false;
let dryRun = false;
for (const arg of args) {
  if (arg.startsWith("--type=")) runType = arg.slice("--type=".length);
  else if (arg === "--upvotes" || arg === "--upvotes-only") runType = "upvotes";
  else if (arg === "--answers") runType = "answers";
  else if (arg === "--collections") runType = "collections";
  else if (arg === "--fast") isFast = true;
  else if (arg === "--dry-run") dryRun = true;
}

const apiUrl = (process.env.WORKER_URL || "").replace(/\/$/, "");
const apiSecret = process.env.API_SECRET || "";

if (!apiUrl || !apiSecret) {
  console.error("❌ 缺少 WORKER_URL 或 API_SECRET，请检查项目根目录下的 .env.local");
  process.exit(1);
}

console.log(`🔗 正在连接云端 Worker (${apiUrl}) 获取最新同步状态与断点游标...`);
const stateRes = await fetch(`${apiUrl}/ingest/sync-state`, {
  headers: { authorization: `Bearer ${apiSecret}` }
});

if (!stateRes.ok) {
  console.error(`❌ 无法从 Worker 获取同步状态: HTTP ${stateRes.status} ${await stateRes.text()}`);
  process.exit(1);
}

const remoteState = await stateRes.json();
const cookieString = remoteState.cookieString || process.env.ZHIHU_COOKIE || "";
const zhihuUsername = remoteState.zhihuUsername || process.env.ZHIHU_USERNAME || "";
const upvotesCursor = remoteState.upvotesCursor || undefined;

if (!cookieString) {
  console.error("❌ 线上 D1 与本地均未找到知乎 Cookie，请先在网页端【凭据】页更新 Cookie");
  process.exit(1);
}
if (!zhihuUsername) {
  console.error("❌ 未找到 ZHIHU_USERNAME");
  process.exit(1);
}

console.log(`✅ 账号: ${zhihuUsername}`);
console.log(`✅ 模式: runType=${runType}, isFast=${isFast}`);
console.log(`✅ 赞同断点游标: ${upvotesCursor ? upvotesCursor : "无（将从头全量扫描）"}`);

// 2. 准备 Apify 本地存储目录并写入 INPUT.json
const storageDir = path.join(CRAWLER_DIR, "storage");
const kvDefaultDir = path.join(storageDir, "key_value_stores", "default");
fs.mkdirSync(kvDefaultDir, { recursive: true });

const inputPayload = {
  runType,
  isFast,
  apiUrl,
  apiSecret,
  zhihuUsername,
  cookieString,
  ...(upvotesCursor ? { upvotesCursor } : {})
};

fs.writeFileSync(
  path.join(kvDefaultDir, "INPUT.json"),
  JSON.stringify(inputPayload, null, 2),
  "utf8"
);

if (dryRun) {
  console.log("✅ --dry-run 校验通过，INPUT.json 已生成。");
  process.exit(0);
}

// 3. 启动本地爬虫（dist/main.js）
console.log("🚀 开始本地同步（Playwright 直连知乎 + 自动写入云端 D1/R2，零 Apify 额度消耗）...\n");
const nodeArgs = process.env.HTTPS_PROXY ? ["--use-env-proxy", "dist/main.js"] : ["dist/main.js"];
const runProc = spawn(process.execPath, nodeArgs, {
  cwd: CRAWLER_DIR,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_USE_ENV_PROXY: process.env.HTTPS_PROXY ? "1" : (process.env.NODE_USE_ENV_PROXY || ""),
    APIFY_LOCAL_STORAGE_DIR: storageDir,
    CRAWLEE_STORAGE_DIR: storageDir
  }
});

runProc.on("exit", code => {
  if (code === 0) {
    console.log("\n🎉 本地同步执行完毕！");
  } else {
    console.error(`\n⚠️ 本地同步暂停（状态码 ${code}）。若因 D1 每日 100K 写入限额暂停，当前页断点已自动保留，明日北京时间 08:00 后重跑即可无缝继续。`);
  }
  process.exit(code ?? 0);
});
