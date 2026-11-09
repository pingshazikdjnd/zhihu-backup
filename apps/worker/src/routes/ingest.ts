import { Hono } from "hono";
import {
  IngestCollectionSnapshotSchema,
  IngestCommentsByRootSchema,
  IngestCommentsSchema,
  IngestContentSchema
} from "shared";
import { upsertContent } from "../services/contents.js";
import { replaceComments, replaceCommentsByRoot } from "../services/comments.js";
import { upsertCollectionSnapshot } from "../services/collections.js";
import { upsertUpvote } from "../services/upvotes.js";
import { processContentImages } from "../services/images.js";
import {
  getFollowedUsersMap,
  updateFollowedUserProgress,
  upsertFollowedUsersSnapshot
} from "../services/following.js";
import { getSyncConfig, getExternalTargetsRaw, resolveActiveOffloadTarget, ensureRemoteCommentSchema, putOffloadedContentHtml, supportsSyncOffload, type ExternalSyncScope } from "./auth.js";
import { acquireSyncLock, releaseSyncLock, renewSyncLock } from "./sync.js";
import { requireSecret } from "../middleware/require-secret.js";
import { db } from "../db.js";
import type { Bindings } from "../types.js";

export const ingestRoutes = new Hono<{ Bindings: Bindings }>();

async function forwardToExternalTargets(
  c: any,
  scope: ExternalSyncScope,
  eventPath: string,
  payload: unknown,
  entityKey: string
) {
  try {
    const targets = await getExternalTargetsRaw(c.env.BUCKET);
    // 只有「双写灾备」目标才需要异步镜像转发：
    // - offload / overflow 目标已在同步写路径里真正承接了数据，再转发一次就是重复写两遍；
    // - 但 supabase / webhook 等无法承接同步分流的 provider 仍保留镜像转发，避免配置失效。
    const matched = targets.filter(t => {
      if (!t.enabled || !t.syncScopes || !t.syncScopes.includes(scope)) return false;
      const role = t.storageRole || "offload";
      if (role === "mirror") return true;
      return !supportsSyncOffload(t, scope);
    });
    if (!matched.length) return;

    const now = new Date().toISOString();
    const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);

    await Promise.allSettled(
      matched.map(async t => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
          if (t.provider === "webhook") {
            const destUrl = `${t.endpointUrl.replace(/\/+$/, "")}${eventPath}`;
            await fetch(destUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(t.authToken ? { Authorization: `Bearer ${t.authToken}` } : {})
              },
              body: payloadStr,
              signal: controller.signal
            });
          } else if (t.provider === "turso") {
            const tursoUrl = `${t.endpointUrl.replace(/\/+$/, "")}/v2/pipeline`;
            await fetch(tursoUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(t.authToken ? { Authorization: `Bearer ${t.authToken}` } : {})
              },
              body: JSON.stringify({
                requests: [
                  {
                    type: "execute",
                    stmt: {
                      sql: "CREATE TABLE IF NOT EXISTS zhihu_backup_mirror (scope TEXT, entity_key TEXT, payload_json TEXT, synced_at TEXT, PRIMARY KEY (scope, entity_key))"
                    }
                  },
                  {
                    type: "execute",
                    stmt: {
                      sql: "INSERT OR REPLACE INTO zhihu_backup_mirror (scope, entity_key, payload_json, synced_at) VALUES (?, ?, ?, ?)",
                      args: [
                        { type: "text", value: String(scope) },
                        { type: "text", value: String(entityKey) },
                        { type: "text", value: payloadStr },
                        { type: "text", value: String(now) }
                      ]
                    }
                  },
                  { type: "close" }
                ]
              }),
              signal: controller.signal
            });
          } else if (t.provider === "cloudflare_d1") {
            const databaseId = t.databaseId || "";
            const parts = databaseId.includes("/") ? databaseId.split("/") : databaseId.split(":");
            const accId = parts[0]?.trim();
            const dbId = parts[1]?.trim();
            if (accId && dbId) {
              const d1Url = `https://api.cloudflare.com/client/v4/accounts/${accId}/d1/database/${dbId}/query`;
              const d1Headers = {
                "Content-Type": "application/json",
                ...(t.authToken ? { Authorization: `Bearer ${t.authToken}` } : {})
              };
              // D1 REST /query 一次只接受一条语句：建表和写入必须拆成两次请求
              await fetch(d1Url, {
                method: "POST",
                headers: d1Headers,
                body: JSON.stringify({
                  sql: `CREATE TABLE IF NOT EXISTS zhihu_backup_mirror (
                    scope TEXT,
                    entity_key TEXT,
                    payload_json TEXT,
                    synced_at TEXT,
                    PRIMARY KEY (scope, entity_key)
                  )`
                }),
                signal: controller.signal
              });
              await fetch(d1Url, {
                method: "POST",
                headers: d1Headers,
                body: JSON.stringify({
                  sql: `INSERT OR REPLACE INTO zhihu_backup_mirror (scope, entity_key, payload_json, synced_at) VALUES (?, ?, ?, ?)`,
                  params: [String(scope), String(entityKey), payloadStr, now]
                }),
                signal: controller.signal
              });
            }
          } else if (t.provider === "s3_r2") {
            // S3 兼容对象存储：path-style PUT 归档到 <endpoint>/<bucket>/<scope>/<entityKey>.json
            const bucketName = (t.databaseId || "").trim().replace(/^\/+|\/+$/g, "");
            if (!bucketName) return;
            const objectUrl = `${t.endpointUrl.replace(/\/+$/, "")}/${encodeURIComponent(bucketName)}/${encodeURIComponent(scope)}/${encodeURIComponent(entityKey)}.json`;
            await fetch(objectUrl, {
              method: "PUT",
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                ...(t.authToken ? { Authorization: `Bearer ${t.authToken}` } : {})
              },
              body: payloadStr,
              signal: controller.signal
            });
          } else if (t.provider === "supabase") {
            const supaUrl = `${t.endpointUrl.replace(/\/+$/, "")}/rest/v1/zhihu_backup_mirror`;
            await fetch(supaUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Prefer: "resolution=merge-duplicates",
                ...(t.authToken ? { apikey: t.authToken, Authorization: `Bearer ${t.authToken}` } : {})
              },
              body: JSON.stringify({
                scope,
                entity_key: entityKey,
                payload_json: payload,
                synced_at: now
              }),
              signal: controller.signal
            });
          }
        } finally {
          clearTimeout(timer);
        }
      })
    );
  } catch {
    // 镜像转发错误绝不外抛
  }
}

function triggerExternalForward(c: any, scope: ExternalSyncScope, eventPath: string, payload: unknown, entityKey: string) {
  const promise = forwardToExternalTargets(c, scope, eventPath, payload, entityKey).catch(() => {});
  // Hono 的 c.executionCtx getter 在没有 ExecutionContext 的环境（单测 / Hono test harness）
  // 会直接抛异常，可选链拦不住 getter 抛错，导致 /ingest/* 入库成功后 500。
  try {
    c.executionCtx?.waitUntil(promise);
  } catch {
    void promise;
  }
}

// 写接口统一鉴权（fail-closed），详见 middleware/require-secret.ts
ingestRoutes.use("*", requireSecret);

// 爬虫每批 /ingest/* 请求都带 x-sync-owner：自动为它续租同步锁。
// 长抓取（几小时）期间只要还在回传数据，15 分钟租约就持续顺延；
// 爬虫蓝屏/崩溃后停止发请求，锁自然过期，无需人工清理。
ingestRoutes.use("*", async (c, next) => {
  const owner = (c.req.header("x-sync-owner") || "").trim();
  if (owner) {
    const renewal = renewSyncLock(owner).catch(() => false);
    try {
      c.executionCtx.waitUntil(renewal);
    } catch {
      // 本地/测试环境没有 executionCtx 时退回同步等待
      await renewal;
    }
  }
  await next();
});

ingestRoutes.post("/content", async c => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "invalid json" }, 400);

  const parsed = IngestContentSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const pk = `${parsed.data.sourceType}:${parsed.data.sourceId}`;

  // 提前取副本：service 层不保证不改动入参；图片重写与落库都基于这份副本。
  const htmlToStore = parsed.data.contentHtml || "";
  const mdToStore = parsed.data.contentMd || "";

  // R2 未绑定时不能静默跳过：D1 里 content_html 是空串，正文会永久丢失。
  const bucket = c.env.BUCKET;
  if ((htmlToStore || mdToStore) && !bucket) {
    return c.json({ error: "R2 bucket not bound; refusing to drop content" }, 503);
  }

  // 先把正文里的知乎图床图片下载进 R2，并把 <img src> 改写成 /api/images/{hash}.{ext}。
  // 重写后的 HTML 同时用于 D1 的 content_hash 与 R2 的 html/ 对象，两者必须同源，
  // 否则详情页拿到的 hash 会指向 R2 里不存在的对象。
  // 每轮都调用是刻意的：已下载的图片会被 bucket.head 命中，不会重复下载，
  // 只有「正文已存在但图片还没备份」的历史数据会在下一次入库时补齐。
  const storedHtml = htmlToStore && bucket
    ? await processContentImages(htmlToStore, bucket)
    : htmlToStore;

  // 先写库（幂等），成功后再写 R2，避免「R2 已是新正文、D1 还是旧 hash」
  const result = await upsertContent(
    storedHtml === htmlToStore ? parsed.data : { ...parsed.data, contentHtml: storedHtml }
  );

  // 正文真分流：命中扩容目标时 HTML 只写外部库（content_blobs / S3 对象），
  // 主 R2 的 html/* 一次 PUT 都不发生（省空间 + 省 Class A 写入）。
  // 主 D1 仍保留轻量标题/摘要/计数元数据，全站列表、搜索、推荐照常工作。
  let htmlOffloadedTo: string | null = null;
  if (storedHtml) {
    const contentOffload = await resolveActiveOffloadTarget(c.env.BUCKET, "contents").catch(() => null);
    if (contentOffload) {
      try {
        await ensureRemoteCommentSchema(contentOffload);
        await putOffloadedContentHtml(contentOffload, pk, result.hash, storedHtml);
        htmlOffloadedTo = contentOffload.name;
      } catch (err) {
        // 外部库不可用时绝不能丢正文：降级回主 R2
        console.warn("[ingest] content offload failed, fallback to main R2:", err);
        htmlOffloadedTo = null;
      }
    }
  }

  if (bucket) {
    // R2 的 put 是 Class A 且不比对内容：同一 key 同字节也会计费。
    // key 已带 content_hash（正文一变 key 就变），所以只要对象已存在就无需重写。
    // 不能只用 created/changed 判断：D1 写成功但 R2 put 失败时，下一轮 changed=false
    // 会让正文永久缺失；这里用 HEAD 兜底，miss 即补写。
    const putIfAbsent = async (key: string, body: string, contentType: string, kind: string) => {
      if (!result.created) {
        const existing = await bucket.head(key).catch(() => null);
        if (existing) return false;
      }
      await bucket.put(key, body, {
        httpMetadata: { contentType },
        customMetadata: { pk, kind }
      });
      return true;
    };

    // HTML 已成功分流到外部库时跳过主 R2；md/ 体积极小，仍留主 R2
    if (storedHtml && !htmlOffloadedTo) {
      // versions/ 前缀全仓库无任何读取，且与 html/ 同字节双写，已删除
      await putIfAbsent(`html/${pk}/${result.hash}`, storedHtml, "text/html; charset=utf-8", "html");
    }
    if (mdToStore) {
      await putIfAbsent(`md/${pk}/${result.hash}`, mdToStore, "text/plain; charset=utf-8", "md");
    }
  }

  triggerExternalForward(c, "contents", "/content", parsed.data, pk);

  return c.json({ ...result, offloadedTo: htmlOffloadedTo ?? undefined });
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

ingestRoutes.post("/comments-by-root", async c => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "invalid json" }, 400);

  const parsed = IngestCommentsByRootSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  // comments 有外键约束，悬空 contentPk 会在 batch 阶段变 500，提前给 404
  const contentExists = await db.prepare(`SELECT 1 FROM contents WHERE pk = ?`).get(parsed.data.contentPk);
  if (!contentExists) {
    return c.json({ error: `content not found: ${parsed.data.contentPk}` }, 404);
  }
  // 子评论必须落 R2；未绑定时拒绝，避免静默丢楼中楼
  const bucket = c.env.BUCKET;
  if (!bucket) {
    return c.json({ error: "R2 bucket not bound; refusing to drop child comments" }, 503);
  }

  const result = await replaceCommentsByRoot(parsed.data, { DB: c.env.DB, BUCKET: bucket });
  triggerExternalForward(c, "comments", "/comments-by-root", parsed.data, parsed.data.contentPk);
  return c.json(result);
});

ingestRoutes.post("/collection-snapshot", async c => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "invalid json" }, 400);

  const parsed = IngestCollectionSnapshotSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const result = await upsertCollectionSnapshot(parsed.data);
  triggerExternalForward(c, "collections", "/collection-snapshot", parsed.data, parsed.data.collection.id);
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
  triggerExternalForward(c, "upvotes", "/upvote", { contentPk: body.contentPk, upvoteTime: body.upvoteTime }, body.contentPk);
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

// 本地同步脚本（scripts/local-sync.mjs）与云端共用同一把互斥锁：
// 本地开跑前 acquire，结束后 release；抢不到返回 409 由脚本自行跳过。
ingestRoutes.post("/sync-lock/acquire", async c => {
  const body = await c.req.json().catch(() => null) as { ownerId?: unknown; source?: unknown } | null;
  const ownerId = typeof body?.ownerId === "string" && body.ownerId.trim()
    ? body.ownerId.trim()
    : undefined;
  const source = typeof body?.source === "string" && body.source.trim()
    ? body.source.trim()
    : "manual";
  const lock = await acquireSyncLock(ownerId, source);
  if (!lock.ok) {
    return c.json({
      ok: false,
      error: "同步任务正在进行中，请稍后再试",
      ownerId: lock.ownerId,
      holder: lock.holder
    }, 409);
  }
  return c.json(lock);
});

ingestRoutes.post("/sync-lock/release", async c => {
  const body = await c.req.json().catch(() => null) as { ownerId?: unknown } | null;
  const ownerId = typeof body?.ownerId === "string" ? body.ownerId.trim() : "";
  if (!ownerId) return c.json({ error: "ownerId is required" }, 400);
  const released = await releaseSyncLock(ownerId);
  return c.json({ ok: true, released });
});
