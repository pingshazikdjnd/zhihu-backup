import { Hono } from "hono";
import { db } from "../db.js";
import { triggerApifyRun } from "../services/apify.js";
import { requireSecret } from "../middleware/require-secret.js";
import type { Bindings } from "../types.js";

export const syncRoutes = new Hono<{ Bindings: Bindings }>();

// 这三个接口会触发 Apify run（真金白银），必须鉴权
syncRoutes.use("*", requireSecret);

/**
 * 跨手动 / Cron / 本地同步的分布式租约锁（app_settings.key = 'sync_lock'）。
 *
 * 旧实现用 SELECT updated_at + 无条件 UPSERT：两个并发请求可以同时读到「无锁」
 * 再双双写入，cron 与手动触发重叠时会起两个 Actor run；且 catch 分支直接放行。
 * 现在用单条 CAS SQL 抢锁（只有锁不存在 / 已过期 / 自己持有才更新成功），
 * value 存 {"ownerId","source","acquiredAt","expiresAt"}：
 * - 爬虫活着时每批 /ingest 请求带 x-sync-owner 自动续租；
 * - 爬虫崩溃后租约 15 分钟自然过期，无需人工清锁；
 * - 释放必须匹配 ownerId，绝不会误删别人的锁。
 */
export const SYNC_LOCK_LEASE_MS = 15 * 60 * 1000;

function lockChanges(res: any): number {
  // 真实 D1 在 meta.changes，本地 better-sqlite3 直接返回 changes
  return Number(res?.meta?.changes ?? res?.changes ?? 0);
}

function parseLockHolder(raw: string | null | undefined): any {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * 抢锁。成功返回本次租约的 ownerId（调用方必须保存并在续租/释放时回传）。
 * 失败返回当前持有者信息；SQL 异常时 fail-closed（返回 ok=false），不再静默放行。
 */
export async function acquireSyncLock(
  ownerId?: string,
  source = "manual"
): Promise<{ ok: boolean; ownerId: string; holder?: any }> {
  const owner = ownerId && ownerId.trim()
    ? ownerId.trim()
    : `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const expiresAt = new Date(now + SYNC_LOCK_LEASE_MS).toISOString();
  const value = JSON.stringify({ ownerId: owner, source, acquiredAt: nowIso, expiresAt });

  try {
    const res: any = await db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('sync_lock', ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
      -- 旧版 Worker 存的是裸 ISO 时间戳（不是合法 JSON），json_extract/json_set 会直接抛
      -- "malformed JSON" 让抢锁永久 fail-closed。json_valid = 0 必须最先短路接管，
      -- 并把所有 json_extract 都用 CASE WHEN json_valid(...) 保护起来，绝不求值非法 JSON。
      WHERE json_valid(app_settings.value) = 0
         OR CASE WHEN json_valid(app_settings.value) THEN json_extract(app_settings.value, '$.expiresAt') ELSE NULL END IS NULL
         OR CASE WHEN json_valid(app_settings.value) THEN json_extract(app_settings.value, '$.expiresAt') ELSE '' END < ?
         OR CASE WHEN json_valid(app_settings.value) THEN json_extract(app_settings.value, '$.ownerId') ELSE '' END = ?
    `).run(value, nowIso, nowIso, owner);

    if (lockChanges(res) > 0) {
      return { ok: true, ownerId: owner };
    }

    const row = await db.prepare(
      `SELECT value FROM app_settings WHERE key = 'sync_lock'`
    ).get<{ value: string }>();
    return { ok: false, ownerId: owner, holder: parseLockHolder(row?.value) };
  } catch (e) {
    // 表未就绪 / SQL 异常：fail-closed，宁可拒绝同步也不并发起两个 Actor run
    console.error("acquireSyncLock failed:", e);
    return { ok: false, ownerId: owner };
  }
}

/** 持有者续租：只有 ownerId 匹配时才刷新 expiresAt（爬虫每批 ingest 都会调用） */
export async function renewSyncLock(ownerId: string, leaseMs = SYNC_LOCK_LEASE_MS): Promise<boolean> {
  if (!ownerId) return false;
  const now = Date.now();
  try {
    const res: any = await db.prepare(`
      UPDATE app_settings
      SET value = CASE WHEN json_valid(value) THEN json_set(value, '$.expiresAt', ?) ELSE value END,
          updated_at = ?
      WHERE key = 'sync_lock'
        AND json_valid(value) = 1
        AND CASE WHEN json_valid(value) THEN json_extract(value, '$.ownerId') ELSE '' END = ?
    `).run(
      new Date(now + leaseMs).toISOString(),
      new Date(now).toISOString(),
      ownerId
    );
    return lockChanges(res) > 0;
  } catch (e) {
    console.error("renewSyncLock failed:", e);
    return false;
  }
}

/** 持有者释放：ownerId 不匹配时行数为 0，不会误删别人的锁 */
export async function releaseSyncLock(ownerId: string): Promise<boolean> {
  if (!ownerId) return false;
  try {
    const res: any = await db.prepare(`
      -- 旧版裸字符串（json_valid = 0）没有 ownerId 可比对，直接允许清除，
      -- 否则上行升级后这行畸形锁永远删不掉。合法 JSON 锁仍严格匹配 ownerId。
      DELETE FROM app_settings
      WHERE key = 'sync_lock'
        AND (
          json_valid(value) = 0
          OR CASE WHEN json_valid(value) THEN json_extract(value, '$.ownerId') ELSE '' END = ?
        )
    `).run(ownerId);
    return lockChanges(res) > 0;
  } catch (e) {
    console.error("releaseSyncLock failed:", e);
    return false;
  }
}

/**
 * 抢锁 → 触发 Apify → 记录 sync_runs。
 * 触发失败时立即释放租约，避免「触发失败却白锁 15 分钟」；
 * 触发成功后保留租约，由爬虫的 /ingest 请求持续续租。
 */
export async function runAndRecord(
  env: Bindings,
  jobType: string,
  runType: string,
  isFast: boolean
): Promise<{ ok: boolean; runId?: string; error?: string; holder?: any }> {
  const lock = await acquireSyncLock(undefined, jobType);
  if (!lock.ok) {
    return { ok: false, error: "同步任务正在进行中，请稍后再试", holder: lock.holder };
  }

  const now = new Date().toISOString();

  const insert = await db.prepare(`
    INSERT INTO sync_runs (job_type, status, message, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(jobType, "running", "Triggered Apify", now, null);

  const runId = (insert as any)?.meta?.last_row_id ?? (insert as any)?.lastInsertRowid;

  // 触发请求本身可能抛网络异常；不兜住的话 sync_runs 会永远停在 running
  let res: { ok: boolean; runId?: string; error?: string };
  try {
    res = await triggerApifyRun(env, runType, isFast, { syncOwnerId: lock.ownerId });
  } catch (e: any) {
    res = { ok: false, error: `trigger failed: ${e?.message || String(e)}` };
  }

  // 触发失败：立刻释放锁，否则 15 分钟租约内所有手动/cron 同步都会被拒
  if (!res.ok) {
    await releaseSyncLock(lock.ownerId);
  }

  try {
    if (runId !== undefined && runId !== null) {
      await db.prepare(`
        UPDATE sync_runs SET status = ?, message = ?, finished_at = ? WHERE id = ?
      `).run(
        res.ok ? "success" : "error",
        res.ok ? `apify run ${res.runId}` : (res.error ?? "unknown error"),
        new Date().toISOString(),
        runId
      );
    }
  } catch (e) {
    console.error("failed to update sync_runs", e);
  }

  return res;
}

syncRoutes.post("/", async c => {
  const res = await runAndRecord(c.env, "manual", "all", false);
  return c.json({
    ok: res.ok,
    note: res.ok ? `Apify job started: ${res.runId}` : res.error
  }, (res.ok ? 200 : 502) as any);
});

syncRoutes.post("/fast", async c => {
  const target = c.req.query("target") || "all";
  const res = await runAndRecord(c.env, `fast:${target}`, target, true);
  return c.json({
    success: res.ok,
    message: res.ok ? "Fast sync triggered via Apify" : res.error
  }, (res.ok ? 200 : 502) as any);
});

syncRoutes.post("/full", async c => {
  const target = c.req.query("target") || "all";
  const res = await runAndRecord(c.env, `full:${target}`, target, false);
  return c.json({
    success: res.ok,
    message: res.ok ? "Full sync triggered via Apify" : res.error
  }, (res.ok ? 200 : 502) as any);
});
