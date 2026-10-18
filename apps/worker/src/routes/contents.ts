import { Hono } from "hono";
import { getContentDetail, listContents } from "../services/contents.js";
import { listComments } from "../services/comments.js";
import type { Bindings } from "../types.js";

export const contentRoutes = new Hono<{ Bindings: Bindings }>();

contentRoutes.get("/", async c => {
  const type = c.req.query("type");
  const q = c.req.query("q");
  const author = c.req.query("author");
  const page = parseInt(c.req.query("page") || "1", 10);
  const { rows, total } = await listContents({ type, q, author, page });
  return c.json({ data: rows, total });
});

contentRoutes.get("/:pk", async c => {
  const pk = c.req.param("pk");
  const detail = await getContentDetail(pk);
  if (detail && detail.content) {
    if (c.env.BUCKET) {
      // 新 key 带 content_hash（旧版本不会被覆盖）；读不到就回落旧 key，兼容历史数据
      const hash = detail.content.content_hash;
      let htmlObj = hash ? await c.env.BUCKET.get(`html/${pk}/${hash}`) : null;
      if (!htmlObj) htmlObj = await c.env.BUCKET.get(`html/${pk}`);
      if (htmlObj) detail.content.content_html = await htmlObj.text();

      let mdObj = hash ? await c.env.BUCKET.get(`md/${pk}/${hash}`) : null;
      if (!mdObj) mdObj = await c.env.BUCKET.get(`md/${pk}`);
      if (mdObj) detail.content.content_md = await mdObj.text();
    }
  }
  return c.json(detail);
});

contentRoutes.get("/:pk/comments", async c => {
  const pk = c.req.param("pk");
  return c.json({ data: await listComments(pk) });
});

// 注意：原来的 /:pk/sync-live 与 /:pk/sync-comments-live 已删除。
// 原因：前端已不再调用；Cloudflare 的出站 IP 抓知乎基本会被风控；
// 留着只是多两个带 cookie 出站的攻击面。抓取统一由 Apify 负责。
