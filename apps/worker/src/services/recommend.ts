import { db } from "../db.js";
import { evaluateContentRisk } from "./risk.js";
import { getFollowedUsersMap } from "./following.js";
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
    // 优先使用原生中文旗舰/高性价比模型：
    // 1. qwen3-30b-a3b-fp8（阿里千问3 30B MoE，3B激活参数，中文互联网语境极强且免费Neurons消耗极低）
    // 2. deepseek-v4.1-flash-1017（DeepSeek V4.1 Flash，中文推理犀利）
    // 3. glm-5.3-flash（智谱 GLM-5.3 Flash，中文原生模型）
    // 4. llama-3.3-70b-instruct-fp8-fast（70B 大参数兜底）
    const models = [
      "@cf/qwen/qwen3-30b-a3b-fp8",
      "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
      "@cf/zai-org/glm-5.3-flash",
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      "@cf/meta/llama-3.1-8b-instruct-fp8"
    ];
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
