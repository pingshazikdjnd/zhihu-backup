import { Hono } from "hono";
import { db } from "../db.js";

export const changeRoutes = new Hono();

changeRoutes.get("/", async c => {
  // 公开无鉴权端点：limit 必须钳制。NaN 会把绑定参数变非法（500），
  // 负数在 SQLite 里 LIMIT -1 = 无上限，一次请求就能拉全表
  const parsed = Number(c.req.query("limit") || 100);
  const limit = Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 1), 500) : 100;
  const excludeComments = c.req.query("exclude_comments") === "true";
  const onlyComments = c.req.query("only_comments") === "true";

  let query = `SELECT id, event_type, entity_type, entity_pk, content_pk, summary, created_at FROM change_events`;
  // 不返回 payload_json：评论事件会把整条原文（可到 10KB/条）存进 payload，
  // 500 条事件就是 5MB+ 的匿名响应放大面；前端也从不消费这个字段
  if (excludeComments) {
    query += ` WHERE event_type NOT LIKE 'comment.%'`;
  } else if (onlyComments) {
    query += ` WHERE event_type LIKE 'comment.%'`;
  }
  query += ` ORDER BY created_at DESC LIMIT ?`;

  const rows = await db.prepare(query).all(limit);

  return c.json({ data: rows });
});

changeRoutes.get("/sync-runs", async c => {
  const rows = await db.prepare(`
    SELECT *
    FROM sync_runs
    ORDER BY started_at DESC
    LIMIT 50
  `).all();

  return c.json({ data: rows });
});
