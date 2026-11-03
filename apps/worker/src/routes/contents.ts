import { Hono } from "hono";
import { getContentDetail, listContents } from "../services/contents.js";
import { getChildComments, listComments, listRootComments } from "../services/comments.js";
import type { Bindings } from "../types.js";

export const contentRoutes = new Hono<{ Bindings: Bindings }>();

contentRoutes.get("/", async c => {
  const type = c.req.query("type");
  const q = c.req.query("q");
  const author = c.req.query("author");
  const sort = c.req.query("sort");
  const page = parseInt(c.req.query("page") || "1", 10);
  const { rows, total } = await listContents({ type, q, author, sort, page });
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

      // 详情页渲染只用 HTML：HTML 命中时 md/ 读取必然 miss（旧通道从不写 md/），
      // 跳过可以省掉 2 次 R2 Class B 读取
      if (!htmlObj) {
        let mdObj = hash ? await c.env.BUCKET.get(`md/${pk}/${hash}`) : null;
        if (!mdObj) mdObj = await c.env.BUCKET.get(`md/${pk}`);
        if (mdObj) detail.content.content_md = await mdObj.text();
      }
    }
  }
  return c.json(detail);
});

contentRoutes.get("/:pk/comments", async c => {
  const pk = c.req.param("pk");
  return c.json({ data: await listComments(pk) });
});

// 根评论分页（热度序）。子评论按需从 R2 读取，不再随根列表一次性返回。
contentRoutes.get("/:pk/root-comments", async c => {
  const pk = c.req.param("pk");
  const limit = parseInt(c.req.query("limit") || "20", 10);
  const offset = parseInt(c.req.query("offset") || "0", 10);
  const data = await listRootComments(c.env.DB, pk, { limit, offset });
  return c.json({
    data,
    limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 20,
    offset: Number.isFinite(offset) ? Math.max(offset, 0) : 0
  });
});

// 点「展开 N 条回复」时读取某个根评论下的子评论。
// R2 未命中时回退读 D1（历史子评论还没搬进 R2），所以 BUCKET 缺失也照样能展开。
contentRoutes.get("/:pk/comments/:rootId/children", async c => {
  const rootId = c.req.param("rootId");
  return c.json({ data: await getChildComments(c.env.BUCKET, rootId, c.env.DB) });
});

// 注意：原来的 /:pk/sync-live 与 /:pk/sync-comments-live 已删除。
// 原因：前端已不再调用；Cloudflare 的出站 IP 抓知乎基本会被风控；
// 留着只是多两个带 cookie 出站的攻击面。抓取统一由 Apify 负责。
