import { Hono } from "hono";
import {
  assessContentWithWorkersAI,
  evaluateFollowingWithAI,
  getRecommendFeed,
  getSimilarContents
} from "../services/recommend.js";
import type { FollowingEvalItem } from "../services/recommend.js";
import { isOriginAllowed } from "./auth.js";
import type { Bindings } from "../types.js";

export const recommendRoutes = new Hono<{ Bindings: Bindings }>();

// 进程内轻量速率限制（防止恶意脚本批量遍历 pk 耗尽每日 10,000 Neurons 免费额度）
let rateWindowStart = 0;
let rateWindowCount = 0;

// 「关注答主 AI 复核」独立限流：每分钟最多 12 次，防止爬虫被刷导致 AI 额度失控
let evalWindowStart = 0;
let evalWindowCount = 0;

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

const MAX_EVAL_ITEMS = 10;
const MAX_EVAL_CHARS = 12000;

function toBoundedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function toBoundedNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// 关注答主批量「是否值得备份」AI 复核（供 Apify 爬虫回调，必须带 API_SECRET）
recommendRoutes.post("/evaluate-following", async c => {
  if (!c.env.API_SECRET) {
    return c.json({ error: "server misconfigured: API_SECRET missing" }, 503);
  }
  const auth = c.req.header("authorization");
  if (!auth || auth !== `Bearer ${c.env.API_SECRET}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const now = Date.now();
  if (now - evalWindowStart > 60_000) {
    evalWindowStart = now;
    evalWindowCount = 0;
  }
  if (evalWindowCount >= 12) {
    return c.json({ error: "AI 复核请求过于频繁，请稍后再试" }, 429);
  }
  evalWindowCount++;

  const body: unknown = await c.req.json().catch(() => null);
  const rawItems = body && typeof body === "object" ? (body as Record<string, unknown>).items : undefined;
  if (!Array.isArray(rawItems)) {
    return c.json({ error: "items must be an array" }, 400);
  }

  const items: FollowingEvalItem[] = [];
  let totalChars = 0;
  for (const raw of rawItems.slice(0, MAX_EVAL_ITEMS)) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const sourceId = toBoundedString(rec.sourceId, 120).trim();
    if (!sourceId) continue;
    const sourceType =
      rec.sourceType === "article" || rec.sourceType === "pin" ? rec.sourceType : "answer";
    const title = toBoundedString(rec.title, 300);
    const questionTitle = toBoundedString(rec.questionTitle, 300);
    const excerpt = toBoundedString(rec.excerpt, 1200);
    totalChars += sourceId.length + title.length + questionTitle.length + excerpt.length;
    const riskScore = toBoundedNumber(rec.riskScore);
    const voteupCount = toBoundedNumber(rec.voteupCount);
    const commentCount = toBoundedNumber(rec.commentCount);
    const favoriteCount = toBoundedNumber(rec.favoriteCount);
    items.push({
      sourceId,
      sourceType,
      title,
      questionTitle,
      excerpt,
      voteupCount,
      commentCount,
      favoriteCount,
      isCollapsed: rec.isCollapsed === true,
      isLabeled: rec.isLabeled === true,
      riskScore,
      riskTags: Array.isArray(rec.riskTags)
        ? rec.riskTags.filter((t): t is string => typeof t === "string").slice(0, 8)
        : undefined
    });
  }

  if (items.length === 0) {
    return c.json({ error: "items is empty or invalid" }, 400);
  }
  if (totalChars > MAX_EVAL_CHARS) {
    return c.json({ error: `items too large (max ${MAX_EVAL_CHARS} chars)` }, 400);
  }

  const res = await evaluateFollowingWithAI(c.env, items);
  return c.json({ ok: true, ...res });
});
