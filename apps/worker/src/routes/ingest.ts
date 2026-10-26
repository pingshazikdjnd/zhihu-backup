import { Hono } from "hono";
import {
  IngestCollectionSnapshotSchema,
  IngestCommentsSchema,
  IngestContentSchema
} from "shared";
import { upsertContent } from "../services/contents.js";
import { replaceComments } from "../services/comments.js";
import { upsertCollectionSnapshot } from "../services/collections.js";
import { upsertUpvote } from "../services/upvotes.js";
import { requireSecret } from "../middleware/require-secret.js";
import { db } from "../db.js";
import type { Bindings } from "../types.js";

export const ingestRoutes = new Hono<{ Bindings: Bindings }>();

// 写接口统一鉴权（fail-closed），详见 middleware/require-secret.ts
ingestRoutes.use("*", requireSecret);

ingestRoutes.post("/content", async c => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "invalid json" }, 400);

  const parsed = IngestContentSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const pk = `${parsed.data.sourceType}:${parsed.data.sourceId}`;

  // 提前取副本：service 层不保证不改动入参，R2 必须写原始正文。
  const htmlToStore = parsed.data.contentHtml || "";
  const mdToStore = parsed.data.contentMd || "";

  // R2 未绑定时不能静默跳过：D1 里 content_html 是空串，正文会永久丢失。
  if ((htmlToStore || mdToStore) && !c.env.BUCKET) {
    return c.json({ error: "R2 bucket not bound; refusing to drop content" }, 503);
  }

  // 先写库（幂等），成功后再写 R2，避免「R2 已是新正文、D1 还是旧 hash」
  const result = await upsertContent(parsed.data);

  if (c.env.BUCKET) {
    if (htmlToStore) {
      // key 带 content_hash：同一篇内容多次更新时旧版本不会被覆盖
      await c.env.BUCKET.put(`html/${pk}/${result.hash}`, htmlToStore, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        customMetadata: { pk }
      });
      // 版本快照单独存一份，D1 的 content_versions 只留 hash + 元数据
      await c.env.BUCKET.put(`versions/${pk}/${result.hash}`, htmlToStore, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        customMetadata: { pk, kind: "version" }
      });
    }
    if (mdToStore) {
      await c.env.BUCKET.put(`md/${pk}/${result.hash}`, mdToStore, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
        customMetadata: { pk }
      });
    }
  }

  return c.json(result);
});

ingestRoutes.post("/comments", async c => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "invalid json" }, 400);

  const parsed = IngestCommentsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  // comments 有外键约束：悬空 contentPk 会在 batch 阶段撞外键变 500，
  // 提前查存在性给个明确的 404（对齐 /ingest/upvote 的做法）
  const contentExists = await db.prepare(`SELECT 1 FROM contents WHERE pk = ?`).get(parsed.data.contentPk);
  if (!contentExists) {
    return c.json({ error: `content not found: ${parsed.data.contentPk}` }, 404);
  }
  const result = await replaceComments(parsed.data);
  return c.json(result);
});

ingestRoutes.post("/collection-snapshot", async c => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "invalid json" }, 400);

  const parsed = IngestCollectionSnapshotSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const result = await upsertCollectionSnapshot(parsed.data);
  return c.json(result);
});

ingestRoutes.post("/upvote", async c => {
  const body = await c.req.json().catch(() => null) as { contentPk?: unknown; upvoteTime?: unknown } | null;
  if (!body) return c.json({ error: "invalid json" }, 400);
  if (typeof body.contentPk !== "string" || !body.contentPk) {
    return c.json({ error: "contentPk is required" }, 400);
  }
  if (typeof body.upvoteTime !== "string" || !body.upvoteTime) {
    return c.json({ error: "upvoteTime is required" }, 400);
  }
  const result = await upsertUpvote(body.contentPk, body.upvoteTime);
  return c.json({ success: true, ...result });
});

ingestRoutes.get("/sync-state", async c => {
  // 供本地同步脚本拉取线上最新断点游标与网页端更新的 cookie（受 requireSecret 保护）
  const rows = await db.prepare(
    `SELECT key, value, updated_at FROM app_settings WHERE key IN ('upvotes_cursor', 'zhihu_cookie')`
  ).all<{ key: string; value: string; updated_at: string }>();
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  const fallbackZc0 = c.env.ZHIHU_COOKIE_Z_C0
    ? (c.env.ZHIHU_COOKIE_Z_C0.includes("=") ? c.env.ZHIHU_COOKIE_Z_C0 : `z_c0=${c.env.ZHIHU_COOKIE_Z_C0}`)
    : null;
  return c.json({
    upvotesCursor: map["upvotes_cursor"] || null,
    cookieString: map["zhihu_cookie"] || c.env.ZHIHU_COOKIE_STRING || fallbackZc0 || null,
    zhihuUsername: c.env.ZHIHU_USERNAME || null
  });
});

ingestRoutes.post("/sync-state", async c => {
  // 爬虫的断点游标上报（赞同段每翻一页存一次"下一页游标"）。
  // 上报失败在爬虫侧被吞掉（最多下次多翻一段），这里无需重语义。
  const body = await c.req.json().catch(() => null) as { key?: unknown; value?: unknown } | null;
  const ALLOWED_KEYS = new Set(["upvotes_cursor"]);
  if (!body || typeof body.key !== "string" || !ALLOWED_KEYS.has(body.key)) {
    return c.json({ error: "invalid key" }, 400);
  }
  if (body.value === null) {
    await db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(body.key);
    return c.json({ ok: true, cleared: true });
  }
  if (typeof body.value !== "string" || !body.value.startsWith("https://")) {
    return c.json({ error: "invalid value" }, 400);
  }
  await db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(body.key, body.value, new Date().toISOString());
  return c.json({ ok: true });
});

ingestRoutes.post("/sync-all", async c => {
  // 云端不再本地拉起任务，统一走 /api/sync/full
  return c.json({ success: false, message: "Use /api/sync/full instead" }, 410 as any);
});
