import { db } from "../db.js";

export async function upsertUpvote(contentPk: string, upvoteTime: string) {
  const now = new Date().toISOString();

  // upvotes 表没有外键：悬空 contentPk 会写入永久不可见的僵尸行
  // （listUpvotes 的 INNER JOIN 读不到它，也无任何清理路径）
  const contentExists = await db.prepare(`SELECT 1 FROM contents WHERE pk = ?`).get(contentPk);
  if (!contentExists) {
    return { created: false, skipped: true };
  }

  // 赞同时间没变就是没有新信息：无谓的 ON CONFLICT DO UPDATE 会每轮重写全量赞同行，
  // 直接跳过写库，把每日写入额度留给真正的新数据
  const existing = await db.prepare(
    `SELECT upvote_time FROM upvotes WHERE content_pk = ?`
  ).get(contentPk) as { upvote_time: string } | null;

  if (existing && existing.upvote_time === upvoteTime) {
    return { created: false, unchanged: true };
  }

  await db.prepare(`
    INSERT INTO upvotes (content_pk, first_seen_at, last_seen_at, upvote_time)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(content_pk) DO UPDATE SET last_seen_at = excluded.last_seen_at, upvote_time = excluded.upvote_time
  `).run(contentPk, now, now, upvoteTime);

  return { created: !existing };
}

export async function listUpvotes(params?: { page?: number; sort?: string }) {
  // page 钳制：超大值会让 OFFSET 超出 SQLite int64 直接 500
  const parsedPage = Number(params?.page ?? 1);
  const page = Number.isFinite(parsedPage) ? Math.min(Math.max(Math.trunc(parsedPage), 1), 100000) : 1;
  const limit = 50;
  const offset = (page - 1) * limit;
  const orderBy = params?.sort === "vote" ? `c.voteup_count DESC, u.upvote_time DESC` : `u.upvote_time DESC`;

  return await db.prepare(`
    SELECT c.pk, c.source_type, c.source_id, c.title, c.question_title, c.source_url, c.author_name, c.author_url_token, c.author_avatar, c.author_headline, c.excerpt,
           c.voteup_count, MAX(c.comment_count, COALESCE(c.archived_comment_count, 0)) AS comment_count, c.favorite_count, c.visit_count, c.created_time, c.updated_time, c.last_seen_at, c.is_deleted, u.upvote_time
    FROM upvotes u
    JOIN contents c ON u.content_pk = c.pk
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}
  `).all();
}
