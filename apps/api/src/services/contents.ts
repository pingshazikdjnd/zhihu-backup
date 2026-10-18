import { db } from "../db.js";
import { emitChange } from "./changes.js";
import { normalizeForHash, sha256 } from "../utils/hash.js";
import { buildSearchText } from "shared";
import type { IngestContentInput } from "shared";

const SEARCH_TEXT_LIMIT = 4000;

export function upsertContent(input: IngestContentInput) {
  const now = new Date().toISOString();
  const pk = `${input.sourceType}:${input.sourceId}`;
  const contentHash = sha256(
    normalizeForHash(input.contentMd || input.contentHtml || input.excerpt || "")
  );
  // 从正文生成纯文本存 content_md（否则 content_md 永远为空，搜索只能搜标题）
  const searchText = buildSearchText(input.contentMd || "", input.contentHtml || "", SEARCH_TEXT_LIMIT);

  const existing = db.prepare(`
    SELECT pk, content_hash, voteup_count, comment_count, favorite_count, visit_count,
           author_avatar, author_headline, is_collapsed, is_labeled, label_info
    FROM contents
    WHERE pk = ?
  `).get(pk) as any;

  const tx = db.transaction(() => {
    if (!existing) {
      db.prepare(`
        INSERT INTO contents (
          pk, source_type, source_id, source_url, title,
          author_name, author_url_token, author_avatar, author_headline,
          question_id, question_title, content_html, content_md, excerpt,
          voteup_count, comment_count, favorite_count, visit_count,
          is_collapsed, is_labeled, label_info,
          created_time, updated_time, content_hash, first_seen_at, last_seen_at, is_deleted, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
      `).run(
        pk,
        input.sourceType,
        input.sourceId,
        input.sourceUrl,
        input.title,
        input.author?.name ?? "",
        input.author?.urlToken ?? null,
        input.author?.avatarUrl ?? null,
        input.author?.headline ?? null,
        input.question?.id ?? null,
        input.question?.title ?? null,
        input.contentHtml,
        searchText,
        input.excerpt,
        input.voteupCount,
        input.commentCount,
        input.favoriteCount || 0,
        input.visitCount || 0,
        input.isCollapsed ? 1 : 0,
        input.isLabeled ? 1 : 0,
        input.labelInfo || null,
        input.createdTime || null,
        input.updatedTime || null,
        contentHash,
        now,
        now
      );

      db.prepare(`
        INSERT INTO content_versions (
          content_pk, version_hash, title, content_html, content_md, excerpt,
          voteup_count, comment_count, snapshot_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        pk,
        contentHash,
        input.title,
        input.contentHtml,
        input.contentMd,
        input.excerpt,
        input.voteupCount,
        input.commentCount,
        now
      );

      emitChange({
        eventType: "content.created",
        entityType: "content",
        entityPk: pk,
        contentPk: pk,
        summary: input.title || pk,
        payload: { pk, sourceUrl: input.sourceUrl }
      });

      return { pk, changed: true, created: true, prevCommentCount: 0 };
    }

    // Preserve existing stats if incoming are 0 to prevent data loss from faulty API responses
    const safeVoteupCount = (input.voteupCount === 0 && existing.voteup_count > 0) ? existing.voteup_count : input.voteupCount;
    const safeCommentCount = (input.commentCount === 0 && existing.comment_count > 0) ? existing.comment_count : input.commentCount;
    const safeFavoriteCount = (!input.favoriteCount && existing.favorite_count > 0) ? existing.favorite_count : (input.favoriteCount || 0);
    const safeVisitCount = (!input.visitCount && existing.visit_count > 0) ? existing.visit_count : (input.visitCount || 0);

    const safeAuthorAvatar = (input.author?.avatarUrl || existing.author_avatar) || null;
    const safeAuthorHeadline = (input.author?.headline || existing.author_headline) || null;
    const safeAuthorName = (input.author?.name || existing.author_name) || "";
    const safeContentHtml = (input.contentHtml || existing.content_html) || "";
    const safeContentMd = searchText || existing.content_md || "";

    const changes: string[] = [];
    let isBodyChanged = false;

    if (existing.content_hash !== contentHash) {
      changes.push("正文已更新");
      isBodyChanged = true;
    }
    if (existing.voteup_count !== safeVoteupCount) {
      changes.push(`点赞数(${existing.voteup_count} -> ${safeVoteupCount})`);
    }
    if (existing.comment_count !== safeCommentCount) {
      changes.push(`评论数(${existing.comment_count} -> ${safeCommentCount})`);
    }
    if (existing.favorite_count !== safeFavoriteCount) {
      changes.push(`收藏数(${existing.favorite_count} -> ${safeFavoriteCount})`);
    }
    if (existing.visit_count !== safeVisitCount) {
      changes.push(`浏览量(${existing.visit_count} -> ${safeVisitCount})`);
    }
    if (existing.author_avatar !== safeAuthorAvatar) {
      changes.push("作者头像更新");
    }
    if (existing.author_headline !== safeAuthorHeadline) {
      changes.push("作者简介更新");
    }
    const inputCollapsed = input.isCollapsed ? 1 : 0;
    if (existing.is_collapsed !== inputCollapsed) {
      changes.push("折叠状态更新");
    }
    const inputLabeled = input.isLabeled ? 1 : 0;
    if (existing.is_labeled !== inputLabeled) {
      changes.push("标签更新");
    }

    if (changes.length > 0) {
      db.prepare(`
        UPDATE contents
        SET title = ?, author_name = ?, author_url_token = ?, author_avatar = ?, author_headline = ?,
            source_url = ?, question_id = ?, question_title = ?, content_html = ?, content_md = ?, excerpt = ?,
            voteup_count = ?, comment_count = ?, favorite_count = ?, visit_count = ?,
            is_collapsed = ?, is_labeled = ?, label_info = ?,
            created_time = ?, updated_time = ?, content_hash = ?, last_seen_at = ?, is_deleted = 0, deleted_at = NULL
        WHERE pk = ?
      `).run(
        input.title,
        safeAuthorName,
        input.author?.urlToken ?? null,
        safeAuthorAvatar,
        safeAuthorHeadline,
        input.sourceUrl,
        input.question?.id ?? null,
        input.question?.title ?? null,
        safeContentHtml,
        safeContentMd,
        input.excerpt,
        safeVoteupCount,
        safeCommentCount,
        safeFavoriteCount,
        safeVisitCount,
        input.createdTime || null,
        input.updatedTime || null,
        contentHash,
        now,
        pk
      );

      if (isBodyChanged) {
        db.prepare(`
          INSERT INTO content_versions (
            content_pk, version_hash, title, content_html, content_md, excerpt,
            voteup_count, comment_count, snapshot_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          pk,
          contentHash,
          input.title,
          input.contentHtml,
          input.contentMd,
          input.excerpt,
          safeVoteupCount,
          safeCommentCount,
          now
        );
      }

      emitChange({
        eventType: "content.updated",
        entityType: "content",
        entityPk: pk,
        contentPk: pk,
        summary: `[数据更新] ${input.title || pk} - ${changes.join(", ")}`,
        payload: { pk, sourceUrl: input.sourceUrl }
      });

      let prevCommentCount = existing.comment_count;
      const hasUnmigratedComments = db.prepare(`SELECT 1 FROM comments WHERE content_pk = ? AND author_avatar IS NULL LIMIT 1`).get(pk);
      if (hasUnmigratedComments) {
        prevCommentCount = 0; // Force sync comments to populate new fields
      }

      return { pk, changed: true, created: false, prevCommentCount };
    }

    let prevCommentCount = existing.comment_count;
    const hasUnmigratedComments = db.prepare(`SELECT 1 FROM comments WHERE content_pk = ? AND author_avatar IS NULL LIMIT 1`).get(pk);
    if (hasUnmigratedComments) {
      prevCommentCount = 0; // Force sync comments to populate new fields
    }

    db.prepare(`
      UPDATE contents
      SET last_seen_at = ?, is_deleted = 0, deleted_at = NULL
      WHERE pk = ?
    `).run(
      now,
      pk
    );

    return { pk, changed: false, created: false, prevCommentCount };
  });

  return tx();
}

export function listContents(params: { type?: string; q?: string; author?: string; page?: number }) {
  const conditions: string[] = [];
  const values: (string | number)[] = [];

  if (params.type) {
    conditions.push(`source_type = ?`);
    values.push(params.type);
  }

  if (params.author) {
    conditions.push(`(author_name = ? OR author_url_token = ?)`);
    values.push(params.author, params.author);
  }

  if (params.q) {
    conditions.push(`(title LIKE ? OR question_title LIKE ? OR content_md LIKE ?)`);
    const kw = `%${params.q}%`;
    values.push(kw, kw, kw);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const page = params.page || 1;
  const limit = 50;
  const offset = (page - 1) * limit;

  const totalRow = db.prepare(`
    SELECT count(*) as c FROM contents ${where}
  `).get(...values) as { c: number };

  const rows = db.prepare(`
    SELECT pk, source_type, source_id, title, question_title, source_url, author_name, author_url_token, excerpt,
           voteup_count, comment_count, favorite_count, visit_count, updated_time, last_seen_at, is_deleted
    FROM contents
    ${where}
    ORDER BY COALESCE(updated_time, last_seen_at) DESC
    LIMIT ${limit} OFFSET ${offset}
  `).all(...values);

  return { rows, total: totalRow.c };
}

export function getContentDetail(pk: string) {
  const content = db.prepare(`
    SELECT *
    FROM contents
    WHERE pk = ?
  `).get(pk);

  const versions = db.prepare(`
    SELECT id, version_hash, snapshot_at, voteup_count, comment_count
    FROM content_versions
    WHERE content_pk = ?
    ORDER BY snapshot_at DESC
  `).all(pk);

  return { content, versions };
}
