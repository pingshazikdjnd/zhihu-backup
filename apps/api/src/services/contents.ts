import { db } from "../db.js";
import { emitChange } from "./changes.js";
import { normalizeForHash, sha256 } from "../utils/hash.js";
import { buildSearchText } from "shared";
import type { IngestContentInput } from "shared";

const SEARCH_TEXT_LIMIT = 4000;

export function upsertContent(input: IngestContentInput) {
  const now = new Date().toISOString();
  const pk = `${input.sourceType}:${input.sourceId}`;
  // 保存原始正文：版本快照必须留有真实内容
  const rawHtml = input.contentHtml ?? "";
  const rawMd = input.contentMd ?? "";
  const rawContentHash = sha256(
    normalizeForHash(rawMd || rawHtml || input.excerpt || "")
  );
  // 从正文生成纯文本存 content_md（否则 content_md 永远为空，搜索只能搜标题）
  const searchText = buildSearchText(rawMd, rawHtml, SEARCH_TEXT_LIMIT);

  // 注意：下面这些列必须与后面 `existing.xxx || ""` 的兜底字段一一对应。
  // 漏选 author_name / content_html / content_md 会让兜底恒为 undefined：
  // 只要某次 ingest 不带正文（例如只更新点赞数），整行 UPDATE 时正文就会被清空。
  const existing = db.prepare(`
    SELECT pk, title, source_url, excerpt, question_id, question_title, author_url_token, created_time, updated_time,
           content_hash, voteup_count, comment_count, favorite_count, visit_count,
           author_name, author_avatar, author_headline,
           content_html, content_md,
           is_collapsed, is_labeled, label_info
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
        // 空串头像/简介存 null 而不是 ""，避免后续 null 与 "" 比较恒不等、
        // 每次重同步都发一条假「作者资料更新」
        input.author?.avatarUrl || null,
        input.author?.headline || null,
        input.question?.id ?? null,
        input.question?.title ?? null,
        rawHtml,
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
        rawContentHash,
        now,
        now
      );

      // 没有正文的入库（例如赞同动态里 target.content 为空）不插空版本，
      // 否则版本历史会被空行污染，后面对比「正文是否变化」也会失真。
      if (rawHtml || rawMd) {
        db.prepare(`
          INSERT INTO content_versions (
            content_pk, version_hash, title, content_html, content_md, excerpt,
            voteup_count, comment_count, snapshot_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          pk,
          rawContentHash,
          input.title,
          rawHtml,
          rawMd,
          input.excerpt,
          input.voteupCount,
          input.commentCount,
          now
        );
      }

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

    // 无正文的更新（如赞同动态里 target.content 为空）不能覆盖正文哈希：
    // 空串哈希没有对应的版本内容，等价于把「正文已更新」变成每轮都触发的假变更。
    // 计数仍正常更新，哈希沿用库里的旧值。
    const contentHash = (rawHtml || rawMd) ? rawContentHash : existing.content_hash;

    // 弱数据源常缺 question / 时间戳，抓取端缺字段时会写 1970-01-01 哨兵：
    // 空值与哨兵都不得覆盖库里的旧值。1970 哨兵还会让排序恒命中假时间、跌底。
    const isRealTime = (s?: string | null) => !!s && !s.startsWith("1970-01-01");
    // 弱载荷缺 question 时会带非空占位串（"未知问题"、/question/undefined/）：
    // 非空但错误，同样不能覆盖库里的真实值
    const PLACEHOLDER_TITLES = new Set(["未知问题", "未知文章", "无标题"]);
    const safeTitle = (input.title && !PLACEHOLDER_TITLES.has(input.title))
      ? input.title
      : (existing.title || input.title || "");
    const safeSourceUrl = input.sourceUrl.includes("undefined")
      ? (existing.source_url || input.sourceUrl)
      : input.sourceUrl;
    const safeExcerpt = input.excerpt || existing.excerpt || "";
    const safeQuestionId = input.question?.id || existing.question_id;
    const safeQuestionTitle = input.question?.title || existing.question_title;
    const safeUrlToken = input.author?.urlToken || existing.author_url_token;
    const safeLabelInfo = input.labelInfo || existing.label_info;
    const safeCreatedTime = isRealTime(input.createdTime) ? input.createdTime : existing.created_time;
    const safeUpdatedTime = isRealTime(input.updatedTime) ? input.updatedTime : existing.updated_time;

    // Preserve existing stats if incoming are 0 to prevent data loss from faulty API responses
    const safeVoteupCount = (input.voteupCount === 0 && existing.voteup_count > 0) ? existing.voteup_count : input.voteupCount;
    const safeCommentCount = (input.commentCount === 0 && existing.comment_count > 0) ? existing.comment_count : input.commentCount;
    const safeFavoriteCount = (!input.favoriteCount && existing.favorite_count > 0) ? existing.favorite_count : (input.favoriteCount || 0);
    const safeVisitCount = (!input.visitCount && existing.visit_count > 0) ? existing.visit_count : (input.visitCount || 0);

    const safeAuthorAvatar = (input.author?.avatarUrl || existing.author_avatar) || null;
    const safeAuthorHeadline = (input.author?.headline || existing.author_headline) || null;
    const safeAuthorName = (input.author?.name || existing.author_name) || "";
    // 正文原文在 contents 里保留，只有本次没带正文时才沿用旧值
    const safeContentHtml = (rawHtml || existing.content_html) || "";
    // 优先用本次生成的可搜索正文，否则保留库里的旧值
    const safeContentMd = searchText || existing.content_md || "";

    // 变更分三组：body 组必须整行落库并留版本/发事件；profile 组只是作者头像/简介
    // 这类装饰性元数据；counter 组只是热度数字在动。后两组都用轻量 UPDATE 落库，
    // 不写版本、不发事件、不计 changed，否则每次同步都追加 content_versions + 事件，
    // 写入量被计数抖动放大，爬虫也永远等不到 changed=false 而无法早停。
    const bodyChanges: string[] = [];
    // 头像 CDN 域名会轮换，同一头像每次 URL 字符串都不同，不能参与「内容是否变更」判定
    const profileChanges: string[] = [];
    const counterChanges: string[] = [];
    let isBodyChanged = false;

    // title 参与变更检测：否则「仅改标题」的更新走零事件分支，标题根本不落库
    if (existing.title !== safeTitle) {
      bodyChanges.push(`标题(${existing.title || "无"} -> ${safeTitle || "无"})`);
    }
    if (existing.content_hash !== contentHash) {
      bodyChanges.push("正文已更新");
      isBodyChanged = true;
    }
    if (existing.voteup_count !== safeVoteupCount) {
      counterChanges.push(`点赞数(${existing.voteup_count} -> ${safeVoteupCount})`);
    }
    if (existing.comment_count !== safeCommentCount) {
      counterChanges.push(`评论数(${existing.comment_count} -> ${safeCommentCount})`);
    }
    if (existing.favorite_count !== safeFavoriteCount) {
      counterChanges.push(`收藏数(${existing.favorite_count} -> ${safeFavoriteCount})`);
    }
    if (existing.visit_count !== safeVisitCount) {
      counterChanges.push(`浏览量(${existing.visit_count} -> ${safeVisitCount})`);
    }
    if (existing.author_avatar !== safeAuthorAvatar) {
      profileChanges.push("作者头像更新");
    }
    if (existing.author_headline !== safeAuthorHeadline) {
      profileChanges.push("作者简介更新");
    }
    const inputCollapsed = input.isCollapsed ? 1 : 0;
    if (existing.is_collapsed !== inputCollapsed) {
      bodyChanges.push("折叠状态更新");
    }
    const inputLabeled = input.isLabeled ? 1 : 0;
    if (existing.is_labeled !== inputLabeled) {
      bodyChanges.push("标签更新");
    }

    // comments 表尚无评论时强制返回 0，触发爬虫补抓；所有返回路径共用。
    // 不能用 author_avatar IS NULL 判定「旧格式未迁移」：匿名/注销用户的头像本来
    // 就是空，会让这些内容永远被判为未抓全、每轮全量重抓评论，早停被反复清零。
    const resolvePrevCommentCount = () => {
      let prevCommentCount = existing.comment_count;
      if (prevCommentCount > 0) {
        const cStat = db.prepare(
          `SELECT COUNT(*) AS cnt FROM comments WHERE content_pk = ?`
        ).get(pk) as { cnt: number } | undefined;
        if (!cStat || Number(cStat.cnt) === 0) {
          prevCommentCount = 0;
        }
      }
      return prevCommentCount;
    };

    if (bodyChanges.length > 0) {
      const changes = bodyChanges.concat(profileChanges, counterChanges);

      db.prepare(`
        UPDATE contents
        SET title = ?, author_name = ?, author_url_token = ?, author_avatar = ?, author_headline = ?,
            source_url = ?, question_id = ?, question_title = ?, content_html = ?, content_md = ?, excerpt = ?,
            voteup_count = ?, comment_count = ?, favorite_count = ?, visit_count = ?,
            is_collapsed = ?, is_labeled = ?, label_info = ?,
            created_time = ?, updated_time = ?, content_hash = ?, last_seen_at = ?, is_deleted = 0, deleted_at = NULL
        WHERE pk = ?
      `).run(
        safeTitle,
        safeAuthorName,
        safeUrlToken ?? null,
        safeAuthorAvatar,
        safeAuthorHeadline,
        safeSourceUrl,
        safeQuestionId ?? null,
        safeQuestionTitle ?? null,
        safeContentHtml,
        safeContentMd,
        safeExcerpt,
        safeVoteupCount,
        safeCommentCount,
        safeFavoriteCount,
        safeVisitCount,
        input.isCollapsed ? 1 : 0,
        input.isLabeled ? 1 : 0,
        safeLabelInfo ?? null,
        safeCreatedTime ?? null,
        safeUpdatedTime ?? null,
        contentHash,
        now,
        pk
      );

      // 无正文的更新不写版本，避免空行污染版本历史
      if (isBodyChanged && (rawHtml || rawMd)) {
        db.prepare(`
          INSERT INTO content_versions (
            content_pk, version_hash, title, content_html, content_md, excerpt,
            voteup_count, comment_count, snapshot_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          pk,
          contentHash,
          safeTitle,
          rawHtml,
          rawMd,
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

      return { pk, changed: true, created: false, prevCommentCount: resolvePrevCommentCount() };
    } else if (profileChanges.length > 0 && counterChanges.length === 0) {
      // 仅作者资料（头像/简介）变化：轻量更新两列，不写版本、不发事件、
      // changed 保持 false，让爬虫的早停判定正常工作
      db.prepare(`
        UPDATE contents
        SET author_avatar = ?, author_headline = ?, last_seen_at = ?
        WHERE pk = ?
      `).run(safeAuthorAvatar, safeAuthorHeadline, now, pk);

      return { pk, changed: false, created: false, prevCommentCount: resolvePrevCommentCount() };
    } else if (counterChanges.length > 0) {
      // 只更新计数字段：单条 UPDATE（4 个数字 + last_seen_at），不写版本、不发事件、
      // changed 保持 false，让爬虫的早停判定生效。
      // 若同时有 profileChanges，在同一句里顺带写作者资料两列，避免头像永远不更新
      db.prepare(`
        UPDATE contents
        SET voteup_count = ?, comment_count = ?, favorite_count = ?, visit_count = ?,
            author_avatar = ?, author_headline = ?, last_seen_at = ?
        WHERE pk = ?
      `).run(
        safeVoteupCount,
        safeCommentCount,
        safeFavoriteCount,
        safeVisitCount,
        safeAuthorAvatar,
        safeAuthorHeadline,
        now,
        pk
      );

      return { pk, changed: false, created: false, prevCommentCount: resolvePrevCommentCount() };
    }

    // 什么都没变：不执行任何 UPDATE（无谓的 last_seen_at 写入同样是写入放大）
    return { pk, changed: false, created: false, prevCommentCount: resolvePrevCommentCount() };
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
    // q 钳制：过长的关键词会让三字段 LIKE 撞 SQLite 的
    // "LIKE or GLOB pattern too complex" 上限直接 500，截断到 100 字符
    const q = params.q.slice(0, 100);
    conditions.push(`(title LIKE ? ESCAPE '\\' OR question_title LIKE ? ESCAPE '\\' OR content_md LIKE ? ESCAPE '\\')`);
    // 转义 LIKE 通配符：否则搜 "%" 会全表命中、"50%" 按 50* 通配匹配
    const kw = `%${q.replace(/[\\%_]/g, m => "\\" + m)}%`;
    values.push(kw, kw, kw);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  // page 钳制：NaN/负数回落第 1 页；超大值会让 OFFSET 超出 SQLite int64 直接 500
  const parsedPage = Number(params.page ?? 1);
  const page = Number.isFinite(parsedPage) ? Math.min(Math.max(Math.trunc(parsedPage), 1), 100000) : 1;
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
