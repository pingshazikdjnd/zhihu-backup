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
async function runAndRecord(c: any, jobType: string, runType: string, isFast: boolean) {
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
