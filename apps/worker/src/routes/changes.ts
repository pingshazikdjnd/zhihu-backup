import { Hono } from "hono";
import { db } from "../db.js";

export const changeRoutes = new Hono();

changeRoutes.get("/", async c => {
  const limit = Number(c.req.query("limit") || 100);
  const excludeComments = c.req.query("exclude_comments") === "true";
  const onlyComments = c.req.query("only_comments") === "true";
  
  let query = `SELECT * FROM change_events`;
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
