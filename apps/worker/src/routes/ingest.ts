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
import {
  getFollowedUsersMap,
  updateFollowedUserProgress,
  upsertFollowedUsersSnapshot
} from "../services/following.js";
import { getSyncConfig } from "./auth.js";
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
    // R2 的 put 是 Class A 且不比对内容：同一 key 同字节也会计费。
    // key 已带 content_hash（正文一变 key 就变），所以只要对象已存在就无需重写。
    // 不能只用 created/changed 判断：D1 写成功但 R2 put 失败时，下一轮 changed=false
    // 会让正文永久缺失；这里用 HEAD 兜底，miss 即补写。
    const putIfAbsent = async (key: string, body: string, contentType: string, kind: string) => {
      if (!result.created) {
        const existing = await c.env.BUCKET.head(key).catch(() => null);
        if (existing) return false;
      }
      await c.env.BUCKET.put(key, body, {
        httpMetadata: { contentType },
        customMetadata: { pk, kind }
      });
      return true;
    };

    if (htmlToStore) {
      // versions/ 前缀全仓库无任何读取，且与 html/ 同字节双写，已删除
      await putIfAbsent(`html/${pk}/${result.hash}`, htmlToStore, "text/html; charset=utf-8", "html");
    }
    if (mdToStore) {
      await putIfAbsent(`md/${pk}/${result.hash}`, mdToStore, "text/plain; charset=utf-8", "md");
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
  const followedMap = await getFollowedUsersMap(c.env.BUCKET);
  const fullModeUsers = Object.values(followedMap)
    .filter(u => !u.is_unfollowed && u.sync_mode === "full")
    .map(u => u.url_token);
  const followedProgress: Record<string, { resumeOffset: number; historyDone: boolean; syncMode: "default" | "full"; lastCheckedAnswerId?: string }> = {};
  for (const u of Object.values(followedMap)) {
    if (u.is_unfollowed) continue;
    followedProgress[u.url_token] = {
      resumeOffset: u.resume_offset ?? 0,
      historyDone: Boolean(u.history_done),
      syncMode: u.sync_mode === "full" ? "full" : "default",
      lastCheckedAnswerId: u.last_checked_answer_id || ""
    };
  }
  const syncConfig = await getSyncConfig(c.env.BUCKET);
  return c.json({
    upvotesCursor: map["upvotes_cursor"] || null,
    cookieString: map["zhihu_cookie"] || c.env.ZHIHU_COOKIE_STRING || fallbackZc0 || null,
    zhihuUsername: c.env.ZHIHU_USERNAME || null,
    fullModeUsers,
    followedProgress,
    syncConfig
  });
});

ingestRoutes.post("/followed-user-progress", async c => {
  const body = await c.req.json().catch(() => null) as {
    urlToken?: unknown;
    resumeOffset?: unknown;
    historyDone?: unknown;
    lastCheckedAnswerId?: unknown;
  } | null;
  if (!body || typeof body.urlToken !== "string" || !body.urlToken) {
    return c.json({ error: "urlToken is required" }, 400);
  }
  const res = await updateFollowedUserProgress(c.env.BUCKET, body.urlToken, {
    resumeOffset: Number(body.resumeOffset) || 0,
    historyDone: Boolean(body.historyDone),
    lastCheckedAnswerId: typeof body.lastCheckedAnswerId === "string" ? body.lastCheckedAnswerId : undefined
  });
  return c.json(res);
});

ingestRoutes.post("/followed-users", async c => {
  const body = await c.req.json().catch(() => null) as {
    users?: unknown;
    incremental?: boolean;
  } | null;
  if (!body || !Array.isArray(body.users)) {
    return c.json({ error: "users array is required" }, 400);
  }
  const res = await upsertFollowedUsersSnapshot(
    c.env.BUCKET,
    body.users as any[],
    Boolean(body.incremental)
  );
  return c.json(res);
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
