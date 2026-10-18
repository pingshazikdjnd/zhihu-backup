import { db } from "../db.js";
import { emitChange } from "./changes.js";
import { normalizeForHash, sha256 } from "../utils/hash.js";
import type { IngestCommentsInput } from "shared";

export function replaceComments(input: IngestCommentsInput) {
  const now = new Date().toISOString();

  const existingRows = db.prepare(`
    SELECT id, comment_hash, is_deleted
    FROM comments
    WHERE content_pk = ?
  `).all(input.contentPk) as Array<{
    id: string;
    comment_hash: string;
    is_deleted: number;
  }>;

  const existingMap = new Map(existingRows.map(row => [row.id, row]));
  const incomingIds = new Set(input.comments.map(c => c.id));

  let added = 0;
  let updated = 0;
  let deleted = 0;

  const tx = db.transaction(() => {
    for (const c of input.comments) {
      const hash = sha256(normalizeForHash(`${c.content}|${c.img}|${c.likes}`));
      const exists = existingMap.get(c.id);

      if (!exists) {
        db.prepare(`
          INSERT INTO comments (
            id, content_pk, parent_comment_id, author_name, author_avatar, be_replied,
            content_md, img_url, time_text, location, likes, is_author, is_top, is_featured, comment_hash,
            first_seen_at, last_seen_at, is_deleted, deleted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
        `).run(
          c.id,
          input.contentPk,
          c.parentId ?? null,
          c.author,
          c.authorAvatar,
          c.beReplied ?? null,
          c.content,
          c.img,
          c.time,
          c.location,
          c.likes,
          c.isAuthor ? 1 : 0,
          c.isTop ? 1 : 0,
          c.isFeatured ? 1 : 0,
          hash,
          now,
          now
        );

        db.prepare(`
          INSERT INTO comment_versions (
            comment_id, content_pk, version_hash, content_md, img_url, likes, snapshot_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(c.id, input.contentPk, hash, c.content, c.img, c.likes, now);

        emitChange({
          eventType: "comment.added",
          entityType: "comment",
          entityPk: c.id,
          contentPk: input.contentPk,
          summary: `${c.author}: ${c.content.slice(0, 30)}`,
          payload: c
        });

        added++;
        continue;
      }

      if (exists.comment_hash !== hash || exists.is_deleted === 1) {
        db.prepare(`
          UPDATE comments
          SET parent_comment_id = ?, 
              author_name = COALESCE(NULLIF(?, ''), author_name), 
              author_avatar = COALESCE(NULLIF(?, ''), author_avatar), 
              be_replied = ?,
              content_md = COALESCE(NULLIF(?, ''), content_md), 
              img_url = COALESCE(NULLIF(?, ''), img_url), 
              time_text = COALESCE(NULLIF(?, ''), time_text), 
              location = COALESCE(NULLIF(?, ''), location),
              likes = ?, is_author = ?, is_top = ?, is_featured = ?, comment_hash = ?, last_seen_at = ?,
              is_deleted = 0, deleted_at = NULL
          WHERE id = ?
        `).run(
          c.parentId ?? null,
          c.author,
          c.authorAvatar,
          c.beReplied ?? null,
          c.content,
          c.img,
          c.time,
          c.location,
          c.likes,
          c.isAuthor ? 1 : 0,
          c.isTop ? 1 : 0,
          c.isFeatured ? 1 : 0,
          hash,
          now,
          c.id
        );

        db.prepare(`
          INSERT INTO comment_versions (
            comment_id, content_pk, version_hash, content_md, img_url, likes, snapshot_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(c.id, input.contentPk, hash, c.content, c.img, c.likes, now);

        emitChange({
          eventType: "comment.updated",
          entityType: "comment",
          entityPk: c.id,
          contentPk: input.contentPk,
          summary: `${c.author}: ${c.content.slice(0, 30)}`,
          payload: c
        });

        updated++;
      } else {
        db.prepare(`
          UPDATE comments
          SET last_seen_at = ?, likes = ?, time_text = ?, location = ?, is_deleted = 0, deleted_at = NULL
          WHERE id = ?
        `).run(now, c.likes, c.time, c.location, c.id);
      }
    }

    for (const row of existingRows) {
      if (input.partial) break; // 数据不完整时跳过删除检测，防止误标删除
      if (!incomingIds.has(row.id) && row.is_deleted === 0) {
        db.prepare(`
          UPDATE comments
          SET is_deleted = 1, deleted_at = ?, last_seen_at = ?
          WHERE id = ?
        `).run(now, now, row.id);

        emitChange({
          eventType: "comment.deleted",
          entityType: "comment",
          entityPk: row.id,
          contentPk: input.contentPk,
          summary: row.id,
          payload: { commentId: row.id }
        });

        deleted++;
      }
    }
  });

  tx();
  return { added, updated, deleted };
}

export function listComments(contentPk: string) {
  return db.prepare(`
    SELECT *
    FROM comments
    WHERE content_pk = ?
    ORDER BY first_seen_at ASC
  `).all(contentPk);
}
