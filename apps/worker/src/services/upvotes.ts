import { db } from "../db.js";

export async function upsertUpvote(contentPk: string, upvoteTime: string) {
  const now = new Date().toISOString();

  // upvotes 表没有外键：悬空 contentPk 会写入永久不可见的僵尸行
  // （listUpvotes 的 INNER JOIN 读不到它，也无任何清理路径）
  const contentExists = await db.prepare(`SELECT 1 FROM contents WHERE pk = ?`).get(contentPk);
  if (!contentExists) {
    return { created: false, skipped: true };
  }

  const existing = await db.prepare(`SELECT 1 FROM upvotes WHERE content_pk = ?`).get(contentPk);

  await db.prepare(`
    INSERT INTO upvotes (content_pk, first_seen_at, last_seen_at, upvote_time)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(content_pk) DO UPDATE SET last_seen_at = excluded.last_seen_at, upvote_time = excluded.upvote_time
  `).run(contentPk, now, now, upvoteTime);

  return { created: !existing };
}

export async function listUpvotes(params?: { page?: number }) {
  const page = params?.page || 1;
  const limit = 50;
  const offset = (page - 1) * limit;

  return await db.prepare(`
    SELECT c.pk, c.source_type, c.source_id, c.title, c.question_title, c.source_url, c.author_name, c.author_url_token, c.excerpt,
           c.voteup_count, c.comment_count, c.favorite_count, c.visit_count, c.updated_time, c.last_seen_at, c.is_deleted, u.upvote_time
    FROM upvotes u
    JOIN contents c ON u.content_pk = c.pk
    ORDER BY u.upvote_time DESC, u.rowid DESC
    LIMIT ${limit} OFFSET ${offset}
  `).all();
}
