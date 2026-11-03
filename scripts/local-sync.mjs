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
// Apify 本地存储目录：INPUT.json 里是 apiSecret / cookieString 明文
const STORAGE_DIR = path.join(CRAWLER_DIR, "storage");
const KV_DEFAULT_DIR = path.join(STORAGE_DIR, "key_value_stores", "default");
const INPUT_JSON_PATH = path.join(KV_DEFAULT_DIR, "INPUT.json");
// 云端租约应急释放句柄：main() 抢锁成功后注册，底部 catch 兜底调用，
// 保证未进入主 try 之前的异常/提前返回也不会把锁白占 15 分钟。
let emergencyReleaseCloudLock = null;
// 锁最多信任 12 小时：PID 被系统复用、或断电后残留的锁文件，
// 会让后续所有定时同步都被判成「已在运行」而永久跳过。
const LOCK_TTL_MS = 12 * 60 * 60 * 1000;

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
  // 0. 启动前清理磁盘上任何历史残留的 INPUT.json（上一轮断电/强杀可能留下明文
  //    apiSecret 与 cookieString）。只删不读，杜绝凭据进入日志或任何处理路径。
  fs.rmSync(INPUT_JSON_PATH, { force: true });

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
    else if (arg.startsWith("--")) console.warn(`⚠️ 忽略了未知参数: ${arg}（可能是拼写错误，本次按已知参数执行）`);
  }

  // 白名单校验：手滑成 --type=answer 之类的拼写错误会让爬虫按未知 runType
  // 走完所有分支都不匹配、直接空跑成功，这里必须提前失败
  const VALID_TYPES = new Set(["all", "answers", "articles", "collections", "upvotes", "following", "following-list"]);
  if (!VALID_TYPES.has(runType)) {
    console.error(`❌ 未知 --type=${runType}；可用：${[...VALID_TYPES].join(" / ")}`);
    process.exitCode = 1;
    return;
  }

  // 3. 单实例文件锁检查（防止计划任务与手动运行并发冲突）
  if (!dryRun && fs.existsSync(LOCK_FILE)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
      const startedAtMs = Date.parse(lockData.startedAt);
      const fresh = Number.isFinite(startedAtMs) && Date.now() - startedAtMs < LOCK_TTL_MS;
      if (isPidAlive(lockData.pid) && fresh) {
        console.log(`⏭️ 已有本地同步任务正在运行 (PID: ${lockData.pid}, 启动于 ${lockData.startedAt})，本次跳过。`);
        return;
      }
      console.log(
        `⚠️ 检测到陈旧锁文件 (PID: ${lockData.pid ?? "未知"}, 启动于 ${lockData.startedAt ?? "未知"})，自动接管。`
      );
    } catch { /* ignore broken lock */ }
  }

  const apiUrl = (process.env.WORKER_URL || "").replace(/\/$/, "");
  const apiSecret = process.env.API_SECRET || "";

  if (!apiUrl || !apiSecret) {
    console.error("❌ 缺少 WORKER_URL 或 API_SECRET，请检查项目根目录下的 .env.local");
    process.exitCode = 1;
    return;
  }

  // 云端同步租约：与云端 cron / 其他本地实例共用同一把互斥锁。
  // 抢不到（409）直接跳过本轮；抢到后爬虫每批 /ingest 请求会续租，
  // 脚本在 finally 里主动释放，进程崩溃则由 15 分钟租约自然过期。
  const syncOwnerId = "local-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  let cloudLockAcquired = false;

  const releaseCloudLock = async () => {
    if (!cloudLockAcquired) return;
    cloudLockAcquired = false;
    await fetch(`${apiUrl}/ingest/sync-lock/release`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiSecret}`,
        connection: "close"
      },
      body: JSON.stringify({ ownerId: syncOwnerId }),
      signal: AbortSignal.timeout(30_000)
    }).catch(() => {});
    console.log("🔓 已释放云端同步锁");
  };
  emergencyReleaseCloudLock = releaseCloudLock;

  // 抢到云端租约之后的每一步（sync-state 请求 / stateRes.json() / 写 INPUT.json /
  // tsc 编译 / 启动爬虫）全部受这一个外层 try/finally 保护：
  // 任一环节抛错或提前 return 都会立即释放云端锁，
  // 绝不泄漏 15 分钟租约导致后续同步全被 409 拒绝。
  try {
    if (!dryRun) {
      console.log(`🔒 正在申请云端同步锁 (owner: ${syncOwnerId})...`);
      let lockRes;
      try {
        lockRes = await fetch(`${apiUrl}/ingest/sync-lock/acquire`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiSecret}`,
            connection: "close"
          },
          body: JSON.stringify({ ownerId: syncOwnerId, source: "local-sync" }),
          signal: AbortSignal.timeout(30_000)
        });
      } catch (e) {
        console.error(`❌ 申请同步锁失败（网络错误）: ${e?.message || e}`);
        process.exitCode = 1;
        return;
      }
      if (lockRes.status === 409) {
        const detail = await lockRes.text().catch(() => "");
        console.log("⏭️ 云端或其他实例同步任务正在进行中，本轮跳过。");
        if (detail) console.log(`   （${detail.slice(0, 200)}）`);
        return;
      }
      if (lockRes.status === 404) {
        // 远端 Worker 还是旧版本、尚未部署分布式锁接口：
        // 降级为「仅本地文件锁」继续执行，不能因为远端没升级就直接罢工。
        await lockRes.text().catch(() => "");
        console.warn(
          "⚠️ 远端 Worker 尚未支持分布式同步锁 (HTTP 404)，降级为仅本地锁继续执行..."
        );
      } else if (!lockRes.ok) {
        console.error(`❌ 申请同步锁失败: HTTP ${lockRes.status} ${await lockRes.text().catch(() => "")}`);
        process.exitCode = 1;
        return;
      } else {
        cloudLockAcquired = true;
        console.log("✅ 已获得云端同步锁（15 分钟租约，爬虫回传数据时自动续租）");
      }
    }

    console.log(`[${new Date().toISOString()}] 🔗 正在连接云端 Worker (${apiUrl}) 获取最新同步状态与断点游标...`);
    const stateRes = await fetch(`${apiUrl}/ingest/sync-state`, {
      headers: {
        authorization: `Bearer ${apiSecret}`,
        connection: "close",
        ...(cloudLockAcquired ? { "x-sync-owner": syncOwnerId } : {})
      },
      // 云端/网络挂死时 30s 内必须失败，否则锁一直被占着，进程也卡死
      signal: AbortSignal.timeout(30_000)
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
    const followedProgress = remoteState.followedProgress && typeof remoteState.followedProgress === "object"
      ? remoteState.followedProgress
      : undefined;
    const syncConfig = remoteState.syncConfig && typeof remoteState.syncConfig === "object"
      ? remoteState.syncConfig
      : undefined;

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
    fs.mkdirSync(KV_DEFAULT_DIR, { recursive: true });

    const inputPayload = {
      runType,
      isFast,
      apiUrl,
      apiSecret,
      zhihuUsername,
      cookieString,
      // 同步租约持有者：爬虫 post() 会把它写进 x-sync-owner 头，Worker 自动续租
      ...(cloudLockAcquired ? { syncOwnerId } : {}),
      ...(upvotesCursor ? { upvotesCursor } : {}),
      ...(fullModeUsers.length > 0 ? { fullModeUsers } : {}),
      ...(followedProgress ? { followedProgress } : {}),
      ...(syncConfig ? { syncConfig } : {})
    };

    // INPUT.json 里是 apiSecret / cookieString 明文，只在「编译 → 启动爬虫」期间存在。
    // 内层 try/finally 覆盖所有出口（正常结束 / --dry-run / 编译失败 / 异常中断），
    // 保证运行结束后磁盘上不残留凭据。
    let lockWritten = false;
    try {
      fs.writeFileSync(
        INPUT_JSON_PATH,
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
        console.log("✅ --dry-run 校验通过（dist/main.js 已编译；含明文凭据的 INPUT.json 已清理）。");
        return;
      }

      // 写入单实例锁
      fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
      lockWritten = true;

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
            // 双保险：即使 Actor input schema 剥离未知字段，环境变量也能把租约持有者带到爬虫
            ...(cloudLockAcquired ? { SYNC_OWNER_ID: syncOwnerId } : {}),
            APIFY_LOCAL_STORAGE_DIR: STORAGE_DIR,
            CRAWLEE_STORAGE_DIR: STORAGE_DIR
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
      // 明文凭据清理放在 finally：任何 return / throw 都会走到
      fs.rmSync(INPUT_JSON_PATH, { force: true });
      if (lockWritten) {
        try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
      }
    }
  } finally {
    // 主动释放云端租约：不释放就要等 15 分钟自然过期，期间所有同步都会被 409 拒绝。
    // 放在最外层 finally，保证 sync-state 网络错误 / JSON 解析异常也一定会释放。
    await releaseCloudLock();
  }
}

main().catch(async err => {
  // 兜底：外层 try 已覆盖抢锁后的全部流程，这里再兜一次
  // （如 releaseCloudLock 自身在 finally 内抛错）确保租约不会白占 15 分钟
  if (emergencyReleaseCloudLock) {
    try { await emergencyReleaseCloudLock(); } catch { /* ignore */ }
  }
  console.error("❌ 本地同步异常:", err);
  process.exitCode = 1;
});
