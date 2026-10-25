import { Hono } from "hono";
import { db } from "../db.js";
import { triggerApifyRun } from "../services/apify.js";
import { requireSecret } from "../middleware/require-secret.js";
import type { Bindings } from "../types.js";

export const syncRoutes = new Hono<{ Bindings: Bindings }>();

// 这三个接口会触发 Apify run（真金白银），必须鉴权
syncRoutes.use("*", requireSecret);

/**
 * 记录一次同步尝试，并在触发后立即把结果写回。
 * 之前只插入 status='running' 就再不更新，列表里永远是 running。
 */
/**
 * 防重入锁：cron 与手动触发重叠会并发起两个 Actor run，
 * 同 pk 的评论对账互相看不见对方刚插入的行，产生批量假删除事件。
 * 锁 TTL 10 分钟（一次 run 触发到跑完的量级），过期自动放行。
 */
async function acquireSyncLock(): Promise<boolean> {
  const TTL_MS = 10 * 60_000;
  const now = new Date().toISOString();
  try {
    const row = await db.prepare(
      `SELECT updated_at FROM app_settings WHERE key = 'sync_lock'`
    ).get() as { updated_at: string } | undefined;
    if (row?.updated_at) {
      const age = Date.now() - Date.parse(row.updated_at);
      if (Number.isFinite(age) && age >= 0 && age < TTL_MS) return false;
    }
    await db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES ('sync_lock', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(Date.now().toString(), now);
    return true;
  } catch {
    // app_settings 表不存在（migration 未 apply）时不挡同步
    return true;
  }
}

async function runAndRecord(c: any, jobType: string, runType: string, isFast: boolean) {
  const lockAcquired = await acquireSyncLock();
  if (!lockAcquired) {
    return { ok: false, error: "已有同步在进行中（10 分钟内重复触发被拒绝）" };
  }

  const now = new Date().toISOString();

  const insert = await db.prepare(`
    INSERT INTO sync_runs (job_type, status, message, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(jobType, "running", "Triggered Apify", now, null);

  const runId = (insert as any)?.meta?.last_row_id;

  // 触发请求本身可能抛网络异常；不兜住的话 sync_runs 会永远停在 running
  let res: { ok: boolean; runId?: string; error?: string };
  try {
    res = await triggerApifyRun(c.env, runType, isFast);
  } catch (e: any) {
    res = { ok: false, error: `trigger failed: ${e?.message || String(e)}` };
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
  const res = await runAndRecord(c, "manual", "all", false);
  return c.json({
    ok: res.ok,
    note: res.ok ? `Apify job started: ${res.runId}` : res.error
  }, (res.ok ? 200 : 502) as any);
});

syncRoutes.post("/fast", async c => {
  const target = c.req.query("target") || "all";
  const res = await runAndRecord(c, `fast:${target}`, target, true);
  return c.json({
    success: res.ok,
    message: res.ok ? "Fast sync triggered via Apify" : res.error
  }, (res.ok ? 200 : 502) as any);
});

syncRoutes.post("/full", async c => {
  const target = c.req.query("target") || "all";
  const res = await runAndRecord(c, `full:${target}`, target, false);
  return c.json({
    success: res.ok,
    message: res.ok ? "Full sync triggered via Apify" : res.error
  }, (res.ok ? 200 : 502) as any);
});
