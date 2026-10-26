#!/usr/bin/env node
/**
 * 本地全量/断点续传同步脚本（不消耗 Apify 额度）
 *
 * 工作流：
 * 1. 读取项目根目录 .env.local（或环境变量）中的 WORKER_URL、API_SECRET 与代理配置
 * 2. 自动探测 HTTPS_PROXY 端口是否存活：存活则自动携带 --use-env-proxy 使 Node fetch
 *    访问 *.workers.dev 走代理（Playwright 抓知乎仍走国内直连防风控）；未启动则自动回退直连
 * 3. 单实例 PID 文件锁（防止后台计划任务与手动运行并发冲突）
 * 4. 请求线上 Worker 的 GET /ingest/sync-state，自动获取：
 *    - D1 中最新的 zhihu_cookie（网页端扫码/更新后自动生效）
 *    - 当前赞同断点游标 upvotes_cursor（从上次中断处继续向旧历史翻页）
 *    - 知乎用户名 zhihuUsername
 * 5. 写入 apps/apify-crawler/storage/key_value_stores/default/INPUT.json
 * 6. 编译并在本地拉起 Playwright Chromium 直接执行 apps/apify-crawler/dist/main.js
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CRAWLER_DIR = path.join(ROOT, "apps", "apify-crawler");
const LOCK_FILE = path.join(CRAWLER_DIR, ".local-sync.lock");

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

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isProxyReachable(proxyUrl) {
  try {
    const u = new URL(proxyUrl);
    const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
    const host = u.hostname || "127.0.0.1";
    return await new Promise(resolve => {
      const socket = net.connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 1200);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.end();
        resolve(true);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  } catch {
    return false;
  }
}

async function main() {
  // 2. 自动探测本地代理端口是否存活，若存活且尚未带 --use-env-proxy 则重启自身
  if (process.env.HTTPS_PROXY && !process.env.__LOCAL_SYNC_PROXY_BOOTSTRAPPED) {
    const proxyOk = await isProxyReachable(process.env.HTTPS_PROXY);
    if (proxyOk) {
      const code = await new Promise(resolve => {
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
        child.on("close", exitCode => resolve(exitCode ?? 0));
      });
      process.exitCode = code;
      return;
    } else {
      console.warn(`⚠️ 本地代理 ${process.env.HTTPS_PROXY} 未启动，已自动回退为直连模式`);
      delete process.env.HTTPS_PROXY;
      delete process.env.HTTP_PROXY;
      delete process.env.NODE_USE_ENV_PROXY;
    }
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

  // 3. 单实例文件锁检查（防止计划任务与手动运行并发冲突）
  if (!dryRun && fs.existsSync(LOCK_FILE)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
      if (isPidAlive(lockData.pid)) {
        console.log(`⏭️ 已有本地同步任务正在运行 (PID: ${lockData.pid}, 启动于 ${lockData.startedAt})，本次跳过。`);
        return;
      }
    } catch { /* ignore broken lock */ }
  }

  const apiUrl = (process.env.WORKER_URL || "").replace(/\/$/, "");
  const apiSecret = process.env.API_SECRET || "";

  if (!apiUrl || !apiSecret) {
    console.error("❌ 缺少 WORKER_URL 或 API_SECRET，请检查项目根目录下的 .env.local");
    process.exitCode = 1;
    return;
  }

  console.log(`[${new Date().toISOString()}] 🔗 正在连接云端 Worker (${apiUrl}) 获取最新同步状态与断点游标...`);
  const stateRes = await fetch(`${apiUrl}/ingest/sync-state`, {
    headers: { authorization: `Bearer ${apiSecret}`, connection: "close" }
  });

  if (!stateRes.ok) {
    console.error(`❌ 无法从 Worker 获取同步状态: HTTP ${stateRes.status} ${await stateRes.text()}`);
    process.exitCode = 1;
    return;
  }

  const remoteState = await stateRes.json();
  const cookieString = remoteState.cookieString || process.env.ZHIHU_COOKIE || "";
  const zhihuUsername = remoteState.zhihuUsername || process.env.ZHIHU_USERNAME || "";
  const upvotesCursor = remoteState.upvotesCursor || undefined;
  const fullModeUsers = Array.isArray(remoteState.fullModeUsers) ? remoteState.fullModeUsers : [];

  if (!cookieString) {
    console.error("❌ 线上 D1 与本地均未找到知乎 Cookie，请先在网页端【凭据】页更新 Cookie");
    process.exitCode = 1;
    return;
  }
  if (!zhihuUsername) {
    console.error("❌ 未找到 ZHIHU_USERNAME");
    process.exitCode = 1;
    return;
  }

  console.log(`✅ 账号: ${zhihuUsername}`);
  console.log(`✅ 模式: runType=${runType}, isFast=${isFast}`);
  console.log(`✅ 赞同断点游标: ${upvotesCursor ? upvotesCursor : "无（日常增量/从头扫描）"}`);
  console.log(`✅ 全量备份关注答主数: ${fullModeUsers.length} 人`);

  // 4. 准备 Apify 本地存储目录并写入 INPUT.json
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
    ...(upvotesCursor ? { upvotesCursor } : {}),
    ...(fullModeUsers.length > 0 ? { fullModeUsers } : {})
  };

  fs.writeFileSync(
    path.join(kvDefaultDir, "INPUT.json"),
    JSON.stringify(inputPayload, null, 2),
    "utf8"
  );

  // 5. 编译 apps/apify-crawler 确保 dist/main.js 为最新代码
  const tscBin = path.join(CRAWLER_DIR, "node_modules", "typescript", "bin", "tsc");
  if (fs.existsSync(tscBin)) {
    const buildCode = await new Promise(resolve => {
      const p = spawn(process.execPath, [tscBin], { cwd: CRAWLER_DIR, stdio: "inherit" });
      p.on("close", c => resolve(c ?? 0));
    });
    if (buildCode !== 0) {
      console.error(`❌ 编译 apps/apify-crawler 失败 (退出码 ${buildCode})`);
      process.exitCode = buildCode;
      return;
    }
  }

  if (dryRun) {
    console.log("✅ --dry-run 校验通过，dist/main.js 与 INPUT.json 已就绪。");
    return;
  }

  // 写入单实例锁
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");

  try {
    // 6. 启动本地爬虫（dist/main.js）
    console.log("🚀 开始本地同步（Playwright 直连知乎 + 自动写入云端 D1/R2，零 Apify 额度消耗）...\n");
    const nodeArgs = process.env.HTTPS_PROXY ? ["--use-env-proxy", "dist/main.js"] : ["dist/main.js"];
    const code = await new Promise(resolve => {
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
      runProc.on("close", c => resolve(c ?? 0));
    });

    if (code === 0) {
      console.log("\n🎉 本地同步执行完毕！");
    } else if (code === 2) {
      console.warn("\n⏸️ 本地同步触达 D1 每日写入限额断路器，当前页断点已自动保留，明日北京时间 08:05 将自动继续。");
    } else {
      console.error(`\n⚠️ 本地同步异常退出（状态码 ${code}）。当前断点已保留，下次定时任务将自动继续。`);
    }
    process.exitCode = code;
  } finally {
    try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
  }
}

main().catch(err => {
  console.error("❌ 本地同步异常:", err);
  process.exitCode = 1;
});
