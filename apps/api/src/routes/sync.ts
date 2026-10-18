import { Hono } from "hono";
import { db } from "../db.js";
// 引入 node child_process 以供手动触发采集脚本
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../../../../");

export const syncRoutes = new Hono();

syncRoutes.post("/", async c => {
  const now = new Date().toISOString();

  const result = db.prepare(`
    INSERT INTO sync_runs (job_type, status, message, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?)
  `).run("manual", "running", "Manual sync triggered", now, null);

  const runId = result.lastInsertRowid;

  // 异步拉起 collector（注意：collector 没有 sync:seed 实现，用 sync 跑回答+评论同步）
  const child = spawn("pnpm", ["sync"], {
    cwd: rootDir,
    stdio: "ignore",
    detached: true,
    shell: true
  });
  
  child.unref(); // 不阻塞主进程

  return c.json({
    ok: true,
    syncRunId: runId,
    note: "后台采集已拉起"
  });
});

syncRoutes.post("/fast", async c => {
  const target = c.req.query("target") || "all";
  const env = { ...process.env, FAST_SYNC: "true" };

  if (target === "all" || target === "upvotes") {
    spawn("pnpm", ["sync:upvotes"], { cwd: rootDir, stdio: "ignore", detached: true, shell: true, env }).unref();
  }
  if (target === "all" || target === "answers") {
    spawn("pnpm", ["sync"], { cwd: rootDir, stdio: "ignore", detached: true, shell: true, env }).unref();
  }
  if (target === "all" || target === "collections") {
    spawn("pnpm", ["collector:sync:collections"], { cwd: rootDir, stdio: "ignore", detached: true, shell: true, env }).unref();
  }

  return c.json({ success: true, message: `Fast sync tasks started for ${target}` });
});

syncRoutes.post("/full", async c => {
  const target = c.req.query("target") || "all";
  const env = { ...process.env, FAST_SYNC: "false" };

  if (target === "all" || target === "upvotes") {
    spawn("pnpm", ["sync:upvotes"], { cwd: rootDir, stdio: "ignore", detached: true, shell: true, env }).unref();
  }
  if (target === "all" || target === "answers") {
    spawn("pnpm", ["sync"], { cwd: rootDir, stdio: "ignore", detached: true, shell: true, env }).unref();
  }
  if (target === "all" || target === "collections") {
    spawn("pnpm", ["collector:sync:collections"], { cwd: rootDir, stdio: "ignore", detached: true, shell: true, env }).unref();
  }

  return c.json({ success: true, message: `Full sync tasks started for ${target}` });
});
