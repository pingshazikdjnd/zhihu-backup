import { Hono } from "hono";
import {
  assessContentWithWorkersAI,
  evaluateFollowingWithAI,
  getRecommendFeed,
  getSimilarContents
} from "../services/recommend.js";
import type { FollowingEvalItem, FollowingSensitivity } from "../services/recommend.js";
import { getActiveWriteToken, isOriginAllowed } from "./auth.js";
import type { Bindings } from "../types.js";

export const recommendRoutes = new Hono<{ Bindings: Bindings }>();

// /ai-assess 的凭据判断沿用项目现有口径：API_SECRET 或凭据页写入口令（不引入新密钥）。
// 正常前端是同源 Pages 代理 POST，浏览器会带 Origin；无 Origin 的脚本必须自带 Bearer 才能用。
async function hasApiCredential(c: any): Promise<boolean> {
  const auth = c.req.header("authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  if (c.env.API_SECRET && auth === `Bearer ${c.env.API_SECRET}`) return true;
  try {
    const writeToken = await getActiveWriteToken(c);
    return Boolean(writeToken) && auth === `Bearer ${writeToken}`;
  } catch {
    return false;
  }
}

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
  const origin = c.req.header("origin");
  // 1) 先验 Origin：带了 Origin 就必须命中白名单，非法才返回 403 Forbidden origin
  if (origin && !isOriginAllowed(c, true)) {
    return c.json({ error: "Forbidden origin" }, 403);
  }
  // 2) 再验写口令：已配置写口令（含 API_SECRET 兜底）时必须携带有效 Bearer；
  //    缺失或错误统一返回 401 { error: "Unauthorized", needToken: true }，与前端弹密逻辑对齐。
  const activeToken = await getActiveWriteToken(c).catch(() => "");
  if (activeToken) {
    if (!(await hasApiCredential(c))) {
      return c.json({ error: "Unauthorized", needToken: true }, 401);
    }
  } else if (!origin) {
    return c.json({ error: "Unauthorized", needToken: true }, 401);
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
// 10 条 ×（sourceId 120 + title/questionTitle/excerpt 各 300）= 10200，12000 只作防御上限；
// 超出时逐条截断而不是整批 400
const MAX_EVAL_CHARS = 12000;
const MAX_EVAL_EXCERPT_CHARS = 300;

function toBoundedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function toBoundedNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function evalItemChars(item: FollowingEvalItem): number {
  return (
    item.sourceId.length +
    (item.title || "").length +
    (item.questionTitle || "").length +
    (item.excerpt || "").length
  );
}

// 超出总字符上限时从后往前裁剪摘要/问题标题/标题，保证整批仍能处理
function enforceEvalCharBudget(items: FollowingEvalItem[], max: number): void {
  let total = items.reduce((sum, item) => sum + evalItemChars(item), 0);
  if (total <= max) return;
  for (let i = items.length - 1; i >= 0 && total > max; i--) {
    const item = items[i];
    for (const field of ["excerpt", "questionTitle", "title"] as const) {
      if (total <= max) break;
      const value = item[field] || "";
      if (!value) continue;
      const cut = Math.min(value.length, total - max);
      item[field] = value.slice(0, value.length - cut);
      total -= cut;
    }
  }
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
  const bodyRec = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const rawItems = bodyRec?.items;
  if (!Array.isArray(rawItems)) {
    return c.json({ error: "items must be an array" }, 400);
  }
  // 旧爬虫不传 sensitivity 时按 standard（阈值 25），保持向后兼容
  const rawSensitivity = bodyRec?.sensitivity;
  const sensitivity: FollowingSensitivity =
    rawSensitivity === "strict" || rawSensitivity === "relaxed" || rawSensitivity === "standard"
      ? rawSensitivity
      : "standard";

  const items: FollowingEvalItem[] = [];
  for (const raw of rawItems.slice(0, MAX_EVAL_ITEMS)) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const sourceId = toBoundedString(rec.sourceId, 120).trim();
    if (!sourceId) continue;
    const sourceType =
      rec.sourceType === "article" || rec.sourceType === "pin" ? rec.sourceType : "answer";
    const title = toBoundedString(rec.title, 300);
    const questionTitle = toBoundedString(rec.questionTitle, 300);
    const excerpt = toBoundedString(rec.excerpt, MAX_EVAL_EXCERPT_CHARS);
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
  enforceEvalCharBudget(items, MAX_EVAL_CHARS);

  const res = await evaluateFollowingWithAI(c.env, items, sensitivity);
  return c.json({ ok: true, ...res });
});
