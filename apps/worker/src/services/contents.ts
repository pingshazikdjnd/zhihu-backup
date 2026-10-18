import { db } from "../db.js";
import { emitChange } from "./changes.js";
import { normalizeForHash, sha256 } from "../utils/hash.js";
import { buildSearchText } from "shared";
import type { IngestContentInput } from "shared";

// D1 单行正文上限：正文原文存 R2，D1 只留纯文本供检索
const SEARCH_TEXT_LIMIT = 4000;

export async function upsertContent(input: IngestContentInput) {
  const now = new Date().toISOString();
  const pk = `${input.sourceType}:${input.sourceId}`;
  // 保存原始正文：清空入库前，版本快照必须留有真实内容
  const rawHtml = input.contentHtml ?? "";
  const rawMd = input.contentMd ?? "";
  // 可搜索正文（HTML 原文存 R2，D1 保留纯文本，否则 content_md LIKE 永远匹配不到）
  const searchText = buildSearchText(rawMd, rawHtml, SEARCH_TEXT_LIMIT);
  const contentHash = await sha256(
    normalizeForHash(rawMd || rawHtml || input.excerpt || "")
  );

  // If excerpt is missing, extract from markdown/html before clearing them
  if (!input.excerpt || input.excerpt === "null" || input.excerpt.trim() === "") {
    const raw = (rawMd || rawHtml).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (raw) {
      input.excerpt = raw.slice(0, 300);
    }
  }

  // 注意：不能就地清空 input.contentHtml / input.contentMd。
  // 调用方（routes/ingest.ts）在 upsert 之后还要用这两个字段写 R2，
  // mutate 入参会让 R2 里存进空字符串。D1 侧只写空串的意图由下面的
  // safeContentHtml 单独控制。

  // 注意：下面这些列必须与后面 `existing.xxx || ""` 的兜底字段一一对应。
  // 之前漏了 author_name / content_html / content_md，导致兜底恒为 undefined：
  // 只要某次 ingest 不带正文（例如只更新点赞数），content_md（D1 里唯一的可搜索文本）
  // 就会被清空，全文搜索逐步失效且不可逆。
  const existing = await db.prepare(`
    SELECT pk, content_hash, voteup_count, comment_count, favorite_count, visit_count,
           author_name, author_avatar, author_headline,
           content_html, content_md,
           is_collapsed, is_labeled, label_info
    FROM contents
    WHERE pk = ?
  `).get(pk) as any;

  return await db.transaction(async () => {
    if (!existing) {
      await db.prepare(`
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
        "",           // content_html 清空，原文在 R2
        searchText,   // content_md 存纯文本，供检索
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

      // 没有正文的入库（例如赞同动态里 target.content 为空）不插空版本，
      // 否则版本历史会被空行污染，后面对比"正文是否变化"也会失真。
      if (rawHtml || rawMd) {
        await db.prepare(`
          INSERT INTO content_versions (
            content_pk, version_hash, title, content_html, content_md, excerpt,
            voteup_count, comment_count, snapshot_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          pk,
          contentHash,
          input.title,
          "", // 版本正文不写进 D1（原文在 R2 的 versions/{pk}/{hash}）
          "",
          input.excerpt,
          input.voteupCount,
          input.commentCount,
          now
        );
      }

      await emitChange({
        eventType: "content.created",
        entityType: "content",
        entityPk: pk,
        contentPk: pk,
        summary: input.title || pk,
        payload: { pk, sourceUrl: input.sourceUrl }
      });

      return { pk, changed: true, created: true, prevCommentCount: 0, hash: contentHash };
    }

    // Preserve existing stats if incoming are 0 to prevent data loss from faulty API responses
    const safeVoteupCount = (input.voteupCount === 0 && existing.voteup_count > 0) ? existing.voteup_count : input.voteupCount;
    const safeCommentCount = (input.commentCount === 0 && existing.comment_count > 0) ? existing.comment_count : input.commentCount;
    const safeFavoriteCount = (!input.favoriteCount && existing.favorite_count > 0) ? existing.favorite_count : (input.favoriteCount || 0);
    const safeVisitCount = (!input.visitCount && existing.visit_count > 0) ? existing.visit_count : (input.visitCount || 0);

    const safeAuthorAvatar = (input.author?.avatarUrl || existing.author_avatar) || null;
    const safeAuthorHeadline = (input.author?.headline || existing.author_headline) || null;
    const safeAuthorName = (input.author?.name || existing.author_name) || "";
    // D1 不存正文原文（原文在 R2），只保留历史行里可能存在的旧值
    const safeContentHtml = existing.content_html || "";
    // 优先用本次生成的可搜索正文，否则保留库里的旧值
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
      // D1 没有交互式事务，batch 是唯一的原子手段：
      // 「更新 contents」和「写 content_versions」必须同生共死。
      const stmts: any[] = [];

      stmts.push(db.prepare(`
        UPDATE contents
        SET title = ?, author_name = ?, author_url_token = ?, author_avatar = ?, author_headline = ?,
            source_url = ?, question_id = ?, question_title = ?, content_html = ?, content_md = ?, excerpt = ?,
            voteup_count = ?, comment_count = ?, favorite_count = ?, visit_count = ?,
            is_collapsed = ?, is_labeled = ?, label_info = ?,
            created_time = ?, updated_time = ?, content_hash = ?, last_seen_at = ?, is_deleted = 0, deleted_at = NULL
        WHERE pk = ?
      `).raw(
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
        input.isCollapsed ? 1 : 0,
        input.isLabeled ? 1 : 0,
        input.labelInfo || null,
        input.createdTime || null,
        input.updatedTime || null,
        contentHash,
        now,
        pk
      ));

      // 同样：无正文的更新不写版本，只更新计数
      if (isBodyChanged && (rawHtml || rawMd)) {
        stmts.push(db.prepare(`
          INSERT INTO content_versions (
            content_pk, version_hash, title, content_html, content_md, excerpt,
            voteup_count, comment_count, snapshot_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).raw(
          pk,
          contentHash,
          input.title,
          "", // 版本正文不写进 D1（原文在 R2 的 versions/{pk}/{hash}）
          "",
          input.excerpt,
          safeVoteupCount,
          safeCommentCount,
          now
        ));
      }

      await db.batch(stmts);

      await emitChange({
        eventType: "content.updated",
        entityType: "content",
        entityPk: pk,
        contentPk: pk,
        summary: `[数据更新] ${input.title || pk} - ${changes.join(", ")}`,
        payload: { pk, sourceUrl: input.sourceUrl }
      });

      let prevCommentCount = existing.comment_count;
      const hasUnmigratedComments = await db.prepare(`SELECT 1 FROM comments WHERE content_pk = ? AND author_avatar IS NULL LIMIT 1`).get(pk);
      if (hasUnmigratedComments) {
        prevCommentCount = 0; // Force sync comments to populate new fields
      }

      return { pk, changed: true, created: false, prevCommentCount, hash: contentHash };
    }

    let prevCommentCount = existing.comment_count;
    const hasUnmigratedComments = await db.prepare(`SELECT 1 FROM comments WHERE content_pk = ? AND author_avatar IS NULL LIMIT 1`).get(pk);
    if (hasUnmigratedComments) {
      prevCommentCount = 0; // Force sync comments to populate new fields
    }

    await db.prepare(`
      UPDATE contents
      SET last_seen_at = ?, is_deleted = 0, deleted_at = NULL
      WHERE pk = ?
    `).run(
      now,
      pk
    );

    return { pk, changed: false, created: false, prevCommentCount, hash: contentHash };
  });
}

export async function listContents(params: { type?: string; q?: string; author?: string; page?: number }) {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.type) {
    conditions.push(`c.source_type = ?`);
    values.push(params.type);
  }

  if (params.author) {
    conditions.push(`(c.author_name = ? OR c.author_url_token = ?)`);
    values.push(params.author, params.author);
  }

  if (params.q) {
    conditions.push(`(c.title LIKE ? OR c.question_title LIKE ? OR c.content_md LIKE ?)`);
    const kw = `%${params.q}%`;
    values.push(kw, kw, kw);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const page = params.page || 1;
  const limit = 50;
  const offset = (page - 1) * limit;

  const totalRow = await db.prepare(`
    SELECT count(*) as c FROM contents c ${where}
  `).get(...values) as { c: number };

  const rows = await db.prepare(`
    SELECT c.pk, c.source_type, c.source_id, c.title, c.question_title, c.source_url,
           c.author_name, c.author_url_token, c.author_avatar, c.author_headline, c.excerpt,
           c.voteup_count, c.comment_count, c.favorite_count, c.visit_count,
           c.updated_time, c.last_seen_at, c.is_deleted, u.upvote_time
    FROM contents c
    LEFT JOIN upvotes u ON u.content_pk = c.pk
    ${where}
    ORDER BY COALESCE(c.updated_time, c.last_seen_at) DESC
    LIMIT ${limit} OFFSET ${offset}
  `).all(...values);

  return { rows, total: totalRow.c };
}

export async function getContentDetail(pk: string) {
  const content = await db.prepare(`
    SELECT *
    FROM contents
    WHERE pk = ?
  `).get(pk);

  const versions = await db.prepare(`
    SELECT id, version_hash, snapshot_at, voteup_count, comment_count
    FROM content_versions
    WHERE content_pk = ?
    ORDER BY snapshot_at DESC
  `).all(pk);

  return { content, versions };
}
