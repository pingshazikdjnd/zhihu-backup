import { db } from "../db.js";

const FAV_JOIN = `(SELECT content_pk, MAX(first_seen_at) AS fav_added_at FROM collection_items WHERE is_removed = 0 GROUP BY content_pk)`;

export function listQuestions(params?: { page?: number; q?: string }) {
  const parsedPage = Number(params?.page ?? 1);
  const page = Number.isFinite(parsedPage) ? Math.min(Math.max(Math.trunc(parsedPage), 1), 100000) : 1;
  const limit = 50;
  const offset = (page - 1) * limit;

  const rawQ = (params?.q ?? "").trim();
  const hasQ = rawQ.length > 0;
  const escapedQ = hasQ ? `%${rawQ.replace(/[\\%_]/g, "\\$&")}%` : "";
  const qClause = hasQ ? `AND (c.question_title LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\')` : "";
  const bindArgs = hasQ ? [escapedQ, escapedQ] : [];

  const totalRow = db.prepare(`
    SELECT count(*) AS c FROM (
      SELECT c.question_id
      FROM contents c
      LEFT JOIN upvotes u ON u.content_pk = c.pk
      LEFT JOIN ${FAV_JOIN} ci ON ci.content_pk = c.pk
      WHERE c.source_type = 'answer'
        AND c.question_id IS NOT NULL AND c.question_id != ''
        AND (u.content_pk IS NOT NULL OR ci.content_pk IS NOT NULL)
        ${qClause}
      GROUP BY c.question_id
    )
  `).get(...bindArgs) as { c: number } | undefined;

  const rows = db.prepare(`
    SELECT
      c.question_id,
      COALESCE(MAX(NULLIF(c.question_title, '')), MAX(NULLIF(c.title, '')), c.question_id) AS question_title,
      count(*) AS answer_count,
      sum(CASE WHEN u.content_pk IS NOT NULL THEN 1 ELSE 0 END) AS upvoted_count,
      sum(CASE WHEN ci.content_pk IS NOT NULL THEN 1 ELSE 0 END) AS faved_count,
      max(COALESCE(u.upvote_time, ci.fav_added_at, c.last_seen_at)) AS latest_time
    FROM contents c
    LEFT JOIN upvotes u ON u.content_pk = c.pk
    LEFT JOIN ${FAV_JOIN} ci ON ci.content_pk = c.pk
    WHERE c.source_type = 'answer'
      AND c.question_id IS NOT NULL AND c.question_id != ''
      AND (u.content_pk IS NOT NULL OR ci.content_pk IS NOT NULL)
      ${qClause}
    GROUP BY c.question_id
    ORDER BY answer_count DESC, latest_time DESC
    LIMIT ${limit} OFFSET ${offset}
  `).all(...bindArgs);

  return { rows, total: totalRow?.c ?? 0 };
}

export function getQuestionAnswers(questionId: string) {
  const answers = db.prepare(`
    SELECT c.pk, c.source_id, c.title, c.question_title, c.source_url,
           c.author_name, c.author_url_token, c.author_avatar, c.author_headline,
           c.excerpt, c.voteup_count, c.comment_count, c.favorite_count, c.visit_count,
           c.is_deleted, c.is_collapsed,
           c.updated_time, c.last_seen_at,
           u.upvote_time,
           ci.fav_added_at,
           CASE WHEN ci.content_pk IS NOT NULL THEN 1 ELSE 0 END AS in_favorites
    FROM contents c
    LEFT JOIN upvotes u ON u.content_pk = c.pk
    LEFT JOIN ${FAV_JOIN} ci ON ci.content_pk = c.pk
    WHERE c.question_id = ?
      AND c.source_type = 'answer'
      AND (u.content_pk IS NOT NULL OR ci.content_pk IS NOT NULL)
    ORDER BY COALESCE(u.upvote_time, ci.fav_added_at, c.last_seen_at) DESC
  `).all(questionId) as any[];

  if (answers.length === 0) {
    return { question: null, answers: [] };
  }

  const bestTitle =
    answers.map(a => (a.question_title || "").trim()).find(Boolean) ||
    answers.map(a => (a.title || "").trim()).find(Boolean) ||
    questionId;

  return {
    question: { question_id: questionId, question_title: bestTitle },
    answers
  };
}
