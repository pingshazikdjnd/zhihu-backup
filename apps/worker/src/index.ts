import { Hono } from "hono";
import { cors } from "hono/cors";
import { ingestRoutes } from "./routes/ingest.js";
import { contentRoutes } from "./routes/contents.js";
import { collectionRoutes } from "./routes/collections.js";
import { changeRoutes } from "./routes/changes.js";
import { syncRoutes } from "./routes/sync.js";
import { upvoteRoutes } from "./routes/upvotes.js";
import { statsRoutes } from "./routes/stats.js";
import { authRoutes } from "./routes/auth.js";
import { questionRoutes } from "./routes/questions.js";
import { followingRoutes } from "./routes/following.js";
import { recommendRoutes } from "./routes/recommend.js";
import { dbContext } from "./db.js";
import { getActiveWriteToken } from "./routes/auth.js";
import { runAndRecord } from "./routes/sync.js";
import { IMAGE_KEY_PREFIX, IMAGE_OBJECT_NAME_RE, contentTypeForImageName, isZhihuImageUrl } from "./services/images.js";
import { findImageFallbackUrl, processImageBatch, IMAGE_TASK_BATCH_DEFAULT_LIMIT } from "./services/image-tasks.js";
import type { Bindings } from "./types.js";

const app = new Hono<{ Bindings: Bindings }>();

// CORS：只放行配置的前端域名与本地开发地址。
// 之前是 cors() 全开，任意网页都能跨域读库、触发同步任务。
app.use("*", cors({
  origin: (origin, c) => {
    if (!origin) return undefined;
    const allowed = ((c.env as Bindings)?.ALLOWED_ORIGIN || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    if (allowed.includes(origin)) return origin;
    // 允许配置的 *.pages.dev 主域名对应的 Cloudflare Pages 预览子域名（如 https://172f1bdd.zhihu-backup.pages.dev）
    for (const item of allowed) {
      if (item.startsWith("https://") && item.endsWith(".pages.dev")) {
        const host = item.slice("https://".length);
        if (origin.startsWith("https://") && origin.endsWith(`.${host}`)) return origin;
      }
    }
    // 本地开发
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
    return undefined;
  },
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["content-type", "authorization"],
}));

app.onError((err, c) => {
  // 只记日志，不把 stack / SQL 语句返回给客户端
  console.error("Hono error:", err);
  return c.json({ error: "internal error" }, 500);
});

// Inject the D1 database instance into the AsyncLocalStorage context
app.use("*", async (c, next) => {
  return dbContext.run(c.env.DB, next);
});

// 可选读接口门禁：READ_AUTH_REQUIRED="true" 时 /api/* 也要求 Bearer。
// 默认不开启，避免阻断现有前端；健康检查与登录状态页始终允许匿名访问。
app.use("/api/*", async (c, next) => {
  if (c.env.READ_AUTH_REQUIRED !== "true") return next();

  const path = new URL(c.req.url).pathname;
  if (path === "/api/health" || path === "/api/auth/zhihu-status") return next();
  // 正文图片是公开静态资源（对象名自带内容哈希、不可变），<img> 标签无法携带
  // Authorization 头，必须匿名可读，否则开启私有读模式后详情页图片全挂。
  if (path.startsWith("/api/images/")) return next();

  const auth = c.req.header("authorization") || "";
  if (auth.startsWith("Bearer ")) {
    if (c.env.API_SECRET && auth === `Bearer ${c.env.API_SECRET}`) return next();
    const writeToken = await getActiveWriteToken(c);
    if (writeToken && auth === `Bearer ${writeToken}`) return next();
  }
  return c.json({ error: "Read authentication required", needToken: true }, 401);
});

app.get("/api/health", c => c.json({ ok: true }));

// 正文图片读取：对象名形如 images/{sha256}.{ext}，key 自带内容哈希所以不可变，
// 可以放心长缓存；数据由 image_tasks 队列的批量下载写入（ingest 只入队不下载）。
app.get("/api/images/*", async c => {
  const bucket = c.env.BUCKET;
  if (!bucket) return c.json({ error: "R2 bucket not bound" }, 503);

  const pathname = new URL(c.req.url).pathname;
  const name = pathname.slice("/api/images/".length);
  // 严格校验对象名：只认 images/ 下的 sha256 文件，杜绝 ../ 之类穿越去读正文/评论对象
  if (!IMAGE_OBJECT_NAME_RE.test(name)) return c.json({ error: "not found" }, 404);

  const object = await bucket.get(`${IMAGE_KEY_PREFIX}${name}`);
  if (!object) {
    // 异步下载还没跑完（或已彻底失败）：回退到任务表里的原始知乎外链，
    // 与 P1 之前「下载失败保留外链」的可见行为一致，避免备份里出现死图。
    // 只允许重定向到知乎图床域名，防止任务表被写脏后变成开放重定向。
    const fallback = await findImageFallbackUrl(`${IMAGE_KEY_PREFIX}${name}`).catch(() => null);
    if (fallback && isZhihuImageUrl(fallback)) {
      return new Response(null, {
        status: 302,
        headers: {
          location: fallback,
          // 短缓存：下载完成后下一次请求就能拿到本地对象，不会被旧 302 长期钉住
          "cache-control": "public, max-age=60",
          "x-content-type-options": "nosniff"
        }
      });
    }
    return c.json({ error: "not found" }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  // 历史对象可能没有 httpMetadata，按扩展名兜底，避免浏览器把图片当二进制下载
  if (!headers.has("content-type")) headers.set("content-type", contentTypeForImageName(name));
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("x-content-type-options", "nosniff");
  // SVG 可以内嵌脚本：直接内联打开会执行同源脚本。只对 .svg 强制下载 +
  // 完全禁用子资源加载，其他图片保持原行为，不影响既有数据访问。
  if (name.toLowerCase().endsWith(".svg")) {
    headers.set("content-disposition", "attachment");
    headers.set("content-security-policy", "default-src 'none'; sandbox");
  }
  return new Response(object.body, { headers });
});

app.route("/ingest", ingestRoutes);
app.route("/api/contents", contentRoutes);
app.route("/api/collections", collectionRoutes);
app.route("/api/changes", changeRoutes);
app.route("/api/sync", syncRoutes);
app.route("/api/upvotes", upvoteRoutes);
app.route("/api/stats", statsRoutes);
app.route("/api/auth", authRoutes);
app.route("/api/questions", questionRoutes);
app.route("/api/following", followingRoutes);
app.route("/api/recommend", recommendRoutes);

// Cloudflare Cron 定时触发 Apify。
// 这样「谁负责爬」这件事完全落在 Apify + CF 自身，前端不需要持有任何 secret。
// 时间在 wrangler.toml 的 [triggers] 里配置（UTC）。
// 日常定时用快速模式（isFast=true：连续 20 条无更新即停，几分钟内完成）；
// 全量模式（从头翻完所有历史）数据量大的账号会跑几小时，只在手动触发时用。
async function scheduledHandler(_event: any, env: Bindings, _ctx: any) {
  // 走与手动触发同一个 runAndRecord：同样抢分布式锁、同样记录 sync_runs，
  // 不再绕过锁直接起 Actor run（cron 与手动重叠会并发双跑）。
  const res = await dbContext.run(env.DB, () => runAndRecord(env, "cron", "all", true));
  console.log(
    "cron sync:",
    res.ok ? `apify run ${res.runId}` : `failed: ${res.error}`
  );

  // 图片队列兜底：cron 打开时即使没有新正文入库，也会继续消化积压的下载任务。
  // ingest 后的 waitUntil 只跑小批量，长积压靠这里与 POST /ingest/image-batch 清空。
  const bucket = env.BUCKET;
  if (bucket) {
    try {
      // cron 用默认小批量：Free 计划单次 invocation 的子请求有限，
      // 一次拉满 100 条图片任务容易把整次 cron 拖超限。
      const images = await dbContext.run(env.DB, () => processImageBatch(bucket, IMAGE_TASK_BATCH_DEFAULT_LIMIT));
      if (images.claimed > 0) {
        console.log(
          `cron images: claimed=${images.claimed} done=${images.done} failed=${images.failed} retry=${images.retry}`
        );
      }
    } catch (err) {
      // 图片队列异常不能把 cron 调用打成失败（同步任务本身已经完成）
      console.warn("[cron] image batch failed:", err instanceof Error ? err.message : err);
    }
  }
}

export default {
  fetch: (req: Request, env: Bindings, ctx: any) => app.fetch(req, env, ctx),
  scheduled: scheduledHandler
};
