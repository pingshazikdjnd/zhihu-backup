import { db, dbContext } from "../db.js";
import { buildChangeStatement } from "./changes.js";
import { isAvatarUrlChanged, normalizeForHash, sha256 } from "../utils/hash.js";
import { withKeyLock } from "./lock.js";
import { getR2TextWithEdgeCache, purgeR2EdgeCache } from "../utils/r2-cache.js";
import {
  ensureRemoteCommentSchema,
  executeRemoteSql,
  executeRemoteSqlBatch,
  listReadableCommentOffloadTargets,
  resolveActiveOffloadTarget,
  type ExternalStorageTarget,
  type RemoteSqlStatement
} from "../routes/auth.js";
import type {
  IngestCommentsByRootInput,
  IngestChildCommentInput,
  IngestCommentsInput,
  IngestRootCommentInput
} from "shared";

// D1 单次 batch 的语句数不宜过大；100 条一批兼顾往返次数和单批体积
const BATCH_SIZE = 100;
const CHILD_THREAD_CACHE_TTL_SECONDS = 30;
// Cloudflare D1 单条 SQL 绑定参数硬上限为 100，统一封顶 90 留足安全余量
const D1_MAX_SQL_PARAMS = 90;

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
      isAvatarUrlChanged(exists.author_avatar, c.authorAvatar) ||
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
  /** 软删根的新鲜度判断用（与 deleted_at 取最大值），随根行一次 SELECT 取回，无额外查询 */
  last_seen_at: string | null;
  deleted_at: string | null;
};

export type ChildCommentRecord = Record<string, unknown> & { id: string; isDeleted?: boolean };

/**
 * R2 旧对象的读取结果三态：
 * - ok：成功读到既有子评论（可参与归档合并）
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
  isDeleted?: boolean;
};

/** comment_threads 里已有的线程索引行（快路径判断用） */
type ExistingThreadRow = {
  root_id: string;
  child_count: number;
  is_complete: number;
  thread_hash: string;
  incoming_hash: string;
  preview_json: string;
  /** 收敛时间：命中「已确认收敛」快路径后按需刷新，防止非活跃库更晚的失败记录反复触发重抓 */
  synced_at: string | null;
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
  is_deleted: number;
  comment_hash: string;
  first_seen_at: string;
  last_seen_at: string;
  child_count: number;
  is_complete: number;
  thread_synced_at: string | null;
  /** 1 = 已存在线程索引但未完成（0 活回复归档/迁移失败遗留），爬虫据此强制重抓 */
  needs_thread_retry?: number;
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

/**
 * 防删归档合并子评论：
 * - 已有子评论永久保留，绝不物理删除；
 * - 本轮新抓到的子评论按 id 覆盖最新内容并清除 isDeleted 标记；
 * - markMissingDeleted=true（本次抓全）时，原站不再返回的旧子评论标记 isDeleted: true；
 * - markMissingDeleted=false（partial/闭评）时，旧子评论保持原样不误标删除。
 */
function archiveMergeChildren(
  existing: ChildCommentRecord[],
  incoming: ChildCommentRecord[],
  markMissingDeleted: boolean
): ChildCommentRecord[] {
  const incomingById = new Map<string, ChildCommentRecord>();
  for (const child of incoming) {
    if (child && typeof child.id === "string" && child.id) {
      const { isDeleted: _omit, ...live } = child;
      incomingById.set(child.id, live as ChildCommentRecord);
    }
  }
  const merged = new Map<string, ChildCommentRecord>();
  for (const prev of existing) {
    if (!prev || typeof prev.id !== "string" || !prev.id) continue;
    const updated = incomingById.get(prev.id);
    if (updated) {
      merged.set(prev.id, updated);
    } else if (markMissingDeleted) {
      merged.set(prev.id, prev.isDeleted === true ? prev : { ...prev, isDeleted: true });
    } else {
      merged.set(prev.id, prev);
    }
  }
  for (const [id, child] of incomingById) {
    if (!merged.has(id)) merged.set(id, child);
  }
  return Array.from(merged.values());
}

/**
 * 合并多份「已落库」的子评论历史列表（迁移/双写过渡期的主库与外部库）。
 *
 * 与 archiveMergeChildren 不同，这里的每一份都是历史快照，没有任何一份代表现网最新状态，
 * 因此只按 id 去重（后面的列表覆盖前面同 ID 记录），原样保留所选记录自身的 isDeleted，
 * 绝不把已删回复洗成存活回复。
 */
function mergeStoredChildrenLists(...lists: ChildCommentRecord[][]): ChildCommentRecord[] {
  const merged = new Map<string, ChildCommentRecord>();
  for (const list of lists) {
    for (const child of list) {
      if (!child || typeof child.id !== "string" || !child.id) continue;
      merged.set(child.id, child);
    }
  }
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
    isAuthor: child.isAuthor === true,
    ...(child.isDeleted === true ? { isDeleted: true } : {})
  };
}

/** 列表页预览：只取前 2 条子评论（优先现存、不足时补已删归档），正文截断到 120 字 */
function buildPreviewReplies(children: ChildCommentRecord[]): PreviewReply[] {
  const live = children.filter(c => c.isDeleted !== true);
  const archived = children.filter(c => c.isDeleted === true);
  return [...live, ...archived].slice(0, PREVIEW_REPLY_LIMIT).map(toPreviewReply);
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

async function readStoredChildThread(
  bucket: R2Bucket,
  rootId: string,
  options: { bypassCache?: boolean } = {}
): Promise<StoredChildThread> {
  const key = childCommentsKey(rootId);
  try {
    // 写路径必须跳过进程内/边缘缓存直读 R2（强一致），避免跨 isolate 旧缓存覆盖新写入；
    // 读路径走短 TTL 边缘缓存，命中时 0 次 R2 Class B 且写入/清空会立即 purge。
    const text = options.bypassCache
      ? await bucket.get(key).then(obj => (obj ? obj.text() : null))
      : await getR2TextWithEdgeCache(bucket, key, { ttlSeconds: CHILD_THREAD_CACHE_TTL_SECONDS });
    if (text === null) return { status: "missing" };
    const parsed = JSON.parse(text) as { children?: unknown; complete?: unknown } | null;
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

// ---------------------------------------------------------------------------
// 「已确认收敛但命中快路径」的按需刷新
//
// 场景：实际写入库里已有较早的完整快照（is_complete=1, synced_at=T1），非活跃库
// 还残留更晚的失败记录（is_complete=0, synced_at=T2 > T1）。补抓回来的回复若与 T1
// 完全一致，写路径会命中快路径直接跳过，synced_at 停留在 T1，hasIncompleteLiveRoot
// 每轮都会再次判定未收敛 → 无休止全量重抓。
// 因此只在「本轮已确认收敛」的快路径上按需探测非活跃库；若确有更晚的未完成活根
// 时间戳，才在实际写入库执行一条轻量 UPDATE，把 synced_at（或已软删根的
// last_seen_at）推过 T2。平时重复同步仍然 0 写入。
// ---------------------------------------------------------------------------

/** 与 hasIncompleteLiveRoot 完全一致的「未完成活根」判定条件（contentPk 占位符在前） */
const INCOMPLETE_LIVE_ROOT_WHERE_SQL = `
    FROM comments c
    LEFT JOIN comment_threads t ON t.root_id = c.id
    WHERE c.content_pk = ? AND c.parent_comment_id IS NULL AND c.is_deleted = 0
      AND (
        (t.root_id IS NOT NULL AND COALESCE(t.is_complete, 0) = 0)
        OR (
          t.root_id IS NULL AND (
            COALESCE(c.child_count, 0) > 0
            OR EXISTS (
              SELECT 1 FROM comments ch
              WHERE ch.parent_comment_id = c.id AND ch.is_deleted = 0
            )
          )
        )
      )
  `;

/** 按 contentPk（可选限定候选根 ID）查询未完成活根及其新鲜度时间戳 */
function buildIncompleteLiveRootProbeSql(contentPk: string, ids: string[]) {
  const useIdFilter = ids.length > 0 && ids.length <= D1_MAX_SQL_PARAMS - 1;
  return {
    sql: `
      SELECT
        c.id AS id,
        c.last_seen_at AS root_last_seen_at,
        t.synced_at AS thread_synced_at,
        (
          SELECT MAX(ch.last_seen_at)
          FROM comments ch
          WHERE ch.parent_comment_id = c.id AND ch.is_deleted = 0
        ) AS latest_child_seen_at
      ${INCOMPLETE_LIVE_ROOT_WHERE_SQL}
      ${useIdFilter ? `AND c.id IN (${ids.map(() => "?").join(", ")})` : ""}
    `,
    params: useIdFilter ? [contentPk, ...ids] : [contentPk]
  };
}

/** 汇总未完成活根；同一根出现在多个非活跃库时取最新状态，任一库时间未知则保持 null */
function mergeIncompleteRootTimestamps(
  rows: IncompleteRootRow[],
  unresolved: Map<string, number | null>
): void {
  for (const row of rows) {
    const id = row.id == null ? "" : String(row.id);
    if (!id) continue;
    const ts = maxTimestampMs(row.root_last_seen_at, row.thread_synced_at, row.latest_child_seen_at);
    if (!unresolved.has(id)) {
      unresolved.set(id, ts);
      continue;
    }
    const prev = unresolved.get(id) ?? null;
    unresolved.set(id, prev === null || ts === null ? null : Math.max(prev, ts));
  }
}

/** 探测非活跃库（主 D1 / 其他外部库）里的未完成活根；逐库 try/catch，绝不阻断当前写入 */
async function probeInactiveIncompleteTimestamps(args: {
  contentPk: string;
  ids: string[];
  mainDatabase?: D1Database | null;
  remoteTargets: ExternalStorageTarget[];
}): Promise<Map<string, number | null>> {
  const inactiveIncomplete = new Map<string, number | null>();
  if (args.ids.length === 0) return inactiveIncomplete;
  const { sql, params } = buildIncompleteLiveRootProbeSql(args.contentPk, args.ids);
  if (args.mainDatabase) {
    try {
      const { results } = await args.mainDatabase.prepare(sql).bind(...params).all<IncompleteRootRow>();
      mergeIncompleteRootTimestamps(results ?? [], inactiveIncomplete);
    } catch (err) {
      console.warn("[comments] inactive incomplete probe failed (main D1):", err);
    }
  }
  for (const target of args.remoteTargets) {
    try {
      const result = await executeRemoteSql(target, sql, params);
      mergeIncompleteRootTimestamps(result.rows as IncompleteRootRow[], inactiveIncomplete);
    } catch (err) {
      console.warn(`[comments] inactive incomplete probe failed (${target.name || target.id}):`, err);
    }
  }
  return inactiveIncomplete;
}

type InactiveRefreshPlan = {
  threadRootIds: string[];
  threadBumpIso: string;
  deletedRootIds: string[];
  deletedBumpIso: string;
};

/**
 * 决定哪些「已确认收敛」的根需要把 synced_at 推过非活跃库的未完成时间戳，
 * 以及哪些已软删根需要刷新 last_seen_at。只有确实更晚的未完成记录才进入计划。
 */
function planInactiveIncompleteRefreshes(args: {
  now: string;
  confirmedFastPathRoots: Map<string, string | null>;
  alreadyDeletedRoots: ExistingRootRow[];
  inactiveIncomplete: Map<string, number | null>;
}): InactiveRefreshPlan {
  const parsedNow = Date.parse(args.now);
  const baseNowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now();

  const threadRootIds: string[] = [];
  let threadBumpMs = baseNowMs;
  for (const [rootId, existingSyncedAt] of args.confirmedFastPathRoots) {
    if (!args.inactiveIncomplete.has(rootId)) continue;
    const incompleteTs = args.inactiveIncomplete.get(rootId) ?? null;
    const existingMs = parseTimestampMs(existingSyncedAt);
    // 与 hasIncompleteLiveRoot 的收敛判定完全对称：已有 synced_at 不旧于未完成记录时无需刷新
    if (existingMs !== null && (incompleteTs === null || existingMs >= incompleteTs)) continue;
    threadRootIds.push(rootId);
    if (incompleteTs !== null) threadBumpMs = Math.max(threadBumpMs, incompleteTs);
  }

  const deletedRootIds: string[] = [];
  let deletedBumpMs = baseNowMs;
  for (const row of args.alreadyDeletedRoots) {
    if (!row.id || !args.inactiveIncomplete.has(row.id)) continue;
    const incompleteTs = args.inactiveIncomplete.get(row.id) ?? null;
    // 软删根的收敛证据是 max(deleted_at, last_seen_at)，刷新时只推进 last_seen_at、保留 deleted_at
    const freshness = maxTimestampMs(row.deleted_at, row.last_seen_at);
    if (freshness !== null && (incompleteTs === null || freshness >= incompleteTs)) continue;
    deletedRootIds.push(row.id);
    if (incompleteTs !== null) deletedBumpMs = Math.max(deletedBumpMs, incompleteTs);
  }

  return {
    threadRootIds,
    threadBumpIso: new Date(threadBumpMs).toISOString(),
    deletedRootIds,
    deletedBumpIso: new Date(deletedBumpMs).toISOString()
  };
}

/** 按 D1 单句绑定参数上限切分 ID 列表（时间戳占 1 个参数） */
function chunkIdsForUpdate(ids: string[]): string[][] {
  const chunks: string[][] = [];
  const maxIds = D1_MAX_SQL_PARAMS - 1;
  for (let i = 0; i < ids.length; i += maxIds) chunks.push(ids.slice(i, i + maxIds));
  return chunks;
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
  // 扩容分流：命中外部分流库时，整批评论（根评论 + 线程索引 + 楼中楼 JSON）只写外部库，
  // 主 D1 的 comments / comment_threads / change_events 与主 R2 的 childcomments/* 全部跳过。
  const offloadTarget = await resolveActiveOffloadTarget(env.BUCKET, "comments").catch(() => null);
  if (offloadTarget && (offloadTarget.provider === "turso" || offloadTarget.provider === "cloudflare_d1")) {
    try {
      return await replaceCommentsByRootOffloaded(input, offloadTarget, env);
    } catch (err) {
      console.warn(`[comments] 外部扩容库写入失败 (${offloadTarget.name})，降级写回主库:`, err);
    }
  }

  const now = new Date().toISOString();
  const database = env.DB;

  const existingResult = await database.prepare(`
    SELECT id, comment_hash, is_deleted, author_avatar, likes, time_text, location, child_count,
           last_seen_at, deleted_at
    FROM comments
    WHERE content_pk = ? AND parent_comment_id IS NULL
  `).bind(input.contentPk).all<ExistingRootRow>();
  const existingRoots = existingResult.results ?? [];
  const existingMap = new Map(existingRoots.map(row => [row.id, row]));

  // 线程索引现状：1 条 SQL 取全（不是每根 1 次），供「输入未变 → 0 R2 / 0 D1 写」快路径使用
  const threadResult = await database.prepare(`
    SELECT root_id, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at
    FROM comment_threads
    WHERE content_pk = ?
  `).bind(input.contentPk).all<ExistingThreadRow>();
  const existingThreads = new Map((threadResult.results ?? []).map(row => [row.root_id, row]));

  // 合并只读 R2 会把迁移前写在 D1 的旧扁平子评论（含已软删历史）弄丢（R2 404 时尤其明显）。
  // 只要本轮有根评论提交，就一次批量取出该内容的旧 D1 子评论行，供防删归档合并使用。
  const legacyChildrenByRoot = new Map<string, ChildCommentRecord[]>();
  let legacyChildrenReadFailed = false;
  if (input.roots.length > 0) {
    try {
      const legacyResult = await database.prepare(`
        SELECT id, parent_comment_id, author_name, author_avatar, be_replied, content_md,
               img_url, time_text, location, likes, is_author, is_deleted
        FROM comments
        WHERE content_pk = ? AND parent_comment_id IS NOT NULL
        ORDER BY first_seen_at ASC
      `).bind(input.contentPk).all<ChildSelectRow>();
      for (const row of legacyResult.results ?? []) {
        const parentId = row.parent_comment_id;
        if (!parentId) continue;
        const child = mapStoredChildRow(row);
        const list = legacyChildrenByRoot.get(parentId);
        if (list) list.push(child);
        else legacyChildrenByRoot.set(parentId, [child]);
      }
    } catch (err) {
      // 旧 D1 子评论状态未知：后续根不能基于半份数据盲写 R2。
      legacyChildrenReadFailed = true;
      console.warn(`[comments] failed to read legacy D1 children for ${input.contentPk}:`, err);
    }
  }

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

  // 命中「已确认收敛」快路径的根（rootId → 实际写入库现有 synced_at）；
  // 以及全量对账时已经软删、不在本次 incoming 里的根（可能在非活跃库留下更晚的失败记录）。
  const confirmedFastPathRoots = new Map<string, string | null>();
  const alreadyDeletedRoots: ExistingRootRow[] = [];

  let added = 0;
  let updated = 0;
  let deleted = 0;
  let r2Puts = 0;

  // 1) 根评论 upsert + 根级删除对账
  const rootStmts: any[] = [];
  for (const { root, img, hash, children } of prepared) {
    const exists = existingMap.get(root.id);
    const liveChildCount = Math.max(root.childCount, children.length);

    if (!exists) {
      rootStmts.push(database.prepare(`
        INSERT INTO comments (
          id, content_pk, parent_comment_id, author_name, author_avatar, be_replied,
          content_md, img_url, time_text, location, likes, is_author, is_top, is_featured,
          comment_hash, child_count, first_seen_at, last_seen_at, is_deleted, deleted_at
        ) VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
        ON CONFLICT(id) DO UPDATE SET
          content_pk = excluded.content_pk,
          parent_comment_id = NULL,
          author_name = COALESCE(NULLIF(excluded.author_name, ''), comments.author_name),
          author_avatar = COALESCE(NULLIF(excluded.author_avatar, ''), comments.author_avatar),
          be_replied = NULL,
          content_md = COALESCE(NULLIF(excluded.content_md, ''), comments.content_md),
          img_url = COALESCE(NULLIF(excluded.img_url, ''), comments.img_url),
          time_text = COALESCE(NULLIF(excluded.time_text, ''), comments.time_text),
          location = COALESCE(NULLIF(excluded.location, ''), comments.location),
          likes = excluded.likes,
          is_author = excluded.is_author,
          is_top = excluded.is_top,
          is_featured = excluded.is_featured,
          comment_hash = excluded.comment_hash,
          child_count = excluded.child_count,
          last_seen_at = excluded.last_seen_at,
          is_deleted = 0,
          deleted_at = NULL
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
        liveChildCount,
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
        liveChildCount,
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
      isAvatarUrlChanged(exists.author_avatar, root.authorAvatar) ||
      (exists.time_text || "") !== (root.time || "") ||
      (exists.location || "") !== (root.location || "") ||
      Number(exists.child_count ?? 0) !== liveChildCount;

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
        liveChildCount,
        root.id
      ));
    }
  }

  // 删除对账只针对根评论：子评论在 R2，由覆盖/合并逻辑处理，不删 D1 里的子评论行
  if (!input.partial) {
    for (const row of existingRoots) {
      if (incomingRootIds.has(row.id)) continue;
      // 已经软删的根不重复写；但若非活跃库残留更晚的失败记录（incompleteTs 更新），
      // 收敛证据 max(deleted_at, last_seen_at) 可能仍更旧，后面需要按需刷新 last_seen_at。
      if (row.is_deleted === 1) {
        alreadyDeletedRoots.push(row);
        continue;
      }
      if (row.is_deleted === 0) {
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

  // 防删归档：原站评论被整体删光时，上面已把全部根评论标成 is_deleted=1 留档；
  // 这里绝不物理删除 R2 楼中楼与 comment_threads 线程索引，而是把 archived_comment_count
  // 单调推高到已归档总数，同时把现网 comment_count 置 0（供爬虫差量比对，避免每轮重复抓空区）。
  if (!input.partial && input.roots.length === 0 && (!input.allRootIds || input.allRootIds.length === 0)) {
    const archivedChildMap = new Map<string, number>();
    for (const row of existingRoots) {
      archivedChildMap.set(
        row.id,
        Math.max(Number(existingThreads.get(row.id)?.child_count ?? 0), Number(row.child_count ?? 0))
      );
    }
    for (const [rootId, th] of existingThreads) {
      if (!archivedChildMap.has(rootId)) {
        archivedChildMap.set(rootId, Number(th.child_count ?? 0));
      }
    }
    let archivedTotal = archivedChildMap.size;
    for (const cCount of archivedChildMap.values()) archivedTotal += cCount;
    rootStmts.push(database.prepare(`
      UPDATE contents
      SET archived_comment_count = MAX(COALESCE(archived_comment_count, 0), comment_count, ?),
          comment_count = 0
      WHERE pk = ?
    `).bind(archivedTotal, input.contentPk));
  }

  await runBatchedStatements(database, rootStmts, ROOT_BATCH_SIZE);

  // 2) 子评论写 R2；3) comment_threads 最后统一 upsert
  const threadStmts: any[] = [];

  for (const { root, children } of prepared) {
    const hasChildren = children.length > 0;
    const childCount = Math.max(root.childCount, children.length);
    const existingThread = existingThreads.get(root.id);
    const isChildrenClosed = Boolean(root.isChildrenClosed);

    // 单个根下的楼中楼在原站被删光：本次抓全且站点确认 childCount = 0。
    // 防删归档模式：先读回已有 R2 / 旧扁平 D1 子评论并全部标为 isDeleted: true 永久归档，
    // 全新 0 回复根则跳过 R2/D1 写入，避免无谓写放大。
    if (!input.partial && !hasChildren && childCount === 0 && root.isChildrenComplete) {
      const key = childCommentsKey(root.id);
      const emptyIncomingHash = await sha256(JSON.stringify({ children: [], childCount: 0, complete: true }));
      const existingChildCount = Number(existingMap.get(root.id)?.child_count ?? 0);
      const legacyList = legacyChildrenByRoot.get(root.id) ?? [];

      // 快路径：上一轮已经是权威 complete 归档且输入未变 → 0 R2 / 0 D1 写
      if (
        existingThread &&
        existingThread.incoming_hash === emptyIncomingHash &&
        existingThread.is_complete === 1 &&
        existingThread.thread_hash !== ""
      ) {
        // 已确认收敛（0 回复 + complete 权威归档）：若非活跃库还有更晚的失败记录，
        // 后面会按需刷新 synced_at，否则 hasIncompleteLiveRoot 会永久反复重抓。
        confirmedFastPathRoots.set(root.id, existingThread.synced_at ?? null);
        continue;
      }

      // 全新 0 回复根（无线程索引、无旧计数、无旧 D1 子评论）→ 0 写跳过
      if (!existingThread && existingChildCount === 0 && legacyList.length === 0 && !legacyChildrenReadFailed) {
        continue;
      }

      let r2Ready = false;
      let archivedChildren: ChildCommentRecord[] = [];
      let nextThreadHash = "";
      let previewJson = "[]";
      const stored = await readStoredChildThread(env.BUCKET, root.id, { bypassCache: true });
      if (stored.status === "error" || legacyChildrenReadFailed) {
        // 读取失败时状态未知：绝不盲写覆盖可能仍可读的旧对象，下面保留重试状态。
        console.warn(`[comments] skip archive empty put for ${key}: previous object unreadable`);
      } else {
        const prevChildren =
          stored.status === "ok"
            ? (stored.children.length === 0 && !stored.complete
                ? archiveMergeChildren(legacyList, stored.children, false)
                : stored.children)
            : legacyList;
        archivedChildren = archiveMergeChildren(prevChildren, [], true);
        if (archivedChildren.length === 0 && !existingThread && existingChildCount === 0) {
          continue;
        }
        nextThreadHash = await sha256(JSON.stringify({ children: archivedChildren, complete: true }));
        previewJson = JSON.stringify(buildPreviewReplies(archivedChildren));
        if (stored.status === "ok" && stored.complete) {
          const storedHash = await sha256(JSON.stringify({ children: stored.children, complete: true }));
          if (storedHash === nextThreadHash) {
            r2Ready = true;
          }
        }
        if (!r2Ready) {
          try {
            await env.BUCKET.put(key, JSON.stringify({ children: archivedChildren, complete: true, updatedAt: now }), {
              httpMetadata: { contentType: "application/json; charset=utf-8" }
            });
            r2Puts++;
            await purgeR2EdgeCache(key);
            r2Ready = true;
          } catch (err) {
            console.warn(`[comments] R2 put failed for ${key}:`, err);
          }
        }
      }

      if (r2Ready) {
        const archivedCount = Math.max(archivedChildren.length, existingThread?.child_count ?? 0, existingChildCount);
        threadStmts.push(database.prepare(`
          INSERT INTO comment_threads (
            root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
          ON CONFLICT(root_id) DO UPDATE SET
            content_pk = excluded.content_pk,
            r2_key = excluded.r2_key,
            child_count = excluded.child_count,
            is_complete = 1,
            thread_hash = excluded.thread_hash,
            incoming_hash = excluded.incoming_hash,
            preview_json = excluded.preview_json,
            synced_at = excluded.synced_at
        `).bind(root.id, input.contentPk, key, archivedCount, nextThreadHash, emptyIncomingHash, previewJson, now));
      } else {
        // 归档失败：严禁写空快照/is_complete=1，但必须留下待重试索引行（needs_thread_retry=1），
        // 否则「活根回复被删光 + 首轮归档失败」的根会永久停在 child_count=0 的新根状态而不被爬虫重抓。
        const hasArchiveHistory =
          Boolean(existingThread) ||
          existingChildCount > 0 ||
          legacyList.length > 0 ||
          legacyChildrenReadFailed;
        if (!hasArchiveHistory) continue;
        const fallbackThreadHash = existingThread?.thread_hash ?? "";
        const retryChildCount = Math.max(
          existingThread?.child_count ?? 0,
          existingChildCount,
          legacyList.length
        );
        const retryPreviewJson = existingThread
          ? (existingThread.preview_json ?? "[]")
          : (legacyList.length > 0 ? JSON.stringify(buildPreviewReplies(legacyList)) : "[]");
        if (
          existingThread &&
          existingThread.is_complete === 0 &&
          existingThread.incoming_hash === "" &&
          existingThread.thread_hash === fallbackThreadHash &&
          existingThread.child_count === retryChildCount &&
          (existingThread.preview_json ?? "[]") === retryPreviewJson
        ) {
          continue;
        }
        threadStmts.push(database.prepare(`
          INSERT INTO comment_threads (
            root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at
          ) VALUES (?, ?, ?, ?, 0, ?, '', ?, ?)
          ON CONFLICT(root_id) DO UPDATE SET
            content_pk = excluded.content_pk,
            r2_key = excluded.r2_key,
            child_count = excluded.child_count,
            is_complete = excluded.is_complete,
            thread_hash = excluded.thread_hash,
            incoming_hash = excluded.incoming_hash,
            preview_json = excluded.preview_json,
            synced_at = excluded.synced_at
        `).bind(root.id, input.contentPk, key, retryChildCount, fallbackThreadHash, retryPreviewJson, now));
      }
      continue;
    }

    // 没有子评论且站点也没报告子评论数：无需线程索引
    if (!hasChildren && childCount === 0) continue;
    const incomingHash = await sha256(JSON.stringify({
      children,
      childCount,
      complete: root.isChildrenComplete,
      ...(isChildrenClosed ? { closed: true } : {})
    }));

    // 快路径：输入与上次完全一致，且上次 R2 已成功落盘 → 0 GET / 0 PUT / 0 条 comment_threads 写入。
    if (
      existingThread &&
      existingThread.incoming_hash === incomingHash &&
      existingThread.child_count >= childCount &&
      (existingThread.is_complete === 1 || (!root.isChildrenComplete && (!isChildrenClosed || existingThread.is_complete === 2))) &&
      (!hasChildren || existingThread.thread_hash !== "")
    ) {
      // 只有「本次确实抓全/闭评」且写入库已是完整态才算确认收敛；
      // hot/未抓全的 partial 同步绝不能刷新 synced_at，否则会把非活跃库的待重试根误洗白。
      if (
        !legacyChildrenReadFailed &&
        ((root.isChildrenComplete && existingThread.is_complete === 1) ||
          (isChildrenClosed && existingThread.is_complete === 2))
      ) {
        confirmedFastPathRoots.set(root.id, existingThread.synced_at ?? null);
      }
      continue;
    }

    // hasChildren=false 且 childCount>0：子评论尚未抓取（或页 0 遇闭评），保留已有 R2 哈希/预览与归档计数
    if (!hasChildren) {
      const desiredComplete = isChildrenClosed ? 2 : (existingThread?.is_complete ?? 0);
      const effectiveChildCount = Math.max(childCount, existingThread?.child_count ?? 0);
      if (
        existingThread &&
        existingThread.child_count === effectiveChildCount &&
        existingThread.is_complete === desiredComplete
      ) {
        // 闭评冻结态（is_complete=2）本身就是权威收敛证据；非闭评的「未抓全跳过」不刷新。
        if (isChildrenClosed && existingThread.is_complete === 2) {
          confirmedFastPathRoots.set(root.id, existingThread.synced_at ?? null);
        }
        continue;
      }
      threadStmts.push(database.prepare(
        isChildrenClosed
          ? `
            INSERT INTO comment_threads (
              root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(root_id) DO UPDATE SET
              content_pk = excluded.content_pk,
              r2_key = excluded.r2_key,
              child_count = excluded.child_count,
              is_complete = excluded.is_complete,
              synced_at = excluded.synced_at
          `
          : `
            INSERT INTO comment_threads (
              root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(root_id) DO UPDATE SET
              content_pk = excluded.content_pk,
              r2_key = excluded.r2_key,
              child_count = excluded.child_count,
              synced_at = excluded.synced_at
          `
      ).bind(
        root.id,
        input.contentPk,
        childCommentsKey(root.id),
        effectiveChildCount,
        desiredComplete,
        existingThread?.thread_hash ?? "",
        existingThread?.incoming_hash ?? "",
        existingThread?.preview_json ?? "[]",
        now
      ));
      continue;
    }

    const key = childCommentsKey(root.id);
    const legacyList = legacyChildrenByRoot.get(root.id) ?? [];
    let childrenToStore = archiveMergeChildren(legacyList, children, root.isChildrenComplete);
    let readFailed = legacyChildrenReadFailed;
    const needExistingMerge =
      !root.isChildrenComplete ||
      Boolean(existingThread) ||
      Number(existingMap.get(root.id)?.child_count ?? 0) > 0 ||
      legacyList.length > 0 ||
      legacyChildrenReadFailed;
    if (needExistingMerge) {
      // 防删归档合并：无论是否抓全，只要可能存在旧对象都要先读回并集归档；
      // 读失败（error）时状态未知，绝不能把本次数据直接覆盖回去。
      const stored = await readStoredChildThread(env.BUCKET, root.id, { bypassCache: true });
      if (stored.status === "error") {
        readFailed = true;
      } else if (legacyChildrenReadFailed) {
        readFailed = true;
      } else if (stored.status === "ok") {
        const baseChildren =
          stored.children.length === 0 && !stored.complete
            ? archiveMergeChildren(legacyList, stored.children, false)
            : stored.children;
        childrenToStore = archiveMergeChildren(baseChildren, children, root.isChildrenComplete);
      } else {
        childrenToStore = archiveMergeChildren(legacyList, children, root.isChildrenComplete);
      }
    }
    const complete = root.isChildrenComplete;
    const effectiveChildCount = complete
      ? Math.max(childCount, childrenToStore.length, existingThread?.child_count ?? 0)
      : Math.max(childCount, existingThread?.child_count ?? 0);
    const previewJson = JSON.stringify(buildPreviewReplies(childrenToStore));
    const nextThreadHash = await sha256(JSON.stringify({ children: childrenToStore, complete }));
    const targetIsComplete = complete
      ? 1
      : (isChildrenClosed || existingThread?.is_complete === 2)
        ? 2
        : 0;

    let isComplete: number;
    let storedThreadHash: string;
    let storedIncomingHash = incomingHash;
    if (readFailed) {
      // 旧对象读取失败：跳过 PUT，保护 R2 里既有的完整楼中楼。
      console.warn(`[comments] skip R2 put for ${key}: previous object unreadable`);
      isComplete = existingThread?.is_complete === 2 ? 2 : 0;
      storedThreadHash = existingThread?.thread_hash ?? "";
      storedIncomingHash = "";
    } else if (
      existingThread &&
      existingThread.thread_hash === nextThreadHash &&
      (complete ? existingThread.is_complete === 1 : existingThread.is_complete !== 1)
    ) {
      isComplete = targetIsComplete;
      storedThreadHash = nextThreadHash;
    } else {
      try {
        await env.BUCKET.put(key, JSON.stringify({
          children: childrenToStore,
          complete,
          updatedAt: now
        }), { httpMetadata: { contentType: "application/json; charset=utf-8" } });
        r2Puts++;
        // 楼中楼一旦更新，CDN 边缘缓存必须立刻刷新，绝不读到旧数据
        await purgeR2EdgeCache(key);
        isComplete = targetIsComplete;
        storedThreadHash = nextThreadHash;
      } catch (err) {
        // R2 与 D1 无法同一事务：PUT 失败不回滚已写的根评论，只把线程标记为不完整。
        // 重开并抓全（complete=true）时 R2 落盘失败必须置 0 可重试，不可沿用闭评冻结态 2。
        console.warn(`[comments] R2 put failed for ${key}:`, err);
        isComplete = complete ? 0 : (existingThread?.is_complete === 2 ? 2 : 0);
        storedThreadHash = existingThread?.thread_hash ?? "";
        storedIncomingHash = "";
      }
    }

    // 只有确实变化才写 comment_threads：重复同步热评不再产生 D1 行写入放大
    if (
      existingThread &&
      existingThread.incoming_hash === storedIncomingHash &&
      existingThread.child_count === effectiveChildCount &&
      existingThread.preview_json === previewJson &&
      existingThread.is_complete === isComplete &&
      existingThread.thread_hash === storedThreadHash
    ) {
      // 写后字段一致说明本轮没有写入；若本次确实抓全/闭评且已有完整态，按需补 synced_at。
      if (
        !readFailed &&
        ((root.isChildrenComplete && existingThread.is_complete === 1) ||
          (isChildrenClosed && existingThread.is_complete === 2))
      ) {
        confirmedFastPathRoots.set(root.id, existingThread.synced_at ?? null);
      }
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
      effectiveChildCount,
      isComplete,
      storedThreadHash,
      storedIncomingHash,
      previewJson,
      now
    ));
  }

  // 「已确认收敛却命中快路径」时按需探测非活跃库（主 D1 是实际写入目标时即全部可读外部库）：
  // 只有对方存在更晚的未完成活根，才追加一条轻量 synced_at / last_seen_at 刷新；
  // 无外部目标或无更晚记录时保持 0 额外写入（重复同步的零写回归不受影响）。
  if (confirmedFastPathRoots.size > 0 || (!input.partial && alreadyDeletedRoots.length > 0)) {
    const readableTargets = await listReadableCommentOffloadTargets(env.BUCKET).catch(() => []);
    if (readableTargets.length > 0) {
      const candidateIds = Array.from(new Set([
        ...confirmedFastPathRoots.keys(),
        ...alreadyDeletedRoots.map(row => row.id)
      ]));
      const inactiveIncomplete = await probeInactiveIncompleteTimestamps({
        contentPk: input.contentPk,
        ids: candidateIds,
        remoteTargets: readableTargets
      });
      if (inactiveIncomplete.size > 0) {
        const plan = planInactiveIncompleteRefreshes({
          now,
          confirmedFastPathRoots,
          alreadyDeletedRoots,
          inactiveIncomplete
        });
        for (const chunk of chunkIdsForUpdate(plan.threadRootIds)) {
          const placeholders = chunk.map(() => "?").join(", ");
          threadStmts.push(database.prepare(
            `UPDATE comment_threads SET synced_at = ? WHERE root_id IN (${placeholders})`
          ).bind(plan.threadBumpIso, ...chunk));
        }
        for (const chunk of chunkIdsForUpdate(plan.deletedRootIds)) {
          const placeholders = chunk.map(() => "?").join(", ");
          threadStmts.push(database.prepare(
            `UPDATE comments SET last_seen_at = ? WHERE id IN (${placeholders})`
          ).bind(plan.deletedBumpIso, ...chunk));
        }
      }
    }
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
 *
 * 传了 bucket 时会透明回源外部扩容库：主 D1 为空（评论被 offload 到外部库）时直接读外部库；
 * overflow 模式下主库返回不足一页时，再合并外部库的新根评论并去重。
 */
export async function listRootComments(
  database: D1Database,
  contentPk: string,
  opts: { limit?: number; offset?: number; liveOnly?: boolean } = {},
  bucket?: any
): Promise<RootCommentRow[]> {
  // 上限 50：D1 单条 SQL 最多 100 个绑定参数，历史预览兜底查询要为每个根绑定
  // 一个 id（50 个根 = 50 参数，加外层查询参数仍在 100 以内），留足安全余量；
  // 前端每页只取 20，完全兼容。
  const limit = clampInt(opts.limit, 20, 1, 50);
  const offset = clampInt(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const liveOnly = Boolean(opts.liveOnly);
  const liveFilter = liveOnly ? " AND c.is_deleted = 0" : "";
  const liveBareFilter = liveOnly ? " AND is_deleted = 0" : "";
  const childCountSelectSql = liveOnly
    ? `CASE
         WHEN t.root_id IS NOT NULL THEN COALESCE(c.child_count, 0)
         ELSE COALESCE(NULLIF(c.child_count, 0), (SELECT COUNT(*) FROM comments ch WHERE ch.parent_comment_id = c.id AND ch.is_deleted = 0), 0)
       END`
    : `COALESCE(
         t.child_count,
         NULLIF(c.child_count, 0),
         (SELECT COUNT(*) FROM comments ch WHERE ch.parent_comment_id = c.id),
         0
       )`;

  const result = await database.prepare(`
    SELECT c.id, c.content_pk, c.author_name, c.author_avatar, c.be_replied,
           c.content_md, c.img_url, c.time_text, c.location, c.likes,
           c.is_author, c.is_top, c.is_featured, c.is_deleted, c.comment_hash,
           c.first_seen_at, c.last_seen_at,
           ${childCountSelectSql} AS child_count,
           COALESCE(t.is_complete, 0) AS is_complete,
           t.preview_json AS preview_json,
           t.synced_at AS thread_synced_at,
           CASE WHEN t.root_id IS NOT NULL AND COALESCE(t.is_complete, 0) = 0 THEN 1 ELSE 0 END AS needs_thread_retry
    FROM comments c
    LEFT JOIN comment_threads t ON t.root_id = c.id
    WHERE c.content_pk = ? AND c.parent_comment_id IS NULL${liveFilter}
    ORDER BY c.is_top DESC, c.likes DESC, c.id DESC
    LIMIT ? OFFSET ?
  `).bind(contentPk, limit, offset).all<RootCommentRow>();

  const rows = result.results ?? [];
  const offloadTargets = bucket ? await listReadableCommentOffloadTargets(bucket).catch(() => []) : [];

  // 主 D1 一条都没有：评论整批被 offload 到外部扩容库（或位于主 D1 末尾之后），直接透明回源
  if (rows.length === 0) {
    if (offset > 0 && offloadTargets.length > 0) {
      const mainIdsResult = await database.prepare(
        `SELECT id FROM comments WHERE content_pk = ? AND parent_comment_id IS NULL${liveBareFilter}`
      ).bind(contentPk).all<{ id: string }>().catch(() => ({ results: [] as Array<{ id: string }> }));
      const mainIds = new Set(
        (mainIdsResult.results ?? []).map(r => r.id).filter(Boolean)
      );
      if (mainIds.size > 0) {
        // 混合过渡态：主 D1 有旧根、外部库可能重存过同一根；跨目标累积去重后再按真实偏移切片
        const priorRemoteNeeded = Math.max(0, offset - mainIds.size);
        const targetRemoteTotal = priorRemoteNeeded + limit;
        const fetchLimit = targetRemoteTotal + mainIds.size;
        const seen = new Set(mainIds);
        const dedupedRemote: RootCommentRow[] = [];
        for (const target of offloadTargets) {
          const remoteRows = await fetchOffloadRootComments(target, contentPk, fetchLimit, 0, liveOnly);
          for (const row of remoteRows) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            dedupedRemote.push(row);
            if (dedupedRemote.length >= targetRemoteTotal) break;
          }
          if (dedupedRemote.length >= targetRemoteTotal) break;
        }
        return dedupedRemote.slice(priorRemoteNeeded, targetRemoteTotal);
      }
    }
    for (const target of offloadTargets) {
      const remoteRows = await fetchOffloadRootComments(target, contentPk, limit, offset, liveOnly);
      if (remoteRows.length > 0) return remoteRows;
    }
    return rows;
  }

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
      SELECT id, parent_comment_id, author_name, be_replied, content_md, likes, is_author, is_deleted
      FROM (
        SELECT id, parent_comment_id, author_name, be_replied, content_md, likes, is_author, is_deleted,
               ROW_NUMBER() OVER (PARTITION BY parent_comment_id ORDER BY is_deleted ASC, first_seen_at ASC) AS rn
        FROM comments
        WHERE parent_comment_id IN (${placeholders})
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
      is_deleted: number;
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
        isAuthor: child.is_author === 1,
        ...(child.is_deleted === 1 ? { isDeleted: true } : {})
      });
      previews.set(child.parent_comment_id, list);
    }
  }

  const finalRows: RootCommentRow[] = rows.map(({ preview_json, ...row }) => ({
    ...row,
    preview_replies: previews.get(row.id) ?? []
  }));

  // overflow 水位附近的过渡态：主库里是旧根评论、外部库里有新根评论。
  // 主库当前页不足 limit 时，从外部库按总分页水位补齐并排除已在主库出现过的根评论。
  if (finalRows.length < limit && offloadTargets.length > 0) {
    const seen = new Set(finalRows.map(row => row.id));
    if (offset > 0) {
      const mainIdsResult = await database.prepare(
        `SELECT id FROM comments WHERE content_pk = ? AND parent_comment_id IS NULL${liveBareFilter}`
      ).bind(contentPk).all<{ id: string }>().catch(() => ({ results: [] as Array<{ id: string }> }));
      for (const r of mainIdsResult.results ?? []) {
        if (r.id) seen.add(r.id);
      }
    }
    for (const target of offloadTargets) {
      const remoteRows = await fetchOffloadRootComments(target, contentPk, limit + offset, 0, liveOnly);
      for (const row of remoteRows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        finalRows.push(row);
        if (finalRows.length >= limit) break;
      }
      if (finalRows.length >= limit) break;
    }
  }

  return finalRows;
}

// 与主 D1 查询同构：外部库的 comments 存根评论行，comment_threads 存子评论数与预览
function buildRemoteRootCommentsSql(liveOnly: boolean): string {
  const liveFilter = liveOnly ? " AND c.is_deleted = 0" : "";
  const childCountSelectSql = liveOnly
    ? `CASE
         WHEN t.root_id IS NOT NULL THEN COALESCE(c.child_count, 0)
         ELSE COALESCE(NULLIF(c.child_count, 0), (SELECT COUNT(*) FROM comments ch WHERE ch.parent_comment_id = c.id AND ch.is_deleted = 0), 0)
       END`
    : `COALESCE(
         t.child_count,
         NULLIF(c.child_count, 0),
         (SELECT COUNT(*) FROM comments ch WHERE ch.parent_comment_id = c.id),
         0
       )`;
  return `
  SELECT c.id, c.content_pk, c.author_name, c.author_avatar, c.be_replied,
         c.content_md, c.img_url, c.time_text, c.location, c.likes,
         c.is_author, c.is_top, c.is_featured, c.is_deleted, c.comment_hash,
         c.first_seen_at, c.last_seen_at,
         ${childCountSelectSql} AS child_count,
         COALESCE(t.is_complete, 0) AS is_complete,
         t.preview_json AS preview_json,
         t.synced_at AS thread_synced_at,
         CASE WHEN t.root_id IS NOT NULL AND COALESCE(t.is_complete, 0) = 0 THEN 1 ELSE 0 END AS needs_thread_retry
  FROM comments c
  LEFT JOIN comment_threads t ON t.root_id = c.id
  WHERE c.content_pk = ? AND c.parent_comment_id IS NULL${liveFilter}
  ORDER BY c.is_top DESC, c.likes DESC, c.id DESC
  LIMIT ? OFFSET ?
`;
}

function normalizeRemoteRootRows(rows: Record<string, any>[]): RootCommentRow[] {
  const normalized: RootCommentRow[] = [];
  for (const row of rows) {
    const id = row.id == null ? "" : String(row.id);
    if (!id) continue;
    normalized.push({
      id,
      content_pk: String(row.content_pk ?? ""),
      author_name: row.author_name == null ? null : String(row.author_name),
      author_avatar: row.author_avatar == null ? null : String(row.author_avatar),
      be_replied: row.be_replied == null ? null : String(row.be_replied),
      content_md: row.content_md == null ? null : String(row.content_md),
      img_url: row.img_url == null ? null : String(row.img_url),
      time_text: row.time_text == null ? null : String(row.time_text),
      location: row.location == null ? null : String(row.location),
      likes: Number(row.likes ?? 0) || 0,
      is_author: Number(row.is_author ?? 0) || 0,
      is_top: Number(row.is_top ?? 0) || 0,
      is_featured: Number(row.is_featured ?? 0) || 0,
      is_deleted: Number(row.is_deleted ?? 0) || 0,
      comment_hash: String(row.comment_hash ?? ""),
      first_seen_at: String(row.first_seen_at ?? ""),
      last_seen_at: String(row.last_seen_at ?? ""),
      child_count: Number(row.child_count ?? 0) || 0,
      is_complete: Number(row.is_complete ?? 0) || 0,
      thread_synced_at: row.thread_synced_at == null ? null : String(row.thread_synced_at),
      needs_thread_retry: Number(row.needs_thread_retry ?? 0) || 0,
      // 预览在外部库 comment_threads.preview_json 里，解析失败按空预览处理（不阻塞根列表）
      preview_replies: parsePreviewJson(typeof row.preview_json === "string" ? row.preview_json : null)
    });
  }
  return normalized;
}

/** 从外部扩容库读取一页根评论；单个库失败只记日志并返回空，不能拖垮整个列表接口 */
async function fetchOffloadRootComments(
  target: ExternalStorageTarget,
  contentPk: string,
  limit: number,
  offset: number,
  liveOnly = false
): Promise<RootCommentRow[]> {
  try {
    const result = await executeRemoteSql(target, buildRemoteRootCommentsSql(liveOnly), [contentPk, limit, offset]);
    return normalizeRemoteRootRows(result.rows);
  } catch (err) {
    console.warn(`[comments] 外部扩容库读取根评论失败 (${target.name}):`, err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// 扩容分流写路径：评论 + 楼中楼 JSON 全部写外部 SQLite 兼容库
// 主 D1（comments / comment_threads / change_events）与主 R2（childcomments/*）零写入。
// ---------------------------------------------------------------------------

function toRemoteRootRow(row: Record<string, any>): ExistingRootRow {
  return {
    id: String(row.id ?? ""),
    comment_hash: String(row.comment_hash ?? ""),
    is_deleted: Number(row.is_deleted ?? 0) || 0,
    author_avatar: row.author_avatar == null ? null : String(row.author_avatar),
    likes: Number(row.likes ?? 0) || 0,
    time_text: row.time_text == null ? null : String(row.time_text),
    location: row.location == null ? null : String(row.location),
    child_count: Number(row.child_count ?? 0) || 0,
    last_seen_at: row.last_seen_at == null ? null : String(row.last_seen_at),
    deleted_at: row.deleted_at == null ? null : String(row.deleted_at)
  };
}

function toRemoteThreadRow(row: Record<string, any>): ExistingThreadRow {
  return {
    root_id: String(row.root_id ?? ""),
    child_count: Number(row.child_count ?? 0) || 0,
    is_complete: Number(row.is_complete ?? 0) || 0,
    thread_hash: String(row.thread_hash ?? ""),
    incoming_hash: String(row.incoming_hash ?? ""),
    preview_json: String(row.preview_json ?? "[]"),
    synced_at: row.synced_at == null ? null : String(row.synced_at)
  };
}

const REMOTE_THREAD_UPSERT_SQL = `
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
`;

const REMOTE_THREAD_COUNT_ONLY_SQL = `
  INSERT INTO comment_threads (
    root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(root_id) DO UPDATE SET
    content_pk = excluded.content_pk,
    r2_key = excluded.r2_key,
    child_count = excluded.child_count,
    synced_at = excluded.synced_at
`;

const REMOTE_WRITE_BATCH_SIZE = 20;

/**
 * 仅对 SQLite 系目标（cloudflare_d1 / turso）把同构多行 VALUES 合并成块，
 * 严格限制单条 SQL 绑定参数不超过 D1_MAX_SQL_PARAMS (90)，兼顾 D1 参数上限与 Workers 子请求预算。
 */
function appendChunkedMultiRowSql(
  targetList: RemoteSqlStatement[],
  rows: unknown[][],
  buildSql: (placeholdersSql: string) => string,
  customRowPlaceholder?: string
): void {
  if (!rows.length) return;
  const colsPerRow = rows[0].length;
  const rowsPerChunk = Math.max(1, Math.floor(D1_MAX_SQL_PARAMS / colsPerRow));
  const rowPlaceholder = customRowPlaceholder ?? `(${new Array(colsPerRow).fill("?").join(", ")})`;
  for (let i = 0; i < rows.length; i += rowsPerChunk) {
    const chunk = rows.slice(i, i + rowsPerChunk);
    const placeholdersSql = new Array(chunk.length).fill(rowPlaceholder).join(", ");
    const params: unknown[] = [];
    for (const row of chunk) params.push(...row);
    targetList.push({ sql: buildSql(placeholdersSql), params });
  }
}

/** 按批 flush 写语句：Turso 一批只占 1 个 Workers 子请求；D1 REST 内部按条串行 */
async function flushRemoteStatements(
  target: ExternalStorageTarget,
  statements: RemoteSqlStatement[],
  size = REMOTE_WRITE_BATCH_SIZE
): Promise<void> {
  for (let i = 0; i < statements.length; i += size) {
    await executeRemoteSqlBatch(target, statements.slice(i, i + size));
  }
}

async function replaceCommentsByRootOffloaded(
  input: IngestCommentsByRootInput,
  target: ExternalStorageTarget,
  env: { BUCKET: R2Bucket; DB: D1Database }
) {
  const now = new Date().toISOString();
  await ensureRemoteCommentSchema(target);

  // 远端现状：根评论 + 线程索引（有提交根时顺带取旧扁平子评论供防删归档合并）合成 1 次 pipeline 读取
  const readBatchStatements: RemoteSqlStatement[] = [
    {
      sql: `SELECT id, comment_hash, is_deleted, author_avatar, likes, time_text, location, child_count,
                   last_seen_at, deleted_at
            FROM comments
            WHERE content_pk = ? AND parent_comment_id IS NULL`,
      params: [input.contentPk]
    },
    {
      sql: `SELECT root_id, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at
            FROM comment_threads
            WHERE content_pk = ?`,
      params: [input.contentPk]
    }
  ];
  if (input.roots.length > 0) {
    readBatchStatements.push({
      sql: `SELECT id, parent_comment_id, author_name, author_avatar, be_replied, content_md,
                   img_url, time_text, location, likes, is_author, is_deleted
            FROM comments
            WHERE content_pk = ? AND parent_comment_id IS NOT NULL
            ORDER BY first_seen_at ASC`,
      params: [input.contentPk]
    });
  }
  const [existingResult, threadResult, remoteLegacyResult] = await executeRemoteSqlBatch(target, readBatchStatements);
  const existingRoots = existingResult.rows.map(toRemoteRootRow);
  const existingMap = new Map(existingRoots.map(row => [row.id, row]));
  const existingThreads = new Map(
    (threadResult?.rows ?? []).map(toRemoteThreadRow).map(row => [row.root_id, row])
  );
  const remoteLegacyChildrenByRoot = new Map<string, ChildCommentRecord[]>();
  const remoteLegacyReadFailed: boolean =
    input.roots.length > 0 && !(remoteLegacyResult as typeof existingResult | undefined);
  if (remoteLegacyResult) {
    for (const row of remoteLegacyResult.rows) {
      const parentId = row.parent_comment_id == null ? "" : String(row.parent_comment_id);
      if (!parentId) continue;
      const child = mapRemoteChildRow(row);
      const list = remoteLegacyChildrenByRoot.get(parentId);
      if (list) list.push(child);
      else remoteLegacyChildrenByRoot.set(parentId, [child]);
    }
  }

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
  const isSqliteRemote = target.provider === "cloudflare_d1" || target.provider === "turso";

  // 命中「已确认收敛」快路径的根（rootId → 外部库现有 synced_at）；
  // 以及全量对账时已经软删、不在本次 incoming 里的根（可能在其他库留下更晚的失败记录）。
  const confirmedFastPathRoots = new Map<string, string | null>();
  const alreadyDeletedRoots: ExistingRootRow[] = [];

  let added = 0;
  let updated = 0;
  let deleted = 0;

  // 1) 根评论 upsert + 删除对账（SQLite 目标合并多行 INSERT 与 IN 删除，单句参数 <= 90）
  const rootStatements: RemoteSqlStatement[] = [];
  const newRootParamRows: unknown[][] = [];
  for (const { root, img, hash, children } of prepared) {
    const exists = existingMap.get(root.id);
    const liveChildCount = Math.max(root.childCount, children.length);

    if (!exists) {
      newRootParamRows.push([
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
        liveChildCount,
        now,
        now
      ]);
      added++;
      continue;
    }

    if (exists.comment_hash !== hash || exists.is_deleted === 1) {
      rootStatements.push({
        sql: `
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
      `,
        params: [
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
          liveChildCount,
          now,
          root.id
        ]
      });
      updated++;
      continue;
    }

    const needsRefresh =
      isAvatarUrlChanged(exists.author_avatar, root.authorAvatar) ||
      (exists.time_text || "") !== (root.time || "") ||
      (exists.location || "") !== (root.location || "") ||
      Number(exists.child_count ?? 0) !== liveChildCount;

    if (needsRefresh) {
      rootStatements.push({
        sql: `
        UPDATE comments
        SET author_avatar = COALESCE(NULLIF(?, ''), author_avatar),
            last_seen_at = ?, likes = ?, time_text = ?, location = ?, child_count = ?,
            is_deleted = 0, deleted_at = NULL
        WHERE id = ?
      `,
        params: [
          root.authorAvatar ?? "",
          now,
          root.likes,
          root.time ?? "",
          root.location ?? "",
          liveChildCount,
          root.id
        ]
      });
    }
  }

  if (newRootParamRows.length > 0) {
    const buildInsertCommentsSql = (placeholders: string) => `
      INSERT INTO comments (
        id, content_pk, parent_comment_id, author_name, author_avatar, be_replied,
        content_md, img_url, time_text, location, likes, is_author, is_top, is_featured,
        comment_hash, child_count, first_seen_at, last_seen_at, is_deleted, deleted_at
      ) VALUES ${placeholders}
      ON CONFLICT(id) DO UPDATE SET
        content_pk = excluded.content_pk,
        parent_comment_id = NULL,
        author_name = COALESCE(NULLIF(excluded.author_name, ''), comments.author_name),
        author_avatar = COALESCE(NULLIF(excluded.author_avatar, ''), comments.author_avatar),
        be_replied = NULL,
        content_md = COALESCE(NULLIF(excluded.content_md, ''), comments.content_md),
        img_url = COALESCE(NULLIF(excluded.img_url, ''), comments.img_url),
        time_text = COALESCE(NULLIF(excluded.time_text, ''), comments.time_text),
        location = COALESCE(NULLIF(excluded.location, ''), comments.location),
        likes = excluded.likes,
        is_author = excluded.is_author,
        is_top = excluded.is_top,
        is_featured = excluded.is_featured,
        comment_hash = excluded.comment_hash,
        child_count = excluded.child_count,
        last_seen_at = excluded.last_seen_at,
        is_deleted = 0,
        deleted_at = NULL
    `;
    if (isSqliteRemote) {
      appendChunkedMultiRowSql(
        rootStatements,
        newRootParamRows,
        buildInsertCommentsSql,
        "(?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)"
      );
    } else {
      for (const row of newRootParamRows) {
        rootStatements.push({
          sql: buildInsertCommentsSql("(?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)"),
          params: row
        });
      }
    }
  }

  if (!input.partial) {
    const deleteIds: string[] = [];
    for (const row of existingRoots) {
      if (incomingRootIds.has(row.id)) continue;
      // 已软删根不重复写；若非活跃库残留更晚的失败记录，后面按需刷新 last_seen_at。
      if (row.is_deleted === 1) {
        alreadyDeletedRoots.push(row);
        continue;
      }
      if (row.is_deleted === 0) {
        deleteIds.push(row.id);
        deleted++;
      }
    }
    if (deleteIds.length > 0) {
      if (isSqliteRemote) {
        const maxIdsPerChunk = D1_MAX_SQL_PARAMS - 2;
        for (let i = 0; i < deleteIds.length; i += maxIdsPerChunk) {
          const chunk = deleteIds.slice(i, i + maxIdsPerChunk);
          const placeholders = chunk.map(() => "?").join(", ");
          rootStatements.push({
            sql: `UPDATE comments SET is_deleted = 1, deleted_at = ?, last_seen_at = ? WHERE id IN (${placeholders})`,
            params: [now, now, ...chunk]
          });
        }
      } else {
        for (const id of deleteIds) {
          rootStatements.push({
            sql: `UPDATE comments SET is_deleted = 1, deleted_at = ?, last_seen_at = ? WHERE id = ?`,
            params: [now, now, id]
          });
        }
      }
    }
  }

  await flushRemoteStatements(target, rootStatements);

  // 2) 楼中楼 JSON + 线程索引写外部库
  // 防删归档模式：原站评论被整体清空时，绝不删除外部库残余楼中楼/线程索引或主 R2 旧对象，
  // 只软删主库遗留活跃根评论并将 archived_comment_count 单调推高、现网 comment_count 置 0。
  if (!input.partial && input.roots.length === 0 && (!input.allRootIds || input.allRootIds.length === 0)) {
    const archivedChildMap = new Map<string, number>();
    for (const row of existingRoots) {
      archivedChildMap.set(
        row.id,
        Math.max(Number(existingThreads.get(row.id)?.child_count ?? 0), Number(row.child_count ?? 0))
      );
    }
    for (const [rootId, th] of existingThreads) {
      if (!archivedChildMap.has(rootId)) {
        archivedChildMap.set(rootId, Number(th.child_count ?? 0));
      }
    }
    let archivedTotal = archivedChildMap.size;
    for (const cCount of archivedChildMap.values()) archivedTotal += cCount;
    try {
      const mainCleanupStmts: any[] = [
        env.DB.prepare(`
          UPDATE comments
          SET is_deleted = 1, deleted_at = ?, last_seen_at = ?
          WHERE content_pk = ? AND is_deleted = 0
        `).bind(now, now, input.contentPk),
        env.DB.prepare(`
          UPDATE contents
          SET archived_comment_count = MAX(COALESCE(archived_comment_count, 0), comment_count, ?),
              comment_count = 0
          WHERE pk = ?
        `).bind(archivedTotal, input.contentPk)
      ];
      await runBatchedStatements(env.DB, mainCleanupStmts, ROOT_BATCH_SIZE);
    } catch { /* 主库状态更新失败不阻塞外部库已完成的软删归档 */ }
  }

  // 在进入根循环前向本地主 D1 与外部库各查一次该内容是否存在迁移前旧楼中楼历史，
  // 只有远端或主库确有旧楼中楼历史时，才为 0 回复根捞回旧数据并标已删归档，
  // 避免全新 0 回复根每批白白多发几十次子请求。
  const mainLegacyRootIds = new Set<string>();
  const mainLegacyThreadChildCountByRoot = new Map<string, number>();
  const mainLegacyChildrenByRoot = new Map<string, ChildCommentRecord[]>();
  let mainLegacyQueryFailed = false;
  const remoteLegacyRootIds = new Set<string>();
  let remoteLegacyQueryFailed = false;
  const hasZeroReplyCompleteCandidate =
    !input.partial &&
    prepared.some(
      ({ root, children }) =>
        children.length === 0 &&
        Math.max(root.childCount, children.length) === 0 &&
        root.isChildrenComplete
    );
  if (hasZeroReplyCompleteCandidate) {
    try {
      const [mainThreadsRes, mainRootsRes, mainChildrenRes] = await Promise.all([
        env.DB.prepare(`SELECT root_id, child_count FROM comment_threads WHERE content_pk = ?`)
          .bind(input.contentPk)
          .all<{ root_id: string; child_count: number }>(),
        env.DB.prepare(`
          SELECT id AS root_id, child_count FROM comments
          WHERE content_pk = ? AND parent_comment_id IS NULL AND child_count > 0
        `).bind(input.contentPk).all<{ root_id: string; child_count: number }>(),
        env.DB.prepare(`
          SELECT id, parent_comment_id, author_name, author_avatar, be_replied, content_md,
                 img_url, time_text, location, likes, is_author, is_deleted
          FROM comments
          WHERE content_pk = ? AND parent_comment_id IS NOT NULL
          ORDER BY first_seen_at ASC
        `).bind(input.contentPk).all<ChildSelectRow>()
      ]);
      for (const r of mainThreadsRes.results ?? []) {
        if (!r.root_id) continue;
        mainLegacyRootIds.add(r.root_id);
        const count = Number(r.child_count ?? 0) || 0;
        if (count > 0) {
          mainLegacyThreadChildCountByRoot.set(
            r.root_id,
            Math.max(mainLegacyThreadChildCountByRoot.get(r.root_id) ?? 0, count)
          );
        }
      }
      for (const r of mainRootsRes.results ?? []) {
        if (!r.root_id) continue;
        mainLegacyRootIds.add(r.root_id);
        const count = Number(r.child_count ?? 0) || 0;
        if (count > 0) {
          mainLegacyThreadChildCountByRoot.set(
            r.root_id,
            Math.max(mainLegacyThreadChildCountByRoot.get(r.root_id) ?? 0, count)
          );
        }
      }
      for (const row of mainChildrenRes.results ?? []) {
        const parentId = row.parent_comment_id;
        if (!parentId) continue;
        mainLegacyRootIds.add(parentId);
        const child = mapStoredChildRow(row);
        const list = mainLegacyChildrenByRoot.get(parentId);
        if (list) list.push(child);
        else mainLegacyChildrenByRoot.set(parentId, [child]);
      }
    } catch {
      mainLegacyQueryFailed = true;
    }
    try {
      const remoteLegacyRes = await executeRemoteSqlBatch(target, [{
        sql: `SELECT root_id FROM child_comment_blobs WHERE content_pk = ?`,
        params: [input.contentPk]
      }]);
      for (const row of remoteLegacyRes[0]?.rows ?? []) {
        const rid = row.root_id == null ? "" : String(row.root_id);
        if (rid) remoteLegacyRootIds.add(rid);
      }
    } catch {
      remoteLegacyQueryFailed = true;
    }
  }

  // 合并所需的旧 JSON：按 <= 90 参数分块一次 IN 批量读回（大幅压低 cloudflare_d1 子请求数）
  const childStatements: RemoteSqlStatement[] = [];
  const blobUpsertRows: unknown[][] = [];
  const threadUpsertRows: unknown[][] = [];
  const threadCountOnlyKeepRows: unknown[][] = [];
  const threadCountOnlyClosedRows: unknown[][] = [];
  const mergeRootIds = prepared
    .filter(({ root, children }) => {
      const hasChildren = children.length > 0;
      const childCount = Math.max(root.childCount, children.length);
      const isZeroReplyComplete = !input.partial && !hasChildren && childCount === 0 && root.isChildrenComplete;
      if (isZeroReplyComplete) {
        return (
          existingThreads.has(root.id) ||
          Number(existingMap.get(root.id)?.child_count ?? 0) > 0 ||
          remoteLegacyRootIds.has(root.id) ||
          remoteLegacyChildrenByRoot.has(root.id)
        );
      }
      if (!hasChildren) return false;
      return (
        !root.isChildrenComplete ||
        existingThreads.has(root.id) ||
        Number(existingMap.get(root.id)?.child_count ?? 0) > 0 ||
        remoteLegacyChildrenByRoot.has(root.id)
      );
    })
    .map(item => item.root.id);
  const storedBlobByRoot = new Map<string, string | null>();
  if (mergeRootIds.length > 0) {
    if (isSqliteRemote) {
      for (let i = 0; i < mergeRootIds.length; i += D1_MAX_SQL_PARAMS) {
        const chunk = mergeRootIds.slice(i, i + D1_MAX_SQL_PARAMS);
        const placeholders = chunk.map(() => "?").join(", ");
        const readRes = await executeRemoteSqlBatch(target, [{
          sql: `SELECT root_id, payload_json FROM child_comment_blobs WHERE root_id IN (${placeholders})`,
          params: chunk
        }]).catch(() => null);
        if (!readRes) {
          for (const rootId of chunk) storedBlobByRoot.set(rootId, null);
          continue;
        }
        const byRoot = new Map<string, string>();
        for (const row of readRes[0]?.rows ?? []) {
          const rid = row.root_id == null ? "" : String(row.root_id);
          if (rid && typeof row.payload_json === "string") {
            byRoot.set(rid, row.payload_json);
          }
        }
        for (const rootId of chunk) {
          storedBlobByRoot.set(rootId, byRoot.get(rootId) ?? "");
        }
      }
    } else {
      const readResults = await executeRemoteSqlBatch(
        target,
        mergeRootIds.map(rootId => ({
          sql: `SELECT payload_json FROM child_comment_blobs WHERE root_id = ?`,
          params: [rootId]
        }))
      ).catch(() => null);
      mergeRootIds.forEach((rootId, index) => {
        if (!readResults) {
          storedBlobByRoot.set(rootId, null);
          return;
        }
        const raw = readResults[index]?.rows[0]?.payload_json;
        storedBlobByRoot.set(rootId, typeof raw === "string" ? raw : "");
      });
    }
  }

  // 0 活回复归档/迁移失败：不写空快照，但必须留下待重试线程索引行（is_complete=0, incoming_hash=""），
  // 供 listRootComments 的 needs_thread_retry 与爬虫重抓消费；child_count 保留既有历史水位。
  const pushZeroReplyArchiveRetryRow = (
    rootId: string,
    existingThread: ExistingThreadRow | undefined
  ): void => {
    const existingRootChildCount = Number(existingMap.get(rootId)?.child_count ?? 0);
    const mainLegacyList = mainLegacyChildrenByRoot.get(rootId) ?? [];
    const remoteLegacyList = remoteLegacyChildrenByRoot.get(rootId) ?? [];
    const fallbackHash = existingThread?.thread_hash ?? "";
    const retryChildCount = Math.max(
      existingThread?.child_count ?? 0,
      existingRootChildCount,
      mainLegacyThreadChildCountByRoot.get(rootId) ?? 0,
      mainLegacyList.length,
      remoteLegacyList.length
    );
    // 同一条子评论可能同时存在于主库与外部库（迁移/双写过渡期）：按 id 合并去重，
    // 外部库版本覆盖主库版本，保证 retryPreviewJson 里每个子评论 ID 只出现一次。
    // 两份都是历史数据，必须原样保留 isDeleted，不能走会清除删除标记的现网合并逻辑。
    const legacyPreviewList = mergeStoredChildrenLists(mainLegacyList, remoteLegacyList);
    const retryPreviewJson = existingThread
      ? (existingThread.preview_json ?? "[]")
      : (legacyPreviewList.length > 0 ? JSON.stringify(buildPreviewReplies(legacyPreviewList)) : "[]");
    if (
      existingThread &&
      existingThread.is_complete === 0 &&
      existingThread.incoming_hash === "" &&
      existingThread.thread_hash === fallbackHash &&
      existingThread.child_count === retryChildCount &&
      (existingThread.preview_json ?? "[]") === retryPreviewJson
    ) {
      return;
    }
    threadUpsertRows.push([
      rootId,
      input.contentPk,
      childCommentsKey(rootId),
      retryChildCount,
      0,
      fallbackHash,
      "",
      retryPreviewJson,
      now
    ]);
  };

  for (const { root, children } of prepared) {
    const hasChildren = children.length > 0;
    const childCount = Math.max(root.childCount, children.length);
    const existingThread = existingThreads.get(root.id);
    const isChildrenClosed = Boolean(root.isChildrenClosed);

    // 单个根的楼中楼在原站被删光：仅当远端或主库存在历史线程/子评论记录时才捞回旧回复并标 isDeleted=true 永久归档，
    // 全新 0 回复根跳过写入；命中快路径时 0 写入。
    if (!input.partial && !hasChildren && childCount === 0 && root.isChildrenComplete) {
      const emptyIncomingHash = await sha256(JSON.stringify({ children: [], childCount: 0, complete: true }));
      if (
        existingThread &&
        existingThread.incoming_hash === emptyIncomingHash &&
        existingThread.is_complete === 1 &&
        existingThread.thread_hash !== ""
      ) {
        // 已确认收敛（0 回复 + complete 权威归档）：非活跃库若有更晚失败记录，后面按需刷新 synced_at。
        confirmedFastPathRoots.set(root.id, existingThread.synced_at ?? null);
        continue;
      }

      const hadRemoteThreadData = Boolean(existingThread);
      const existingRootChildCount = Number(existingMap.get(root.id)?.child_count ?? 0);
      const hadMainLegacyData = mainLegacyQueryFailed || mainLegacyRootIds.has(root.id);
      const hadRemoteLegacyData =
        remoteLegacyQueryFailed ||
        remoteLegacyRootIds.has(root.id) ||
        remoteLegacyChildrenByRoot.has(root.id);
      if (!hadRemoteThreadData && existingRootChildCount === 0 && !hadMainLegacyData && !hadRemoteLegacyData) {
        continue;
      }

      const raw = storedBlobByRoot.get(root.id);
      if (mainLegacyQueryFailed || remoteLegacyQueryFailed || raw === null || remoteLegacyReadFailed) {
        pushZeroReplyArchiveRetryRow(root.id, existingThread);
        continue;
      }

      let prevChildren: ChildCommentRecord[] = [];
      let parsedBlobInvalid = false;
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as { children?: unknown; complete?: unknown } | null;
          if (!parsed || !Array.isArray(parsed.children)) {
            parsedBlobInvalid = true;
          } else {
            prevChildren = parsed.children.filter(
              (c): c is ChildCommentRecord => !!c && typeof c === "object" && typeof (c as any).id === "string"
            );
            if (prevChildren.length === 0 && parsed.complete !== true) {
              prevChildren = mergeStoredChildrenLists(remoteLegacyChildrenByRoot.get(root.id) ?? []);
            }
          }
        } catch {
          parsedBlobInvalid = true;
        }
      } else {
        prevChildren = mergeStoredChildrenLists(remoteLegacyChildrenByRoot.get(root.id) ?? []);
      }

      if (parsedBlobInvalid) {
        pushZeroReplyArchiveRetryRow(root.id, existingThread);
        continue;
      }

      // 迁移前主库有历史线程/子评论而外部库尚无回复：从主 R2 与主 D1 捞回并标已删归档，防止切换 offload 后丢失旧楼中楼
      const mainLegacyList = mainLegacyChildrenByRoot.get(root.id) ?? [];
      if (prevChildren.length === 0 && hadMainLegacyData) {
        const mainStored = await readStoredChildThread(env.BUCKET, root.id, { bypassCache: true });
        if (mainStored.status === "error") {
          console.warn(`[comments] skip offload archive empty for ${root.id}: main R2 object unreadable`);
          pushZeroReplyArchiveRetryRow(root.id, existingThread);
          continue;
        }
        if (mainStored.status === "ok") {
          prevChildren = mergeStoredChildrenLists(mainLegacyList, mainStored.children);
        } else {
          prevChildren = mainLegacyList;
        }
      }

      const archivedChildren = archiveMergeChildren(prevChildren, [], true);
      if (archivedChildren.length === 0 && !existingThread && !hadMainLegacyData && existingRootChildCount === 0) {
        continue;
      }
      const archivedThreadHash = await sha256(JSON.stringify({ children: archivedChildren, complete: true }));
      const archivedCount = Math.max(
        archivedChildren.length,
        existingThread?.child_count ?? 0,
        existingRootChildCount,
        mainLegacyThreadChildCountByRoot.get(root.id) ?? 0
      );
      const previewJson = JSON.stringify(buildPreviewReplies(archivedChildren));
      blobUpsertRows.push([
        root.id,
        input.contentPk,
        JSON.stringify({ children: archivedChildren, complete: true, updatedAt: now }),
        1,
        now
      ]);
      threadUpsertRows.push([
        root.id,
        input.contentPk,
        childCommentsKey(root.id),
        archivedCount,
        1,
        archivedThreadHash,
        emptyIncomingHash,
        previewJson,
        now
      ]);
      continue;
    }

    if (!hasChildren && childCount === 0) continue;
    const incomingHash = await sha256(JSON.stringify({
      children,
      childCount,
      complete: root.isChildrenComplete,
      ...(isChildrenClosed ? { closed: true } : {})
    }));

    // 完全重复的同步：0 次外部库写入（与主库快路径一致的判定条件）
    if (
      existingThread &&
      existingThread.incoming_hash === incomingHash &&
      existingThread.child_count >= childCount &&
      (existingThread.is_complete === 1 || (!root.isChildrenComplete && (!isChildrenClosed || existingThread.is_complete === 2))) &&
      (!hasChildren || existingThread.thread_hash !== "")
    ) {
      // 只有本次确实抓全/闭评且外部库已是完整态才算确认收敛；hot/partial 不刷新。
      if (
        !remoteLegacyReadFailed &&
        ((root.isChildrenComplete && existingThread.is_complete === 1) ||
          (isChildrenClosed && existingThread.is_complete === 2))
      ) {
        confirmedFastPathRoots.set(root.id, existingThread.synced_at ?? null);
      }
      continue;
    }

    // 子评论尚未抓取（或页 0 遇闭评）：保留已有楼中楼 JSON/哈希/预览与归档计数；闭评置 2 冻结，否则保留原 is_complete
    if (!hasChildren) {
      const desiredComplete = isChildrenClosed ? 2 : (existingThread?.is_complete ?? 0);
      const effectiveChildCount = Math.max(childCount, existingThread?.child_count ?? 0);
      if (
        existingThread &&
        existingThread.child_count === effectiveChildCount &&
        existingThread.is_complete === desiredComplete
      ) {
        // 闭评冻结态（is_complete=2）本身就是权威收敛证据；非闭评的「未抓全跳过」不刷新。
        if (isChildrenClosed && existingThread.is_complete === 2) {
          confirmedFastPathRoots.set(root.id, existingThread.synced_at ?? null);
        }
        continue;
      }
      const rowParams = [
        root.id,
        input.contentPk,
        childCommentsKey(root.id),
        effectiveChildCount,
        desiredComplete,
        existingThread?.thread_hash ?? "",
        existingThread?.incoming_hash ?? "",
        existingThread?.preview_json ?? "[]",
        now
      ];
      if (isChildrenClosed) {
        threadCountOnlyClosedRows.push(rowParams);
      } else {
        threadCountOnlyKeepRows.push(rowParams);
      }
      continue;
    }

    const key = childCommentsKey(root.id);
    const remoteLegacyList = remoteLegacyChildrenByRoot.get(root.id) ?? [];
    let childrenToStore = archiveMergeChildren(remoteLegacyList, children, root.isChildrenComplete);
    let readFailed: boolean = remoteLegacyReadFailed;
    const hadRemoteMergeCandidate =
      !root.isChildrenComplete ||
      Boolean(existingThread) ||
      Number(existingMap.get(root.id)?.child_count ?? 0) > 0 ||
      remoteLegacyList.length > 0;
    if (hadRemoteMergeCandidate) {
      const raw = storedBlobByRoot.get(root.id);
      if (raw === null || remoteLegacyReadFailed) {
        readFailed = true;
      } else if (raw) {
        try {
          const parsed = JSON.parse(raw) as { children?: unknown; complete?: unknown } | null;
          if (!parsed || !Array.isArray(parsed.children)) {
            readFailed = true;
          } else {
            const existingChildren = parsed.children.filter(
              (c): c is ChildCommentRecord => !!c && typeof c === "object" && typeof (c as any).id === "string"
            );
            const baseChildren =
              existingChildren.length === 0 && parsed.complete !== true
                ? mergeStoredChildrenLists(remoteLegacyList, existingChildren)
                : existingChildren;
            childrenToStore = archiveMergeChildren(baseChildren, children, root.isChildrenComplete);
          }
        } catch {
          readFailed = true;
        }
      } else {
        childrenToStore = archiveMergeChildren(remoteLegacyList, children, root.isChildrenComplete);
      }
    }

    const complete = root.isChildrenComplete;
    const effectiveChildCount = complete
      ? Math.max(childCount, childrenToStore.length, existingThread?.child_count ?? 0)
      : Math.max(childCount, existingThread?.child_count ?? 0);
    const previewJson = JSON.stringify(buildPreviewReplies(childrenToStore));
    const nextThreadHash = await sha256(JSON.stringify({ children: childrenToStore, complete }));
    const targetIsComplete = complete
      ? 1
      : (isChildrenClosed || existingThread?.is_complete === 2)
        ? 2
        : 0;

    let isComplete: number;
    let storedThreadHash: string;
    let storedIncomingHash = incomingHash;
    if (readFailed) {
      console.warn(`[comments] 跳过外部库楼中楼写入 (${root.id}): 旧 JSON 不可读`);
      isComplete = existingThread?.is_complete === 2 ? 2 : 0;
      storedThreadHash = existingThread?.thread_hash ?? "";
      storedIncomingHash = "";
    } else if (
      existingThread &&
      existingThread.thread_hash === nextThreadHash &&
      (complete ? existingThread.is_complete === 1 : existingThread.is_complete !== 1)
    ) {
      isComplete = targetIsComplete;
      storedThreadHash = nextThreadHash;
    } else {
      blobUpsertRows.push([
        root.id,
        input.contentPk,
        JSON.stringify({ children: childrenToStore, complete, updatedAt: now }),
        complete ? 1 : 0,
        now
      ]);
      isComplete = targetIsComplete;
      storedThreadHash = nextThreadHash;
    }

    if (
      existingThread &&
      existingThread.incoming_hash === storedIncomingHash &&
      existingThread.child_count === effectiveChildCount &&
      existingThread.preview_json === previewJson &&
      existingThread.is_complete === isComplete &&
      existingThread.thread_hash === storedThreadHash
    ) {
      // 写后字段一致说明本轮没有写入；若本次确实抓全/闭评且外部库已有完整态，按需补 synced_at。
      if (
        !readFailed &&
        ((root.isChildrenComplete && existingThread.is_complete === 1) ||
          (isChildrenClosed && existingThread.is_complete === 2))
      ) {
        confirmedFastPathRoots.set(root.id, existingThread.synced_at ?? null);
      }
      continue;
    }

    threadUpsertRows.push([
      root.id,
      input.contentPk,
      key,
      effectiveChildCount,
      isComplete,
      storedThreadHash,
      storedIncomingHash,
      previewJson,
      now
    ]);
  }

  // 「已确认收敛却命中快路径」时按需探测非活跃库（主 D1 + 其他可读外部库）：
  // 只有对方存在更晚的未完成活根，才追加一条轻量 synced_at / last_seen_at 刷新；
  // 任何非活跃库查询异常都在探测内部吞掉，绝不影响当前写入；无匹配时保持 0 外部库写入。
  if (confirmedFastPathRoots.size > 0 || (!input.partial && alreadyDeletedRoots.length > 0)) {
    const otherReadableTargets = (await listReadableCommentOffloadTargets(env.BUCKET).catch(() => []))
      .filter(t => t.id !== target.id);
    const candidateIds = Array.from(new Set([
      ...confirmedFastPathRoots.keys(),
      ...alreadyDeletedRoots.map(row => row.id)
    ]));
    const inactiveIncomplete = await probeInactiveIncompleteTimestamps({
      contentPk: input.contentPk,
      ids: candidateIds,
      mainDatabase: env.DB,
      remoteTargets: otherReadableTargets
    });
    if (inactiveIncomplete.size > 0) {
      const plan = planInactiveIncompleteRefreshes({
        now,
        confirmedFastPathRoots,
        alreadyDeletedRoots,
        inactiveIncomplete
      });
      for (const chunk of chunkIdsForUpdate(plan.threadRootIds)) {
        const placeholders = chunk.map(() => "?").join(", ");
        childStatements.push({
          sql: `UPDATE comment_threads SET synced_at = ? WHERE root_id IN (${placeholders})`,
          params: [plan.threadBumpIso, ...chunk]
        });
      }
      for (const chunk of chunkIdsForUpdate(plan.deletedRootIds)) {
        const placeholders = chunk.map(() => "?").join(", ");
        childStatements.push({
          sql: `UPDATE comments SET last_seen_at = ? WHERE id IN (${placeholders})`,
          params: [plan.deletedBumpIso, ...chunk]
        });
      }
    }
  }

  if (isSqliteRemote) {
    appendChunkedMultiRowSql(
      childStatements,
      blobUpsertRows,
      placeholders => `
        INSERT OR REPLACE INTO child_comment_blobs (root_id, content_pk, payload_json, complete, updated_at)
        VALUES ${placeholders}
      `
    );
    appendChunkedMultiRowSql(
      childStatements,
      threadUpsertRows,
      placeholders => `
        INSERT INTO comment_threads (
          root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at
        ) VALUES ${placeholders}
        ON CONFLICT(root_id) DO UPDATE SET
          content_pk = excluded.content_pk,
          r2_key = excluded.r2_key,
          child_count = excluded.child_count,
          is_complete = excluded.is_complete,
          thread_hash = excluded.thread_hash,
          incoming_hash = excluded.incoming_hash,
          preview_json = excluded.preview_json,
          synced_at = excluded.synced_at
      `
    );
    appendChunkedMultiRowSql(
      childStatements,
      threadCountOnlyKeepRows,
      placeholders => `
        INSERT INTO comment_threads (
          root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at
        ) VALUES ${placeholders}
        ON CONFLICT(root_id) DO UPDATE SET
          content_pk = excluded.content_pk,
          r2_key = excluded.r2_key,
          child_count = excluded.child_count,
          synced_at = excluded.synced_at
      `
    );
    appendChunkedMultiRowSql(
      childStatements,
      threadCountOnlyClosedRows,
      placeholders => `
        INSERT INTO comment_threads (
          root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at
        ) VALUES ${placeholders}
        ON CONFLICT(root_id) DO UPDATE SET
          content_pk = excluded.content_pk,
          r2_key = excluded.r2_key,
          child_count = excluded.child_count,
          is_complete = excluded.is_complete,
          synced_at = excluded.synced_at
      `
    );
  } else {
    for (const row of blobUpsertRows) {
      childStatements.push({
        sql: `INSERT OR REPLACE INTO child_comment_blobs (root_id, content_pk, payload_json, complete, updated_at)
              VALUES (?, ?, ?, ?, ?)`,
        params: row
      });
    }
    for (const row of threadUpsertRows) {
      childStatements.push({ sql: REMOTE_THREAD_UPSERT_SQL, params: row });
    }
    for (const row of threadCountOnlyKeepRows) {
      childStatements.push({ sql: REMOTE_THREAD_COUNT_ONLY_SQL, params: row });
    }
    for (const row of threadCountOnlyClosedRows) {
      childStatements.push({
        sql: `
          INSERT INTO comment_threads (
            root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(root_id) DO UPDATE SET
            content_pk = excluded.content_pk,
            r2_key = excluded.r2_key,
            child_count = excluded.child_count,
            is_complete = excluded.is_complete,
            synced_at = excluded.synced_at
        `,
        params: row
      });
    }
  }

  await flushRemoteStatements(target, childStatements);

  // 主 D1 写入 0 行、主 R2 PUT 0 次。
  // added/updated/deleted 回答的是「主 D1 写了几行」，这里必须是 0：
  // 爬虫的每日 D1 写入预算正是 (added+updated+deleted)*2 + threadUpserts，报 0 才不会误耗预算。
  // 本次真正写进外部库的条数放在 offloadedCounts 里，便于排查。
  return {
    added: 0,
    updated: 0,
    deleted: 0,
    r2Puts: 0,
    threadUpserts: 0,
    offloadedTo: target.name,
    offloadedCounts: { added, updated, deleted }
  };
}

/** 判断外部评论扩容库中是否已有指定内容的评论（存在即返回 true，避免 offload 时 prevCommentCount 误归零） */
export async function hasOffloadedComments(
  bucket: R2Bucket | undefined,
  contentPk: string
): Promise<boolean> {
  if (!bucket) return false;
  const targets = await listReadableCommentOffloadTargets(bucket).catch(() => []);
  for (const target of targets) {
    try {
      const result = await executeRemoteSql(
        target,
        `SELECT 1 AS has_any FROM comments WHERE content_pk = ? LIMIT 1`,
        [contentPk]
      );
      if (result.rows.length > 0) return true;
    } catch {
      // 单个外部库不可用时继续探测下一个目标
    }
  }
  return false;
}

/** 解析 DB / API 返回的时间戳；支持 ISO 与 SQLite `YYYY-MM-DD HH:MM:SS`，空值或非法值返回 null */
function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  let text = String(value).trim();
  if (!text) return null;
  text = text.replace(" ", "T");
  // SQLite 的 datetime('now') 不带时区，按 UTC 解释；带 Z/偏移的 ISO 原样解析
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) text = `${text}Z`;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/** 多个时间戳中取最新值；全部缺失/非法时返回 null */
function maxTimestampMs(...values: unknown[]): number | null {
  let latest: number | null = null;
  for (const value of values) {
    const ms = parseTimestampMs(value);
    if (ms !== null && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

interface IncompleteRootRow {
  id?: string | null;
  root_last_seen_at?: string | null;
  thread_synced_at?: string | null;
  latest_child_seen_at?: string | null;
}

interface SettledRootRow {
  id?: string | null;
  is_deleted?: number | null;
  deleted_at?: string | null;
  root_last_seen_at?: string | null;
  is_complete?: number | null;
  thread_synced_at?: string | null;
}

/**
 * 判断某篇内容是否还有「需要重试归档」的存活根评论。
 *
 * 根评论列表按热度只取前 50 条（D1 绑定参数上限），第 50 根之后失败归档的线程
 * 不会出现在任何一页里；爬虫仅凭当前页逐行状态会永久漏掉它们。这里用单条
 * `SELECT 1 ... LIMIT 1` 在当前实际写入库探测，不拉整表、不占绑定参数、
 * 不会因 join 放大重复计数。
 *
 * 启用外部分流后，任意外部库里可能残留历史副本，且 `resolveActiveOffloadTarget`
 * 会随 storageRole / overflowThresholdRows / 主库评论行数变化。因此：
 * - 先确定「当前实际写入库」（主 D1 或某个外部库）。实际写入库有未完成活根，
 *   必须触发重试，非活跃库的旧副本无权屏蔽它；
 * - 非活跃库里的待重试根，只有实际写入库存在「明确收敛证据」（软删根或
 *   is_complete IN (1, 2) 的线程索引）且收敛时间不早于待重试副本时才算收敛。
 *   远端只有裸根行（partial 写入后线程/blob 尚未落盘）不算收敛。
 */
export async function hasIncompleteLiveRoot(
  database: D1Database,
  contentPk: string,
  bucket?: any
): Promise<boolean> {
  const hasAnySql = `SELECT 1 AS has_any ${INCOMPLETE_LIVE_ROOT_WHERE_SQL} LIMIT 1`;
  const rootRowsSql = `
    SELECT
      c.id AS id,
      c.last_seen_at AS root_last_seen_at,
      t.synced_at AS thread_synced_at,
      (
        SELECT MAX(ch.last_seen_at)
        FROM comments ch
        WHERE ch.parent_comment_id = c.id AND ch.is_deleted = 0
      ) AS latest_child_seen_at
    ${INCOMPLETE_LIVE_ROOT_WHERE_SQL}
  `;

  // 配置读取走 db 代理，必须与入参 database 绑定同一 AsyncLocalStorage 上下文：
  // HTTP 路由里二者一致，直接单测调用时则可能尚未进入 run(database)。
  const withDatabaseContext = <T>(fn: () => Promise<T>): Promise<T> =>
    dbContext.getStore() === database ? fn() : dbContext.run(database, fn);

  const offloadTargets = bucket
    ? await withDatabaseContext(() => listReadableCommentOffloadTargets(bucket)).catch(() => [])
    : [];

  // 未启用外部扩容库：保持原有单条探测，零额外开销。
  if (offloadTargets.length === 0) {
    try {
      const row = await database.prepare(hasAnySql).bind(contentPk).first<{ has_any?: number }>();
      return Boolean(row);
    } catch {
      return false;
    }
  }

  const activeOffloadTarget = bucket
    ? await withDatabaseContext(() => resolveActiveOffloadTarget(bucket, "comments")).catch(() => null)
    : null;

  /** 汇总未完成活根；同一根出现在多个非活跃库时取最新状态，任一库时间未知则保持 null */
  const mergeIncompleteRows = mergeIncompleteRootTimestamps;

  /** 只剔除实际写入库里有明确收敛证据、且不旧于待重试副本的根 */
  const applySettledRows = (rows: SettledRootRow[], unresolved: Map<string, number | null>) => {
    for (const row of rows) {
      const id = row.id == null ? "" : String(row.id);
      if (!id || !unresolved.has(id)) continue;
      const isDeleted = Number(row.is_deleted ?? 0) === 1;
      const isComplete = Number(row.is_complete ?? 0);
      const settledTs = isDeleted
        ? maxTimestampMs(row.deleted_at, row.root_last_seen_at)
        : isComplete === 1 || isComplete === 2
          ? parseTimestampMs(row.thread_synced_at)
          : null;
      if (settledTs === null) continue;
      const incompleteTs = unresolved.get(id) ?? null;
      if (incompleteTs === null || settledTs >= incompleteTs) unresolved.delete(id);
    }
  };

  /** 收敛查询：只有软删根或已完成线程索引才算收敛，裸根行不参与判定 */
  const buildSettledQuery = (ids: string[]) => {
    const useIdFilter = ids.length > 0 && ids.length <= D1_MAX_SQL_PARAMS - 1;
    return {
      sql: `
        SELECT
          c.id AS id,
          c.is_deleted AS is_deleted,
          c.deleted_at AS deleted_at,
          c.last_seen_at AS root_last_seen_at,
          t.is_complete AS is_complete,
          t.synced_at AS thread_synced_at
        FROM comments c
        LEFT JOIN comment_threads t ON t.root_id = c.id
        WHERE c.content_pk = ?
          AND c.parent_comment_id IS NULL
          AND (
            c.is_deleted = 1
            OR (t.root_id IS NOT NULL AND t.is_complete IN (1, 2))
          )
          ${useIdFilter ? `AND c.id IN (${ids.map(() => "?").join(", ")})` : ""}
      `,
      params: useIdFilter ? [contentPk, ...ids] : [contentPk]
    };
  };

  const warnProbeFailure = (target: ExternalStorageTarget, err: unknown) => {
    console.warn(`[comments] hasIncompleteLiveRoot probe failed (${target.name || target.id}):`, err);
  };

  // 分支 A：当前实际写入库是主 D1（例如所有外部库都是未达阈值的 overflow）。
  if (!activeOffloadTarget) {
    // A1) 主 D1 自己还有未完成活根：立即触发重试，非活跃外部库的旧副本无权屏蔽。
    try {
      const row = await database.prepare(hasAnySql).bind(contentPk).first<{ has_any?: number }>();
      if (row) return true;
    } catch {
      // 主库探测失败不能让路由整体 500：调用方按 false 处理
      return false;
    }

    // A2) 再看非活跃外部库残留的未完成活根。
    const unresolved = new Map<string, number | null>();
    for (const target of offloadTargets) {
      try {
        const result = await executeRemoteSql(target, rootRowsSql, [contentPk]);
        mergeIncompleteRows(result.rows as IncompleteRootRow[], unresolved);
      } catch (err) {
        warnProbeFailure(target, err);
      }
    }
    if (unresolved.size === 0) return false;

    // A3) 只允许主 D1 的收敛证据剔除旧副本；收敛查询失败时保守触发重试。
    const { sql, params } = buildSettledQuery(Array.from(unresolved.keys()));
    try {
      const { results } = await database.prepare(sql).bind(...params).all<SettledRootRow>();
      applySettledRows(results ?? [], unresolved);
    } catch (err) {
      console.warn("[comments] hasIncompleteLiveRoot main convergence probe failed:", err);
      return true;
    }
    return unresolved.size > 0;
  }

  // 分支 B：当前实际写入库是某个外部库。
  // B1) 实际写入库存在未完成活根：立即触发重试。
  let activeReachable = false;
  try {
    const result = await executeRemoteSql(activeOffloadTarget, hasAnySql, [contentPk]);
    if (result.rows.length > 0) return true;
    activeReachable = true;
  } catch (err) {
    warnProbeFailure(activeOffloadTarget, err);
  }

  // B2) 收集所有非活跃库（主 D1 + 其余外部库）的未完成活根。
  const unresolved = new Map<string, number | null>();
  try {
    const { results } = await database.prepare(rootRowsSql).bind(contentPk).all<IncompleteRootRow>();
    mergeIncompleteRows(results ?? [], unresolved);
  } catch (err) {
    console.warn("[comments] hasIncompleteLiveRoot main probe failed:", err);
  }
  for (const target of offloadTargets) {
    if (target.id === activeOffloadTarget.id) continue;
    try {
      const result = await executeRemoteSql(target, rootRowsSql, [contentPk]);
      mergeIncompleteRows(result.rows as IncompleteRootRow[], unresolved);
    } catch (err) {
      warnProbeFailure(target, err);
    }
  }
  if (unresolved.size === 0) return false;

  // B3) 实际写入库不可达时无法证明已收敛，保守触发重试。
  if (!activeReachable) return true;

  // B4) 仅用实际写入库的收敛证据剔除；失败时同样保守触发重试。
  const { sql, params } = buildSettledQuery(Array.from(unresolved.keys()));
  try {
    const result = await executeRemoteSql(activeOffloadTarget, sql, params);
    applySettledRows(result.rows as SettledRootRow[], unresolved);
  } catch (err) {
    console.warn(
      `[comments] hasIncompleteLiveRoot convergence probe failed (${activeOffloadTarget.name || activeOffloadTarget.id}):`,
      err
    );
    return true;
  }
  return unresolved.size > 0;
}

/**
 * 按需读取某个根评论下的全部子评论。
 *
 * 读取顺序：
 * 1. 若配置了可读的外部扩容库（offloadTargets）：优先读外部库 child_comment_blobs（含 complete=true 权威快照），
 *    blob 缺失时再查外部库 comments 子评论行，避免迁移前主 R2 的旧快照永久遮蔽外部库新数据；
 * 2. 主 R2 childcomments/{rootId}.json（未启用外部库 / overflow 旧线程所在）；
 * 3. 主 D1 comments 的子评论行（迁移前 / 早期数据兜底，含已软删归档）。
 */
export async function getChildComments(
  bucket: R2Bucket | undefined,
  rootId: string,
  database?: D1Database
): Promise<ChildCommentRecord[]> {
  if (bucket) {
    const offloadTargets = await listReadableCommentOffloadTargets(bucket).catch(() => []);
    for (const target of offloadTargets) {
      const blob = await readRemoteChildBlob(target, rootId);
      // 外部库 complete=true 是权威快照：即使 children 为空也直接返回 []，绝不回退主 R2 / D1 复活未归档旧行
      if (blob.status === "ok" && (blob.complete || blob.children.length > 0)) {
        return blob.children;
      }
      // blob 缺失、读取失败或是不完整空快照时，回查外部库扁平子评论行兼容历史写入
      const rowChildren = await readRemoteChildRows(target, rootId);
      if (rowChildren.length > 0) return rowChildren;
    }

    const stored = await readStoredChildThread(bucket, rootId);
    if (stored.status === "ok" && (stored.complete || stored.children.length > 0)) {
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
           img_url, time_text, location, likes, is_author, is_deleted
    FROM comments
    WHERE parent_comment_id = ?
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
    is_deleted: number;
  }>();

  return (result.results ?? []).map(mapStoredChildRow);
}

/** 外部库 child_comment_blobs.payload_json → StoredChildThread（与 R2 对象同构，保留 complete 权威标记） */
async function readRemoteChildBlob(
  target: ExternalStorageTarget,
  rootId: string
): Promise<StoredChildThread> {
  try {
    const result = await executeRemoteSql(
      target,
      `SELECT payload_json, complete FROM child_comment_blobs WHERE root_id = ?`,
      [rootId]
    );
    if (!result.rows.length) return { status: "missing" };
    const raw = result.rows[0]?.payload_json;
    if (typeof raw !== "string" || !raw) return { status: "missing" };
    const parsed = JSON.parse(raw) as { children?: unknown; complete?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.children)) return { status: "error" };
    const complete = parsed.complete === true || Number(result.rows[0]?.complete ?? 0) === 1;
    const children = parsed.children
      .filter((c): c is ChildCommentRecord => !!c && typeof c === "object" && typeof (c as any).id === "string")
      .map(child => ({
        ...child,
        img_url: (child as any).img_url || (child as any).img || ""
      }));
    return { status: "ok", complete, children };
  } catch (err) {
    console.warn(`[comments] 外部扩容库读取楼中楼失败 (${target.name}):`, err);
    return { status: "error" };
  }
}

/** 外部库 comments 表里按 parent_comment_id 存的子评论行（含已软删归档） */
async function readRemoteChildRows(
  target: ExternalStorageTarget,
  rootId: string
): Promise<ChildCommentRecord[]> {
  try {
    const result = await executeRemoteSql(target, `
      SELECT id, parent_comment_id, author_name, author_avatar, be_replied, content_md,
             img_url, time_text, location, likes, is_author, is_deleted
      FROM comments
      WHERE parent_comment_id = ?
      ORDER BY first_seen_at ASC
    `, [rootId]);
    return result.rows.map(mapRemoteChildRow);
  } catch (err) {
    console.warn(`[comments] 外部扩容库读取子评论行失败 (${target.name}):`, err);
    return [];
  }
}

type ChildSelectRow = {
  id: string | null;
  parent_comment_id: string | null;
  author_name: string | null;
  author_avatar: string | null;
  be_replied: string | null;
  content_md: string | null;
  img_url: string | null;
  time_text: string | null;
  location: string | null;
  likes: number | null;
  is_author: number | null;
  is_deleted?: number | null;
};

function mapStoredChildRow(row: ChildSelectRow): ChildCommentRecord {
  const img = row.img_url ?? "";
  return {
    id: String(row.id ?? ""),
    parentId: row.parent_comment_id,
    author: row.author_name ?? "",
    authorAvatar: row.author_avatar ?? "",
    beReplied: row.be_replied,
    content: row.content_md ?? "",
    img,
    img_url: img,
    time: row.time_text ?? "",
    location: row.location ?? "",
    likes: Number(row.likes ?? 0) || 0,
    isAuthor: row.is_author === 1,
    ...(row.is_deleted === 1 ? { isDeleted: true } : {})
  };
}

/** 远程 D1/Turso 返回的是任意对象（列值已归一化为 string/number/null），这里只做形状收敛 */
function mapRemoteChildRow(row: Record<string, any>): ChildCommentRecord {
  return mapStoredChildRow({
    id: row.id == null ? null : String(row.id),
    parent_comment_id: row.parent_comment_id == null ? null : String(row.parent_comment_id),
    author_name: row.author_name == null ? null : String(row.author_name),
    author_avatar: row.author_avatar == null ? null : String(row.author_avatar),
    be_replied: row.be_replied == null ? null : String(row.be_replied),
    content_md: row.content_md == null ? null : String(row.content_md),
    img_url: row.img_url == null ? null : String(row.img_url),
    time_text: row.time_text == null ? null : String(row.time_text),
    location: row.location == null ? null : String(row.location),
    likes: Number(row.likes ?? 0) || 0,
    is_author: Number(row.is_author ?? 0) || 0,
    is_deleted: Number(row.is_deleted ?? 0) || 0
  });
}

