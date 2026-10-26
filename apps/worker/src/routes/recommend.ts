import { Hono } from "hono";
import {
  assessContentWithWorkersAI,
  getRecommendFeed,
  getSimilarContents
} from "../services/recommend.js";
import { isOriginAllowed } from "./auth.js";
import type { Bindings } from "../types.js";

export const recommendRoutes = new Hono<{ Bindings: Bindings }>();

// 进程内轻量速率限制（防止恶意脚本批量遍历 pk 耗尽每日 10,000 Neurons 免费额度）
let rateWindowStart = 0;
let rateWindowCount = 0;

// 获取知乎主页式多路混合推荐流（channel = mix | risk | authors | classic）
recommendRoutes.get("/", async c => {
  const channel = c.req.query("channel") || "mix";
  const seed = parseInt(c.req.query("seed") || String(Date.now()), 10);
  const limit = parseInt(c.req.query("limit") || "20", 10);
  const res = await getRecommendFeed(c.env, { channel, seed, limit });
  return c.json(res);
});

// 获取某篇回答的相似回答推荐
recommendRoutes.get("/similar/:pk", async c => {
  const pk = c.req.param("pk");
  const res = await getSimilarContents(pk);
  return c.json(res);
});

// 调用 Cloudflare Workers AI 对单篇回答进行「和谐风险 + 核心价值」深度鉴定
recommendRoutes.post("/ai-assess", async c => {
  if (!isOriginAllowed(c)) {
    return c.json({ error: "Forbidden origin" }, 403);
  }
  const now = Date.now();
  if (now - rateWindowStart > 60_000) {
    rateWindowStart = now;
    rateWindowCount = 0;
  }
  if (rateWindowCount >= 20) {
    return c.json({ error: "AI 评估请求过于频繁，请稍后再试" }, 429);
  }
  rateWindowCount++;

  const body = await c.req.json().catch(() => null) as { pk?: unknown } | null;
  const pk = typeof body?.pk === "string" ? body.pk.trim() : "";
  if (!pk) return c.json({ error: "pk is required" }, 400);
  const res = await assessContentWithWorkersAI(c.env, pk);
  if (!res.ok) return c.json(res, 404);
  return c.json(res);
});
