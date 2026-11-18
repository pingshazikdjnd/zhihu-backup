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

  // 1) fetchStoredCommentState + shouldSyncCommentsDeep：0 子评论根与足够评论总量不反复重抓
  assert.match(crawlerSrc, /Number\(row\.child_count\) > 0 && Number\(row\.is_complete \?\? 0\) !== 1/);
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
