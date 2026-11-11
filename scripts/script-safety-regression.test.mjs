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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
