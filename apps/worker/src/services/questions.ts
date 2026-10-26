import { db } from "../db.js";

/**
 * 按知乎「问题」维度聚合用户赞同/收藏过的回答。
 *
 * 数据模型：contents.question_id/question_title 只在 answer 类型上有值；
 * upvotes（赞同过）与 collection_items（收藏着，is_removed=0）标记"与我相关"。
 * 一条回答可能同时被赞同和收藏、也可能躺在多个收藏夹——收藏侧先 DISTINCT
 * 再 JOIN，避免行数膨胀把 count 放大。
 */

// 收藏侧去重后的关联：每个 pk 一行。
// 用 idx_collection_items_collection (collection_id, is_removed, ...) 只取 is_removed=0 的行
// 再 DISTINCT content_pk，子查询物化一次后供外层逐行探测
const FAV_JOIN = `(SELECT DISTINCT content_pk FROM collection_items WHERE is_removed = 0)`;

export async function listQuestions(params?: { page?: number }) {
  const parsedPage = Number(params?.page ?? 1);
  const page = Number.isFinite(parsedPage) ? Math.min(Math.max(Math.trunc(parsedPage), 1), 100000) : 1;
  const limit = 50;
  const offset = (page - 1) * limit;

  const totalRow = await db.prepare(`
    SELECT count(*) AS c FROM (
      SELECT c.question_id
      FROM contents c
      LEFT JOIN upvotes u ON u.content_pk = c.pk
      LEFT JOIN ${FAV_JOIN} ci ON ci.content_pk = c.pk
      WHERE c.source_type = 'answer'
        AND c.question_id IS NOT NULL AND c.question_id != ''
        AND (u.content_pk IS NOT NULL OR ci.content_pk IS NOT NULL)
      GROUP BY c.question_id
    )
  `).get() as { c: number };

  const rows = await db.prepare(`
    SELECT
      c.question_id,
      c.question_title,
      count(*) AS answer_count,
      sum(CASE WHEN u.content_pk IS NOT NULL THEN 1 ELSE 0 END) AS upvoted_count,
      sum(CASE WHEN ci.content_pk IS NOT NULL THEN 1 ELSE 0 END) AS faved_count,
      max(COALESCE(u.upvote_time, c.last_seen_at)) AS latest_time
    FROM contents c
    LEFT JOIN upvotes u ON u.content_pk = c.pk
    LEFT JOIN ${FAV_JOIN} ci ON ci.content_pk = c.pk
    WHERE c.source_type = 'answer'
      AND c.question_id IS NOT NULL AND c.question_id != ''
      AND (u.content_pk IS NOT NULL OR ci.content_pk IS NOT NULL)
    GROUP BY c.question_id, c.question_title
    ORDER BY answer_count DESC, latest_time DESC
    LIMIT ${limit} OFFSET ${offset}
  `).all();

  return { rows, total: totalRow.c };
}

export async function getQuestionAnswers(questionId: string) {
  const question = await db.prepare(`
    SELECT question_id, question_title FROM contents
    WHERE question_id = ? AND source_type = 'answer' AND question_title IS NOT NULL
    LIMIT 1
  `).get(questionId);

  const answers = await db.prepare(`
    SELECT c.pk, c.source_id, c.title, c.source_url,
           c.author_name, c.author_url_token, c.author_avatar, c.author_headline,
           c.excerpt, c.voteup_count, c.comment_count, c.favorite_count, c.visit_count,
           c.updated_time, c.last_seen_at,
           u.upvote_time,
           CASE WHEN ci.content_pk IS NOT NULL THEN 1 ELSE 0 END AS in_favorites
    FROM contents c
    LEFT JOIN upvotes u ON u.content_pk = c.pk
    LEFT JOIN ${FAV_JOIN} ci ON ci.content_pk = c.pk
    WHERE c.question_id = ?
      AND c.source_type = 'answer'
      AND (u.content_pk IS NOT NULL OR ci.content_pk IS NOT NULL)
    ORDER BY COALESCE(u.upvote_time, c.last_seen_at) DESC
  `).all(questionId);

  return { question, answers };
}
