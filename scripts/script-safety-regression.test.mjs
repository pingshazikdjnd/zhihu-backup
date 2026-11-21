/**
 * 脚本安全回归测试（纯静态 / vm 隔离执行，绝不 import 目标脚本）
 *
 * 目标脚本都带顶层副作用（读 .env.local、连本地 D1/R2、联网、拉起子进程），
 * 直接 import 会执行主程序。因此这里只做两件事：
 *   1. 读取源码做配置/顺序的静态断言；
 *   2. 用正则提取顶层纯函数，在 vm 沙箱里用假的 fs/process 执行真实逻辑。
 * 唯一会写盘的是 local-sync 锁行为测试，限定在系统临时目录并在 finally 清理。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function readScript(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

/** 提取顶层函数源码（以行首 `}` 结束，内部嵌套括号都带缩进） */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `源码中缺少函数 ${name}`);
  const end = src.indexOf("\n}\n", start);
  assert.ok(end >= 0, `函数 ${name} 缺少顶层结束括号`);
  return src.slice(start, end + 3);
}

/** 提取简单字符串数组常量并求值（复制为宿主 realm 数组，避免跨 vm 原型比较失败） */
function extractConstArray(src, name) {
  const match = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;`).exec(src);
  assert.ok(match, `源码中缺少数组常量 ${name}`);
  return Array.from(vm.runInNewContext(`[${match[1]}]`));
}

/** 把若干顶层函数（可附带依赖的 const 源码）放进隔离上下文执行 */
function loadPureFunctions(src, names, extraSource = "") {
  const code = [
    extraSource,
    ...names.map((name) => extractFunction(src, name)),
    `globalThis.__pure = { ${names.join(", ")} };`
  ]
    .filter(Boolean)
    .join("\n\n");
  const context = vm.createContext({});
  vm.runInContext(code, context);
  return context.__pure;
}

const uploadSrc = readScript("scripts/upload-to-cloudflare.mjs");
const verifySrc = readScript("scripts/verify-local-harvest.mjs");
const harvestSrc = readScript("scripts/full-local-harvest.mjs");
const localSyncSrc = readScript("scripts/local-sync.mjs");
const statsSrc = readScript("apps/worker/src/routes/stats.ts");

// ---------------------------------------------------------------------------
// upload-to-cloudflare：image_tasks 顺序
// ---------------------------------------------------------------------------
test("image_tasks 在导出/清空/导入行数三处都补齐且顺序正确", () => {
  const exportTables = extractConstArray(uploadSrc, "EXPORT_TABLES");
  const wipeOrder = extractConstArray(uploadSrc, "WIPE_ORDER");
  const importTables = extractConstArray(verifySrc, "IMPORT_ROW_TABLES");

  assert.ok(exportTables.includes("image_tasks"), "EXPORT_TABLES 必须包含 image_tasks");
  assert.equal(
    exportTables.indexOf("image_tasks"),
    exportTables.indexOf("contents") + 1,
    "EXPORT_TABLES 中 image_tasks 必须紧跟 contents（父→子）"
  );

  assert.ok(wipeOrder.includes("image_tasks"), "WIPE_ORDER 必须包含 image_tasks");
  assert.equal(
    wipeOrder.indexOf("image_tasks"),
    wipeOrder.indexOf("contents") - 1,
    "WIPE_ORDER 中 image_tasks 必须紧邻 contents 之前（子→父）"
  );

  assert.ok(importTables.includes("image_tasks"), "verify 的 IMPORT_ROW_TABLES 必须包含 image_tasks");
  assert.ok(importTables.indexOf("image_tasks") > importTables.indexOf("contents"));
});

// ---------------------------------------------------------------------------
// upload-to-cloudflare：app_settings 白名单 + wipe 保留键
// ---------------------------------------------------------------------------
test("app_settings 导出只允许 sync_config 白名单，wipe 保留远端运行态键", () => {
  const allowKeys = extractConstArray(uploadSrc, "APP_SETTINGS_EXPORT_KEYS");
  assert.deepEqual(allowKeys, ["sync_config"], "导出白名单必须只有 sync_config");
  assert.ok(!uploadSrc.includes("APP_SETTINGS_SKIP_EXPORT"), "不得保留黑名单式导出过滤");

  const keysSrc = /const\s+APP_SETTINGS_EXPORT_KEYS\s*=\s*\[[\s\S]*?\];/.exec(uploadSrc);
  assert.ok(keysSrc, "缺少 APP_SETTINGS_EXPORT_KEYS 定义");
  const { shouldExportAppSetting } = loadPureFunctions(
    uploadSrc,
    ["shouldExportAppSetting"],
    keysSrc[0]
  );

  assert.equal(shouldExportAppSetting("sync_config"), true);
  for (const key of [
    "zhihu_cookie",
    "fallback_ai_api_key",
    "cookie_write_token",
    "external_storage_targets",
    "apify_last_run",
    "upvotes_cursor",
    "sync_lock",
    "some_future_api_key"
  ]) {
    assert.equal(shouldExportAppSetting(key), false, `${key} 不得被导出`);
  }

  assert.match(uploadSrc, /!shouldExportAppSetting\(row\.key\)/, "导出循环必须走白名单函数");

  const preserve = extractConstArray(uploadSrc, "APP_SETTINGS_PRESERVE_ON_WIPE");
  assert.deepEqual(preserve, [
    "zhihu_cookie",
    "fallback_ai_api_key",
    "cookie_write_token",
    "external_storage_targets",
    "sync_config",
    "upvotes_cursor",
    "apify_last_run",
    "ai_daily_neuron_budget",
    "sync_lock"
  ]);
  assert.match(uploadSrc, /DELETE FROM app_settings WHERE key NOT IN/);
  assert.match(uploadSrc, /APP_SETTINGS_PRESERVE_ON_WIPE\.map/);
});

// ---------------------------------------------------------------------------
// upload-to-cloudflare：R2 续传 etag 严格匹配
// ---------------------------------------------------------------------------
test("R2 续传只在本地/远端 etag 均非空且去引号后一致时跳过", () => {
  const { normalizeR2Etag, isR2ObjectResumable } = loadPureFunctions(uploadSrc, [
    "normalizeR2Etag",
    "isR2ObjectResumable"
  ]);

  assert.equal(normalizeR2Etag('"abc"'), "abc");
  assert.equal(normalizeR2Etag("abc"), "abc");

  assert.equal(isR2ObjectResumable({ etag: '"abc"' }, { etag: "abc" }), true);
  assert.equal(isR2ObjectResumable({ etag: "abc" }, { etag: '"abc"' }), true);
  assert.equal(isR2ObjectResumable({ etag: "abc" }, { etag: "def" }), false, "etag 不同必须重传");
  assert.equal(isR2ObjectResumable({ etag: "abc", size: 10 }, { etag: "", size: 10 }), false, "远端 etag 缺失必须重传");
  assert.equal(isR2ObjectResumable({ etag: null, size: 10 }, { etag: "abc", size: 10 }), false, "本地 etag 缺失必须重传");
  assert.equal(isR2ObjectResumable({ etag: "   " }, { etag: "abc" }), false);
  assert.equal(isR2ObjectResumable({ etag: "abc" }, {}), false);

  assert.ok(!uploadSrc.includes("Number(obj.size) === Number(m.size)"), "不得仅凭 size 相同跳过");
  assert.match(uploadSrc, /if \(m && isR2ObjectResumable\(m, obj\)\)/);
});

// ---------------------------------------------------------------------------
// upload-to-cloudflare：R2 进度身份必须包含内容 etag
// ---------------------------------------------------------------------------
test("R2 进度身份含 etag：同 key 新内容、旧裸 key、无 etag 都必须重传", () => {
  const { r2ProgressIdentity, isR2DoneForManifest } = loadPureFunctions(uploadSrc, [
    "normalizeR2Etag",
    "r2ProgressIdentity",
    "isR2DoneForManifest"
  ]);

  const key = "childcomments/知乎 1:2.json";
  const oldRec = { key, etag: '"old-etag"' };
  const newRec = { key, etag: '"new-etag"' };
  const oldIdentity = r2ProgressIdentity(oldRec);
  assert.equal(oldIdentity, `${key}\nold-etag`, "身份必须是 key + 换行 + 去引号 etag（key 可含空格/中文/冒号）");

  const done = new Set([oldIdentity]);
  assert.equal(isR2DoneForManifest(oldRec, done), true, "同 key + 同 etag 可以跳过");
  assert.equal(isR2DoneForManifest(newRec, done), false, "同 key 新 etag 不得跳过");
  assert.equal(isR2DoneForManifest({ key, etag: '"old-etag"' }, oldIdentity), false, "仅字符串快照不是 identity Set");

  const legacyOnly = new Set([key]);
  assert.equal(
    isR2DoneForManifest(oldRec, legacyOnly),
    false,
    "旧版无 etag 的裸 key 进度不得匹配含有效 etag 的新 manifest"
  );
  assert.equal(isR2DoneForManifest({ key }, legacyOnly), false, "manifest 无 etag 不得跳过");
  assert.equal(isR2DoneForManifest({ key, etag: '""' }, legacyOnly), false, "空 etag 不得跳过");
  assert.equal(r2ProgressIdentity({ key }), "", "无 etag 不能构造身份");
  assert.equal(r2ProgressIdentity(null), "");
  assert.equal(isR2DoneForManifest(oldRec, new Set()), false);

  assert.match(
    uploadSrc,
    /const todo = manifest\.filter\(\(m\) => !isR2DoneForManifest\(m, r2Done\)\);/,
    "待上传清单必须按 key+etag 身份判断"
  );
  assert.match(uploadSrc, /markR2Done\(rec\.key, rec\.size, rec\.etag\)/, "上传成功后必须把 etag 传给 markR2Done");
  assert.match(uploadSrc, /r2Done\.add\(identity\);/, "远端 list 匹配后只能登记 key+etag 身份");
  assert.ok(!uploadSrc.includes("r2Done.add(obj.key)"), "不得再按裸 key 登记远端已完成对象");
});

test("R2_DONE_LOG 新格式 JSON Lines 可 round-trip，旧裸 key 行按无身份处理", () => {
  const { r2ProgressIdentity, formatR2DoneLogLine, parseR2DoneLogLine } = loadPureFunctions(uploadSrc, [
    "normalizeR2Etag",
    "r2ProgressIdentity",
    "formatR2DoneLogLine",
    "parseR2DoneLogLine"
  ]);

  const rec = { key: "childcomments/知乎 1:2.json", etag: '"abc123"' };
  const line = formatR2DoneLogLine(rec);
  assert.equal(line, JSON.stringify({ key: rec.key, etag: "abc123" }));
  assert.equal(parseR2DoneLogLine(line), r2ProgressIdentity(rec), "新格式日志必须能还原出同一身份");
  assert.equal(parseR2DoneLogLine(` ${line} `), r2ProgressIdentity(rec), "读取时应容忍行首尾空白");

  assert.equal(parseR2DoneLogLine(rec.key), "", "旧格式裸 key 行必须按无身份处理");
  assert.equal(parseR2DoneLogLine(JSON.stringify({ key: rec.key })), "", "旧 JSON 无 etag 行必须按无身份处理");
  assert.equal(parseR2DoneLogLine(JSON.stringify({ key: rec.key, etag: '""' })), "", "空 etag 行必须按无身份处理");
  assert.equal(parseR2DoneLogLine("{broken json"), "", "损坏的新格式行不得被当成旧 key");
  assert.equal(parseR2DoneLogLine(""), "");
  assert.equal(formatR2DoneLogLine({ key: rec.key }), "", "无 etag 不得写入日志行");
});

// ---------------------------------------------------------------------------
// verify-local-harvest：异常汇总纯函数
// ---------------------------------------------------------------------------
test("verify 异常汇总覆盖所有已检查项，未抓完线程不计入损坏", () => {
  const { summarizeReconAnomalies } = loadPureFunctions(verifySrc, ["summarizeReconAnomalies"]);

  const empty = summarizeReconAnomalies({});
  assert.equal(empty.total, 0);
  assert.equal(empty.damaged, false);

  const recon = {
    html: { missing: 2, missingLikelyInFlight: 1, zeroSize: 1, blobMissing: 3, sizeMismatch: 4 },
    threads: {
      missing: 5,
      missingLikelyInFlight: 2,
      zeroSize: 6,
      blobMissing: 7,
      parseFailures: 8,
      childCountMismatch: 9
    },
    childJsonSample: { missingBlob: 10, parseFailures: 11 }
  };
  const summary = summarizeReconAnomalies(recon);
  assert.equal(summary.html.total, 10);
  assert.equal(summary.threads.total, 35);
  assert.equal(summary.childJsonSample.total, 21);
  assert.equal(summary.total, 66);
  assert.equal(summary.inFlightHint, 3, "在途只作提示，不改变异常统计");
  assert.equal(summary.damaged, true);

  // 未抓子评论的未完成线程不在检查范围：额外字段不得被当成损坏
  const unfinished = summarizeReconAnomalies({
    html: {},
    threads: { threadsTotal: 78000, unfinished: 78000, child_count_zero: 78000 },
    childJsonSample: {}
  });
  assert.equal(unfinished.total, 0);
  assert.equal(unfinished.damaged, false);
});

test("verify 结论只在零异常时声称 100% 落盘/具备上云条件", () => {
  assert.match(verifySrc, /const reconCritical = reconSummary\.total;/);
  assert.match(verifySrc, /属于损坏或数据不一致，当前状态不可用于打包上云/);
  assert.match(verifySrc, /summary: reconSummary/);
  assert.ok(!verifySrc.includes("个对象在途未落盘"), "不得把异常全部归因于在途");
});

// ---------------------------------------------------------------------------
// full-local-harvest + stats.ts：fresh 旁路与 followed_users 指标
// ---------------------------------------------------------------------------
test("stats 请求路径 fresh=1 绕过缓存，且只在 statsBefore/statsAfter 使用", () => {
  const { statsPath } = loadPureFunctions(harvestSrc, ["statsPath"]);
  assert.equal(statsPath(true), "/api/stats?fresh=1");
  assert.equal(statsPath(false), "/api/stats");
  assert.equal(statsPath(), "/api/stats");

  assert.equal(
    (harvestSrc.match(/await fetchStats\(ctx\.secret, true\)/g) || []).length,
    2,
    "statsBefore 与 statsAfter 必须显式 fresh"
  );
  assert.match(harvestSrc, /async function localHealthy\(\)[\s\S]*?\/api\/stats[\s\S]*?5_000/);
  assert.match(harvestSrc, /localRequest\(statsPath\(fresh\)/);

  assert.match(statsSrc, /c\.req\.query\("fresh"\) === "1"/);
  assert.match(statsSrc, /if \(!fresh && cachedStats\)/);
  assert.match(statsSrc, /SELECT count\(\*\) as c FROM followed_users/);
  assert.match(statsSrc, /total_followed_users: followedUsersCount\.c/);
});

test("stats 解析把缺失的 followed_users 视为未知而非 0", () => {
  const { parseStatsPayload } = loadPureFunctions(harvestSrc, ["parseStatsPayload"]);

  const withFollowed = parseStatsPayload({ total_contents: 3, total_followed_users: 7 });
  assert.equal(withFollowed.contents, 3);
  assert.equal(withFollowed.followed_users, 7);

  const missing = parseStatsPayload({ total_contents: 3 });
  assert.equal(missing.followed_users, null, "旧版 Worker 缺少字段时必须为 null");

  const explicitNull = parseStatsPayload({ total_followed_users: null });
  assert.equal(explicitNull.followed_users, null);

  assert.equal(parseStatsPayload(null), null);
});

test("diffStatsProgress 把 followed_users 纳入增长，未知指标不按 0 比较", () => {
  const progressKeysSrc = /const\s+STATS_PROGRESS_KEYS\s*=\s*\[[\s\S]*?\];/.exec(harvestSrc);
  assert.ok(progressKeysSrc, "缺少 STATS_PROGRESS_KEYS");
  const { diffStatsProgress } = loadPureFunctions(
    harvestSrc,
    ["diffStatsProgress"],
    progressKeysSrc[0]
  );

  const before = { contents: 1, comments: 2, collection_items: 3, upvotes: 4, followed_users: 10 };
  const after = { contents: 2, comments: 2, collection_items: 3, upvotes: 4, followed_users: 13 };
  const grown = diffStatsProgress(before, after);
  assert.deepEqual([...grown.grown].sort(), ["contents+1", "followed_users+3"]);
  assert.equal(grown.comparable, true);

  // after 缺字段：不得把未知当 0 产生 followed_users-10 的假结论
  const unknownAfter = diffStatsProgress(before, {
    contents: 2,
    comments: 2,
    collection_items: 3,
    upvotes: 4,
    followed_users: null
  });
  assert.equal(unknownAfter.comparable, true);
  assert.ok(!unknownAfter.grown.some((item) => item.startsWith("followed_users")));

  const unknownBefore = diffStatsProgress(
    { ...before, followed_users: undefined },
    after
  );
  assert.ok(!unknownBefore.grown.some((item) => item.startsWith("followed_users")));

  // 所有指标都未知时不宣称可比（避免把未知误判成 0 增长）
  const allUnknown = diffStatsProgress({ contents: null }, { contents: "" });
  assert.equal(allUnknown.comparable, false);
  assert.deepEqual([...allUnknown.grown], []);

  const beforeUnavailable = diffStatsProgress(null, after);
  assert.deepEqual(
    { grown: [...beforeUnavailable.grown], comparable: beforeUnavailable.comparable },
    { grown: ["stats_unavailable_before"], comparable: false }
  );
  const afterUnavailable = diffStatsProgress(before, null);
  assert.deepEqual(
    { grown: [...afterUnavailable.grown], comparable: afterUnavailable.comparable },
    { grown: [], comparable: false }
  );
});

// ---------------------------------------------------------------------------
// local-sync：wx 原子锁行为与代码顺序
// ---------------------------------------------------------------------------
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode ?? 1);
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? 1));
  });
}

/** 子进程写完结果后可能瞬间存在空文件：轮询到可解析为止 */
function readJsonWhenReady(file, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      if (Date.now() > deadline) throw new Error(`等待 JSON 文件超时: ${file}`);
      sleepSync(20);
    }
  }
}

function spawnLockHarness(harnessPath, args) {
  return spawn(process.execPath, [harnessPath, ...args], {
    cwd: path.dirname(harnessPath),
    stdio: "ignore"
  });
}

const LOCK_FUNCTION_NAMES = [
  "isPidAlive",
  "readLocalLock",
  "releaseLocalLock",
  "tryCreateLocalLock",
  "acquireLocalLock"
];

/** 提取生产锁函数源码，供 vm / 子进程 harness 复用（不 import 真实 local-sync 主脚本） */
function lockFunctionSources() {
  return LOCK_FUNCTION_NAMES.map(name => extractFunction(localSyncSrc, name)).join("\n");
}

/** 用生产锁函数源码生成独立子进程 harness，用文件同步模拟 runMain 的进入/持有/释放 */
function buildLockChildHarness(lockFile) {
  return [
    `"use strict";`,
    `const fs = require("node:fs");`,
    `const LOCK_FILE = ${JSON.stringify(lockFile)};`,
    "let lockWritten = false;",
    "let localLockToken = null;",
    "const LOCK_TTL_MS = 12 * 60 * 60 * 1000;",
    lockFunctionSources(),
    `
const role = process.argv[2];
const readyPath = process.argv[3];
const goPath = process.argv[4];
const resultPath = process.argv[5];
const releasePath = process.argv[6];
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function waitFor(file) {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error("timeout waiting for " + file);
    sleepSync(20);
  }
}
function writeResult(record) {
  fs.writeFileSync(resultPath, JSON.stringify(record));
}
try {
  waitFor(goPath);
  if (role === "exception") {
    const state = acquireLocalLock();
    try {
      if (!state.ok) throw new Error("异常场景抢锁失败: " + JSON.stringify(state));
      throw new Error("模拟 runMain 异常");
    } finally {
      if (state.owned) releaseLocalLock();
    }
  }
  const state = acquireLocalLock();
  const record = {
    ok: state.ok,
    owned: state.owned,
    enteredRunMain: state.ok && state.owned,
    pid: process.pid
  };
  writeResult(record);
  if (state.owned) {
    fs.writeFileSync(readyPath, "acquired");
    waitFor(releasePath);
    releaseLocalLock();
    record.released = !fs.existsSync(LOCK_FILE);
    writeResult(record);
  }
} catch (err) {
  try { writeResult({ error: String(err && err.stack || err), pid: process.pid }); } catch {}
  process.exitCode = 1;
}
`
  ].join("\n");
}

function createLockHarness(lockFile) {
  const logs = [];
  const code = [
    "let lockWritten = false;",
    "let localLockToken = null;",
    "const LOCK_TTL_MS = 12 * 60 * 60 * 1000;",
    lockFunctionSources(),
    "globalThis.__lock = {",
    "  acquire() { return acquireLocalLock(); },",
    "  release() { return releaseLocalLock(); },",
    "  state() { return { lockWritten, localLockToken }; },",
    "  setState(written, token) { lockWritten = written; localLockToken = token; },",
    "  setEnv(name, value) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }",
    "};"
  ].join("\n");
  const context = vm.createContext({
    fs,
    LOCK_FILE: lockFile,
    console: {
      log: (...args) => logs.push(args.map(String).join(" ")),
      warn: (...args) => logs.push(args.map(String).join(" ")),
      error: (...args) => logs.push(args.map(String).join(" "))
    },
    process: {
      pid: process.pid,
      env: {},
      kill: (pid, signal) => process.kill(pid, signal)
    }
  });
  vm.runInContext(code, context);
  return { lock: context.__lock, logs };
}

test("local-sync 锁：wx 原子占位、EEXIST 跳过、只释放自己的锁", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-local-sync-lock-"));
  const lockFile = path.join(dir, ".local-sync.lock");
  try {
    const { lock, logs } = createLockHarness(lockFile);

    const first = lock.acquire();
    assert.deepEqual({ ok: first.ok, owned: first.owned }, { ok: true, owned: true });
    assert.equal(lock.state().lockWritten, true);
    assert.equal(fs.existsSync(lockFile), true);
    const ownRaw = fs.readFileSync(lockFile, "utf8");
    const own = JSON.parse(ownRaw);
    assert.deepEqual(Object.keys(own).sort(), ["pid", "startedAt", "token"]);
    assert.equal(own.pid, process.pid);

    const second = lock.acquire();
    assert.deepEqual({ ok: second.ok, owned: second.owned }, { ok: false, owned: false });
    assert.equal(fs.readFileSync(lockFile, "utf8"), ownRaw, "EEXIST 不得改写已有锁");

    lock.release();
    assert.equal(fs.existsSync(lockFile), false);
    assert.equal(lock.state().lockWritten, false);

    // 其他进程持有：release 不能误删
    const foreignRaw = JSON.stringify({
      pid: process.pid + 1,
      startedAt: new Date().toISOString(),
      token: "foreign"
    });
    fs.writeFileSync(lockFile, foreignRaw, "utf8");
    lock.setState(true, "mine");
    lock.release();
    assert.equal(fs.readFileSync(lockFile, "utf8"), foreignRaw, "不得删除其他进程的锁");

    // 活跃锁（当前 PID + 新 startedAt）：友好跳过，日志说明 PID
    const liveRaw = JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      token: "live"
    });
    fs.writeFileSync(lockFile, liveRaw, "utf8");
    logs.length = 0;
    const live = lock.acquire();
    assert.deepEqual({ ok: live.ok, owned: live.owned }, { ok: false, owned: false });
    assert.equal(fs.readFileSync(lockFile, "utf8"), liveRaw);
    assert.ok(
      logs.some(line => line.includes("已有本地同步任务正在运行") && line.includes(String(process.pid))),
      "活跃锁必须给出友好跳过提示"
    );

    // 父进程已持锁时子进程直接继承，不重复创建文件
    fs.rmSync(lockFile, { force: true });
    lock.setEnv("__LOCAL_SYNC_LOCK_INHERITED", "1");
    const inherited = lock.acquire();
    assert.deepEqual({ ok: inherited.ok, owned: inherited.owned }, { ok: true, owned: false });
    assert.equal(fs.existsSync(lockFile), false, "继承锁不得重复创建 canonical 锁");
    lock.setEnv("__LOCAL_SYNC_LOCK_INHERITED", undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("local-sync 锁：陈旧/损坏/超 TTL 活锁一律安全拒绝且原样保留锁文件", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-local-sync-stale-"));
  const lockFile = path.join(dir, ".local-sync.lock");
  const cases = [
    {
      name: "PID 不存活的陈旧锁",
      raw: JSON.stringify({ pid: 2147483647, startedAt: "2000-01-01T00:00:00.000Z", token: "dead" }),
      reason: "进程已不存活"
    },
    {
      name: "PID 存活但超过 TTL",
      raw: JSON.stringify({ pid: process.pid, startedAt: "2000-01-01T00:00:00.000Z", token: "old-live" }),
      reason: "进程仍存活"
    },
    {
      name: "损坏锁",
      raw: "{not-json",
      reason: "无法解析或读取锁内容"
    }
  ];
  try {
    const { lock, logs } = createLockHarness(lockFile);
    for (const item of cases) {
      fs.writeFileSync(lockFile, item.raw, "utf8");
      logs.length = 0;
      const state = lock.acquire();
      assert.deepEqual(
        { ok: state.ok, owned: state.owned },
        { ok: false, owned: false },
        `${item.name}：必须安全拒绝`
      );
      assert.equal(fs.readFileSync(lockFile, "utf8"), item.raw, `${item.name}：canonical 锁内容必须原样保留`);
      assert.ok(logs.some(line => line.includes(item.reason)), `${item.name}：日志必须说明拒绝原因`);
      assert.ok(logs.some(line => line.includes(lockFile)), `${item.name}：日志必须打印锁文件完整路径`);
      assert.ok(
        logs.some(line => line.includes("手动删除") && line.includes(".local-sync.lock")),
        `${item.name}：日志必须给出人工处理提示`
      );
      assert.deepEqual(fs.readdirSync(dir), [".local-sync.lock"], `${item.name}：不得产生 stale/隔离文件`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("local-sync 锁：真实多进程同时抢无锁路径，只有一个进入 runMain", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-local-sync-race-"));
  const lockFile = path.join(dir, ".local-sync.lock");
  const harnessPath = path.join(dir, "lock-harness.cjs");
  const goPath = path.join(dir, "go");
  const releasePath = path.join(dir, "release");
  const resultPaths = Array.from({ length: 4 }, (_, i) => path.join(dir, `result-${i}.json`));
  const children = [];
  try {
    fs.writeFileSync(harnessPath, buildLockChildHarness(lockFile), "utf8");
    resultPaths.forEach((resultPath, i) => {
      children.push(
        spawnLockHarness(harnessPath, ["race", path.join(dir, `ready-${i}`), goPath, resultPath, releasePath])
      );
    });
    fs.writeFileSync(goPath, "go");

    const results = resultPaths.map(resultPath => readJsonWhenReady(resultPath));
    for (const record of results) assert.equal(record.error, undefined, `子进程异常: ${record.error}`);

    const winners = results.filter(record => record.enteredRunMain);
    assert.equal(winners.length, 1, "同一时刻只能有一个进程进入 runMain");
    assert.ok(results.every(record => record.ok === record.owned), "没拿到锁的进程必须安全拒绝");

    const winnerIndex = results.indexOf(winners[0]);
    const held = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    assert.equal(held.pid, children[winnerIndex].pid, "canonical 锁必须属于唯一赢家");
    assert.ok(held.token, "锁必须带 token");
    assert.deepEqual(fs.readdirSync(dir).filter(name => name.includes(".stale-")), [], "不得产生 stale 文件");

    fs.writeFileSync(releasePath, "release");
    const exits = await Promise.all(children.map(waitForExit));
    assert.deepEqual(exits, [0, 0, 0, 0], "所有子进程都必须正常退出");
    assert.equal(fs.existsSync(lockFile), false, "赢家释放后不得残留 canonical 锁");
    assert.equal(
      JSON.parse(fs.readFileSync(resultPaths[winnerIndex], "utf8")).released,
      true,
      "赢家必须在模拟 runMain 结束后释放自己的锁"
    );
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("local-sync 锁：启动前已有陈旧锁时多进程全部安全拒绝且锁文件完全不变", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-local-sync-stale-race-"));
  const lockFile = path.join(dir, ".local-sync.lock");
  const harnessPath = path.join(dir, "lock-harness.cjs");
  const goPath = path.join(dir, "go");
  const staleRaw = JSON.stringify({
    pid: 2147483647,
    startedAt: "2000-01-01T00:00:00.000Z",
    token: "stale"
  });
  const resultPaths = Array.from({ length: 4 }, (_, i) => path.join(dir, `result-${i}.json`));
  const children = [];
  try {
    fs.writeFileSync(lockFile, staleRaw, "utf8");
    const beforeStat = fs.statSync(lockFile);
    fs.writeFileSync(harnessPath, buildLockChildHarness(lockFile), "utf8");
    resultPaths.forEach(resultPath => {
      children.push(spawnLockHarness(harnessPath, ["stale", "", goPath, resultPath, ""]));
    });
    fs.writeFileSync(goPath, "go");

    const exits = await Promise.all(children.map(waitForExit));
    assert.deepEqual(exits, [0, 0, 0, 0], "安全拒绝必须正常退出");
    const results = resultPaths.map(resultPath => JSON.parse(fs.readFileSync(resultPath, "utf8")));
    for (const record of results) {
      assert.equal(record.error, undefined, `子进程异常: ${record.error}`);
      assert.equal(record.ok, false);
      assert.equal(record.owned, false);
      assert.equal(record.enteredRunMain, false, "陈旧锁存在时任何进程都不得进入 runMain");
    }

    assert.equal(fs.readFileSync(lockFile, "utf8"), staleRaw, "canonical 锁内容必须逐字节不变");
    assert.equal(fs.statSync(lockFile).size, beforeStat.size, "canonical 锁文件大小必须不变");
    assert.deepEqual(fs.readdirSync(dir).filter(name => name.includes(".stale-")), [], "不得产生任何 stale 文件");
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("local-sync 锁：runMain 异常时 finally 仍释放自己的锁", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-local-sync-exception-"));
  const lockFile = path.join(dir, ".local-sync.lock");
  const harnessPath = path.join(dir, "lock-harness.cjs");
  const goPath = path.join(dir, "go");
  const resultPath = path.join(dir, "result.json");
  let child = null;
  try {
    fs.writeFileSync(harnessPath, buildLockChildHarness(lockFile), "utf8");
    child = spawnLockHarness(harnessPath, ["exception", "", goPath, resultPath, ""]);
    fs.writeFileSync(goPath, "go");
    const exitCode = await waitForExit(child);
    assert.equal(exitCode, 1, "模拟异常必须以非零状态退出");
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    assert.match(result.error, /模拟 runMain 异常/);
    assert.equal(fs.existsSync(lockFile), false, "异常退出路径必须释放本进程的锁");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("local-sync 在拿锁前不做任何网络/输入/编译操作，且不自动接管已有锁", () => {
  const mainStart = localSyncSrc.indexOf("async function main() {");
  const runMainStart = localSyncSrc.indexOf("async function runMain() {");
  assert.ok(runMainStart > 0 && mainStart > runMainStart, "缺少 runMain/main 包装结构");

  const runMainBody = localSyncSrc.slice(runMainStart, mainStart);
  const wrapper = localSyncSrc.slice(mainStart);

  // 所有副作用都在 runMain 内，而 runMain 只被 wrapper 的 try 调用一次
  assert.ok(runMainBody.includes("fs.rmSync(INPUT_JSON_PATH, { force: true })"));
  assert.ok(runMainBody.includes("isProxyReachable(process.env.HTTPS_PROXY)"));
  assert.ok(runMainBody.includes("/ingest/sync-lock/acquire"));
  assert.ok(runMainBody.includes("/ingest/sync-state"));
  assert.ok(runMainBody.includes("spawn(process.execPath, [tscBin]"));
  assert.ok(!runMainBody.includes("acquireLocalLock()"), "runMain 内不得再抢锁");
  assert.ok(!runMainBody.includes("writeFileSync(LOCK_FILE"), "runMain 内不得再写锁");
  assert.equal((localSyncSrc.match(/await runMain\(\)/g) || []).length, 1);

  const acquireAt = wrapper.indexOf("acquireLocalLock()");
  const runMainAt = wrapper.indexOf("await runMain()");
  const releaseAt = wrapper.indexOf("releaseLocalLock()");
  assert.ok(acquireAt > 0, "wrapper 必须先抢锁");
  assert.ok(acquireAt < runMainAt, "锁必须先于 runMain（INPUT/代理/网络/编译）");
  assert.ok(runMainAt < releaseAt, "释放必须在 runMain 之后");
  assert.match(wrapper, /try \{\s*await runMain\(\);\s*\} finally \{/);

  assert.match(localSyncSrc, /flag: "wx"/, "本地锁必须用 wx 原子创建");
  assert.match(localSyncSrc, /err\?\.code === "EEXIST"/);
  assert.match(localSyncSrc, /__LOCAL_SYNC_LOCK_INHERITED/);
  assert.match(localSyncSrc, /if \(lockState\.owned\) releaseLocalLock\(\);/);
  assert.ok(!localSyncSrc.includes("if (lockWritten) {"), "旧的内层锁释放必须移除");

  // 不得再保留 rename/quarantine/恢复式自动接管；EEXIST 后只读诊断
  assert.ok(!localSyncSrc.includes("quarantine"), "不得保留 quarantine 隔离实现");
  assert.ok(!localSyncSrc.includes("takeoverStaleLocalLock"), "不得保留自动接管实现");
  assert.ok(!localSyncSrc.includes("restoreQuarantinedLock"), "不得保留恢复隔离文件实现");
  assert.ok(!localSyncSrc.includes("lockIdentity"), "不得保留 rename 身份校验辅助函数");
  assert.ok(!localSyncSrc.includes(".stale-"), "锁模块不得生成 stale 隔离文件名");

  const acquireBody = extractFunction(localSyncSrc, "acquireLocalLock");
  assert.ok(
    !/fs\.(unlinkSync|renameSync|copyFileSync)/.test(acquireBody),
    "EEXIST 后不得删除/移动/恢复 canonical 锁文件"
  );
  assert.match(acquireBody, /readLocalLock\(\)/, "EEXIST 后必须只读检查现有锁");
  assert.match(acquireBody, /isPidAlive\(lockData\.pid\)/, "必须区分 PID 是否存活");
  assert.match(acquireBody, /LOCK_FILE/, "人工处理提示必须包含完整锁文件路径");
  assert.match(acquireBody, /手动删除/, "陈旧/损坏锁必须提示人工删除");
  assert.match(acquireBody, /\.local-sync\.lock/, "提示必须点名 .local-sync.lock");
  assert.equal(
    (localSyncSrc.match(/fs\.writeFileSync\(\s*LOCK_FILE,/g) || []).length,
    1,
    "canonical 锁只允许 tryCreateLocalLock 用 wx 创建一次"
  );

  // 锁内容只允许 pid/startedAt/token，绝不带 cookie/apiSecret
  const lockWriteBody = extractFunction(localSyncSrc, "tryCreateLocalLock");
  assert.match(lockWriteBody, /JSON\.stringify\(\{ pid: process\.pid, startedAt: new Date\(\)\.toISOString\(\), token \}\)/);
  assert.ok(!/cookie|apiSecret|zhihu/i.test(lockWriteBody), "锁文件不得写入任何凭据");

  const releaseBody = extractFunction(localSyncSrc, "releaseLocalLock");
  assert.match(releaseBody, /data\.pid !== process\.pid/);
  assert.match(releaseBody, /data\.token !== token/);
  assert.equal((releaseBody.match(/fs\.unlinkSync\(LOCK_FILE\)/g) || []).length, 1);
});

// ---------------------------------------------------------------------------
// full-local-harvest：评论补采候选覆盖「第一页 20 条」截断
// ---------------------------------------------------------------------------
test("评论补采候选同时覆盖 roots*3<评论数 与 评论数>20 且 roots=20，且不泛化", () => {
  // REPAIR_CANDIDATE_SQL 以 .join("\n") 收尾，不能用只认 `];` 的 extractConstArray
  const sqlArray = /const\s+REPAIR_CANDIDATE_SQL\s*=\s*(\[[\s\S]*?\])\s*\.join/.exec(harvestSrc);
  assert.ok(sqlArray, "缺少 REPAIR_CANDIDATE_SQL 数组定义");
  const sql = Array.from(vm.runInNewContext(sqlArray[1])).join("\n");

  // 原判定必须保留（roots=0 只可能从这里命中，不会被新分支宽泛纳入）
  assert.match(sql, /COALESCE\(r\.roots, 0\) \* 3 < c\.comment_count/, "原判定必须保留");
  assert.match(sql, /COALESCE\(r\.roots, 0\) < 50/, "原判定的 roots<50 上限必须保留");
  // 新判定：精确的 20 条截断签名
  assert.match(sql, /c\.comment_count > 20 AND COALESCE\(r\.roots, 0\) = 20/, "必须覆盖第一页 20 条截断");
  assert.ok(!/roots, 0\) <= 20/.test(sql), "不得把截断判定放宽成 <=20");
  assert.ok(
    !/COALESCE\(r\.roots, 0\) < c\.comment_count(?! \* 3)/.test(sql),
    "不得泛化成「根评论 < 评论总数就重抓」"
  );

  // 用内存 SQLite 按真实数据形态验证候选集合（不触碰任何本地/远端 D1 文件）
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE contents (
        pk TEXT PRIMARY KEY, source_type TEXT NOT NULL, comment_count INTEGER NOT NULL, is_deleted INTEGER NOT NULL
      );
      CREATE TABLE comments (
        id TEXT PRIMARY KEY, content_pk TEXT NOT NULL, parent_comment_id TEXT, is_deleted INTEGER NOT NULL
      );
    `);
    const insertContent = db.prepare(
      "INSERT INTO contents (pk, source_type, comment_count, is_deleted) VALUES (?, ?, ?, ?)"
    );
    const insertRoot = db.prepare(
      "INSERT INTO comments (id, content_pk, parent_comment_id, is_deleted) VALUES (?, ?, NULL, 0)"
    );
    const insertReply = db.prepare(
      "INSERT INTO comments (id, content_pk, parent_comment_id, is_deleted) VALUES (?, ?, ?, 0)"
    );
    const seed = (pk, type, commentCount, roots, deleted = 0) => {
      insertContent.run(pk, type, commentCount, deleted);
      for (let i = 0; i < roots; i += 1) insertRoot.run(`${pk}-r${i}`, pk);
    };

    seed("answer:1", "answer", 21, 20); // 命中新判定
    seed("answer:2", "answer", 20, 20); // 未超过 20，不命中
    seed("answer:3", "answer", 5, 0); // 仅命中原判定（roots=0 不应被新分支纳入）
    seed("answer:4", "answer", 100, 40); // 回复占比高，120<100 不成立
    seed("answer:5", "answer", 130, 40); // 命中原判定
    seed("answer:6", "answer", 1000, 60); // roots<50 不成立
    seed("article:7", "article", 30, 20); // 文章同样覆盖
    seed("answer:8", "answer", 21, 21); // roots 不是 20，不命中
    seed("pin:9", "pin", 21, 20); // 非 answer/article
    seed("answer:10", "answer", 21, 20, 1); // 已删除
    seed("answer:11", "answer", 100, 20); // 真实 20 条根评论 + 大量回复：已知可接受误报，会重抓一次
    // 楼中楼不计入 roots
    for (let i = 0; i < 10; i += 1) insertReply.run(`answer:1-c${i}`, "answer:1", "answer:1-r0");

    const pks = db.prepare(sql).all().map((row) => row.pk);
    assert.deepEqual(pks, ["answer:1", "answer:11", "answer:3", "answer:5", "article:7"]);
  } finally {
    db.close();
  }
});

test("full-local-harvest --repair-images 在拿实例锁前转交独立脚本，且不改写阶段进度", () => {
  assert.match(harvestSrc, /if \(opts\.repairImages\)/, "必须提供 --repair-images 分流");
  assert.match(harvestSrc, /repair-local-images\.mjs/, "必须转交独立脚本");
  const branchAt = harvestSrc.indexOf("if (opts.repairImages)");
  const lockAt = harvestSrc.indexOf("if (!acquireInstanceLock())");
  assert.ok(branchAt > 0 && lockAt > branchAt, "图片补采必须在实例锁之前分流");
  const branch = harvestSrc.slice(branchAt, lockAt);
  assert.match(branch, /runRepairImagesMode\(\)/);
  assert.ok(!branch.includes("repairMax"), "图片补采不能被 --repair-max 限制");
  assert.ok(!branch.includes("writeProgress"), "图片补采不得写阶段进度");

  // 图片参数由独立的转交函数透传（不与评论补采/阶段状态机共用参数）
  const delegate = extractFunction(harvestSrc, "runRepairImagesMode");
  assert.match(delegate, /repair-local-images\.mjs/);
  assert.match(delegate, /--image-batch-size=\$\{opts\.imageBatchSize\}/);
  assert.match(delegate, /--image-max-batches=\$\{opts\.imageMaxBatches\}/);
  assert.match(delegate, /opts\.imageScanOnly/);
  assert.match(delegate, /opts\.dryRun/);
  assert.ok(!delegate.includes("repairMax"), "图片补采不能被 --repair-max 限制");

  // 评论补采的风控中断仍必须以非零退出（不能被当成成功）
  assert.match(harvestSrc, /process\.exitCode = ok \? 0 : 1;/);
});

// ---------------------------------------------------------------------------
// repair-local-images：与 Worker 生产图片身份规则逐字一致
// ---------------------------------------------------------------------------
const repairImagesSrc = readScript("scripts/repair-local-images.mjs");
const imagesProductionSrc = readScript("apps/worker/src/services/images.ts");

/** 提取 `const NAME = ...;` 源码片段（可跨行，不含裸分号） */
function extractConstSource(src, name) {
  const match = new RegExp(`const\\s+${name}\\s*=\\s*[^;]+;`).exec(src);
  assert.ok(match, `源码中缺少常量 ${name}`);
  return match[0];
}

/** 提取 `const NAME = <expr>;` 的右值并在独立上下文求值 */
function evalConstRhs(src, name) {
  const match = new RegExp(`const\\s+${name}\\s*=\\s*`).exec(src);
  assert.ok(match, `源码中缺少常量 ${name}`);
  const start = match.index + match[0].length;
  const end = src.indexOf(";", start);
  assert.ok(end > start, `常量 ${name} 缺少结束分号`);
  return vm.runInNewContext(`(${src.slice(start, end)})`);
}

function loadRepairImagePure() {
  const extraSource = [
    "IMAGE_KEY_PREFIX",
    "IMAGE_API_PREFIX",
    "MAX_IMAGES_PER_CONTENT",
    "ALLOWED_IMAGE_EXTENSIONS",
    "LOCAL_IMAGE_SRC_RE"
  ]
    .map((name) => extractConstSource(repairImagesSrc, name))
    .join("\n");
  const names = [
    "isZhihuImageUrl",
    "imageIdentity",
    "extensionFromUrl",
    "toFetchableUrl",
    "extractImgSources",
    "sha256Hex",
    "imageObjectKeyForUrl",
    "localImageObjectName",
    "planContentImageTasks",
    "clampImageBatchSize",
    "clampImageMaxBatches",
    "assertLocalWorkerUrl",
    "normalizeBatchResult"
  ];
  const code = [
    extraSource,
    ...names.map((name) => extractFunction(repairImagesSrc, name)),
    `globalThis.__pure = { ${names.join(", ")} };`
  ].join("\n\n");
  const context = vm.createContext({ createHash, URL });
  vm.runInContext(code, context);
  return context.__pure;
}

test("图片身份规则与 Worker 生产实现逐字等价（常量/正则/扩展名归一）", () => {
  // 允许扩展名集合、单篇上限、R2/站内路径前缀必须完全一致
  assert.deepEqual(
    [...evalConstRhs(repairImagesSrc, "ALLOWED_IMAGE_EXTENSIONS")].sort(),
    [...evalConstRhs(imagesProductionSrc, "ALLOWED_EXTENSIONS")].sort(),
    "允许的图片扩展名必须与生产一致"
  );
  assert.equal(
    evalConstRhs(repairImagesSrc, "MAX_IMAGES_PER_CONTENT"),
    evalConstRhs(imagesProductionSrc, "MAX_IMAGES_PER_CONTENT"),
    "单篇图片上限必须与生产一致"
  );
  assert.equal(
    evalConstRhs(repairImagesSrc, "IMAGE_KEY_PREFIX"),
    evalConstRhs(imagesProductionSrc, "IMAGE_KEY_PREFIX"),
    "R2 图片对象前缀必须与生产一致"
  );
  assert.equal(
    evalConstRhs(repairImagesSrc, "IMAGE_API_PREFIX"),
    evalConstRhs(imagesProductionSrc, "IMAGE_API_PREFIX"),
    "站内图片路径前缀必须与生产一致"
  );

  // 身份串/扩展名/可抓取 URL/图片提取四条规则必须逐字沿用生产实现
  const identityChain = '.replace(/^\\/+/, "").replace(/_\\d+w(?=\\.[^./]+$)/i, "")';
  const extMatch = "pathname.match(/\\.([a-z0-9]+)$/i)";
  const jpegRule = 'ext === "jpeg" ? "jpg" : ext';
  const ampRule = 'src.trim().replace(/&amp;/gi, "&")';
  const imgTagRe = "const tagRe = /<img\\b[^>]*>/gi;";
  const imgSrcAttrRe = `const srcAttrRe = /\\ssrc\\s*=\\s*(?:"([^"]*)"|'([^']*)')/i;`;
  const hostRule = 'host === "zhimg.com" || host.endsWith(".zhimg.com")';
  for (const snippet of [identityChain, extMatch, jpegRule, ampRule, imgTagRe, imgSrcAttrRe, hostRule]) {
    assert.ok(imagesProductionSrc.includes(snippet), `生产图片规则缺少预期片段：${snippet}`);
    assert.ok(repairImagesSrc.includes(snippet), `本地脚本必须沿用生产片段：${snippet}`);
  }
  assert.ok(imagesProductionSrc.includes('parsed.protocol !== "https:"'));
  assert.ok(repairImagesSrc.includes('parsed.protocol !== "https:"'));

  // sha256 必须是 UTF-8 小写 hex（与 Worker utils/hash.ts 的 crypto.subtle 结果一致）
  const pure = loadRepairImagePure();
  assert.equal(pure.sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(pure.sha256Hex("v2-abc.jpg"), "52ad864b4bd98cc6f92dd9863da543cd7e1f92c6512cd562bb7a5c8e0c4263d0");
  assert.equal(
    pure.imageObjectKeyForUrl("https://pic1.zhimg.com/v2-abc_720w.jpg?source=1"),
    "images/52ad864b4bd98cc6f92dd9863da543cd7e1f92c6512cd562bb7a5c8e0c4263d0.jpg"
  );
  assert.equal(pure.imageIdentity("https://picx.zhimg.com/v2-abc_720w.jpg?x=1"), "v2-abc.jpg");
});

test("图片任务规划：外链按身份去重入队，站内路径绝不二次哈希", () => {
  const pure = loadRepairImagePure();
  const url = "https://pic1.zhimg.com/v2-abc_720w.jpg?source=1";
  const expectedKey = pure.imageObjectKeyForUrl(url);

  // 1) 对象缺失 → 生成一条任务
  const missing = pure.planContentImageTasks(`<p>a<img src="${url}">b</p>`, {
    objectExists: () => false,
    findTask: () => null
  });
  assert.equal(missing.tasks.length, 1);
  assert.equal(missing.tasks[0].objectKey, expectedKey);
  assert.equal(missing.tasks[0].imageUrl, url);
  assert.equal(missing.counts.externalUrls, 1);
  assert.equal(missing.counts.newTasks, 1);

  // 2) 对象已存在 → 不入队
  const backedUp = pure.planContentImageTasks(`<img src="${url}">`, {
    objectExists: (key) => key === expectedKey,
    findTask: () => null
  });
  assert.equal(backedUp.tasks.length, 0);
  assert.equal(backedUp.counts.externalBackedUp, 1);

  // 3) 同一路径不同子域/尺寸只算一张
  const duplicated = pure.planContentImageTasks(
    '<img src="https://pic1.zhimg.com/v2-abc_720w.jpg?source=1"><img src="https://picx.zhimg.com/v2-abc.jpg?sign=2">',
    { objectExists: () => false, findTask: () => null }
  );
  assert.equal(duplicated.tasks.length, 1);
  assert.equal(duplicated.counts.externalUrls, 2);

  // 4) 已改写的站内路径缺对象且没有任务行：不可恢复，跳过且绝不生成新对象名
  const localName = `${"a".repeat(64)}.jpg`;
  const localMissing = pure.planContentImageTasks(`<img src="/api/images/${localName}">`, {
    objectExists: () => false,
    findTask: () => null
  });
  assert.equal(localMissing.tasks.length, 0);
  assert.equal(localMissing.counts.localPaths, 1);
  assert.equal(localMissing.counts.skipped["local-path-no-task"], 1);
  assert.ok(!JSON.stringify(localMissing.tasks).includes("/api/images/"), "站内路径不得被当成外链");

  // 5) 站内路径缺对象但本地任务行是 pending：交给现有队列消费
  const localPending = pure.planContentImageTasks(`<img src="/api/images/${localName}">`, {
    objectExists: () => false,
    findTask: () => ({ imageUrl: url, status: "pending" })
  });
  assert.equal(localPending.tasks.length, 0);
  assert.equal(localPending.counts.localTaskPending, 1);

  // 6) failed / done 的旧行不会本次复活，单独计入跳过
  const localFailed = pure.planContentImageTasks(`<img src="/api/images/${localName}">`, {
    objectExists: () => false,
    findTask: () => ({ imageUrl: url, status: "failed" })
  });
  assert.equal(localFailed.counts.skipped["local-path-failed-task"], 1);
  const localDone = pure.planContentImageTasks(`<img src="/api/images/${localName}">`, {
    objectExists: () => false,
    findTask: () => ({ imageUrl: url, status: "done" })
  });
  assert.equal(localDone.counts.skipped["local-path-done-without-object"], 1);

  // 7) 外链已有 failed 行：不重复入队，等生产冷却逻辑处理
  const externalFailed = pure.planContentImageTasks(`<img src="${url}">`, {
    objectExists: () => false,
    findTask: () => ({ imageUrl: url, status: "failed" })
  });
  assert.equal(externalFailed.tasks.length, 0);
  assert.equal(externalFailed.counts.skipped["external-failed-task"], 1);
});

test("图片任务规划：协议相对地址被还原、无扩展名/非知乎域名/超上限都只统计不猜", () => {
  const pure = loadRepairImagePure();

  // 协议相对地址补 https: 后才可抓取
  const protocolRelative = pure.planContentImageTasks(
    '<img src="//pic1.zhimg.com/v2-rel.png?x=1&amp;y=2">',
    { objectExists: () => false, findTask: () => null }
  );
  assert.equal(protocolRelative.tasks.length, 1);
  assert.ok(protocolRelative.tasks[0].imageUrl.startsWith("https://pic1.zhimg.com/"));
  assert.ok(protocolRelative.tasks[0].imageUrl.includes("&y=2"), "&amp; 必须还原成 &");

  // 无扩展名：保留现状（不猜 Content-Type、不生成对象名）
  const noExt = pure.planContentImageTasks('<img src="https://pic1.zhimg.com/v2-noext">', {
    objectExists: () => false,
    findTask: () => null
  });
  assert.equal(noExt.tasks.length, 0);
  assert.equal(noExt.counts.skipped["no-extension"], 1);

  // 非知乎域名 / 非 https 一律跳过
  const other = pure.planContentImageTasks(
    '<img src="https://evil.example.com/a.jpg"><img src="http://pic1.zhimg.com/v2-http.jpg">',
    { objectExists: () => false, findTask: () => null }
  );
  assert.equal(other.tasks.length, 0);
  assert.equal(other.counts.skipped["non-zhihu"], 2);

  // 超过 50 张时与生产一致：只处理前 50 个候选，其余计入 over-limit
  const many = Array.from({ length: 55 }, (_, i) => `<img src="https://pic1.zhimg.com/v2-${i}.jpg">`).join("");
  const capped = pure.planContentImageTasks(many, { objectExists: () => false, findTask: () => null });
  assert.equal(capped.tasks.length, 50);
  assert.equal(capped.counts.externalUrls, 50);
  assert.equal(capped.counts.skipped["over-limit"], 5);

  // 空正文/无图片直接返回空计划
  assert.equal(pure.planContentImageTasks("", { objectExists: () => false, findTask: () => null }).tasks.length, 0);
  assert.equal(
    pure.planContentImageTasks("<p>no image</p>", { objectExists: () => false, findTask: () => null }).tasks.length,
    0
  );
});

test("图片补采参数收敛：batch-size 1..100、max-batches >=0、只允许 loopback Worker", () => {
  const pure = loadRepairImagePure();
  assert.equal(pure.clampImageBatchSize(20), 20);
  assert.equal(pure.clampImageBatchSize(0), 1);
  assert.equal(pure.clampImageBatchSize(101), 100);
  assert.equal(pure.clampImageBatchSize(Number.NaN), 20);
  assert.equal(pure.clampImageBatchSize("30"), 30);

  assert.equal(pure.clampImageMaxBatches(0), 0);
  assert.equal(pure.clampImageMaxBatches(5), 5);
  assert.equal(pure.clampImageMaxBatches(-3), 0);
  assert.equal(pure.clampImageMaxBatches(Number.NaN), 0);

  assert.equal(pure.assertLocalWorkerUrl("http://127.0.0.1:18787"), "http://127.0.0.1:18787");
  assert.equal(pure.assertLocalWorkerUrl("http://localhost:18787"), "http://localhost:18787");
  assert.throws(() => pure.assertLocalWorkerUrl("https://zhihu-backup.pages.dev"), /拒绝非 loopback/);

  // vm 里创建的对象原型属于另一个 realm，逐字段比较而不是 deepEqual
  const batch = pure.normalizeBatchResult({ claimed: 20, done: 19, failed: 0, retry: 1 });
  assert.equal(batch.claimed, 20);
  assert.equal(batch.done, 19);
  assert.equal(batch.failed, 0);
  assert.equal(batch.retry, 1);
  for (const empty of [pure.normalizeBatchResult({}), pure.normalizeBatchResult(null)]) {
    assert.equal(empty.claimed, 0);
    assert.equal(empty.done, 0);
    assert.equal(empty.failed, 0);
    assert.equal(empty.retry, 0);
  }
});

test("repair-local-images 只写本地 image_tasks、只连 loopback、临时 SQL 必清理", () => {
  const src = repairImagesSrc;

  // 绝不出现远端执行标志，且唯一硬编码的地址是 loopback
  assert.ok(!src.includes("--remote"), "源码不得出现任何远端执行标志");
  assert.ok(!/https:\/\//.test(src), "源码不得硬编码任何远端地址");
  assert.equal((src.match(/http:\/\//g) || []).length, 1, "唯一允许的地址是 loopback Worker");
  assert.match(src, /const LOCAL_WORKER_URL = "http:\/\/127\.0\.0\.1:\d+";/);
  assert.match(src, /assertLocalWorkerUrl\(LOCAL_WORKER_URL\)/);
  assert.equal((src.match(/\bfetch\(/g) || []).length, 1, "只允许一个 fetch 出口");
  assert.match(src, /fetchJson\(`\$\{LOCAL_WORKER_URL\}\$\{pathname\}`/);

  // 只写 image_tasks，且必须幂等
  assert.match(src, /INSERT OR IGNORE INTO image_tasks/);
  assert.match(src, /\(content_pk, image_url, object_key, status, attempts, created_at, updated_at\)/);
  assert.ok(!/INTO\s+contents\b/i.test(src), "不得写 contents");
  assert.ok(!/UPDATE\s+contents\b/i.test(src), "不得改 contents");
  assert.ok(!/content_hash\s*=/i.test(src), "不得改 content_hash");
  assert.ok(!/\/ingest\/content/.test(src), "不得重新入库正文");

  // 写库走 wrangler 本地 SQL 文件，且 SQL 文件与临时目录都在 finally 清理
  assert.match(src, /"d1", "execute", DB_NAME, "--local", "--yes", `--file=\$\{sqlPath\}`/);
  assert.match(src, /fs\.rmSync\(sqlPath, \{ force: true \}\)/);
  assert.match(src, /fs\.rmSync\(tempDir, \{ recursive: true, force: true \}\)/);
  assert.match(src, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\)/);

  // 显式模式标记 + 只读打开的本地库
  assert.match(src, /if \(!opts\.repairImages\)/);
  assert.match(src, /readonly: true, fileMustExist: true/);
  assert.match(src, /query_only = ON/);

  // 日志里不得出现图片外链 / HTML / 正文 / cookie
  assert.ok(!/cookie/i.test(src), "脚本不得处理 cookie");
  const logLines = src.split("\n").filter((line) => /console\.(log|error|warn)\(|(^|\s)log\(/.test(line));
  for (const line of logLines) {
    assert.ok(!line.includes("imageUrl"), `日志不得打印图片外链: ${line.trim()}`);
    assert.ok(!line.includes("image_url"), `日志不得打印外链字段: ${line.trim()}`);
  }
  assert.ok(!/JSON\.stringify\([^)]*tasks/.test(src), "不得把任务外链序列化进日志");
  assert.ok(!/JSON\.stringify\([^)]*html/.test(src), "不得把 HTML 序列化进日志");

  // 只有两个带鉴权的本地端点；健康检查走 /api/stats
  const endpoints = [...src.matchAll(/localRequest\(\s*"([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(endpoints, ["/ingest/image-batch", "/ingest/sync-state"]);
  assert.match(src, /fetchJson\(`\$\{LOCAL_WORKER_URL\}\/api\/stats`/);
});

// ---------------------------------------------------------------------------
// run-comment-repair / repair-upvotes-and-gaps / crawler 安全回归
// ---------------------------------------------------------------------------
test("run-comment-repair 对非风控单条告警使用进程内 sessionDeferredSet 延后，既不写死 skippedPks 也不原地死循环", () => {
  const repairSrc = readScript("scripts/run-comment-repair.mjs");
  assert.match(repairSrc, /const sessionDeferredSet = new Set\(\)/);
  assert.match(repairSrc, /!sessionDeferredSet\.has\(x\.pk\)/);
  assert.match(repairSrc, /sessionDeferredSet\.add\(pk\)/);
  assert.ok(!repairSrc.includes("progress.skippedPks.push(pk)"), "单条瞬时告警不得永久写入 skippedPks");
});

test("crawler 与补抓脚本统一过滤无效 question.id 并处理楼中楼关闭/空页", () => {
  const crawlerSrc = readScript("apps/apify-crawler/src/main.ts").replace(/\r\n/g, "\n");
  const gapRepairSrc = readScript("scripts/repair-upvotes-and-gaps.mjs");

  const metaFns = loadPureFunctions(
    crawlerSrc.replace("function resolveAnswerQuestionMeta(question: any, answerId: string | number)", "function resolveAnswerQuestionMeta(question, answerId)"),
    ["resolveAnswerQuestionMeta"]
  );
  for (const badQ of [{ id: undefined, title: "T" }, { id: "undefined", title: "T" }, { id: "null", title: "T" }]) {
    const res = metaFns.resolveAnswerQuestionMeta(badQ, "123");
    assert.equal(res.sourceUrl, "https://www.zhihu.com/answer/123");
    assert.equal(res.question, undefined);
  }
  const validMeta = metaFns.resolveAnswerQuestionMeta({ id: 456, title: "有效问题" }, "123");
  assert.equal(validMeta.sourceUrl, "https://www.zhihu.com/question/456/answer/123");
  assert.equal(validMeta.question.id, "456");
  assert.equal(metaFns.resolveAnswerQuestionMeta({ id: 456, title: null }, "123").question.title, "");

  // 确认不再残留裸拼 /question/${...question?.id}/answer/
  assert.ok(!crawlerSrc.includes("${item.question?.id}/answer/"));
  assert.ok(!crawlerSrc.includes("${target.question?.id}/answer/"));
  assert.match(gapRepairSrc, /qId !== "undefined" && qId !== "null"/);
  assert.match(gapRepairSrc, /typeof item\.question\?\.title === "string"/);

  // syncHotCommentsForContent 楼中楼需识别闭评错误且在非 is_end 空页置位 cIncomplete
  const syncBody = crawlerSrc.slice(crawlerSrc.indexOf("export async function syncHotCommentsForContent("));
  const childLoop = syncBody.slice(0, syncBody.indexOf("rootsBuffer.push("));
  assert.match(childLoop, /\/已关闭评论\/\.test\(errMsg\)/);
  assert.match(childLoop, /if \(!chIsEnd\) cIncomplete = true;/);

  // 1) fetchStoredCommentState + shouldSyncCommentsDeep：0 子评论根、闭评冻结(is_complete=2)与足够评论总量不反复重抓
  assert.match(crawlerSrc, /Number\(row\.child_count\) > 0 && Number\(row\.is_complete \?\? 0\) === 0/);
  assert.match(crawlerSrc, /if \(state\.storedComments >= expected\) return false;/);

  // 2) postCommentsByRoot 只因 circuitBroken 中断（含空 roots 全量对账），不在 riskExhausted 时丢弃内存已抓批次
  const postRootBlock = crawlerSrc.slice(
    crawlerSrc.indexOf("async function postCommentsByRoot("),
    crawlerSrc.indexOf("function shouldSyncComments(")
  );
  assert.match(postRootBlock, /if \(stats\.circuitBroken\)/);
  assert.match(postRootBlock, /if \(!partial\) \{\s*if \(stats\.circuitBroken\)/);
  assert.ok(!postRootBlock.includes("stats.riskExhausted"));
  assert.match(crawlerSrc, /if \(\/已关闭评论\/\.test\(errMsg\)\)[\s\S]{0,180}if \(rootPages === 0\) \{\s*rootEnded = true;\s*\} else \{\s*cIncomplete = true;\s*\}/);
  assert.match(syncBody, /const res = await postCommentsByRoot\(contentPk, \[\], \{ partial: false, allRootIds \}\);\s*if \(res\.aborted\)/);

  // 3) 关注答主分页跟随 paging.next 或步长 batchLimit，不再按 data.length 跃迁
  const followAnswersSection = crawlerSrc.slice(crawlerSrc.indexOf("async function runFollowingScraperBody("));
  assert.ok(!followAnswersSection.includes("aOffset += (aJson.data?.length"), "不得再用 data.length 推进服务端分页 offset");

  // 4) zhihu-fetch 网络重试耗尽必须传 isLastAttempt 计入 riskExhausted
  const fetchSrc = readScript("apps/apify-crawler/src/zhihu-fetch.ts");
  assert.match(fetchSrc, /throw recordFailure\(\s*"network",\s*0,\s*label,[\s\S]{0,120}\bisLastAttempt\b/);
});

test("upload / local-sync / repair-comments / download-images 安全回归", () => {
  // 1) upload-to-cloudflare 分片切换后必须重置 pendingText，避免跨分片重复行
  assert.match(uploadSrc, /flushChunk\(\);\s*\/\/[^\n]*\n\s*pendingText = rowSql;\s*pendingBytes =/);

  // 2) local-sync runMain 内注册 SIGINT/SIGTERM 清理并在 finally 解绑；等待子进程退出并先放云锁再放本地锁
  assert.match(localSyncSrc, /process\.once\("SIGINT", handleSignal\)/);
  assert.match(localSyncSrc, /process\.once\("SIGTERM", handleSignal\)/);
  assert.match(localSyncSrc, /process\.off\("SIGINT", handleSignal\)/);
  assert.match(localSyncSrc, /childToStop\.once\("close", finish\)/);
  assert.match(localSyncSrc, /await emergencyReleaseCloudLock\(\)[\s\S]{0,120}if \(ownsLocalLock\) releaseLocalLock\(\)/);
  assert.match(localSyncSrc, /spawn\(process\.execPath, \[tscBin\][\s\S]{0,120}activeChild = p;/);

  // 3) run-comment-repair 分离 stdout/stderr 行缓冲并解析显式 status 标签
  const repairCommentsSrc = readScript("scripts/run-comment-repair.mjs");
  assert.match(repairCommentsSrc, /let stdoutBuf = "";\s*let stderrBuf = "";/);
  assert.match(repairCommentsSrc, /\\\[status=\(ok\|closed\|failed\)\\\]/);

  // 4) download-images-direct 对 --retry-failed 重置起点 attempts=0 并写回 nextAttempts
  const dlDirectSrc = readScript("scripts/download-images-direct.mjs");
  assert.match(dlDirectSrc, /row\.status === "failed"\s*\?\s*0\s*:/);
  assert.match(dlDirectSrc, /const nextAttempts = t\.attempts \+ 1;/);
});

// ---------------------------------------------------------------------------
// 新增回归：P0-2 / P1-2 / P1-3 / P1-6 / P1-7 / P1-8 / P2-3 / P2-4 / P2-7
// ---------------------------------------------------------------------------
test("[P0-2][P1-8][P2-3][P2-4][P2-7] crawler/main.ts 与补抓脚本安全回归", () => {
  const crawlerSrc = readScript("apps/apify-crawler/src/main.ts").replace(/\r\n/g, "\n");
  const gapRepairSrc = readScript("scripts/repair-upvotes-and-gaps.mjs");

  // P0-2：runScraperBody 与 syncHotCommentsForContent 子评论遇「已关闭评论」只置 chClosed=true，绝不置 chIsEnd=true
  assert.equal(
    (crawlerSrc.match(/childrenComplete = !chClosed && \(chIsEnd \|\| children\.length >= childCount\);/g) || []).length,
    2,
    "runScraperBody 与 syncHotCommentsForContent 必须统一使用 !chClosed 门控 childrenComplete"
  );
  assert.ok(
    !/if\s*\(\/已关闭评论\/\.test\(errMsg\)\)\s*\{\s*console\.log\([^\n]*子评论[^\n]*\);\s*chIsEnd = true;/m.test(crawlerSrc),
    "子评论闭评不得再置 chIsEnd = true"
  );

  // P1-8：runScraperBody 支持 order_by=ts 首页空页回退 order_by=score 与第 0 页空页清零对账
  const scraperBody = crawlerSrc.slice(
    crawlerSrc.indexOf("async function runScraperBody("),
    crawlerSrc.indexOf("export async function runArticleScraper(")
  );
  assert.match(scraperBody, /const canFallbackScore = cfg\.commentsMyAnswers === "full" && rootPages === 0 && currentOrderBy === "ts";/);
  assert.match(scraperBody, /\.\.\.\(canFallbackScore \? \{ allowEmptyPage: true \} : \{\}\)/);
  assert.match(scraperBody, /fellBackToScore = true;\s*cIncomplete = true;\s*currentOrderBy = "score";\s*cNextUrl = buildRootCommentsUrl\(0, "score"\);/);
  assert.match(scraperBody, /if \(rootPages === 0 && emptyIsEnd && !fellBackToScore && cfg\.commentsMyAnswers === "full"\)[\s\S]{0,2000}postCommentsByRoot\(contentPk, \[\], \{ partial: false, allRootIds: \[\] \}\)/);

  // P2-3：hasReachedCursor 优先时间维度 offset，不被浅层 page_num 误导
  const cursorStart = crawlerSrc.indexOf("  function hasReachedCursor(");
  assert.ok(cursorStart >= 0, "main.ts 缺少 hasReachedCursor");
  const cursorEnd = crawlerSrc.indexOf("\n  }\n", cursorStart);
  assert.ok(cursorEnd >= 0, "hasReachedCursor 缺少结束括号");
  const cursorFnSrc = crawlerSrc
    .slice(cursorStart, cursorEnd + 4)
    .replace("function hasReachedCursor(candidateUrl: string, savedCursor?: string): boolean", "function hasReachedCursor(candidateUrl, savedCursor)");
  const hasReachedCursor = vm.runInNewContext(`(${cursorFnSrc})`, { URL });
  assert.equal(
    hasReachedCursor(
      "https://www.zhihu.com/api/v3/moments/u/activities?page_num=5&offset=1735000000000",
      "https://www.zhihu.com/api/v3/moments/u/activities?page_num=3&offset=1700000000000"
    ),
    false,
    "offset 仍比断点更晚时，不得因 page_num 较大而提前判追平"
  );
  assert.equal(
    hasReachedCursor(
      "https://www.zhihu.com/api/v3/moments/u/activities?page_num=2&offset=1690000000000",
      "https://www.zhihu.com/api/v3/moments/u/activities?page_num=10&offset=1700000000000"
    ),
    true,
    "offset 已追平/越过断点时必须返回 true"
  );
  assert.equal(
    hasReachedCursor(
      "https://www.zhihu.com/api/v3/moments/u/activities?page_num=4",
      "https://www.zhihu.com/api/v3/moments/u/activities?page_num=3"
    ),
    true,
    "无 offset 时退回比较 page_num"
  );

  // P2-4：缺省 is_collapsed / is_labeled 透传 undefined
  assert.match(gapRepairSrc, /isCollapsed: typeof item\.is_collapsed === "boolean" \? item\.is_collapsed : undefined,/);
  assert.match(gapRepairSrc, /isLabeled: typeof item\.is_labeled === "boolean" \? item\.is_labeled : undefined,/);
  assert.match(crawlerSrc, /isCollapsed: typeof art\.is_collapsed === "boolean" \? art\.is_collapsed : undefined,/);
  assert.match(crawlerSrc, /isLabeled: typeof art\.is_labeled === "boolean" \? art\.is_labeled : undefined,/);
  assert.match(crawlerSrc, /isCollapsed: typeof item\.is_collapsed === "boolean" \? item\.is_collapsed : undefined,/);
  assert.match(crawlerSrc, /isLabeled: typeof item\.is_labeled === "boolean" \? item\.is_labeled : undefined,/);

  // P2-7：爬虫终态退出前调用 releaseSyncLockBeforeExit
  assert.match(crawlerSrc, /async function releaseSyncLockBeforeExit\(\): Promise<void>/);
  assert.ok(
    (crawlerSrc.match(/await releaseSyncLockBeforeExit\(\);/g) || []).length >= 5,
    "所有终态退出路径前必须尝试释放云端锁"
  );
});

test("[P1-2][P1-3][P2-7] local-sync / full-local-harvest 信号退出码与 run-comment-repair 跨平台停机", () => {
  // P1-2：local-sync close 回调不得把信号中止（null）归为 0，且 tsc 返回后及启动爬虫前检查 signalHandled
  assert.ok(!localSyncSrc.includes("resolve(exitCode ?? 0)"));
  assert.ok(!localSyncSrc.includes("resolve(c ?? 0)"));
  assert.equal((localSyncSrc.match(/if \(signalHandled\) return;/g) || []).length, 5);
  assert.match(localSyncSrc, /const isProxyParent = !emergencyReleaseCloudLock;/);

  // P1-3：full-local-harvest runChild 信号中止不得返回 0，且仅 !signal 时才标 completed
  assert.ok(!harvestSrc.includes("resolve({ code: code ?? 0"));
  assert.match(harvestSrc, /code: code !== null \? code : \(signal \? 128 : 1\),\s*signal: signal \|\| null,/);
  assert.match(harvestSrc, /if \(code === 0 && !signal && cursorSettled && !riskTerminal\)/);

  // P2-7：run-comment-repair stopLocalWorker 跨平台停机
  const repairCommentsSrc = readScript("scripts/run-comment-repair.mjs");
  assert.match(repairCommentsSrc, /process\.platform === "win32"/);
  assert.match(repairCommentsSrc, /proc\.kill\("SIGTERM"\)/);
});

test("[P1-6] download-images-direct 读取 meta/sync_config.json 并与 D1 按时间戳择新", () => {
  const dlDirectSrc = readScript("scripts/download-images-direct.mjs");
  assert.ok(!dlDirectSrc.includes("config/sync_config.json"), "不得再查错误键 config/sync_config.json");
  assert.match(dlDirectSrc, /meta\/sync_config\.json/);

  const validConst = extractConstSource(dlDirectSrc, "VALID_IMAGE_QUALITIES");
  // 注入真实 fs/path 到沙箱以读取隔离临时目录下的 blob
  const sandbox = { fs, path };
  const context = vm.createContext(sandbox);
  vm.runInContext(
    `${validConst}\n${extractFunction(dlDirectSrc, "readImageQuality")}\nglobalThis.__read = readImageQuality;`,
    context
  );
  const readFn = context.__read;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-dl-cfg-"));
  const d1 = new Database(":memory:");
  const r2 = new Database(":memory:");
  try {
    d1.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);");
    r2.exec("CREATE TABLE _mf_objects (key TEXT PRIMARY KEY, blob_id TEXT, uploaded INTEGER);");

    // 1) R2 更新时间较新（模拟 D1 满额写入失败后仅写到 R2）→ 必须采用 R2 配置
    fs.writeFileSync(path.join(tmpDir, "blob-r2"), JSON.stringify({ imageQuality: "compressed", updatedAt: "2026-11-20T10:00:00.000Z" }));
    r2.prepare("INSERT INTO _mf_objects VALUES (?, ?, ?)").run("meta/sync_config.json", "blob-r2", Date.parse("2026-11-20T10:00:00.000Z"));
    d1.prepare("INSERT INTO app_settings VALUES (?, ?, ?)").run("sync_config", JSON.stringify({ imageQuality: "original", updatedAt: "2026-11-19T10:00:00.000Z" }), "2026-11-19T10:00:00.000Z");
    assert.equal(readFn(d1, r2, tmpDir), "compressed");

    // 2) D1 更新时间较新 → 采用 D1 配置
    d1.prepare("UPDATE app_settings SET value = ?, updated_at = ? WHERE key = 'sync_config'").run(
      JSON.stringify({ imageQuality: "high", updatedAt: "2026-11-21T10:00:00.000Z" }),
      "2026-11-21T10:00:00.000Z"
    );
    assert.equal(readFn(d1, r2, tmpDir), "high");
  } finally {
    d1.close();
    r2.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("[P1-7] run-comment-repair scanCandidates 不得因已软删根或未抓全楼中楼而跳过残缺内容", () => {
  const repairCommentsSrc = readScript("scripts/run-comment-repair.mjs");
  const { scanCandidates } = loadPureFunctions(repairCommentsSrc, ["scanCandidates"]);
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE contents (pk TEXT PRIMARY KEY, source_type TEXT NOT NULL, comment_count INTEGER NOT NULL, is_deleted INTEGER NOT NULL);
      CREATE TABLE comments (id TEXT PRIMARY KEY, content_pk TEXT NOT NULL, parent_comment_id TEXT, is_deleted INTEGER NOT NULL);
      CREATE TABLE comment_threads (root_id TEXT PRIMARY KEY, content_pk TEXT NOT NULL, child_count INTEGER NOT NULL, is_complete INTEGER NOT NULL);
    `);

    // 场景 A：comment_count=30, 仅 5 条有效根；另有 1 条已软删旧根对应的 thread child_count=30（旧 SQL 会误算 5+30>=30 并跳过）
    db.prepare("INSERT INTO contents VALUES ('answer:1', 'answer', 30, 0)").run();
    for (let i = 1; i <= 5; i++) {
      db.prepare("INSERT INTO comments VALUES (?, 'answer:1', NULL, 0)").run(`r1-${i}`);
    }
    db.prepare("INSERT INTO comments VALUES ('r1-deleted', 'answer:1', NULL, 1)").run();
    db.prepare("INSERT INTO comment_threads VALUES ('r1-deleted', 'answer:1', 30, 1)").run();

    // 场景 B：comment_count=30, 5 条有效根，其中 1 条根 child_count=30 但 is_complete=0（旧 SQL 会误算 5+30>=30 并跳过）
    db.prepare("INSERT INTO contents VALUES ('answer:2', 'answer', 30, 0)").run();
    for (let i = 1; i <= 5; i++) {
      db.prepare("INSERT INTO comments VALUES (?, 'answer:2', NULL, 0)").run(`r2-${i}`);
    }
    db.prepare("INSERT INTO comment_threads VALUES ('r2-1', 'answer:2', 30, 0)").run();

    // 场景 C：真正完整（5 条有效根 + is_complete=1 的 25 条子评论 >= 30，无未完成线程）→ 应正确跳过
    db.prepare("INSERT INTO contents VALUES ('answer:3', 'answer', 30, 0)").run();
    for (let i = 1; i <= 5; i++) {
      db.prepare("INSERT INTO comments VALUES (?, 'answer:3', NULL, 0)").run(`r3-${i}`);
    }
    db.prepare("INSERT INTO comment_threads VALUES ('r3-1', 'answer:3', 25, 1)").run();

    // 场景 D [P2-4]：闭评冻结（5 条有效根 + is_complete=2 的 25 条子评论 >= 30，无未完成线程）→ 应跳过不再重抓
    db.prepare("INSERT INTO contents VALUES ('answer:4', 'answer', 30, 0)").run();
    for (let i = 1; i <= 5; i++) {
      db.prepare("INSERT INTO comments VALUES (?, 'answer:4', NULL, 0)").run(`r4-${i}`);
    }
    db.prepare("INSERT INTO comment_threads VALUES ('r4-1', 'answer:4', 25, 2)").run();

    const scan = scanCandidates(db);
    assert.equal(scan.skippedAlreadyComplete, 2, "真正完整与闭评冻结(is_complete=2)的内容都应被跳过");
    assert.deepEqual(Array.from(scan.targets, t => t.pk), ["answer:1", "answer:2"]);
  } finally {
    db.close();
  }
});

test("[P2-4] crawler fetchStoredCommentState / shouldSyncCommentsDeep 对 is_complete=2 不触发重复补抓", async () => {
  const crawlerSrc = readScript("apps/apify-crawler/src/main.ts").replace(/\r\n/g, "\n");
  assert.equal((crawlerSrc.match(/toRootCommentGroup\(c, children, childrenComplete, childrenClosed\)/g) || []).length, 2);

  // 用 TypeScript transpile 剥离类型注解后再在 vm 执行 fetchStoredCommentState + shouldSyncCommentsDeep
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const crawlerRequire = createRequire(path.join(ROOT, "apps", "apify-crawler", "package.json"));
  const tsMod = await import(pathToFileURL(crawlerRequire.resolve("typescript")).href);
  const ts = tsMod.default ?? tsMod;
  const crawlerJs = ts.transpileModule(crawlerSrc, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;

  const fnBlock = [
    extractFunction(crawlerJs, "shouldSyncComments"),
    extractFunction(crawlerJs, "isStoredRootCommentRow"),
    "async " + extractFunction(crawlerJs, "fetchStoredCommentState"),
    "async " + extractFunction(crawlerJs, "shouldSyncCommentsDeep")
  ].join("\n");

  let returnedRows = [];
  const ctx = vm.createContext({
    apiUrl: "https://worker.example",
    apiSecret: "sec",
    commentSyncIncomplete: new Set(),
    fetch: async () => ({
      ok: true,
      json: async () => ({ data: returnedRows })
    })
  });
  vm.runInContext(`${fnBlock}\nglobalThis.__state = fetchStoredCommentState;\nglobalThis.__deep = shouldSyncCommentsDeep;`, ctx);

  // 1) is_complete = 2 视为已冻结：incompleteRoots = 0，且 storedComments 包含已知子评数
  returnedRows = [
    { child_count: 10, is_complete: 2 },
    { child_count: 5, is_complete: 1 }
  ];
  const frozenState = await ctx.__state("answer:p24");
  assert.equal(frozenState.incompleteRoots, 0, "is_complete=2 不得计入 incompleteRoots");
  assert.equal(frozenState.storedComments, 17);
  assert.equal(await ctx.__deep("answer:p24", 17, 17, "full"), false, "闭评冻结后不应再重复触发补抓");

  // 2) is_complete = 0 仍计入 incompleteRoots 并触发补抓
  returnedRows = [{ child_count: 10, is_complete: 0 }];
  const retryState = await ctx.__state("answer:p24-retry");
  assert.equal(retryState.incompleteRoots, 1);
  assert.equal(await ctx.__deep("answer:p24-retry", 11, 11, "full"), true);
});

test("[P0-1][P1-4] crawler score 回退不触发全量删对账，畸形响应与非确认空页不误清零", async () => {
  const crawlerSrc = readScript("apps/apify-crawler/src/main.ts").replace(/\r\n/g, "\n");
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const crawlerRequire = createRequire(path.join(ROOT, "apps", "apify-crawler", "package.json"));
  const tsMod = await import(pathToFileURL(crawlerRequire.resolve("typescript")).href);
  const ts = tsMod.default ?? tsMod;
  const crawlerJs = ts.transpileModule(crawlerSrc, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;

  const fnCode = [
    extractFunction(crawlerJs, "pickCommentImageUrl"),
    extractFunction(crawlerJs, "normalizeCommentImage"),
    extractFunction(crawlerJs, "toChildComment"),
    extractFunction(crawlerJs, "toRootCommentGroup"),
    "async " + extractFunction(crawlerJs, "runScraperBody"),
    "async " + extractFunction(crawlerJs.replace("export async function syncHotCommentsForContent(", "async function syncHotCommentsForContent("), "syncHotCommentsForContent")
  ].join("\n");

  const makeRoots = (prefix, count, startIdx = 0) =>
    Array.from({ length: count }, (_, idx) => {
      const n = startIdx + idx;
      return {
        id: `${prefix}-${n}`,
        content: `comment ${n}`,
        author: { name: `U${n}`, avatar_url: "" },
        vote_count: n,
        child_comment_count: 0,
        child_comments: []
      };
    });

  let zhihuHandler;
  let postRootCalls = [];
  let incompleteSet = new Set();
  const makeStats = () => ({
    saved: 0, failed: 0, authRejected: 0, riskEmpty: 0, zhihuRejected: 0,
    riskFailStreak: 0, riskExhausted: false, riskPaused: false, riskPauseMs: 0,
    consecutiveFailures: 0, circuitBroken: false, estimatedWrites: 0
  });
  const sandbox = {
    URL,
    Set,
    Map,
    Array,
    Number,
    String,
    Boolean,
    Math,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    MAX_COMMENT_PAGES: 200,
    ZHIHU_USERNAME: "tester",
    isFast: false,
    cfg: { commentsMyAnswers: "full", commentsCollections: "full", commentsUpvotes: "full", commentsFollowing: "full" },
    stats: makeStats(),
    get commentSyncIncomplete() { return incompleteSet; },
    jitterSleep: async () => {},
    createStealthContext: async () => ({ addCookies: async () => {} }),
    getCookiesArray: () => [],
    fetchAnswerTrueStats: async () => null,
    resolveAnswerQuestionMeta: (q, id) => ({ sourceUrl: `https://www.zhihu.com/question/1/answer/${id}`, question: q }),
    cleanHtml: s => String(s || ""),
    toIsoOrNull: () => "2026-01-01T00:00:00.000Z",
    sendContent: async () => ({ created: false, changed: false, prevCommentCount: 0 }),
    shouldSyncCommentsDeep: async () => true,
    sanitizeErrorForLog: e => String(e?.message || e),
    zhihuJson: async (ctx, url, opts) => zhihuHandler(ctx, url, opts),
    postCommentsByRoot: async (contentPk, roots, opts = {}) => {
      postRootCalls.push({ contentPk, count: roots.length, opts });
      return { batches: 1, roots: roots.length, children: 0, aborted: false };
    }
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(`${fnCode}\nglobalThis.__run = runScraperBody;\nglobalThis.__syncHot = syncHotCommentsForContent;`, ctx);

  // 1) P0-1 runScraperBody: order_by=ts 首页空页 is_end=false 回退 order_by=score 返回 200 根 + is_end=true
  //    断言全部 postCommentsByRoot 调用均为 partial: true 且无 allRootIds（绝不触发 201~N 删除对账）
  postRootCalls = [];
  incompleteSet = new Set();
  sandbox.stats = makeStats();
  zhihuHandler = async (_c, url) => {
    if (url.includes("/members/tester/answers")) {
      return {
        json: {
          data: [{ id: "ans-p01", type: "answer", comment_count: 300, content: "<p>body</p>", question: { id: 1, title: "Q" } }],
          paging: { is_end: true }
        }
      };
    }
    if (url.includes("order_by=ts")) {
      return { json: { data: [], paging: { is_end: false } } };
    }
    const u = new URL(url);
    const pageIdx = Number(u.searchParams.get("offset") || "0");
    const nextIdx = pageIdx + 1;
    return {
      json: {
        data: makeRoots("score", 20, pageIdx * 20),
        paging: nextIdx < 10
          ? { is_end: false, next: `https://www.zhihu.com/api/v4/comment_v5/answers/ans-p01/root_comment?order_by=score&limit=20&offset=${nextIdx}` }
          : { is_end: true }
      }
    };
  };
  await ctx.__run({});
  assert.ok(postRootCalls.length >= 10, "200 根应分多批提交");
  assert.equal(postRootCalls.every(c => c.opts?.partial === true && c.opts?.allRootIds === undefined), true, "score 回退全批必须强制 partial:true 且不带 allRootIds");

  // 2) P0-1 syncHotCommentsForContent: 200 根回退 score 同样不得在尾部补发 partial:false 全量对账
  postRootCalls = [];
  incompleteSet = new Set();
  sandbox.stats = makeStats();
  zhihuHandler = async (_c, url) => {
    if (url.includes("order_by=ts")) {
      return { json: { data: [], paging: { is_end: false } } };
    }
    const u = new URL(url);
    const pageIdx = Number(u.searchParams.get("offset") || "0");
    const nextIdx = pageIdx + 1;
    return {
      json: {
        data: makeRoots("art-score", 20, pageIdx * 20),
        paging: nextIdx < 10
          ? { is_end: false, next: `https://www.zhihu.com/api/v4/comment_v5/articles/art-p01/root_comment?order_by=score&limit=20&offset=${nextIdx}` }
          : { is_end: true }
      }
    };
  };
  await ctx.__syncHot({}, "article", "art-p01", "full");
  assert.equal(postRootCalls.length, 10);
  assert.equal(postRootCalls.every(c => c.opts?.partial === true && c.opts?.allRootIds === undefined), true);

  // 3) P1-4: 缺失 data 数组的畸形响应 { paging: { is_end: true } } 不得误判清零
  postRootCalls = [];
  incompleteSet = new Set();
  sandbox.stats = makeStats();
  zhihuHandler = async (_c, url) => {
    if (url.includes("/members/tester/answers")) {
      return {
        json: {
          data: [{ id: "ans-mal", type: "answer", comment_count: 10, content: "<p>body</p>", question: { id: 1, title: "Q" } }],
          paging: { is_end: true }
        }
      };
    }
    return { json: { paging: { is_end: true } } };
  };
  await ctx.__run({});
  assert.equal(postRootCalls.length, 0, "缺失 data 数组不得触发任何清零提交");
  assert.equal(incompleteSet.has("answer:ans-mal"), true);

  // 4) P1-4: commentCount > 0 时首页单次空页 is_end=true 必须走 zhihuJson 二次确认；二次确认不通过则绝不清零
  postRootCalls = [];
  incompleteSet = new Set();
  sandbox.stats = makeStats();
  let tsCalls = 0;
  zhihuHandler = async (_c, url) => {
    if (url.includes("/members/tester/answers")) {
      return {
        json: {
          data: [{ id: "ans-confirm-fail", type: "answer", comment_count: 25, content: "<p>body</p>", question: { id: 1, title: "Q" } }],
          paging: { is_end: true }
        }
      };
    }
    tsCalls++;
    if (tsCalls === 1) return { json: { data: [], paging: { is_end: true } } };
    return { json: { data: makeRoots("recover", 1), paging: { is_end: true } } };
  };
  await ctx.__run({});
  assert.equal(tsCalls, 2, "commentCount > 0 时必须复用 zhihuJson 发起二次确认");
  assert.equal(postRootCalls.length, 0, "二次确认仍有评论/未确认清空时不得提交 allRootIds: []");
  assert.equal(incompleteSet.has("answer:ans-confirm-fail"), true);

  // 5) P1-4: 二次确认仍为空且 is_end=true 时放行清零
  postRootCalls = [];
  incompleteSet = new Set();
  sandbox.stats = makeStats();
  tsCalls = 0;
  zhihuHandler = async (_c, url) => {
    if (url.includes("/members/tester/answers")) {
      return {
        json: {
          data: [{ id: "ans-confirm-ok", type: "answer", comment_count: 25, content: "<p>body</p>", question: { id: 1, title: "Q" } }],
          paging: { is_end: true }
        }
      };
    }
    tsCalls++;
    return { json: { data: [], paging: { is_end: true } } };
  };
  await ctx.__run({});
  assert.equal(tsCalls, 2);
  assert.equal(postRootCalls.length, 1);
  assert.deepEqual(Array.from(postRootCalls[0].opts.allRootIds), []);
  assert.equal(postRootCalls[0].opts.partial, false);
});

test("[P1-7][P2-9] local-sync 代理 IPC 软停/等 close 再放锁/幂等、crawler aborting 钩子与 run-comment-repair 进程组停机", async () => {
  const http = await import("node:http");
  const net = await import("node:net");
  const crawlerSrc = readScript("apps/apify-crawler/src/main.ts").replace(/\r\n/g, "\n");
  const repairCommentsSrc = readScript("scripts/run-comment-repair.mjs");

  // 1) 静态与行为校验：crawler/main.ts 已挂载 Actor.on("aborting") 与 SIGINT/SIGTERM，且并发释放严格幂等
  assert.match(crawlerSrc, /Actor\.on\("aborting"/);
  assert.match(crawlerSrc, /process\.once\("SIGINT", handleCrawlerSignal\)/);
  assert.match(crawlerSrc, /process\.once\("SIGTERM", handleCrawlerSignal\)/);

  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const crawlerRequire = createRequire(path.join(ROOT, "apps", "apify-crawler", "package.json"));
  const tsMod = await import(pathToFileURL(crawlerRequire.resolve("typescript")).href);
  const ts = tsMod.default ?? tsMod;
  const crawlerJs = ts.transpileModule(crawlerSrc, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  const releaseFnCode = "async " + extractFunction(crawlerJs, "releaseSyncLockBeforeExit");
  let resolveFetch;
  let fetchCalls = 0;
  const relCtx = vm.createContext({
    AbortSignal,
    syncOwnerId: "owner-1",
    apiUrl: "https://worker.example",
    apiSecret: "sec",
    syncLockReleasePromise: null,
    fetch: () => {
      fetchCalls++;
      return new Promise(r => { resolveFetch = r; });
    }
  });
  vm.runInContext(`${releaseFnCode}\nglobalThis.__rel = releaseSyncLockBeforeExit;`, relCtx);
  let p1Done = false;
  let p2Done = false;
  const p1 = relCtx.__rel().then(() => { p1Done = true; });
  const p2 = relCtx.__rel().then(() => { p2Done = true; });
  assert.equal(fetchCalls, 1, "并发调用 releaseSyncLockBeforeExit 只允许发出 1 次释放请求");
  await new Promise(r => setTimeout(r, 20));
  assert.equal(p1Done || p2Done, false, "未收到释放响应前两个调用方都必须等待同一在途 Promise");
  resolveFetch({ ok: true });
  await Promise.all([p1, p2]);
  assert.equal(p1Done && p2Done, true);

  // 2) 静态检查：local-sync 默认超时推导公式、IPC 通道、connected 校验与 process.disconnect()
  assert.match(localSyncSrc, /DEFAULT_PROXY_SHUTDOWN_TIMEOUT_MS\s*=\s*CRAWLER_STOP_TIMEOUT_MS\s*\+\s*FORCE_KILL_CLOSE_WAIT_MS\s*\+\s*CLOUD_LOCK_RELEASE_TIMEOUT_MS\s*\+\s*2_000/);
  assert.match(localSyncSrc, /resolveTimeoutMs\(\s*"LOCAL_SYNC_SHUTDOWN_TIMEOUT_MS",\s*DEFAULT_PROXY_SHUTDOWN_TIMEOUT_MS\s*\)/);
  assert.match(localSyncSrc, /stdio:\s*\["inherit",\s*"inherit",\s*"inherit",\s*"ipc"\]/);
  assert.match(localSyncSrc, /childToStop\.connected/);
  assert.match(localSyncSrc, /type:\s*"graceful-shutdown"/);
  assert.match(localSyncSrc, /process\.disconnect\(\)/);
  assert.match(localSyncSrc, /allowedNodeEnvironmentFlags\?\.has\("--use-env-proxy"\)/);

  // 3) 真实代理父子进程联调（全程限定在 os.tmpdir()）：验证 IPC 软停、等 close 再放锁、叠加信号幂等、超时强杀等 close
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-local-sync-ipc-"));
  const scriptsDir = path.join(dir, "scripts");
  const crawlerDir = path.join(dir, "apps", "apify-crawler");
  const distDir = path.join(crawlerDir, "dist");
  const lockFile = path.join(crawlerDir, ".local-sync.lock");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });

  // 测试副本仅在环境变量显式存在时把信号文件转成父/子进程内信号事件（解决 Windows 下 kill() 无信号句柄的跨平台测试限制）
  const instrumentedLocalSync = `${localSyncSrc}
if (!process.env.__LOCAL_SYNC_PROXY_BOOTSTRAPPED && process.env.__TEST_PARENT_SIGNAL_FILE) {
  const sigFile = process.env.__TEST_PARENT_SIGNAL_FILE;
  const t = setInterval(() => {
    if (fs.existsSync(sigFile)) {
      clearInterval(t);
      const sig = fs.readFileSync(sigFile, "utf8").trim() || "SIGTERM";
      process.emit(sig, sig);
    }
  }, 15);
  t.unref();
}
if (process.env.__LOCAL_SYNC_PROXY_BOOTSTRAPPED && process.env.__TEST_CHILD_SIGNAL_FILE) {
  const sigFile = process.env.__TEST_CHILD_SIGNAL_FILE;
  const t = setInterval(() => {
    if (fs.existsSync(sigFile)) {
      clearInterval(t);
      const sig = fs.readFileSync(sigFile, "utf8").trim() || "SIGINT";
      process.emit(sig, sig);
    }
  }, 15);
  t.unref();
}
`;
  const testScriptPath = path.join(scriptsDir, "local-sync.mjs");
  fs.writeFileSync(testScriptPath, instrumentedLocalSync, "utf8");
  fs.writeFileSync(
    path.join(distDir, "main.js"),
    `import fs from "node:fs";
     if (process.env.__TEST_CRAWLER_READY_FILE) fs.writeFileSync(process.env.__TEST_CRAWLER_READY_FILE, String(process.pid));
     setInterval(() => {}, 1000);`,
    "utf8"
  );

  let releaseDelayMs = 150;
  let releaseCalls = 0;
  let lockExistsDuringRelease = [];
  const proxyServer = net.createServer(sock => sock.end());
  await new Promise(resolve => proxyServer.listen(0, "127.0.0.1", resolve));
  const proxyPort = proxyServer.address().port;

  let hangRelease = false;
  const openReleaseResponses = [];
  const workerServer = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/ingest/sync-lock/acquire") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && req.url === "/ingest/sync-state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ cookieString: "z_c0=test", zhihuUsername: "tester", syncConfig: {} }));
      return;
    }
    if (req.method === "POST" && req.url === "/ingest/sync-lock/release") {
      releaseCalls++;
      lockExistsDuringRelease.push(fs.existsSync(lockFile));
      if (hangRelease) {
        openReleaseResponses.push(res);
        return;
      }
      await new Promise(r => setTimeout(r, releaseDelayMs));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, released: true }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => workerServer.listen(0, "127.0.0.1", resolve));
  const workerPort = workerServer.address().port;

  const spawnWithLogs = extraEnv => {
    const cleanEnv = { ...process.env };
    for (const k of ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "https_proxy"]) {
      delete cleanEnv[k];
    }
    const proc = spawn(process.execPath, [testScriptPath], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...cleanEnv,
        WORKER_URL: `http://127.0.0.1:${workerPort}`,
        API_SECRET: "sec",
        HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        ...extraEnv
      }
    });
    let output = "";
    const append = chunk => {
      output = (output + chunk.toString("utf8")).slice(-4000);
    };
    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);
    return { proc, getOutput: () => output.trim() };
  };

  const waitUntilFile = async (file, proc, getOutput, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(file)) {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new Error(
          `process exited before creating ${file} (exit=${proc.exitCode}, signal=${proc.signalCode}):\n${getOutput()}`
        );
      }
      if (Date.now() > deadline) {
        throw new Error(`timeout waiting for ${file}:\n${getOutput()}`);
      }
      await new Promise(r => setTimeout(r, 20));
    }
  };

  let spawnedProc = null;
  try {
    // 场景 A：代理父进程发 IPC 软停，子进程耗时 150ms 放云锁并 process.disconnect() 迅速退出；
    //         子进程关闭前绝不可删除 .local-sync.lock
    releaseDelayMs = 150;
    releaseCalls = 0;
    lockExistsDuringRelease = [];
    const readyA = path.join(dir, "ready-a");
    const parentSigA = path.join(dir, "parent-sig-a");
    const procA = spawnWithLogs({
      LOCAL_SYNC_SHUTDOWN_TIMEOUT_MS: "6000",
      __TEST_CRAWLER_READY_FILE: readyA,
      __TEST_PARENT_SIGNAL_FILE: parentSigA
    });
    spawnedProc = procA.proc;
    await waitUntilFile(readyA, procA.proc, procA.getOutput);
    assert.equal(fs.existsSync(lockFile), true);
    const tStartA = Date.now();
    fs.writeFileSync(parentSigA, "SIGTERM");
    const exitA = await waitForExit(spawnedProc);
    const elapsedA = Date.now() - tStartA;
    spawnedProc = null;
    assert.equal(exitA, 130);
    assert.equal(releaseCalls, 1, "子进程必须执行一次 /ingest/sync-lock/release");
    assert.deepEqual(lockExistsDuringRelease, [true], "子进程释放云锁且 close 前，父进程不得删除 .local-sync.lock");
    assert.equal(fs.existsSync(lockFile), false, "子进程 close 后父进程必须清理 .local-sync.lock");
    assert.ok(elapsedA < 4000, `process.disconnect() 应使子进程迅速退出而不等待 6000ms 超时，实际=${elapsedA}ms`);

    // 场景 B：叠加信号（子进程同时收到 SIGINT 与父进程 IPC graceful-shutdown）严格幂等只释放一次云锁
    releaseDelayMs = 120;
    releaseCalls = 0;
    lockExistsDuringRelease = [];
    const readyB = path.join(dir, "ready-b");
    const parentSigB = path.join(dir, "parent-sig-b");
    const childSigB = path.join(dir, "child-sig-b");
    const procB = spawnWithLogs({
      LOCAL_SYNC_SHUTDOWN_TIMEOUT_MS: "5000",
      __TEST_CRAWLER_READY_FILE: readyB,
      __TEST_PARENT_SIGNAL_FILE: parentSigB,
      __TEST_CHILD_SIGNAL_FILE: childSigB
    });
    spawnedProc = procB.proc;
    await waitUntilFile(readyB, procB.proc, procB.getOutput);
    fs.writeFileSync(childSigB, "SIGINT");
    fs.writeFileSync(parentSigB, "SIGINT");
    const exitB = await waitForExit(spawnedProc);
    spawnedProc = null;
    assert.equal(exitB, 130);
    assert.equal(releaseCalls, 1, "叠加 SIGINT 与 IPC 必须幂等只释放一次云端锁");
    assert.equal(fs.existsSync(lockFile), false);

    // 场景 C：可注入短超时兜底（250ms），令解锁请求永久挂起以区分强杀与自然退出
    hangRelease = true;
    releaseCalls = 0;
    const readyC = path.join(dir, "ready-c");
    const parentSigC = path.join(dir, "parent-sig-c");
    const procC = spawnWithLogs({
      LOCAL_SYNC_SHUTDOWN_TIMEOUT_MS: "250",
      LOCAL_SYNC_FORCE_KILL_WAIT_MS: "1000",
      __TEST_CRAWLER_READY_FILE: readyC,
      __TEST_PARENT_SIGNAL_FILE: parentSigC
    });
    spawnedProc = procC.proc;
    await waitUntilFile(readyC, procC.proc, procC.getOutput);
    const tStartC = Date.now();
    fs.writeFileSync(parentSigC, "SIGTERM");
    const exitC = await waitForExit(spawnedProc);
    const elapsedC = Date.now() - tStartC;
    spawnedProc = null;
    assert.equal(exitC, 130);
    assert.ok(elapsedC >= 200 && elapsedC < 2000, `超时强杀应落在 200..2000ms 区间而非自然退出或长时间卡死，实际=${elapsedC}ms`);
    assert.equal(fs.existsSync(lockFile), false, "超时强杀 wait close 后必须清理 .local-sync.lock");
  } finally {
    hangRelease = false;
    for (const res of openReleaseResponses) {
      try { res.destroy(); } catch {}
    }
    if (spawnedProc && spawnedProc.exitCode === null && spawnedProc.signalCode === null) {
      spawnedProc.kill();
    }
    proxyServer.close();
    workerServer.closeAllConnections?.();
    workerServer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 4) P2-9: run-comment-repair startLocalWorker detached 与 stopLocalWorker 非 Windows 进程组停机
  assert.match(repairCommentsSrc, /detached:\s*process\.platform !== "win32"/);
  const stopCalls = [];
  let failGroupKill = false;
  const stopSrc = extractFunction(repairCommentsSrc, "stopLocalWorker");
  const stopCtx = vm.createContext({
    execFileSync: () => {},
    process: {
      platform: "linux",
      kill: (pid, sig) => {
        stopCalls.push({ kind: "process.kill", pid, sig });
        if (failGroupKill) throw new Error("ESRCH");
      }
    }
  });
  vm.runInContext(`${stopSrc}\nglobalThis.__stop = stopLocalWorker;`, stopCtx);

  const procMock = {
    pid: 4321,
    kill: sig => stopCalls.push({ kind: "proc.kill", pid: 4321, sig })
  };
  stopCtx.__stop(procMock);
  assert.deepEqual(Array.from(stopCalls), [{ kind: "process.kill", pid: -4321, sig: "SIGTERM" }]);

  stopCalls.length = 0;
  failGroupKill = true;
  stopCtx.__stop(procMock);
  assert.deepEqual(Array.from(stopCalls), [
    { kind: "process.kill", pid: -4321, sig: "SIGTERM" },
    { kind: "proc.kill", pid: 4321, sig: "SIGTERM" }
  ]);
});

// ---------- M1 / M2 / M3 / M4 / M8 / M9 / M15 回归测试 ----------

test("[M1] crawler 中止停写、排空在途写入后再放锁，并在途挂死时不提前释锁", async () => {
  const crawlerSrc = readScript("apps/apify-crawler/src/main.ts").replace(/\r\n/g, "\n");
  // Actor.on("aborting") 必须 await stopWorkAndReleaseSyncLock() 且绝不调 process.exit(130)
  assert.match(crawlerSrc, /Actor\.on\("aborting",\s*async \(\) => \{\s*await stopWorkAndReleaseSyncLock\(\);\s*\}\);/);
  assert.match(crawlerSrc, /stopWorkAndReleaseSyncLock\(\)\.finally\(\(\) => \{\s*process\.exit\(130\);\s*\}\);/);

  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const crawlerRequire = createRequire(path.join(ROOT, "apps", "apify-crawler", "package.json"));
  const tsMod = await import(pathToFileURL(crawlerRequire.resolve("typescript")).href);
  const ts = tsMod.default ?? tsMod;
  const crawlerJs = ts.transpileModule(crawlerSrc, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;

  const fnCode = [
    extractFunction(crawlerJs, "sanitizeErrorForLog"),
    "async " + extractFunction(crawlerJs, "releaseSyncLockBeforeExit"),
    extractFunction(crawlerJs, "waitForInFlightIngestWrites"),
    "async " + extractFunction(crawlerJs, "stopWorkAndReleaseSyncLock"),
    "async " + extractFunction(crawlerJs, "post"),
    "async " + extractFunction(crawlerJs, "postCommentsByRoot")
  ].join("\n");

  const runScenario = async ({ hangInFlight }) => {
    let releaseCalls = 0;
    const writeCalls = [];
    let resolveInFlight;
    let firstWriteStarted;
    const firstWriteStartedPromise = new Promise(r => { firstWriteStarted = r; });
    const abortSignals = [];
    const ctx = vm.createContext({
      AbortController,
      AbortSignal,
      Promise,
      Set,
      Array,
      Math,
      Number,
      String,
      Error,
      setTimeout,
      clearTimeout,
      console: { log() {}, warn() {}, error() {} },
      apiUrl: "https://worker.example",
      apiSecret: "sec",
      syncOwnerId: "owner-m1",
      UNLIMITED_LOCAL_WRITES: true,
      MAX_DAILY_ESTIMATED_WRITES: 100000,
      stats: { saved: 0, failed: 0, consecutiveFailures: 0, circuitBroken: false, estimatedWrites: 0 },
      fetch: (url, init = {}) => {
        const u = String(url);
        if (u.endsWith("/ingest/sync-lock/release")) {
          releaseCalls++;
          return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
        }
        writeCalls.push(u);
        if (init.signal) abortSignals.push(init.signal);
        firstWriteStarted();
        if (hangInFlight) {
          return new Promise(() => {});
        }
        return new Promise(resolve => { resolveInFlight = resolve; });
      }
    });
    const patchedPrefix = `
      let syncLockReleasePromise = null;
      let abortRequested = false;
      const ingestAbortController = new AbortController();
      const inFlightIngestWrites = new Set();
      const INGEST_ABORT_DRAIN_TIMEOUT_MS = 40;
      const INGEST_ABORT_CANCEL_GRACE_MS = 25;
      let stopAndReleasePromise = null;
    `;
    vm.runInContext(
      `${patchedPrefix}\n${fnCode}\nglobalThis.__stop = stopWorkAndReleaseSyncLock;\nglobalThis.__post = post;\nglobalThis.__postRoots = postCommentsByRoot;\nglobalThis.__getStats = () => stats;\nglobalThis.__getAbortReq = () => abortRequested;`,
      ctx
    );

    // 发起一个在途写请求并等其进入 fetch
    const inFlightPromise = ctx.__post("/ingest/content", { pk: "answer:1" });
    await firstWriteStartedPromise;
    assert.equal(writeCalls.length, 1);

    // 触发中止协调：立即阻断新写；未结束前不得释放云锁
    const stopPromise = ctx.__stop();
    assert.equal(ctx.__getAbortReq(), true);
    assert.equal(ctx.__getStats().circuitBroken, true);
    await assert.rejects(() => ctx.__post("/ingest/content", { pk: "answer:2" }), /abort_requested/);
    const rootAborted = await ctx.__postRoots("answer:2", [], { partial: false, allRootIds: [] });
    assert.equal(rootAborted.aborted, true);
    assert.equal(writeCalls.length, 1, "中止后不得再发出任何新 fetch");
    assert.equal(releaseCalls, 0, "在途写入结束前绝不可释放云端锁");

    if (!hangInFlight) {
      resolveInFlight({
        ok: true,
        status: 200,
        json: async () => ({ created: true }),
        text: async () => ""
      });
      await inFlightPromise;
      await stopPromise;
      assert.equal(releaseCalls, 1, "全部在途写入结束后才释放 1 次云端锁");
    } else {
      await stopPromise;
      assert.equal(abortSignals.length, 1);
      assert.equal(abortSignals[0].aborted, true, "超时后必须调用 ingestAbortController.abort()");
      assert.equal(releaseCalls, 0, "仍有未确认结束的挂死写入时绝不可提前释放云端锁");
    }
  };

  await runScenario({ hangInFlight: false });
  await runScenario({ hangInFlight: true });
});

test("[M2][M3] crawler hot 模式不传 partial:false、score 回退保留在 commentSyncIncomplete、syncHotCommentsForContent 空页二次确认", async () => {
  const crawlerSrc = readScript("apps/apify-crawler/src/main.ts").replace(/\r\n/g, "\n");
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const crawlerRequire = createRequire(path.join(ROOT, "apps", "apify-crawler", "package.json"));
  const tsMod = await import(pathToFileURL(crawlerRequire.resolve("typescript")).href);
  const ts = tsMod.default ?? tsMod;
  const crawlerJs = ts.transpileModule(crawlerSrc, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;

  const fnCode = [
    extractFunction(crawlerJs, "pickCommentImageUrl"),
    extractFunction(crawlerJs, "normalizeCommentImage"),
    extractFunction(crawlerJs, "toChildComment"),
    extractFunction(crawlerJs, "toRootCommentGroup"),
    "async " + extractFunction(crawlerJs, "runScraperBody"),
    "async " + extractFunction(crawlerJs.replace("export async function syncHotCommentsForContent(", "async function syncHotCommentsForContent("), "syncHotCommentsForContent")
  ].join("\n");

  const makeRoots = (prefix, count, startIdx = 0) =>
    Array.from({ length: count }, (_, idx) => {
      const n = startIdx + idx;
      return {
        id: `${prefix}-${n}`,
        content: `comment ${n}`,
        author: { name: `U${n}`, avatar_url: "" },
        vote_count: n,
        child_comment_count: 0,
        child_comments: []
      };
    });

  let zhihuHandler;
  let postRootCalls = [];
  let postRootAborted = false;
  let incompleteSet = new Set();
  const makeStats = () => ({
    saved: 0, failed: 0, authRejected: 0, riskEmpty: 0, zhihuRejected: 0,
    riskFailStreak: 0, riskExhausted: false, riskPaused: false, riskPauseMs: 0,
    consecutiveFailures: 0, circuitBroken: false, estimatedWrites: 0
  });
  const sandbox = {
    URL,
    Set,
    Map,
    Array,
    Number,
    String,
    Boolean,
    Math,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    MAX_COMMENT_PAGES: 200,
    ZHIHU_USERNAME: "tester",
    isFast: false,
    cfg: { commentsMyAnswers: "full", commentsCollections: "full", commentsUpvotes: "full", commentsFollowing: "full" },
    stats: makeStats(),
    get commentSyncIncomplete() { return incompleteSet; },
    jitterSleep: async () => {},
    createStealthContext: async () => ({ addCookies: async () => {} }),
    getCookiesArray: () => [],
    fetchAnswerTrueStats: async () => null,
    resolveAnswerQuestionMeta: (q, id) => ({ sourceUrl: `https://www.zhihu.com/question/1/answer/${id}`, question: q }),
    cleanHtml: s => String(s || ""),
    toIsoOrNull: () => "2026-01-01T00:00:00.000Z",
    sendContent: async () => ({ created: false, changed: false, prevCommentCount: 0 }),
    shouldSyncCommentsDeep: async () => true,
    sanitizeErrorForLog: e => String(e?.message || e),
    zhihuJson: async (ctx, url, opts) => zhihuHandler(ctx, url, opts),
    postCommentsByRoot: async (contentPk, roots, opts = {}) => {
      postRootCalls.push({ contentPk, count: roots.length, opts });
      return { batches: 1, roots: roots.length, children: 0, aborted: postRootAborted };
    }
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(`${fnCode}\nglobalThis.__run = runScraperBody;\nglobalThis.__syncHot = syncHotCommentsForContent;`, ctx);

  // 1) M2: hot 模式在 runScraperBody 下即使根评论不足 1 页，绝不提交 partial: false
  postRootCalls = [];
  incompleteSet = new Set();
  sandbox.cfg.commentsMyAnswers = "hot";
  sandbox.stats = makeStats();
  zhihuHandler = async (_c, url) => {
    if (url.includes("/members/tester/answers")) {
      return {
        json: {
          data: [{ id: "ans-hot", type: "answer", comment_count: 5, content: "<p>body</p>", question: { id: 1, title: "Q" } }],
          paging: { is_end: true }
        }
      };
    }
    return { json: { data: makeRoots("hot", 2), paging: { is_end: true } } };
  };
  await ctx.__run({});
  assert.equal(postRootCalls.length, 1);
  assert.equal(postRootCalls[0].opts.partial, true, "hot 模式绝不允许提交 partial: false");

  // 2) M2: full 模式 score 回退抓满 200 根后，两条链路都必须把 contentPk 保留在 commentSyncIncomplete
  sandbox.cfg.commentsMyAnswers = "full";
  postRootCalls = [];
  incompleteSet = new Set();
  sandbox.stats = makeStats();
  zhihuHandler = async (_c, url) => {
    if (url.includes("/members/tester/answers")) {
      return {
        json: {
          data: [{ id: "ans-score-200", type: "answer", comment_count: 300, content: "<p>body</p>", question: { id: 1, title: "Q" } }],
          paging: { is_end: true }
        }
      };
    }
    if (url.includes("order_by=ts")) return { json: { data: [], paging: { is_end: false } } };
    const pageIdx = Number(new URL(url).searchParams.get("offset") || "0");
    return {
      json: {
        data: makeRoots("s", 20, pageIdx * 20),
        paging: pageIdx + 1 < 10
          ? { is_end: false, next: `https://www.zhihu.com/api/v4/comment_v5/answers/ans-score-200/root_comment?order_by=score&limit=20&offset=${pageIdx + 1}` }
          : { is_end: true }
      }
    };
  };
  await ctx.__run({});
  assert.equal(incompleteSet.has("answer:ans-score-200"), true, "runScraperBody score 回退必须保留在 commentSyncIncomplete");

  incompleteSet = new Set();
  const hotScoreOutcome = await ctx.__syncHot({}, "article", "art-score-200", "full");
  assert.equal(hotScoreOutcome, "failed");
  assert.equal(incompleteSet.has("article:art-score-200"), true, "syncHotCommentsForContent score 回退必须保留在 commentSyncIncomplete");

  // 3) M3: syncHotCommentsForContent full 模式首页空页二次确认（非 0 预期或未知预期时）
  postRootCalls = [];
  incompleteSet = new Set();
  let emptyCalls = 0;
  zhihuHandler = async () => {
    emptyCalls++;
    if (emptyCalls === 1) return { json: { data: [], paging: { is_end: true } } };
    return { json: { data: makeRoots("rec", 1), paging: { is_end: true } } };
  };
  const failConfirmRes = await ctx.__syncHot({}, "answer", "ans-empty-fail", "full");
  assert.equal(failConfirmRes, "failed");
  assert.equal(emptyCalls, 2);
  assert.equal(postRootCalls.length, 0, "二次确认未通过绝不得清零");
  assert.equal(incompleteSet.has("answer:ans-empty-fail"), true);

  // 确认两次均空，但 postCommentsByRoot 返回 aborted=true 时必须标 failed
  postRootCalls = [];
  incompleteSet = new Set();
  emptyCalls = 0;
  postRootAborted = true;
  zhihuHandler = async () => {
    emptyCalls++;
    return { json: { data: [], paging: { is_end: true } } };
  };
  const abortedEmptyRes = await ctx.__syncHot({}, "answer", "ans-empty-aborted", "full");
  assert.equal(abortedEmptyRes, "failed");
  assert.equal(emptyCalls, 2);
  assert.equal(postRootCalls.length, 1);
  assert.equal(incompleteSet.has("answer:ans-empty-aborted"), true);

  // 明确传入 expectedCommentCount = 0 时免二次确认直接清零
  postRootCalls = [];
  incompleteSet = new Set();
  emptyCalls = 0;
  postRootAborted = false;
  const zeroExpectedRes = await ctx.__syncHot({}, "answer", "ans-empty-zero", "full", 0);
  assert.equal(zeroExpectedRes, "ok");
  assert.equal(emptyCalls, 1);
  assert.equal(postRootCalls.length, 1);
  assert.deepEqual(Array.from(postRootCalls[0].opts.allRootIds), []);
});

test("[M4] repair-local-images 在服务端钳制 limit=12 时连续消费 25 条图片任务直至清空", async () => {
  const http = await import("node:http");
  let remainingTasks = 25;
  const batchSizesClaimed = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/ingest/image-batch") {
      let bodyText = "";
      for await (const chunk of req) bodyText += chunk;
      const body = JSON.parse(bodyText || "{}");
      const effectiveLimit = Math.min(Number(body.limit) || 6, 12);
      const claimed = Math.min(effectiveLimit, remainingTasks);
      remainingTasks -= claimed;
      batchSizesClaimed.push(claimed);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ claimed, done: claimed, failed: 0, retry: 0, limit: effectiveLimit }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const fnCode = [
      extractFunction(repairImagesSrc, "normalizeBatchResult"),
      "async " + extractFunction(repairImagesSrc, "consumeImageBatches")
    ].join("\n");
    const ctx = vm.createContext({
      opts: { imageBatchSize: 20, imageMaxBatches: 0 },
      IMAGE_BATCH_TIMEOUT_MS: 5000,
      log() {},
      localRequest: async (pathname, init) => {
        const res = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
        const json = await res.json();
        return { res, json };
      }
    });
    vm.runInContext(`${fnCode}\nglobalThis.__consume = consumeImageBatches;`, ctx);
    await ctx.__consume({ value: "sec" });
    assert.equal(remainingTasks, 0, "25 条待消费任务必须在连续批中全部消费完");
    assert.deepEqual(batchSizesClaimed, [12, 12, 1, 0], "服务端钳制 12 时不应因 12 < 20 而早停");
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test("[M8][M9][M15] local-sync 代理透传与双向强杀等待、run-comment-repair 启动期清理与 SIGHUP、full-local-harvest 清 signal", async () => {
  // M8: local-sync 两处无条件 NODE_USE_ENV_PROXY=1 且 !isProxyParent 超时同样 SIGKILL + forceKillTimer
  assert.match(localSyncSrc, /\.\.\.\(process\.env\.HTTPS_PROXY \? \{ NODE_USE_ENV_PROXY: "1" \} : \{\}\),/);
  assert.match(localSyncSrc, /const hasHttpsProxy = Boolean\(process\.env\.HTTPS_PROXY\);[\s\S]{0,400}NODE_USE_ENV_PROXY: hasHttpsProxy \? "1" : \(process\.env\.NODE_USE_ENV_PROXY \|\| ""\),/);
  assert.doesNotMatch(localSyncSrc, /if \(isProxyParent\) \{\s*try \{ childToStop\.kill\("SIGKILL"\)/);
  assert.match(localSyncSrc, /try \{ childToStop\.kill\("SIGKILL"\); \} catch \{ \/\* ignore \*\/ \}\s*forceKillTimer = setTimeout/);

  // M9: run-comment-repair 启动中登记 startingWorkerProc 并在失败/信号时停进程组，非 Windows 监听并解绑 SIGHUP
  const repairCommentsSrc = readScript("scripts/run-comment-repair.mjs");
  assert.match(repairCommentsSrc, /if \(process\.platform !== "win32"\) process\.once\("SIGHUP", handleSignal\)/);
  assert.match(repairCommentsSrc, /if \(process\.platform !== "win32"\) process\.off\("SIGHUP", handleSignal\)/);
  assert.match(repairCommentsSrc, /if \(startingWorkerProc\)/);

  const spawnedProcs = [];
  const stoppedProcs = [];
  const startWorkerSrc = extractFunction(repairCommentsSrc, "startLocalWorker");
  const repairCtx = vm.createContext({
    WORKER_DIR: ".",
    WRANGLER_BIN: "wrangler",
    process: { execPath: "node", platform: "linux" },
    spawn: () => {
      const p = { pid: 5566, on() {}, stderr: { on() {} } };
      spawnedProcs.push(p);
      return p;
    },
    stopLocalWorker: p => stoppedProcs.push(p),
    fetch: async () => { throw new Error("boot fail"); },
    sleep: async () => {},
    Date: { now: (() => { let t = 0; return () => (t += 65_000); })() }
  });
  vm.runInContext(`async ${startWorkerSrc}\nglobalThis.__start = startLocalWorker;`, repairCtx);
  let recordedSpawn = null;
  await assert.rejects(
    () => repairCtx.__start(18787, proc => { recordedSpawn = proc; }),
    /启动失败/
  );
  assert.equal(recordedSpawn, spawnedProcs[0], "spawn 后必须立即通过回调登记 proc");
  assert.equal(stoppedProcs[0], spawnedProcs[0], "启动失败时必须调用 stopLocalWorker 清理 proc");

  // M15: full-local-harvest 模板、resetProgress 与 runStageWithCooldown 均置 entry.signal = null
  const stageConst = /const STAGES = \[[\s\S]*?\n\];/.exec(harvestSrc)[0];
  const policyConst = /const GOLDEN_POLICY = Object\.freeze\(\{[\s\S]*?\}\);/.exec(harvestSrc)[0];
  const harvestPure = loadPureFunctions(
    harvestSrc,
    ["emptyProgress", "resetProgress"],
    `const LOCAL_WORKER_URL = "http://127.0.0.1:18787";\nfunction writeProgress() {}\n${stageConst}\n${policyConst}`
  );
  const prog = harvestPure.emptyProgress();
  for (const id of Object.keys(prog.stages)) {
    assert.equal(prog.stages[id].signal, null, `emptyProgress stages.${id}.signal 必须为 null`);
    prog.stages[id].signal = "SIGTERM";
  }
  harvestPure.resetProgress(prog);
  for (const id of Object.keys(prog.stages)) {
    assert.equal(prog.stages[id].signal, null, `resetProgress 必须清零 stages.${id}.signal`);
  }
  assert.match(harvestSrc, /entry\.exitCode = null;\s*entry\.signal = null;/);
});
