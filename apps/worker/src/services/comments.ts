import { db } from "../db.js";
import { buildChangeStatement } from "./changes.js";
import { normalizeForHash, sha256 } from "../utils/hash.js";
import { withKeyLock } from "./lock.js";
import type {
  IngestCommentsByRootInput,
  IngestChildCommentInput,
  IngestCommentsInput,
  IngestRootCommentInput
} from "shared";

// D1 单次 batch 的语句数不宜过大；100 条一批兼顾往返次数和单批体积
const BATCH_SIZE = 100;

/**
 * 评论同步。
 *
 * 原来每条评论按「INSERT comments / INSERT comment_versions / emitChange」逐条 await，
 * 300 条评论 ≈ 900 次 D1 往返，会撞 Workers 子请求上限。
 * 现在先把所有语句按顺序拼好，再分批 batch 提交：
 *   - 每批内部是原子的（D1 batch 语义）
 *   - 往返次数从 O(n) 降到 O(n/100)
 */
export function replaceComments(input: IngestCommentsInput) {
  // 同 pk 写串行化：并发评论同步的对账互相看不见对方刚插入的行，
  // 会产生批量假删除事件（详见 lock.ts）
  return withKeyLock(`comments:${input.contentPk}`, () => replaceCommentsInner(input));
}

async function replaceCommentsInner(input: IngestCommentsInput) {
  const now = new Date().toISOString();

  const existingRows = await db.prepare(`
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
  // 整批原子失败且重试（同 payload）必然再失败（同 collections 的去重方案）
  const uniqueComments = new Map<string, typeof input.comments[number]>();
  for (const c of input.comments) {
    uniqueComments.set(c.id, c);
  }
  // 图片与 hash 在写语句循环外一次算好：
  // - img 是标准字段，imageUrl 是旧通道兼容字段，标准 img 优先；
  // - hash 输入仍是 `${content}|${img}|${likes}`，同一评论换通道不会因字段名不同而反复产生版本/事件。
  const preparedComments = new Map<string, {
    comment: typeof input.comments[number];
    img: string;
    hash: string;
  }>();
  for (const c of uniqueComments.values()) {
    const img = c.img || c.imageUrl || "";
    const hash = await sha256(normalizeForHash(`${c.content}|${img}|${c.likes}`));
    preparedComments.set(c.id, { comment: c, img, hash });
  }
  // 分批提交时对账基准是 allIds（全量），单发时是本批 comments 的 id
  const incomingIds = new Set(input.allIds ?? input.comments.map(c => c.id));

  let added = 0;
  let updated = 0;
  let deleted = 0;

  // 语句统一收集后按序 batch 提交（不再写 comment_versions）
  const stmts: any[] = [];

  for (const { comment: c, img, hash } of preparedComments.values()) {
    const exists = existingMap.get(c.id);

    if (!exists) {
      stmts.push(db.prepare(`
        INSERT INTO comments (
          id, content_pk, parent_comment_id, author_name, author_avatar, be_replied,
          content_md, img_url, time_text, location, likes, is_author, is_top, is_featured, comment_hash,
          first_seen_at, last_seen_at, is_deleted, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
      `).raw(
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
      ));

      // 评论快照不再写 comment_versions（D1 写放大主要来源），表保留仅作历史归档
      stmts.push(buildChangeStatement({
        eventType: "comment.added",
        entityType: "comment",
        entityPk: c.id,
        contentPk: input.contentPk,
        summary: `${c.author}: ${c.content.slice(0, 30)}`,
        payload: { commentId: c.id, contentPk: input.contentPk }
      }));

      added++;
      continue;
    }

    if (exists.comment_hash !== hash || exists.is_deleted === 1) {
      stmts.push(db.prepare(`
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
      `).raw(
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
      ));

      stmts.push(buildChangeStatement({
        eventType: "comment.updated",
        entityType: "comment",
        entityPk: c.id,
        contentPk: input.contentPk,
        summary: `${c.author}: ${c.content.slice(0, 30)}`,
        payload: { commentId: c.id, contentPk: input.contentPk }
      }));

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
      stmts.push(db.prepare(`
        UPDATE comments
        SET author_avatar = COALESCE(NULLIF(?, ''), author_avatar),
            last_seen_at = ?, likes = ?, time_text = ?, location = ?,
            is_deleted = 0, deleted_at = NULL
        WHERE id = ?
      `).raw(c.authorAvatar, now, c.likes, c.time, c.location, c.id));
    }
  }

  // 删除检测：抓取不完整时整段跳过，避免误标
  if (!input.partial) {
    for (const row of existingRows) {
      if (!incomingIds.has(row.id) && row.is_deleted === 0) {
        stmts.push(db.prepare(`
          UPDATE comments
          SET is_deleted = 1, deleted_at = ?, last_seen_at = ?
          WHERE id = ?
        `).raw(now, now, row.id));

        stmts.push(buildChangeStatement({
          eventType: "comment.deleted",
          entityType: "comment",
          entityPk: row.id,
          contentPk: input.contentPk,
          summary: row.id,
          payload: { commentId: row.id }
        }));

        deleted++;
      }
    }
  }

  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    await db.batch(stmts.slice(i, i + BATCH_SIZE));
  }

  return { added, updated, deleted };
}

export async function listComments(contentPk: string) {
  return await db.prepare(`
    SELECT *
    FROM comments
    WHERE content_pk = ?
    ORDER BY first_seen_at ASC
  `).all(contentPk);
}

// ---------------------------------------------------------------------------
// 评论双层存储：根评论 → D1 comments；子评论 → R2 childcomments/{rootId}.json
// 同步元数据 → D1 comment_threads。旧 replaceComments 保留给旧爬虫通道。
// ---------------------------------------------------------------------------

const CHILD_COMMENTS_PREFIX = "childcomments/";
// 按根写库时每批最多 50 条 statement，把子请求预算留给每根的 R2 GET/PUT
const ROOT_BATCH_SIZE = 50;

type ExistingRootRow = {
  id: string;
  comment_hash: string;
  is_deleted: number;
  author_avatar: string | null;
  likes: number;
  time_text: string | null;
  location: string | null;
  child_count: number;
};

export type ChildCommentRecord = Record<string, unknown> & { id: string };

/**
 * R2 旧对象的读取结果三态：
 * - ok：成功读到既有子评论（可参与 partial 合并）
 * - missing：R2 404，确实没有旧对象，可以放心写入本次数据
 * - error：读取/解析失败，状态未知——绝不能用本次不完整数据覆盖，
 *   否则既有完整楼中楼会被半份数据冲掉（P0）
 */
type StoredChildThread =
  | { status: "ok"; children: ChildCommentRecord[]; complete: boolean }
  | { status: "missing" }
  | { status: "error" };

/** 列表页直接展示的轻量回复预览（前 2 条子评论），前端打开详情前无需读 R2 */
export type PreviewReply = {
  id: string;
  author: string;
  beReplied: string | null;
  content: string;
  likes: number;
  isAuthor: boolean;
};

/** comment_threads 里已有的线程索引行（快路径判断用） */
type ExistingThreadRow = {
  root_id: string;
  child_count: number;
  is_complete: number;
  thread_hash: string;
  incoming_hash: string;
  preview_json: string;
};

export type RootCommentRow = {
  id: string;
  content_pk: string;
  author_name: string | null;
  author_avatar: string | null;
  be_replied: string | null;
  content_md: string | null;
  img_url: string | null;
  time_text: string | null;
  location: string | null;
  likes: number;
  is_author: number;
  is_top: number;
  is_featured: number;
  comment_hash: string;
  first_seen_at: string;
  last_seen_at: string;
  child_count: number;
  is_complete: number;
  thread_synced_at: string | null;
  /** 原始预览字符串；对外返回前会转成 preview_replies 数组并去掉该字段 */
  preview_json?: string | null;
  preview_replies: PreviewReply[];
};

function childCommentsKey(rootId: string) {
  return `${CHILD_COMMENTS_PREFIX}${rootId}.json`;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** D1 单批语句数上限 50：超过就拆成多次 batch（每次 batch 计 1 个子请求） */
async function runBatchedStatements(database: D1Database, stmts: any[], size: number) {
  for (let i = 0; i < stmts.length; i += size) {
    await database.batch(stmts.slice(i, i + size));
  }
}

function normalizeChildComment(c: IngestChildCommentInput): ChildCommentRecord {
  const img = c.img || c.imageUrl || "";
  return {
    id: c.id,
    parentId: c.parentId,
    author: c.author,
    authorAvatar: c.authorAvatar ?? "",
    beReplied: c.beReplied ?? null,
    content: c.content,
    img,
    // 前端/历史数据只读 img_url，两个字段写同一个字符串，任一字段都能取到图
    img_url: img,
    time: c.time ?? "",
    location: c.location ?? "",
    likes: c.likes,
    isAuthor: c.isAuthor ?? false
  };
}

/** 同一 root 的子评论按 id 去重（翻页漂移会产生重复 id），后出现的覆盖先出现的 */
function normalizeChildren(children: IngestChildCommentInput[]): ChildCommentRecord[] {
  const map = new Map<string, ChildCommentRecord>();
  for (const child of children) {
    if (!child || !child.id) continue;
    map.set(child.id, normalizeChildComment(child));
  }
  return Array.from(map.values());
}

/** partial 合并：旧对象里的子评论全部保留，新抓到的按 id 覆盖/追加，不删除 */
function mergeChildren(existing: ChildCommentRecord[], incoming: ChildCommentRecord[]): ChildCommentRecord[] {
  const merged = new Map<string, ChildCommentRecord>();
  for (const child of existing) {
    if (child && typeof child.id === "string" && child.id) merged.set(child.id, child);
  }
  for (const child of incoming) merged.set(child.id, child);
  return Array.from(merged.values());
}

const PREVIEW_REPLY_LIMIT = 2;
const PREVIEW_CONTENT_LENGTH = 120;

function toPreviewReply(child: Record<string, unknown>): PreviewReply {
  const content = typeof child.content === "string" ? child.content : "";
  const likes = typeof child.likes === "number" ? child.likes : Number(child.likes ?? 0);
  return {
    id: typeof child.id === "string" ? child.id : String(child.id ?? ""),
    author: typeof child.author === "string" ? child.author : "",
    beReplied: typeof child.beReplied === "string" ? child.beReplied : null,
    content: content.slice(0, PREVIEW_CONTENT_LENGTH),
    likes: Number.isFinite(likes) ? likes : 0,
    isAuthor: child.isAuthor === true
  };
}

/** 列表页预览：只取前 2 条子评论，正文截断到 120 字，避免 D1 行放大 */
function buildPreviewReplies(children: ChildCommentRecord[]): PreviewReply[] {
  return children.slice(0, PREVIEW_REPLY_LIMIT).map(toPreviewReply);
}

/** 解析 comment_threads.preview_json；损坏/非数组按空预览处理（走 D1 兜底） */
function parsePreviewJson(raw: string | null | undefined): PreviewReply[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is ChildCommentRecord => !!item && typeof item === "object")
      .map(toPreviewReply)
      .filter(item => item.id !== "");
  } catch {
    return [];
  }
}

async function readStoredChildThread(bucket: R2Bucket, rootId: string): Promise<StoredChildThread> {
  const key = childCommentsKey(rootId);
  try {
    const obj = await bucket.get(key);
    if (!obj) return { status: "missing" };
    const parsed = JSON.parse(await obj.text()) as { children?: unknown; complete?: unknown } | null;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.children)) {
      console.warn(`[comments] invalid R2 payload for ${key}`);
      return { status: "error" };
    }
    return {
      status: "ok",
      children: parsed.children.filter(
        (c): c is ChildCommentRecord => !!c && typeof c === "object" && typeof (c as any).id === "string"
      ),
      complete: parsed.complete === true
    };
  } catch (err) {
    // 读取/解析失败不能当作「没有旧数据」：调用方必须跳过 PUT，避免覆盖既有楼中楼
    console.warn(`[comments] failed to read R2 ${key}:`, err);
    return { status: "error" };
  }
}

function buildRootChangeStatement(
  database: D1Database,
  eventType: "comment.added" | "comment.updated" | "comment.deleted",
  rootId: string,
  contentPk: string,
  summary: string,
  now: string
) {
  // 与 changes.ts 的评论 payload 裁剪保持一致：只存引用，不复制正文
  return database.prepare(`
    INSERT INTO change_events (
      event_type, entity_type, entity_pk, content_pk, summary, payload_json, created_at
    ) VALUES (?, 'comment', ?, ?, ?, ?, ?)
  `).bind(
    eventType,
    rootId,
    contentPk,
    summary,
    JSON.stringify({ commentId: rootId, contentPk }),
    now
  );
}

/**
 * 按根同步评论（新爬虫通道）。
 *
 * - 根评论 upsert 进 D1 comments，不写 comment_versions；
 * - 子评论写 R2 childcomments/{rootId}.json（complete 才整体覆盖，否则与旧对象合并）；
 * - comment_threads 记录每根的子评论数/完整性；
 * - 删除对账只针对根评论，D1 里已有的子评论行不碰。
 *
 * 顺序固定为：D1 根评论 → R2 子评论 → D1 comment_threads。
 * R2 与 D1 无法同事务，R2 PUT 失败只把 is_complete 置 0，不回滚已写的根评论。
 */
export function replaceCommentsByRoot(
  input: IngestCommentsByRootInput,
  env: { BUCKET: R2Bucket; DB: D1Database }
) {
  return withKeyLock(`comments:${input.contentPk}`, () => replaceCommentsByRootInner(input, env));
}

async function replaceCommentsByRootInner(
  input: IngestCommentsByRootInput,
  env: { BUCKET: R2Bucket; DB: D1Database }
) {
  const now = new Date().toISOString();
  const database = env.DB;

  const existingResult = await database.prepare(`
    SELECT id, comment_hash, is_deleted, author_avatar, likes, time_text, location, child_count
    FROM comments
    WHERE content_pk = ? AND parent_comment_id IS NULL
  `).bind(input.contentPk).all<ExistingRootRow>();
  const existingRoots = existingResult.results ?? [];
  const existingMap = new Map(existingRoots.map(row => [row.id, row]));

  // 线程索引现状：1 条 SQL 取全（不是每根 1 次），供「输入未变 → 0 R2 / 0 D1 写」快路径使用
  const threadResult = await database.prepare(`
    SELECT root_id, child_count, is_complete, thread_hash, incoming_hash, preview_json
    FROM comment_threads
    WHERE content_pk = ?
  `).bind(input.contentPk).all<ExistingThreadRow>();
  const existingThreads = new Map((threadResult.results ?? []).map(row => [row.root_id, row]));

  // 同一 root 重复出现（翻页漂移）只保留最后一条
  const uniqueRoots = new Map<string, IngestRootCommentInput>();
  for (const root of input.roots) uniqueRoots.set(root.id, root);

  const prepared: Array<{
    root: IngestRootCommentInput;
    img: string;
    hash: string;
    children: ChildCommentRecord[];
  }> = [];
  for (const root of uniqueRoots.values()) {
    const img = root.img || root.imageUrl || "";
    const hash = await sha256(normalizeForHash(`${root.content}|${img}|${root.likes}`));
    prepared.push({ root, img, hash, children: normalizeChildren(root.children) });
  }

  const incomingRootIds = new Set(input.allRootIds ?? prepared.map(p => p.root.id));

  let added = 0;
  let updated = 0;
  let deleted = 0;
  let r2Puts = 0;

  // 1) 根评论 upsert + 根级删除对账
  const rootStmts: any[] = [];
  for (const { root, img, hash } of prepared) {
    const exists = existingMap.get(root.id);

    if (!exists) {
      rootStmts.push(database.prepare(`
        INSERT INTO comments (
          id, content_pk, parent_comment_id, author_name, author_avatar, be_replied,
          content_md, img_url, time_text, location, likes, is_author, is_top, is_featured,
          comment_hash, child_count, first_seen_at, last_seen_at, is_deleted, deleted_at
        ) VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
      `).bind(
        root.id,
        input.contentPk,
        root.author,
        root.authorAvatar ?? "",
        root.content,
        img,
        root.time ?? "",
        root.location ?? "",
        root.likes,
        root.isAuthor ? 1 : 0,
        root.isTop ? 1 : 0,
        root.isFeatured ? 1 : 0,
        hash,
        root.childCount,
        now,
        now
      ));

      rootStmts.push(buildRootChangeStatement(
        database,
        "comment.added",
        root.id,
        input.contentPk,
        `${root.author}: ${root.content.slice(0, 30)}`,
        now
      ));

      added++;
      continue;
    }

    if (exists.comment_hash !== hash || exists.is_deleted === 1) {
      rootStmts.push(database.prepare(`
        UPDATE comments
        SET parent_comment_id = NULL,
            author_name = COALESCE(NULLIF(?, ''), author_name),
            author_avatar = COALESCE(NULLIF(?, ''), author_avatar),
            be_replied = NULL,
            content_md = COALESCE(NULLIF(?, ''), content_md),
            img_url = COALESCE(NULLIF(?, ''), img_url),
            time_text = COALESCE(NULLIF(?, ''), time_text),
            location = COALESCE(NULLIF(?, ''), location),
            likes = ?, is_author = ?, is_top = ?, is_featured = ?,
            comment_hash = ?, child_count = ?, last_seen_at = ?,
            is_deleted = 0, deleted_at = NULL
        WHERE id = ?
      `).bind(
        root.author,
        root.authorAvatar ?? "",
        root.content,
        img,
        root.time ?? "",
        root.location ?? "",
        root.likes,
        root.isAuthor ? 1 : 0,
        root.isTop ? 1 : 0,
        root.isFeatured ? 1 : 0,
        hash,
        root.childCount,
        now,
        root.id
      ));

      rootStmts.push(buildRootChangeStatement(
        database,
        "comment.updated",
        root.id,
        input.contentPk,
        `${root.author}: ${root.content.slice(0, 30)}`,
        now
      ));

      updated++;
      continue;
    }

    // hash 未变：只有头像/时间/位置/子评论数确有变化才补一条轻量刷新
    const needsRefresh =
      (!!root.authorAvatar && root.authorAvatar !== exists.author_avatar) ||
      (exists.time_text || "") !== (root.time || "") ||
      (exists.location || "") !== (root.location || "") ||
      Number(exists.child_count ?? 0) !== root.childCount;

    if (needsRefresh) {
      rootStmts.push(database.prepare(`
        UPDATE comments
        SET author_avatar = COALESCE(NULLIF(?, ''), author_avatar),
            last_seen_at = ?, likes = ?, time_text = ?, location = ?, child_count = ?,
            is_deleted = 0, deleted_at = NULL
        WHERE id = ?
      `).bind(
        root.authorAvatar ?? "",
        now,
        root.likes,
        root.time ?? "",
        root.location ?? "",
        root.childCount,
        root.id
      ));
    }
  }

  // 删除对账只针对根评论：子评论在 R2，由覆盖/合并逻辑处理，不删 D1 里的子评论行
  if (!input.partial) {
    for (const row of existingRoots) {
      if (!incomingRootIds.has(row.id) && row.is_deleted === 0) {
        rootStmts.push(database.prepare(`
          UPDATE comments
          SET is_deleted = 1, deleted_at = ?, last_seen_at = ?
          WHERE id = ?
        `).bind(now, now, row.id));

        rootStmts.push(buildRootChangeStatement(
          database,
          "comment.deleted",
          row.id,
          input.contentPk,
          row.id,
          now
        ));

        deleted++;
      }
    }
  }

  // 全量对账（非 partial）且本次一条根评论都没有：原站评论被整体删光。
  // 单纯把根评论软删不会修正 contents.comment_count，列表页会永远显示旧评论数，
  // 且下次 ingest 见旧计数非 0 又会重复触发评论抓取 —— 这里同步清零。
  if (!input.partial && input.roots.length === 0 && (!input.allRootIds || input.allRootIds.length === 0)) {
    rootStmts.push(database.prepare(`
      UPDATE contents SET comment_count = 0 WHERE pk = ?
    `).bind(input.contentPk));
  }

  await runBatchedStatements(database, rootStmts, ROOT_BATCH_SIZE);

  // 2) 子评论写 R2；3) comment_threads 最后统一 upsert
  const threadStmts: any[] = [];

  // 评论整体清零时，残余线程索引里的子评论数与预览也必须一起清掉，
  // 否则列表页仍会展示已删除楼中楼的旧预览。
  // 而且只把 child_count 归零不够：thread_hash / incoming_hash 不清，R2 旧对象不删，
  // 原站清空后又新增子评论、下次 partial 同步时旧 R2 子评论会被「合并复活」。
  // 所有根评论此刻都已软删，直接删掉残余线程索引行最干净，下次从零重建。
  if (!input.partial && input.roots.length === 0 && (!input.allRootIds || input.allRootIds.length === 0)) {
    for (const rootId of existingThreads.keys()) {
      const bucket = env.BUCKET as any;
      if (typeof bucket?.delete === "function") {
        await bucket.delete(childCommentsKey(rootId)).catch(() => {
          // R2 删除失败不阻塞清零：D1 行删除后旧对象不再被引用，仅浪费少量存储
        });
      }
    }
    threadStmts.push(database.prepare(`
      DELETE FROM comment_threads WHERE content_pk = ?
    `).bind(input.contentPk));
  }
  for (const { root, children } of prepared) {
    const hasChildren = children.length > 0;
    const childCount = Math.max(root.childCount, children.length);
    const existingThread = existingThreads.get(root.id);

    // 单个根下的楼中楼在原站被删光：本次抓全且站点确认 childCount = 0。
    // 必须主动清空 R2 与线程索引，否则已删光的楼中楼会一直展示旧预览。
    if (
      !input.partial &&
      !hasChildren &&
      childCount === 0 &&
      root.isChildrenComplete &&
      existingThread &&
      existingThread.child_count > 0
    ) {
      const key = childCommentsKey(root.id);
      const emptyThreadHash = await sha256(JSON.stringify({ children: [], complete: true }));
      const emptyIncomingHash = await sha256(JSON.stringify({ children: [], childCount: 0, complete: true }));
      try {
        await env.BUCKET.put(key, JSON.stringify({ children: [], complete: true, updatedAt: now }), {
          httpMetadata: { contentType: "application/json; charset=utf-8" }
        });
        r2Puts++;
        threadStmts.push(database.prepare(`
          UPDATE comment_threads
          SET child_count = 0, is_complete = 1, preview_json = '[]',
              thread_hash = ?, incoming_hash = ?, synced_at = ?
          WHERE root_id = ?
        `).bind(emptyThreadHash, emptyIncomingHash, now, root.id));
      } catch (err) {
        // R2 写失败则保留 D1 旧索引：避免出现「R2 仍是旧子评论、D1 却宣称 0 条」的不一致
        console.warn(`[comments] R2 put failed for ${key}:`, err);
      }
      continue;
    }

    // 没有子评论且站点也没报告子评论数：无需线程索引
    if (!hasChildren && childCount === 0) continue;
    const incomingHash = await sha256(JSON.stringify({
      children,
      childCount,
      complete: root.isChildrenComplete
    }));

    // 快路径：输入与上次完全一致，且上次 R2 已成功落盘 → 0 GET / 0 PUT / 0 条 comment_threads 写入。
    // thread_hash 非空保证上次 PUT 真的成功过；is_complete 分支保证「上次没抓全、这次抓全」仍会重试。
    if (
      existingThread &&
      existingThread.incoming_hash === incomingHash &&
      existingThread.child_count === childCount &&
      (existingThread.is_complete === 1 || !root.isChildrenComplete) &&
      (!hasChildren || existingThread.thread_hash !== "")
    ) {
      continue;
    }

    // hasChildren=false 且 childCount>0：子评论尚未抓取，只登记计数，保留已有 R2 哈希/预览，别把它们冲掉
    if (!hasChildren) {
      if (existingThread && existingThread.child_count === childCount) continue;
      threadStmts.push(database.prepare(`
        INSERT INTO comment_threads (
          root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(root_id) DO UPDATE SET
          content_pk = excluded.content_pk,
          r2_key = excluded.r2_key,
          child_count = excluded.child_count,
          synced_at = excluded.synced_at
      `).bind(
        root.id,
        input.contentPk,
        childCommentsKey(root.id),
        childCount,
        existingThread?.is_complete ?? 0,
        existingThread?.thread_hash ?? "",
        existingThread?.incoming_hash ?? "",
        existingThread?.preview_json ?? "[]",
        now
      ));
      continue;
    }

    const key = childCommentsKey(root.id);
    let childrenToStore = children;
    let readFailed = false;
    if (!root.isChildrenComplete) {
      // 本次没抓全：与 R2 旧对象合并，只增改不删。
      // 读失败（error）时状态未知，绝不能把本次不完整数据当成合并结果写回去。
      const stored = await readStoredChildThread(env.BUCKET, root.id);
      if (stored.status === "ok") {
        childrenToStore = mergeChildren(stored.children, children);
      } else if (stored.status === "error") {
        readFailed = true;
      }
    }
    const complete = root.isChildrenComplete;
    const previewJson = JSON.stringify(buildPreviewReplies(childrenToStore));
    const nextThreadHash = await sha256(JSON.stringify({ children: childrenToStore, complete }));

    let threadComplete: boolean;
    let storedThreadHash: string;
    let storedIncomingHash = incomingHash;
    if (readFailed) {
      // 旧对象读取失败：跳过 PUT，保护 R2 里既有的完整楼中楼。
      // 恢复状态与 PUT 失败完全一致：is_complete=0、thread_hash 保留旧值、
      // incoming_hash 清空 → 下轮同输入不会误命中快路径，会自动重试合并。
      console.warn(`[comments] skip R2 put for ${key}: previous object unreadable`);
      threadComplete = false;
      storedThreadHash = existingThread?.thread_hash ?? "";
      storedIncomingHash = "";
    } else if (
      existingThread &&
      existingThread.thread_hash === nextThreadHash &&
      existingThread.is_complete === (complete ? 1 : 0)
    ) {
      // R2 里已经是同一份内容：跳过这次 Class A 写入
      threadComplete = complete;
      storedThreadHash = nextThreadHash;
    } else {
      try {
        await env.BUCKET.put(key, JSON.stringify({
          children: childrenToStore,
          complete,
          updatedAt: now
        }), { httpMetadata: { contentType: "application/json; charset=utf-8" } });
        r2Puts++;
        threadComplete = complete;
        storedThreadHash = nextThreadHash;
      } catch (err) {
        // R2 与 D1 无法同一事务：PUT 失败不回滚已写的根评论，只把线程标记为不完整。
        // thread_hash 保留旧值、incoming_hash 清空 → 下次同输入不会误命中快路径，会重新 PUT。
        console.warn(`[comments] R2 put failed for ${key}:`, err);
        threadComplete = false;
        storedThreadHash = existingThread?.thread_hash ?? "";
        storedIncomingHash = "";
      }
    }

    const isComplete = threadComplete ? 1 : 0;
    // 只有确实变化才写 comment_threads：重复同步热评不再产生 D1 行写入放大
    if (
      existingThread &&
      existingThread.incoming_hash === storedIncomingHash &&
      existingThread.child_count === childCount &&
      existingThread.preview_json === previewJson &&
      existingThread.is_complete === isComplete &&
      existingThread.thread_hash === storedThreadHash
    ) {
      continue;
    }

    threadStmts.push(database.prepare(`
      INSERT INTO comment_threads (
        root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(root_id) DO UPDATE SET
        content_pk = excluded.content_pk,
        r2_key = excluded.r2_key,
        child_count = excluded.child_count,
        is_complete = excluded.is_complete,
        thread_hash = excluded.thread_hash,
        incoming_hash = excluded.incoming_hash,
        preview_json = excluded.preview_json,
        synced_at = excluded.synced_at
    `).bind(
      root.id,
      input.contentPk,
      key,
      childCount,
      isComplete,
      storedThreadHash,
      storedIncomingHash,
      previewJson,
      now
    ));
  }

  await runBatchedStatements(database, threadStmts, ROOT_BATCH_SIZE);

  return { added, updated, deleted, r2Puts, threadUpserts: threadStmts.length };
}

/**
 * 根评论分页列表：热度序（置顶 > 点赞 > id），附带 comment_threads 的子评论数/完整性，
 * 以及前 2 条回复预览（preview_replies）——知乎 App 风格列表直接展示，打开详情前 0 次 R2 读取。
 *
 * child_count 的优先级：线程索引 → comments 表已有值 → 现数子评论行。
 * 历史未迁移根评论（D1 有子评论但没有 comment_threads 行、也没进 R2）用 1 条批量 SQL 兜底预览。
 */
export async function listRootComments(
  database: D1Database,
  contentPk: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<RootCommentRow[]> {
  // 上限 50：D1 单条 SQL 最多 100 个绑定参数，历史预览兜底查询要为每个根绑定
  // 一个 id（50 个根 = 50 参数，加外层查询参数仍在 100 以内），留足安全余量；
  // 前端每页只取 20，完全兼容。
  const limit = clampInt(opts.limit, 20, 1, 50);
  const offset = clampInt(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  const result = await database.prepare(`
    SELECT c.id, c.content_pk, c.author_name, c.author_avatar, c.be_replied,
           c.content_md, c.img_url, c.time_text, c.location, c.likes,
           c.is_author, c.is_top, c.is_featured, c.comment_hash,
           c.first_seen_at, c.last_seen_at,
           COALESCE(
             t.child_count,
             NULLIF(c.child_count, 0),
             (SELECT COUNT(*) FROM comments ch WHERE ch.parent_comment_id = c.id AND ch.is_deleted = 0),
             0
           ) AS child_count,
           COALESCE(t.is_complete, 0) AS is_complete,
           t.preview_json AS preview_json,
           t.synced_at AS thread_synced_at
    FROM comments c
    LEFT JOIN comment_threads t ON t.root_id = c.id
    WHERE c.content_pk = ? AND c.parent_comment_id IS NULL AND c.is_deleted = 0
    ORDER BY c.is_top DESC, c.likes DESC, c.id DESC
    LIMIT ? OFFSET ?
  `).bind(contentPk, limit, offset).all<RootCommentRow>();

  const rows = result.results ?? [];
  if (rows.length === 0) return rows;

  const previews = new Map<string, PreviewReply[]>();
  const needsFallback: string[] = [];
  for (const row of rows) {
    const parsed = parsePreviewJson(row.preview_json);
    if (parsed.length > 0) {
      previews.set(row.id, parsed);
    } else if (row.child_count > 0 && !row.thread_synced_at) {
      // 历史根评论：D1 comments 里已有子评论但还没有 comment_threads 行
      needsFallback.push(row.id);
    }
  }

  // 只对当前页（≤50 条）里需要兜底的根做一次批量查询，走 idx_comments_parent。
  // 用窗口函数每个根只取前 2 条（预览只需要 2 条），避免热门根把几千条子评论拉回来。
  if (needsFallback.length > 0) {
    const placeholders = needsFallback.map(() => "?").join(", ");
    const childResult = await database.prepare(`
      SELECT id, parent_comment_id, author_name, be_replied, content_md, likes, is_author
      FROM (
        SELECT id, parent_comment_id, author_name, be_replied, content_md, likes, is_author,
               ROW_NUMBER() OVER (PARTITION BY parent_comment_id ORDER BY first_seen_at ASC) AS rn
        FROM comments
        WHERE parent_comment_id IN (${placeholders}) AND is_deleted = 0
      )
      WHERE rn <= 2
      ORDER BY rn ASC
    `).bind(...needsFallback).all<{
      id: string;
      parent_comment_id: string;
      author_name: string | null;
      be_replied: string | null;
      content_md: string | null;
      likes: number;
      is_author: number;
    }>();

    for (const child of childResult.results ?? []) {
      const list = previews.get(child.parent_comment_id) ?? [];
      if (list.length >= PREVIEW_REPLY_LIMIT) continue;
      list.push({
        id: child.id,
        author: child.author_name ?? "",
        beReplied: child.be_replied ?? null,
        content: (child.content_md ?? "").slice(0, PREVIEW_CONTENT_LENGTH),
        likes: child.likes ?? 0,
        isAuthor: child.is_author === 1
      });
      previews.set(child.parent_comment_id, list);
    }
  }

  return rows.map(({ preview_json, ...row }) => ({
    ...row,
    preview_replies: previews.get(row.id) ?? []
  }));
}

/**
 * 按需读取某个根评论下的全部子评论。
 *
 * 优先读 R2 childcomments/{rootId}.json；R2 未命中（历史数据还没搬进 R2、或 BUCKET 未绑定）
 * 且传了 database 时回退查 D1 comments 的子评论行，保证迁移前详情页也能展开。
 */
export async function getChildComments(
  bucket: R2Bucket | undefined,
  rootId: string,
  database?: D1Database
): Promise<ChildCommentRecord[]> {
  if (bucket) {
    const stored = await readStoredChildThread(bucket, rootId);
    if (stored.status === "ok" && stored.children.length > 0) {
      // 历史 R2 对象可能只有 img 没有 img_url：两个字段都补齐，前端读任一都能取到图
      return stored.children.map(child => ({
        ...child,
        img_url: child.img_url || child.img || ""
      }));
    }
  }
  if (!database) return [];

  const result = await database.prepare(`
    SELECT id, parent_comment_id, author_name, author_avatar, be_replied, content_md,
           img_url, time_text, location, likes, is_author
    FROM comments
    WHERE parent_comment_id = ? AND is_deleted = 0
    ORDER BY first_seen_at ASC
  `).bind(rootId).all<{
    id: string;
    parent_comment_id: string;
    author_name: string | null;
    author_avatar: string | null;
    be_replied: string | null;
    content_md: string | null;
    img_url: string | null;
    time_text: string | null;
    location: string | null;
    likes: number;
    is_author: number;
  }>();

  return (result.results ?? []).map(row => {
    const img = row.img_url ?? "";
    return {
      id: row.id,
      parentId: row.parent_comment_id,
      author: row.author_name ?? "",
      authorAvatar: row.author_avatar ?? "",
      beReplied: row.be_replied,
      content: row.content_md ?? "",
      img,
      img_url: img,
      time: row.time_text ?? "",
      location: row.location ?? "",
      likes: row.likes,
      isAuthor: row.is_author === 1
    };
  });
}
