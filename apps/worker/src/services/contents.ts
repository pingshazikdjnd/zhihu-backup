import { db } from "../db.js";
import { buildChangeStatement } from "./changes.js";
import { normalizeForHash, sha256 } from "../utils/hash.js";
import { withKeyLock } from "./lock.js";
import { buildSearchText, safeTruncate } from "shared";
import type { IngestContentInput } from "shared";

// D1 单行正文上限：正文原文存 R2，D1 只留纯文本供检索
const SEARCH_TEXT_LIMIT = 4000;

/**
 * 用于哈希的 HTML 归一化：知乎图片 CDN 域名（pic1/picx/pic2...）与签名 query
 * 每次请求都可能不同，直接参与哈希会导致同一篇回答每轮都被判为「正文已更新」，
 * 进而无限追加版本与变更事件。这里只改哈希输入，不改落库/R2 的原始 HTML。
 */
function normalizeHtmlForHash(html: string): string {
  return html
    .replace(/https?:\/\/pic[0-9a-z]*\.zhimg\.com/gi, "https://zhimg.com")
    // 仅对 <img src> 归一化尺寸后缀与查询签名；正文纯文本里的 _720w 不得被剥掉，
    // 否则不同正文（如教程里的文件名对比）可能归一成同一串、变更漏检
    .replace(/(<img\b[^>]*?\ssrc=")([^"]*)"/gi, (_m, prefix, url) =>
      `${prefix}${String(url).replace(/_\d+w(?=[.\/]?)/, "").replace(/\?.*$/, "")}"`
    );
}

/**
 * 占位 URL 识别：抓取端缺字段时会拼出 /question/undefined/、/answer/null 这类地址。
 * 只认整段恰为 undefined/null 的路径段，普通单词（如 nullable）不受影响。
 */
function hasPlaceholderPathSegment(url: string): boolean {
  try {
    return new URL(url).pathname
      .split("/")
      .some(segment => segment === "undefined" || segment === "null");
  } catch {
    return false;
  }
}

export function upsertContent(input: IngestContentInput) {
  // 同 pk 写串行化：消除读-比-写的并发覆盖窗口（详见 lock.ts）
  return withKeyLock(`${input.sourceType}:${input.sourceId}`, () => upsertContentInner(input));
}

async function upsertContentInner(input: IngestContentInput) {
  const now = new Date().toISOString();
  const pk = `${input.sourceType}:${input.sourceId}`;
  // 保存原始正文：清空入库前，版本快照必须留有真实内容
  const rawHtml = input.contentHtml ?? "";
  const rawMd = input.contentMd ?? "";
  // 可搜索正文（HTML 原文存 R2，D1 保留纯文本，否则 content_md LIKE 永远匹配不到）
  const searchText = buildSearchText(rawMd, rawHtml, SEARCH_TEXT_LIMIT);
  // 哈希只吃归一化后的正文：图片 CDN 域名/签名抖动不应被判定为「正文已更新」。
  // 注意 htmlToStore / R2 里的原文不受影响，归一化结果仅在哈希比较中使用。
  const rawContentHash = await sha256(
    normalizeForHash(normalizeHtmlForHash(rawMd || rawHtml || input.excerpt || ""))
  );

  // If excerpt is missing, extract from markdown/html before clearing them
  if (!input.excerpt || input.excerpt === "null" || input.excerpt.trim() === "") {
    const raw = (rawMd || rawHtml).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (raw) {
      input.excerpt = safeTruncate(raw, 300);
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
    SELECT pk, title, source_url, excerpt, question_id, question_title, author_url_token, created_time, updated_time,
           content_hash, voteup_count, comment_count, favorite_count, visit_count,
           author_name, author_avatar, author_headline,
           content_html, content_md,
           is_collapsed, is_labeled, label_info
    FROM contents
    WHERE pk = ?
  `).get(pk) as any;

  if (!existing) {
    // D1 没有交互式事务：正文行、版本快照与 content.created 事件必须在同一个
    // batch 里原子提交，否则中途失败会留下「有正文没事件」等不可对账状态。
    const createStmts: any[] = [];

    createStmts.push(db.prepare(`
      INSERT INTO contents (
        pk, source_type, source_id, source_url, title,
        author_name, author_url_token, author_avatar, author_headline,
        question_id, question_title, content_html, content_md, excerpt,
        voteup_count, comment_count, favorite_count, visit_count,
        is_collapsed, is_labeled, label_info,
        created_time, updated_time, content_hash, first_seen_at, last_seen_at, is_deleted, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
    `).raw(
      pk,
      input.sourceType,
      input.sourceId,
      input.sourceUrl,
      input.title,
      input.author?.name ?? "",
      input.author?.urlToken ?? null,
      // 空串头像/简介存 null 而不是 ""：UPDATE 路径的 safe* 会把空串折叠成
      // null，首存 "" 与后续 null 比较恒不等，每次重同步都发一条假"头像更新"事件
      input.author?.avatarUrl || null,
      input.author?.headline || null,
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
      rawContentHash,
      now,
      now
    ));

    // 没有正文的入库（例如赞同动态里 target.content 为空）不插空版本，
    // 否则版本历史会被空行污染，后面对比"正文是否变化"也会失真。
    if (rawHtml || rawMd) {
      createStmts.push(db.prepare(`
        INSERT INTO content_versions (
          content_pk, version_hash, title, content_html, content_md, excerpt,
          voteup_count, comment_count, snapshot_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).raw(
        pk,
        rawContentHash,
        input.title,
        "", // 版本正文不写进 D1（原文在 R2 的 versions/{pk}/{hash}）
        "",
        input.excerpt,
        input.voteupCount,
        input.commentCount,
        now
      ));
    }

    createStmts.push(buildChangeStatement({
      eventType: "content.created",
      entityType: "content",
      entityPk: pk,
      contentPk: pk,
      summary: input.title || pk,
      payload: { pk, sourceUrl: input.sourceUrl }
    }));

    await db.batch(createStmts);

    return { pk, changed: true, created: true, prevCommentCount: 0, hash: rawContentHash };
  }

  // 无正文的更新（如赞同动态里 target.content 为空）不能覆盖正文哈希：
  // 空串哈希在 R2 里永远没有对应对象，详情读路径会指向不存在的键，
  // 正文会空窗到下次全量同步。计数仍正常更新，哈希沿用库里的旧值。
  const contentHash = (rawHtml || rawMd) ? rawContentHash : existing.content_hash;

  // 弱数据源（赞同动态等）常缺 question / 时间戳，且抓取端缺字段时会写
  // 1970-01-01 哨兵：空值与哨兵都不得覆盖库里的旧值（同 safeVoteupCount 思路）。
  // 1970 哨兵还会让 ORDER BY COALESCE(updated_time, ...) 恒命中假时间、排序跌底。
  const isRealTime = (s?: string | null) => !!s && !s.startsWith("1970-01-01");
  // moments 等弱载荷缺 question 时会带非空占位串（"未知问题"、/question/undefined/）：
  // 非空但错误，同样不能覆盖库里的真实值，且这三个字段不参与 changes[] 比较、
  // 后续正确数据不会主动修复，必须在写入侧挡住
  const PLACEHOLDER_TITLES = new Set(["未知问题", "未知文章", "无标题"]);
  const safeTitle = (input.title && !PLACEHOLDER_TITLES.has(input.title))
    ? input.title
    : (existing.title || input.title || "");
  const safeSourceUrl = hasPlaceholderPathSegment(input.sourceUrl)
    ? (existing.source_url || input.sourceUrl)
    : input.sourceUrl;
  const safeExcerpt = input.excerpt || existing.excerpt || "";
  const safeQuestionId = input.question?.id || existing.question_id;
  const safeQuestionTitle = input.question?.title || existing.question_title;
  const safeUrlToken = input.author?.urlToken || existing.author_url_token;
  const safeLabelInfo = input.labelInfo || existing.label_info;
  const safeCreatedTime = isRealTime(input.createdTime) ? input.createdTime : existing.created_time;
  const safeUpdatedTime = isRealTime(input.updatedTime) ? input.updatedTime : existing.updated_time;

  // Preserve existing stats if incoming are 0 to prevent data loss from faulty API responses.
  const safeVoteupCount = (input.voteupCount === 0 && existing.voteup_count > 0) ? existing.voteup_count : input.voteupCount;
  // 评论数是例外：弱数据源（本次载荷不带正文，如收藏夹条目/赞同动态）里的 0 常常是
  // 「未提供」而非「真的被删光」，必须沿用旧值；但带正文的完整载荷里 0 是真实观测，
  // 若也锁死旧值，原站评论被删光后计数会永远停在旧数字。此时如实落 0，
  // 并由 replaceCommentsByRoot 的全量清零对账兜底（见 services/comments.ts）。
  const isWeakCommentPayload = !rawHtml && !rawMd;
  const safeCommentCount =
    (input.commentCount === 0 && existing.comment_count > 0 && isWeakCommentPayload)
      ? existing.comment_count
      : input.commentCount;
  const safeFavoriteCount = (!input.favoriteCount && existing.favorite_count > 0) ? existing.favorite_count : (input.favoriteCount || 0);
  const safeVisitCount = (!input.visitCount && existing.visit_count > 0) ? existing.visit_count : (input.visitCount || 0);

  const safeAuthorAvatar = (input.author?.avatarUrl || existing.author_avatar) || null;
  const safeAuthorHeadline = (input.author?.headline || existing.author_headline) || null;
  const safeAuthorName = (input.author?.name || existing.author_name) || "";
  // D1 不存正文原文（原文在 R2），只保留历史行里可能存在的旧值
  const safeContentHtml = existing.content_html || "";
  // 优先用本次生成的可搜索正文，否则保留库里的旧值
  const safeContentMd = searchText || existing.content_md || "";

  // 变更分两组：body 组必须整行落库并留版本/发事件；counter 组只是热度数字在动，
  // 用一条轻量 UPDATE 落库即可（不写版本、不发事件、不计 changed），
  // 否则每次同步都追加 content_versions + 事件，D1 每日写入额度被计数抖动打满，
  // 爬虫也永远等不到 changed=false 而无法早停。
  const bodyChanges: string[] = [];
  // profile 组是装饰性元数据（作者头像/简介）：头像 CDN 域名会轮换，同一头像每次
  // URL 字符串都不同，不能参与「内容是否变更」判定，否则每轮都误判变更、写入放大
  // 且爬虫永远等不到 changed=false。
  const profileChanges: string[] = [];
  const counterChanges: string[] = [];
  let isBodyChanged = false;

  // title 参与变更检测：否则"仅改标题"的更新走零事件分支，标题根本不落库
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
  // 未传（弱数据源）时保留库里的既有值；显式 false 才置 0
  const nextCollapsed = input.isCollapsed !== undefined ? (input.isCollapsed ? 1 : 0) : existing.is_collapsed;
  if (existing.is_collapsed !== nextCollapsed) {
    bodyChanges.push("折叠状态更新");
  }
  const nextLabeled = input.isLabeled !== undefined ? (input.isLabeled ? 1 : 0) : existing.is_labeled;
  if (existing.is_labeled !== nextLabeled) {
    bodyChanges.push("标签更新");
  }

  // comments 表尚无评论时强制返回 0，触发爬虫补抓；
  // 两条「无 body 变更」的返回路径都必须带上这个修正
  const resolvePrevCommentCount = async () => {
    let prevCommentCount = existing.comment_count;
    if (prevCommentCount > 0) {
      // 只需判断「有没有评论」：COUNT(*) 会扫全量评论行，热门内容每轮同步都是读放大
      const cStat = await db.prepare(
        `SELECT 1 AS has_any FROM comments WHERE content_pk = ? LIMIT 1`
      ).get<{ has_any: number }>(pk);
      // 只有「一条评论都没入库」才强制补抓。此前用 author_avatar IS NULL 判定
      // 「旧格式未迁移」，但知乎匿名/注销用户的头像本来就是空，导致这些内容
      // 永远被判为未抓全、每轮全量重抓评论，早停被反复清零。
      if (!cStat) {
        prevCommentCount = 0;
      }
    }
    return prevCommentCount;
  };

  if (bodyChanges.length > 0) {
    const changes = bodyChanges.concat(profileChanges, counterChanges);
    // D1 没有交互式事务，batch 是唯一的原子手段：
    // 「更新 contents」「写 content_versions」「发 content.updated 事件」必须同生共死。
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
      nextCollapsed,
      nextLabeled,
      safeLabelInfo ?? null,
      safeCreatedTime ?? null,
      safeUpdatedTime ?? null,
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
        safeTitle,
        "", // 版本正文不写进 D1（原文在 R2 的 versions/{pk}/{hash}）
        "",
        input.excerpt,
        safeVoteupCount,
        safeCommentCount,
        now
      ));
    }

    // content.updated 事件并入同一个 batch：D1 batch 内整体成功或整体失败，
    // 不能再在 batch 之外单独 emitChange，否则会出现「正文已改但事件丢失」。
    stmts.push(buildChangeStatement({
      eventType: "content.updated",
      entityType: "content",
      entityPk: pk,
      contentPk: pk,
      summary: `[数据更新] ${input.title || pk} - ${changes.join(", ")}`,
      payload: { pk, sourceUrl: input.sourceUrl }
    }));

    await db.batch(stmts);

    let prevCommentCount = existing.comment_count;
    if (prevCommentCount > 0) {
      // 与 resolvePrevCommentCount 保持一致：只用「一条评论都没入库」判定补抓。
      // 早前这里还检查 author_avatar IS NULL（旧格式未迁移），但匿名/注销用户的
      // 头像本来就是 NULL，会让每次正文变更都强制整篇重抓评论、早停反复清零。
      const cStat = await db.prepare(
        `SELECT 1 AS has_any FROM comments WHERE content_pk = ? LIMIT 1`
      ).get<{ has_any: number }>(pk);
      if (!cStat) {
        prevCommentCount = 0; // comments 表中尚无评论，强制返回 0 触发爬虫补抓
      }
    }

    return { pk, changed: true, created: false, prevCommentCount, hash: contentHash };
  } else if (profileChanges.length > 0 && counterChanges.length === 0) {
    // 仅作者资料（头像/简介）变化：轻量更新两列，不写版本、不发事件、
    // changed 保持 false，让爬虫的早停判定正常工作
    await db.prepare(`
      UPDATE contents
      SET author_avatar = ?, author_headline = ?, last_seen_at = ?
      WHERE pk = ?
    `).run(safeAuthorAvatar, safeAuthorHeadline, now, pk);

    return { pk, changed: false, created: false, prevCommentCount: await resolvePrevCommentCount(), hash: contentHash };
  } else if (counterChanges.length > 0) {
    // 只更新计数字段：单条 UPDATE（4 个数字 + last_seen_at），不写版本、不发事件、
    // changed 保持 false，让爬虫的早停判定生效。
    // 若同时有 profileChanges，在同一句里顺带写作者资料两列，避免头像永远不更新
    await db.prepare(`
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

    return { pk, changed: false, created: false, prevCommentCount: await resolvePrevCommentCount(), hash: contentHash };
  }

  // 什么都没变：不执行任何 UPDATE（无谓的 last_seen_at 写入同样是每日额度黑洞）
  return { pk, changed: false, created: false, prevCommentCount: await resolvePrevCommentCount(), hash: contentHash };
}

export async function listContents(params: { type?: string; q?: string; author?: string; sort?: string; page?: number }) {
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
    // q 钳制：过长的关键词会让三字段 LIKE 撞 SQLite 的
    // "LIKE or GLOB pattern too complex" 上限直接 500，截断到 100 字符
    const q = params.q.slice(0, 100);
    conditions.push(`(c.title LIKE ? ESCAPE '\\' OR c.question_title LIKE ? ESCAPE '\\' OR c.content_md LIKE ? ESCAPE '\\')`);
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

  const orderBy =
    params.sort === "vote"
      ? `c.voteup_count DESC, COALESCE(NULLIF(c.created_time, ''), NULLIF(c.updated_time, ''), '1970-01-01') DESC`
      : params.sort === "time" || params.author
      ? `COALESCE(NULLIF(c.created_time, ''), NULLIF(c.updated_time, ''), '1970-01-01') DESC, CAST(c.source_id AS INTEGER) DESC`
      : `c.last_seen_at DESC`;

  const totalRow = await db.prepare(`
    SELECT count(*) as c FROM contents c ${where}
  `).get(...values) as { c: number };

  const rows = await db.prepare(`
    SELECT c.pk, c.source_type, c.source_id, c.title, c.question_title, c.source_url,
           c.author_name, c.author_url_token, c.author_avatar, c.author_headline, c.excerpt,
           c.voteup_count, c.comment_count, c.favorite_count, c.visit_count,
           c.created_time, c.updated_time, c.last_seen_at, c.is_deleted, u.upvote_time
    FROM contents c
    LEFT JOIN upvotes u ON u.content_pk = c.pk
    ${where}
    ORDER BY ${orderBy}
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
