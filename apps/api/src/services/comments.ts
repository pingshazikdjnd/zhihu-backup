import { db } from "../db.js";
import { emitChange } from "./changes.js";
import { normalizeForHash, sha256 } from "../utils/hash.js";
import type { IngestCommentsInput } from "shared";

export function replaceComments(input: IngestCommentsInput) {
  const now = new Date().toISOString();

  const existingRows = db.prepare(`
    SELECT id, comment_hash, is_deleted, author_avatar, likes, time_text, location
    FROM comments
    WHERE content_pk = ?
  `).all(input.contentPk) as Array<{
    id: string;
    comment_hash: string;
    is_deleted: number;
    author_avatar: string | null;
    likes: number;
    time_text: string | null;
    location: string | null;
  }>;

  const existingMap = new Map(existingRows.map(row => [row.id, row]));
  // 知乎评论按点赞序+offset 分页，抓取期间点赞变化会让同一条评论漂移到
  // 相邻页，payload 里出现重复 id：不去重的话两条同 id INSERT 撞主键，
  // 整个事务回滚。Map 保留最后一次出现的值。
  const uniqueComments = new Map<string, IngestCommentsInput["comments"][number]>();
  for (const c of input.comments) {
    uniqueComments.set(c.id, c);
  }
  // 图片与 hash 在写循环外一次算好：
  // - img 是标准字段，imageUrl 是旧通道兼容字段，标准 img 优先；
  // - hash 输入仍是 `${content}|${img}|${likes}`，同一评论换通道不会因字段名不同而反复产生版本/事件。
  const preparedComments = new Map<string, {
    comment: IngestCommentsInput["comments"][number];
    img: string;
    hash: string;
  }>();
  for (const c of uniqueComments.values()) {
    const img = c.img || c.imageUrl || "";
    const hash = sha256(normalizeForHash(`${c.content}|${img}|${c.likes}`));
    preparedComments.set(c.id, { comment: c, img, hash });
  }
  // 分批写入时对账基准是 allIds（全量），单发时是本次 comments 的 id
  const incomingIds = new Set(input.allIds ?? input.comments.map(c => c.id));

  let added = 0;
  let updated = 0;
  let deleted = 0;

  const insertComment = db.prepare(`
    INSERT INTO comments (
      id, content_pk, parent_comment_id, author_name, author_avatar, be_replied,
      content_md, img_url, time_text, location, likes, is_author, is_top, is_featured, comment_hash,
      first_seen_at, last_seen_at, is_deleted, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
  `);
  const insertVersion = db.prepare(`
    INSERT INTO comment_versions (
      comment_id, content_pk, version_hash, content_md, img_url, likes, snapshot_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const updateComment = db.prepare(`
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
  `);
  const refreshComment = db.prepare(`
    UPDATE comments
    SET author_avatar = COALESCE(NULLIF(?, ''), author_avatar),
        last_seen_at = ?, likes = ?, time_text = ?, location = ?,
        is_deleted = 0, deleted_at = NULL
    WHERE id = ?
  `);
  const markDeleted = db.prepare(`
    UPDATE comments
    SET is_deleted = 1, deleted_at = ?, last_seen_at = ?
    WHERE id = ?
  `);

  const tx = db.transaction(() => {
    for (const { comment: c, img, hash } of preparedComments.values()) {
      const exists = existingMap.get(c.id);

      if (!exists) {
        insertComment.run(
          c.id,
          input.contentPk,
          c.parentId ?? null,
          c.author,
          c.authorAvatar,
          c.beReplied ?? null,
          c.content,
          img,
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

        insertVersion.run(c.id, input.contentPk, hash, c.content, img, c.likes, now);

        emitChange({
          eventType: "comment.added",
          entityType: "comment",
          entityPk: c.id,
          contentPk: input.contentPk,
          summary: `${c.author}: ${c.content.slice(0, 30)}`,
          payload: { commentId: c.id, contentPk: input.contentPk }
        });

        added++;
        continue;
      }

      if (exists.comment_hash !== hash || exists.is_deleted === 1) {
        updateComment.run(
          c.parentId ?? null,
          c.author,
          c.authorAvatar,
          c.beReplied ?? null,
          c.content,
          img,
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

        insertVersion.run(c.id, input.contentPk, hash, c.content, img, c.likes, now);

        emitChange({
          eventType: "comment.updated",
          entityType: "comment",
          entityPk: c.id,
          contentPk: input.contentPk,
          summary: `${c.author}: ${c.content.slice(0, 30)}`,
          payload: { commentId: c.id, contentPk: input.contentPk }
        });

        updated++;
        continue;
      }

      // 内容没变，只在头像/时间/位置确有变化时才刷新；
      // 点赞数已纳入 comment_hash，不再单独判断。删除态复活由上面的更新分支处理。
      // 旧行 time_text/location 可能是 NULL，本次抓取缺失时是空串：二者视为相同，
      // 否则每次同步都会因 NULL !== "" 再发一条刷新 UPDATE。
      const needsRefresh =
        (!!c.authorAvatar && c.authorAvatar !== exists.author_avatar) ||
        (exists.time_text || "") !== (c.time || "") ||
        (exists.location || "") !== (c.location || "");

      if (needsRefresh) {
        refreshComment.run(c.authorAvatar, now, c.likes, c.time, c.location, c.id);
      }
    }

    for (const row of existingRows) {
      if (input.partial) break; // 数据不完整时跳过删除检测，防止误标删除
      if (!incomingIds.has(row.id) && row.is_deleted === 0) {
        markDeleted.run(now, now, row.id);

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
