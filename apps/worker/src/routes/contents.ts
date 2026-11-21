import { Hono } from "hono";
import { getContentDetail, listContents } from "../services/contents.js";
import { getChildComments, listComments, listRootComments } from "../services/comments.js";
import {
  listReadableContentOffloadTargets,
  readOffloadedContentHtml,
  type ExternalStorageTarget
} from "./auth.js";
import { getR2TextWithEdgeCache } from "../utils/r2-cache.js";
import type { Bindings } from "../types.js";

export const contentRoutes = new Hono<{ Bindings: Bindings }>();

/**
 * 主 R2 未命中时，从外部扩容库透明回读正文 HTML。
 * 正文被 offload 到 Turso / 跨账号 D1 的 content_blobs 或外部 S3 时，详情页依然无感可读。
 */
async function readOffloadedHtml(
  pk: string,
  hash: string | null | undefined,
  bucket: any
): Promise<string | null> {
  if (!bucket) return null;
  let targets: ExternalStorageTarget[] = [];
  try {
    targets = await listReadableContentOffloadTargets(bucket);
  } catch {
    return null;
  }
  for (const target of targets) {
    const html = await readOffloadedContentHtml(target, pk, hash || undefined).catch(() => null);
    if (html) return html;
  }
  return null;
}

contentRoutes.get("/", async c => {
  const type = c.req.query("type");
  const q = c.req.query("q");
  const mine = c.req.query("mine");
  const isMine = mine === "1" || mine === "true";
  let author = c.req.query("author");
  if (!author && isMine) {
    let owner = (c.env.ZHIHU_USERNAME || "").trim();
    if (!owner && c.env.DB) {
      try {
        const row = await c.env.DB.prepare(
          `SELECT value FROM app_settings WHERE key = 'zhihu_username'`
        ).first<{ value?: string }>();
        owner = String(row?.value || "").trim();
      } catch { /* ignore */ }
    }
    // 未配置 ZHIHU_USERNAME 时传哨兵作者名，绝不退化成全量返回他人内容
    author = owner || "__unconfigured_owner__";
  }
  const sort = c.req.query("sort");
  const page = parseInt(c.req.query("page") || "1", 10);
  const { rows, total } = await listContents({ type, q, author, sort, page });
  return c.json({ data: rows, total });
});

contentRoutes.get("/:pk", async c => {
  const pk = c.req.param("pk");
  const detail = await getContentDetail(pk);
  if (detail && detail.content) {
    // 新 key 带 content_hash（旧版本不会被覆盖）；读不到就回落旧 key，兼容历史数据
    const hash = detail.content.content_hash as string | null | undefined;
    let htmlFound = false;

    if (c.env.BUCKET) {
      // 带 content_hash 的正文对象不可变：边缘缓存一年（immutable）
      const hashedHtml = hash
        ? await getR2TextWithEdgeCache(c.env.BUCKET, `html/${pk}/${hash}`, { immutable: true })
        : null;
      if (hashedHtml !== null) {
        detail.content.content_html = hashedHtml;
        htmlFound = true;
      }
    }

    // 主 R2 新 key 未命中时先查外部扩容库（content_blobs / 外部 S3），避免主 R2 旧 key html/{pk} 遮蔽新版 offload 正文
    if (!htmlFound) {
      const remoteHtml = await readOffloadedHtml(pk, hash, c.env.BUCKET);
      if (remoteHtml) {
        detail.content.content_html = remoteHtml;
        htmlFound = true;
      }
    }

    // 外部扩容库仍未命中时再回落主 R2 旧 key html/{pk}（兼容历史未加 hash 数据）
    if (!htmlFound && c.env.BUCKET) {
      const legacyHtml = await getR2TextWithEdgeCache(c.env.BUCKET, `html/${pk}`, { ttlSeconds: 3600 });
      if (legacyHtml !== null) {
        detail.content.content_html = legacyHtml;
        htmlFound = true;
      }
    }

    // 详情页渲染只用 HTML：HTML 命中时 md/ 读取必然 miss（旧通道从不写 md/），
    // 跳过可以省掉 2 次 R2 Class B 读取
    if (!htmlFound && c.env.BUCKET) {
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

// 根评论分页（热度序）。子评论按需从 R2 读取，不再随根列表一次性返回。
// 传 BUCKET 让 service 能在主 D1 为空时透明回源外部扩容库。
contentRoutes.get("/:pk/root-comments", async c => {
  const pk = c.req.param("pk");
  const limit = parseInt(c.req.query("limit") || "20", 10);
  const offset = parseInt(c.req.query("offset") || "0", 10);
  const liveOnlyParam = (c.req.query("live_only") || "").trim().toLowerCase();
  const liveOnly = liveOnlyParam === "1" || liveOnlyParam === "true";
  const data = await listRootComments(c.env.DB, pk, { limit, offset, liveOnly }, c.env.BUCKET);
  return c.json({
    data,
    limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 20,
    offset: Number.isFinite(offset) ? Math.max(offset, 0) : 0
  });
});

// 点「展开 N 条回复」时读取某个根评论下的子评论。
// 读取顺序：主 R2 → 外部扩容库（楼中楼 JSON / 子评论行）→ 主 D1 历史数据。
contentRoutes.get("/:pk/comments/:rootId/children", async c => {
  const rootId = c.req.param("rootId");
  // 楼中楼的更新由 /ingest/comments-by-root 写 R2 后立即 purge 边缘缓存；
  // 这里 30s 的短缓存只吸收「展开/收起」抖动与并发重复点击。
  c.header("Cache-Control", "public, max-age=30, stale-while-revalidate=300");
  return c.json({ data: await getChildComments(c.env.BUCKET, rootId, c.env.DB) });
});

// 注意：原来的 /:pk/sync-live 与 /:pk/sync-comments-live 已删除。
// 原因：前端已不再调用；Cloudflare 的出站 IP 抓知乎基本会被风控；
// 留着只是多两个带 cookie 出站的攻击面。抓取统一由 Apify 负责。
