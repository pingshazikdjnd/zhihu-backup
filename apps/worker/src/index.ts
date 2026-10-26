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
import { dbContext } from "./db.js";
import { triggerApifyRun } from "./services/apify.js";
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

app.get("/api/health", c => c.json({ ok: true }));

app.route("/ingest", ingestRoutes);
app.route("/api/contents", contentRoutes);
app.route("/api/collections", collectionRoutes);
app.route("/api/changes", changeRoutes);
app.route("/api/sync", syncRoutes);
app.route("/api/upvotes", upvoteRoutes);
app.route("/api/stats", statsRoutes);
app.route("/api/auth", authRoutes);
app.route("/api/questions", questionRoutes);

// Cloudflare Cron 定时触发 Apify。
// 这样「谁负责爬」这件事完全落在 Apify + CF 自身，前端不需要持有任何 secret。
// 时间在 wrangler.toml 的 [triggers] 里配置（UTC）。
// 日常定时用快速模式（isFast=true：连续 20 条无更新即停，几分钟内完成）；
// 全量模式（从头翻完所有历史）数据量大的账号会跑几小时，只在手动触发时用。
async function scheduledHandler(_event: any, env: Bindings, _ctx: any) {
  const res = await triggerApifyRun(env, "all", true);
  console.log("cron sync:", res.ok ? `apify run ${res.runId}` : `failed: ${res.error}`);
}

export default {
  fetch: (req: Request, env: Bindings, ctx: any) => app.fetch(req, env, ctx),
  scheduled: scheduledHandler
};
