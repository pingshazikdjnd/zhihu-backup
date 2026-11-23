import { db, FAV_JOIN_SQL } from "../db.js";

/**
 * 按知乎「问题」维度聚合用户赞同/收藏过的回答。
 *
 * 数据模型：contents.question_id/question_title 只在 answer 类型上有值；
 * upvotes（赞同过）与 collection_items（收藏着，is_removed=0）标记"与我相关"。
 * 一条回答可能同时被赞同和收藏、也可能躺在多个收藏夹——收藏侧先 GROUP BY content_pk
 * 去重再 JOIN，避免行数膨胀把 count 放大。
 */

export async function listQuestions(params?: { page?: number; q?: string }) {
  const parsedPage = Number(params?.page ?? 1);
  const page = Number.isFinite(parsedPage) ? Math.min(Math.max(Math.trunc(parsedPage), 1), 100000) : 1;
  const limit = 50;
  const offset = (page - 1) * limit;

  const rawQ = (params?.q ?? "").trim();
  const hasQ = rawQ.length > 0;
  const escapedQ = hasQ ? `%${rawQ.replace(/[\\%_]/g, "\\$&")}%` : "";
  const qClause = hasQ ? `AND (c.question_title LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\')` : "";
  const bindArgs = hasQ ? [escapedQ, escapedQ] : [];

  const totalRow = await db.prepare(`
    SELECT count(*) AS c FROM (
      SELECT c.question_id
      FROM contents c
      LEFT JOIN upvotes u ON u.content_pk = c.pk
      ${FAV_JOIN_SQL}
      WHERE c.source_type = 'answer'
        AND c.question_id IS NOT NULL AND c.question_id != ''
        AND (u.content_pk IS NOT NULL OR fav.content_pk IS NOT NULL)
        ${qClause}
      GROUP BY c.question_id
    )
  `).get<{ c: number }>(...bindArgs);

  // 仅按 c.question_id 分组：知乎问题改名会导致同一 question_id 下不同回答带有新旧标题，
  // 若按 (question_id, question_title) 分组会把同一问题拆成多行、拆碎计数并导致前端 React key 冲突。
  const rows = await db.prepare(`
    SELECT
      c.question_id,
      COALESCE(MAX(NULLIF(c.question_title, '')), MAX(NULLIF(c.title, '')), c.question_id) AS question_title,
      count(*) AS answer_count,
      sum(CASE WHEN u.content_pk IS NOT NULL THEN 1 ELSE 0 END) AS upvoted_count,
      sum(CASE WHEN fav.content_pk IS NOT NULL THEN 1 ELSE 0 END) AS faved_count,
      max(COALESCE(u.upvote_time, fav.fav_added_at, c.last_seen_at)) AS latest_time
    FROM contents c
    LEFT JOIN upvotes u ON u.content_pk = c.pk
    ${FAV_JOIN_SQL}
    WHERE c.source_type = 'answer'
      AND c.question_id IS NOT NULL AND c.question_id != ''
      AND (u.content_pk IS NOT NULL OR fav.content_pk IS NOT NULL)
      ${qClause}
    GROUP BY c.question_id
    ORDER BY answer_count DESC, latest_time DESC
    LIMIT ${limit} OFFSET ${offset}
  `).all(...bindArgs);

  return { rows, total: totalRow?.c ?? 0 };
}

export async function getQuestionAnswers(questionId: string) {
  const answers = await db.prepare(`
    SELECT c.pk, c.source_id, c.title, c.question_title, c.source_url,
           c.author_name, c.author_url_token, c.author_avatar, c.author_headline,
           c.excerpt, c.voteup_count, MAX(c.comment_count, COALESCE(c.archived_comment_count, 0)) AS comment_count, c.favorite_count, c.visit_count,
           c.is_deleted, c.is_collapsed,
           c.updated_time, c.last_seen_at,
           u.upvote_time,
           fav.fav_added_at,
           CASE WHEN fav.content_pk IS NOT NULL THEN 1 ELSE 0 END AS in_favorites
    FROM contents c
    LEFT JOIN upvotes u ON u.content_pk = c.pk
    ${FAV_JOIN_SQL}
    WHERE c.question_id = ?
      AND c.source_type = 'answer'
      AND (u.content_pk IS NOT NULL OR fav.content_pk IS NOT NULL)
    ORDER BY COALESCE(u.upvote_time, fav.fav_added_at, c.last_seen_at) DESC
  `).all(questionId);

  if (answers.length === 0) {
    return { question: null, answers: [] };
  }

  // 从匹配的回答中选取非空标题（优先取最新同步回答的 question_title，回退到 title，最后兜底 questionId）
  const bestTitle =
    answers.map((a: any) => (a.question_title || "").trim()).find(Boolean) ||
    answers.map((a: any) => (a.title || "").trim()).find(Boolean) ||
    questionId;

  return {
    question: { question_id: questionId, question_title: bestTitle },
    answers
  };
}
