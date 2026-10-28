import { db } from "../db.js";
import { evaluateContentRisk } from "./risk.js";
import { getFollowedUsersMap } from "./following.js";
import { getSyncConfig } from "../routes/auth.js";
import { sha256 } from "../utils/hash.js";
import type { Bindings } from "../types.js";

const FAV_JOIN = `(SELECT content_pk, MAX(first_seen_at) AS fav_added_at FROM collection_items WHERE is_removed = 0 GROUP BY content_pk)`;

// 基于 seed 的确定性伪随机数生成器（用于「换一批」）
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function getRecommendFeed(
  env: Bindings,
  params?: { channel?: string; seed?: number; limit?: number }
) {
  const channel = params?.channel || "mix";
  const seed = Number.isFinite(Number(params?.seed)) ? Number(params?.seed) : Date.now();
  const limit = Math.min(Math.max(Number(params?.limit) || 20, 5), 50);
  const rand = mulberry32(seed);

  const followedMap = await getFollowedUsersMap(env.BUCKET);
  const followedTokens = new Set(
    Object.values(followedMap)
      .filter(u => !u.is_unfollowed)
      .map(u => u.url_token)
  );
  const followedNames = new Set(
    Object.values(followedMap)
      .filter(u => !u.is_unfollowed)
      .map(u => u.name)
  );

  // 拉取候选池（兼顾最新与高赞内容，单次查询 400 条在 D1 仅需几毫秒）
  const candidates = await db.prepare(`
    SELECT c.pk, c.source_type, c.source_id, c.title, c.question_id, c.question_title,
           c.source_url, c.author_name, c.author_url_token, c.author_avatar, c.author_headline,
           c.excerpt, c.voteup_count, c.comment_count, c.favorite_count, c.visit_count,
           c.is_deleted, c.is_collapsed, c.is_labeled, c.label_info,
           c.created_time, c.updated_time, c.last_seen_at,
           u.upvote_time,
           ci.fav_added_at,
           CASE WHEN ci.content_pk IS NOT NULL THEN 1 ELSE 0 END AS in_favorites
    FROM contents c
    LEFT JOIN upvotes u ON u.content_pk = c.pk
    LEFT JOIN ${FAV_JOIN} ci ON ci.content_pk = c.pk
    WHERE c.author_url_token IS NULL OR c.author_url_token != ?
    ORDER BY
      CASE WHEN c.is_deleted = 1 OR c.is_collapsed = 1 THEN 0 ELSE 1 END ASC,
      c.voteup_count DESC,
      c.last_seen_at DESC
    LIMIT 450
  `).all<any>(env.ZHIHU_USERNAME || "yang-xu-heng-94");

  // 统计作者在候选池与用户交互中的频次（识别偏爱答主）
  const authorFreq = new Map<string, number>();
  for (const r of candidates) {
    const key = r.author_url_token || r.author_name || "";
    if (!key) continue;
    if (r.upvote_time || Number(r.in_favorites) === 1) {
      authorFreq.set(key, (authorFreq.get(key) || 0) + 1);
    }
  }

  const scored = candidates.map(r => {
    const risk = evaluateContentRisk(r);
    const authorKey = r.author_url_token || r.author_name || "";
    const favAuthorCount = authorKey ? (authorFreq.get(authorKey) || 0) : 0;
    const isFollowed = r.author_url_token
      ? followedTokens.has(r.author_url_token)
      : Boolean(r.author_name && followedNames.has(r.author_name));

    let recommendReason = "✨ 精选回看";
    if (Number(r.is_deleted) === 1) {
      recommendReason = "💀 绝版抢救 · 原站已删除";
    } else if (Number(r.is_collapsed) === 1) {
      recommendReason = "⚠️ 防夹保护 · 原站已折叠";
    } else if (risk.risk_level === "high" && risk.value_score >= 20) {
      recommendReason = `🔴 高危易和谐 · ${risk.risk_tags[0] || "高敏高赞"}`;
    } else if (isFollowed && favAuthorCount >= 2) {
      recommendReason = `🔥 关注且偏爱的答主 (${r.author_name})`;
    } else if (isFollowed) {
      recommendReason = `👀 你关注的答主 (${r.author_name})`;
    } else if (favAuthorCount >= 3) {
      recommendReason = `❤️ 常看答主 · 已收录 TA ${favAuthorCount} 篇`;
    } else if (Number(r.in_favorites) === 1 && r.upvote_time) {
      recommendReason = "⭐ 赞同且收藏的双重精选";
    } else if (risk.value_score >= 45) {
      recommendReason = "💎 超高收藏比 · 硬核神贴";
    }

    // 综合推荐分 + 随机扰动（让每次「换一批」既保持高质量又有新鲜感）
    const jitter = (rand() - 0.5) * 28;
    const mixScore =
      risk.value_score * 0.55 +
      risk.risk_score * 0.35 +
      (isFollowed ? 18 : 0) +
      Math.min(favAuthorCount * 5, 20) +
      jitter;

    return {
      ...r,
      ...risk,
      is_followed_author: Boolean(isFollowed),
      author_Positive_count: favAuthorCount,
      recommend_reason: recommendReason,
      _mixScore: mixScore,
      _riskRankScore: risk.risk_score * 0.65 + risk.value_score * 0.35 + (rand() - 0.5) * 8,
      _classicScore: risk.value_score + (Number(r.is_deleted) === 1 ? 30 : 0) + (rand() - 0.5) * 15
    };
  });

  let pool = scored;
  if (channel === "risk") {
    pool = scored
      .filter(r => r.risk_score >= 28 || Number(r.is_deleted) === 1 || Number(r.is_collapsed) === 1)
      .sort((a, b) => b._riskRankScore - a._riskRankScore);
  } else if (channel === "authors") {
    pool = scored
      .filter(r => r.is_followed_author || r.author_Positive_count >= 2)
      .sort((a, b) => b._mixScore - a._mixScore);
  } else if (channel === "classic") {
    pool = scored
      .filter(r => Number(r.is_deleted) === 1 || Number(r.is_collapsed) === 1 || r.value_score >= 35 || Number(r.in_favorites) === 1)
      .sort((a, b) => b._classicScore - a._classicScore);
  } else {
    pool = [...scored].sort((a, b) => b._mixScore - a._mixScore);
  }

  // 多样性打散：同一批次中同一个答主最多出现 2 篇、同一个问题最多出现 1 篇
  const selected: any[] = [];
  const usedAuthors = new Map<string, number>();
  const usedQuestions = new Set<string>();

  for (const item of pool) {
    if (selected.length >= limit) break;
    const aKey = item.author_url_token || item.author_name || "";
    const qKey = item.question_id || "";
    if (qKey && usedQuestions.has(qKey) && channel === "mix") continue;
    if (aKey && (usedAuthors.get(aKey) || 0) >= 2 && channel !== "authors") continue;

    selected.push(item);
    if (qKey) usedQuestions.add(qKey);
    if (aKey) usedAuthors.set(aKey, (usedAuthors.get(aKey) || 0) + 1);
  }

  // 统计高危神贴概览
  const highRiskCount = scored.filter(r => r.risk_level === "high").length;
  const mediumRiskCount = scored.filter(r => r.risk_level === "medium").length;

  return {
    channel,
    seed,
    stats: {
      candidate_pool: scored.length,
      high_risk_count: highRiskCount,
      medium_risk_count: mediumRiskCount
    },
    data: selected.map(({ _mixScore, _riskRankScore, _classicScore, ...rest }) => rest)
  };
}

/**
 * 查找相似回答（同问题高赞回答 / 同答主代表作 / 标题核心词关联）
 */
export async function getSimilarContents(pk: string) {
  const target = await db.prepare(`
    SELECT pk, title, question_id, question_title, author_name, author_url_token
    FROM contents WHERE pk = ?
  `).get<any>(pk);

  if (!target) return { data: [] };

  const titleText = String(target.question_title || target.title || "").trim();
  // 提取 2~4 字中文核心词用于主题关联
  const words = (titleText.match(/[\u4e00-\u9fa5]{2,4}/g) || [])
    .filter(w => !["为什么", "如何看待", "怎么看", "有哪些", "是什么", "怎么", "是不是", "可以", "什么"].includes(w))
    .slice(0, 3);

  const likeClauses = words.map(() => `(c.title LIKE ? OR c.question_title LIKE ?)`).join(" OR ");
  const likeArgs: string[] = [];
  for (const w of words) {
    likeArgs.push(`%${w}%`, `%${w}%`);
  }

  const ANON_NAMES = new Set(["匿名用户", "知乎用户", "匿名", ""]);
  const validAuthorToken = String(target.author_url_token || "").trim();
  const validAuthorName = !validAuthorToken && !ANON_NAMES.has(String(target.author_name || "").trim())
    ? String(target.author_name).trim()
    : "__none__";

  const rows = await db.prepare(`
    SELECT c.pk, c.source_type, c.source_id, c.title, c.question_id, c.question_title,
           c.source_url, c.author_name, c.author_url_token, c.author_avatar, c.author_headline,
           c.excerpt, c.voteup_count, c.comment_count, c.favorite_count,
           c.is_deleted, c.is_collapsed, c.is_labeled, c.label_info,
           c.updated_time, c.last_seen_at
    FROM contents c
    WHERE c.pk != ?
      AND (
        (c.question_id IS NOT NULL AND c.question_id != '' AND c.question_id = ?)
        OR (c.author_url_token IS NOT NULL AND c.author_url_token != '' AND c.author_url_token = ?)
        OR ((c.author_url_token IS NULL OR c.author_url_token = '') AND c.author_name = ?)
        ${likeClauses ? `OR (${likeClauses})` : ""}
      )
    ORDER BY
      CASE WHEN c.question_id = ? THEN 0 WHEN c.author_url_token = ? OR c.author_name = ? THEN 1 ELSE 2 END ASC,
      c.voteup_count DESC
    LIMIT 6
  `).all<any>(
    pk,
    target.question_id || "__none__",
    validAuthorToken || "__none__",
    validAuthorName,
    ...likeArgs,
    target.question_id || "__none__",
    validAuthorToken || "__none__",
    validAuthorName
  );

  return {
    data: rows.map(r => ({
      ...r,
      ...evaluateContentRisk(r),
      relation_type:
        r.question_id && r.question_id === target.question_id
          ? "同问题回答"
          : r.author_name && r.author_name === target.author_name
          ? `同答主 (${r.author_name})`
          : "相似主题"
    }))
  };
}

/**
 * 调用 Cloudflare Workers AI 对单篇回答做深度「和谐风险鉴定 + 核心看点提炼」
 * 结果自动缓存在 R2 meta/ai-risk/<pk>.json，同一篇回答只消耗一次免费 AI 额度
 */
export async function assessContentWithWorkersAI(env: Bindings, pk: string) {
  const row = await db.prepare(`
    SELECT pk, source_type, source_id, title, question_title, author_name,
           excerpt, content_hash, voteup_count, comment_count, favorite_count,
           is_deleted, is_collapsed, is_labeled, label_info
    FROM contents WHERE pk = ?
  `).get<any>(pk);

  if (!row) {
    return { ok: false, error: "内容不存在" };
  }

  const staticRisk = evaluateContentRisk(row);
  const cacheKey = `meta/ai-risk/${pk.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;

  // 1. 先查 R2 缓存（命中则 0 算力秒回）
  if (env.BUCKET) {
    try {
      const cached = await env.BUCKET.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(await cached.text());
        return { ok: true, cached: true, ...staticRisk, ai: parsed };
      }
    } catch { /* ignore */ }
  }

  // 2. 从 R2 读取正文纯文本前 1200 字供 AI 分析
  let bodySnippet = row.excerpt || "";
  if (env.BUCKET && row.content_hash) {
    try {
      const obj =
        (await env.BUCKET.get(`html/${pk}/${row.content_hash}`)) ||
        (await env.BUCKET.get(`html/${pk}`));
      if (obj) {
        const html = await obj.text();
        bodySnippet = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
      }
    } catch { /* ignore */ }
  }

  const prompt = `你是一个专业的知乎内容归档与防和谐风险评估助手。请分析以下已备份的知乎回答，用简洁犀利的中文给出评估（控制在 180 字以内，分三点输出）：
1. 【和谐风险鉴定】：判断该回答在知乎原站被折叠/删除的风险（高/中/低），点明具体容易触发审核的敏感点或争议点；
2. 【核心看点提炼】：一句话总结这篇回答写得最精彩、最有保存价值的核心论点；
3. 【归档建议】：给出抢救备份级别建议。

问题标题：${row.question_title || row.title}
答主：${row.author_name || "匿名"}（${row.voteup_count} 赞同 / ${row.favorite_count} 收藏 / ${row.comment_count} 评论）
原站状态：${row.is_deleted ? "已被删除" : row.is_collapsed ? "已被折叠" : "正常"}
正文摘录：${bodySnippet}`;

  let aiText = "";
  let modelUsed = "rule-fallback";

  if (env.AI) {
    const cfg = await getSyncConfig(env.BUCKET);
    const defaultChain = [
      "@cf/qwen/qwen3-30b-a3b-fp8",
      "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
      "@cf/zai-org/glm-5.3-flash",
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      "@cf/meta/llama-3.1-8b-instruct-fp8"
    ];
    const models = cfg.preferredAiModel
      ? [cfg.preferredAiModel, ...defaultChain.filter(m => m !== cfg.preferredAiModel)]
      : defaultChain;
    for (const m of models) {
      try {
        const resp = await env.AI.run(m, {
          messages: [
            { role: "system", content: "你擅长分析中文互联网文章的审查和谐风险与核心价值，回答简明扼要，直接输出三点结论，不要输出多余寒暄。" },
            { role: "user", content: prompt }
          ],
          max_tokens: 360
        });
        const rawText =
          typeof resp?.response === "string"
            ? resp.response
            : typeof resp?.choices?.[0]?.message?.content === "string"
            ? resp.choices[0].message.content
            : "";
        // 剥离可能的 <think>...</think> 思考块，只留最终精炼结论
        const text = rawText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
        if (text) {
          aiText = text;
          modelUsed = m;
          break;
        }
      } catch {
        // 尝试下一个免费模型
      }
    }
  }

  if (!aiText) {
    aiText = `1. 【和谐风险鉴定】：风险评分 ${staticRisk.risk_score}/100（${staticRisk.risk_level === "high" ? "高危易和谐" : staticRisk.risk_level === "medium" ? "中度敏感" : "低风险"}），命中特征：${staticRisk.risk_tags.join("、") || "常规内容"}。\n2. 【核心看点提炼】：获 ${row.voteup_count} 赞同与 ${row.favorite_count} 收藏（含金量评分 ${staticRisk.value_score}/100），建议重点留存全文快照。`;
  }

  const aiResult = {
    analysis: aiText,
    model: modelUsed,
    evaluated_at: new Date().toISOString()
  };

  if (env.BUCKET && modelUsed !== "rule-fallback") {
    try {
      await env.BUCKET.put(cacheKey, JSON.stringify(aiResult), {
        httpMetadata: { contentType: "application/json; charset=utf-8" }
      });
    } catch { /* ignore */ }
  }

  return {
    ok: true,
    cached: false,
    ...staticRisk,
    ai: aiResult
  };
}

// ===== 关注答主「是否值得备份」AI 批量复核 =====
// 目标：规则筛选未通过、但处在候选池（高赞/长文/中风险）的回答或文章，
// 用一次批量 Workers AI 调用判断是否值得抢救备份，重点识别容易被和谐的内容。
// 额度保护：单次最多 10 条、逐条 R2 缓存、失败一律规则降级不抛错。

export type FollowingEvalItem = {
  sourceId: string;
  sourceType: "answer" | "article" | "pin";
  title: string;
  questionTitle?: string;
  excerpt?: string;
  voteupCount?: number;
  commentCount?: number;
  favoriteCount?: number;
  isCollapsed?: boolean;
  isLabeled?: boolean;
  riskScore?: number;
  riskTags?: string[];
};

export type FollowingEvalResult = { sourceId: string; worth: boolean; risk: number; reason: string };

// AI 不可用 / 解析失败 / 未返回该条时的规则兜底（绝不抛错中断抓取）
function fallbackFollowingResult(item: FollowingEvalItem): FollowingEvalResult {
  const risk = Math.min(100, Math.max(0, Math.round(Number(item.riskScore) || 0)));
  return {
    sourceId: item.sourceId,
    worth: risk >= 25 || Boolean(item.isCollapsed) || Boolean(item.isLabeled),
    risk,
    reason: "AI不可用·规则兜底"
  };
}

function extractWorkersAiText(resp: unknown): string {
  if (!resp || typeof resp !== "object") return "";
  const obj = resp as Record<string, unknown>;
  if (typeof obj.response === "string") return obj.response;
  const choices = obj.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (first && typeof first === "object") {
      const message = (first as Record<string, unknown>).message;
      if (message && typeof message === "object") {
        const content = (message as Record<string, unknown>).content;
        if (typeof content === "string") return content;
      }
    }
  }
  return "";
}

// 剥离 ```json 围栏与 <think> 思考块，再从文本里截取第一个 JSON 数组
function parseFollowingAiArray(text: string): FollowingEvalResult[] | null {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const results: FollowingEvalResult[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const sourceId = typeof rec.sourceId === "string" ? rec.sourceId : "";
    if (!sourceId) continue;
    const riskRaw = Number(rec.risk);
    results.push({
      sourceId,
      worth: rec.worth === true,
      risk: Number.isFinite(riskRaw) ? Math.min(100, Math.max(0, Math.round(riskRaw))) : 0,
      reason: typeof rec.reason === "string" ? rec.reason.slice(0, 120) : ""
    });
  }
  return results.length > 0 ? results : null;
}

export async function evaluateFollowingWithAI(env: Bindings, items: FollowingEvalItem[]) {
  const capped = items.slice(0, 10);
  const resultMap = new Map<string, FollowingEvalResult & { cached: boolean }>();
  const cacheKeyMap = new Map<string, string>();
  const misses: FollowingEvalItem[] = [];
  let cachedCount = 0;

  // 1. 逐条查 R2 缓存：key = meta/ai-following/<sha256(sourceId|摘要|赞数)>.json
  for (const item of capped) {
    const cacheSeed = `${item.sourceId}|${item.excerpt || item.title || ""}|${Number(item.voteupCount) || 0}`;
    let cacheKey = "";
    try {
      cacheKey = `meta/ai-following/${await sha256(cacheSeed)}.json`;
    } catch { /* 哈希失败则跳过缓存 */ }
    if (cacheKey) cacheKeyMap.set(item.sourceId, cacheKey);

    let hit: (FollowingEvalResult & { cached: boolean }) | null = null;
    if (env.BUCKET && cacheKey) {
      try {
        const obj = await env.BUCKET.get(cacheKey);
        if (obj) {
          const parsed: unknown = JSON.parse(await obj.text());
          if (parsed && typeof parsed === "object") {
            const rec = parsed as Record<string, unknown>;
            if (typeof rec.worth === "boolean" && rec.sourceId === item.sourceId) {
              const riskRaw = Number(rec.risk);
              hit = {
                sourceId: item.sourceId,
                worth: rec.worth,
                risk: Number.isFinite(riskRaw) ? Math.min(100, Math.max(0, Math.round(riskRaw))) : 0,
                reason: typeof rec.reason === "string" ? rec.reason.slice(0, 120) : "",
                cached: true
              };
            }
          }
        }
      } catch { /* 缓存损坏按未命中处理 */ }
    }
    if (hit) {
      resultMap.set(item.sourceId, hit);
      cachedCount++;
    } else {
      misses.push(item);
    }
  }

  let model = cachedCount > 0 && misses.length === 0 ? "cache" : "rule-fallback";

  // 2. 未命中条目合并成一次批量 prompt 调用现有 AI 链
  if (misses.length > 0 && env.AI) {
    const cfg = await getSyncConfig(env.BUCKET);
    const defaultChain = [
      "@cf/qwen/qwen3-30b-a3b-fp8",
      "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
      "@cf/zai-org/glm-5.3-flash",
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      "@cf/meta/llama-3.1-8b-instruct-fp8"
    ];
    const models = cfg.preferredAiModel
      ? [cfg.preferredAiModel, ...defaultChain.filter(m => m !== cfg.preferredAiModel)]
      : defaultChain;

    // 每条只放判断必需的最小字段，不塞正文全文（控制 token 与限额消耗）
    const promptItems = misses.map(item => ({
      sourceType: item.sourceType,
      title: item.title || "",
      questionTitle: item.questionTitle || "",
      excerpt: (item.excerpt || "").slice(0, 200),
      voteupCount: Number(item.voteupCount) || 0,
      commentCount: Number(item.commentCount) || 0,
      favoriteCount: Number(item.favoriteCount) || 0,
      isCollapsed: Boolean(item.isCollapsed),
      isLabeled: Boolean(item.isLabeled),
      ruleRiskScore: Math.min(100, Math.max(0, Math.round(Number(item.riskScore) || 0))),
      ruleRiskTags: Array.isArray(item.riskTags) ? item.riskTags.slice(0, 6) : []
    }));

    const prompt = `你是知乎内容归档与防和谐风险评估助手。请判断下列关注答主的内容是否值得备份保存，特别关注容易被知乎折叠/删除/限流的敏感内容（时政、社会争议、审查相关、禁评迹象等），同时保留信息密度高、有长期收藏价值的干货。
只输出一个 JSON 数组，不要输出任何解释、前后缀或 markdown 代码块。数组元素格式：
[{"sourceId":"原文id","worth":true,"risk":78,"reason":"不超过20字的中文理由"}]
字段说明：worth 是否值得备份（布尔值），risk 被和谐风险 0-100 整数，reason 简短中文理由。
待判断内容（JSON）：
${JSON.stringify(promptItems)}`;

    for (const m of models) {
      try {
        const resp: unknown = await env.AI.run(m, {
          messages: [
            { role: "system", content: "你是知乎内容归档助手，只输出 JSON 数组，不输出任何其它文字。" },
            { role: "user", content: prompt }
          ],
          max_tokens: 900
        });
        const parsed = parseFollowingAiArray(extractWorkersAiText(resp));
        if (!parsed) continue;

        const allowed = new Set(misses.map(i => i.sourceId));
        const adopted: FollowingEvalResult[] = [];
        for (const r of parsed) {
          if (!allowed.has(r.sourceId)) continue;
          resultMap.set(r.sourceId, { ...r, cached: false });
          adopted.push(r);
        }
        // 模型没给出任何有效条目视为本模型失败，继续尝试下一个
        if (adopted.length === 0) continue;

        model = m;
        // 3. 仅解析成功的结果写回 R2 缓存（规则降级的条目下轮仍可重试）
        if (env.BUCKET) {
          for (const r of adopted) {
            const key = cacheKeyMap.get(r.sourceId);
            if (!key) continue;
            try {
              await env.BUCKET.put(key, JSON.stringify(r), {
                httpMetadata: { contentType: "application/json; charset=utf-8" }
              });
            } catch { /* 缓存写入失败不影响本次结果 */ }
          }
        }
        break;
      } catch {
        // 尝试下一个免费模型
      }
    }
  }

  // 4. 仍无结论的条目统一走规则降级，保证结果完整且不抛错
  for (const item of misses) {
    if (!resultMap.has(item.sourceId)) {
      resultMap.set(item.sourceId, { ...fallbackFollowingResult(item), cached: false });
    }
  }

  const results = capped
    .map(item => resultMap.get(item.sourceId))
    .filter((r): r is FollowingEvalResult & { cached: boolean } => Boolean(r));

  return { results, model, cachedCount };
}
