import { db } from "../db.js";
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
const R2_BULK_DELETE_BATCH_SIZE = 1000;
const MAX_SYNC_EDGE_PURGE_KEYS = 10;
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

async function deleteR2KeysBatch(
  bucket: any,
  keys: string[]
): Promise<{ ok: boolean; succeededKeys: string[]; failedKeys: string[] }> {
  if (!keys.length || typeof bucket?.delete !== "function") {
    return { ok: true, succeededKeys: [], failedKeys: [] };
  }
  const succeededKeys: string[] = [];
  const failedKeys: string[] = [];
  for (let i = 0; i < keys.length; i += R2_BULK_DELETE_BATCH_SIZE) {
    const batch = keys.slice(i, i + R2_BULK_DELETE_BATCH_SIZE);
    if (batch.length === 1) {
      try {
        await bucket.delete(batch[0]);
        succeededKeys.push(batch[0]);
      } catch {
        failedKeys.push(batch[0]);
      }
      continue;
    }
    try {
      await bucket.delete(batch);
      succeededKeys.push(...batch);
    } catch {
      // 兼容仅支持单 key 字符串的测试 mock：小批量退回逐条删除，大批量不撞子请求上限且绝不静默当成功
      if (batch.length <= MAX_SYNC_EDGE_PURGE_KEYS) {
        for (const k of batch) {
          try {
            await bucket.delete(k);
            succeededKeys.push(k);
          } catch {
            failedKeys.push(k);
          }
        }
      } else {
        failedKeys.push(...batch);
      }
    }
  }
  return { ok: failedKeys.length === 0, succeededKeys, failedKeys };
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

  // 合并只读 R2 会把迁移前写在 D1 的旧扁平子评论弄丢（R2 404 时尤其明显）。
  // 无论整批 partial 还是单根 isChildrenComplete=false，都需要一次批量取出本内容 is_deleted=0 的旧子评论行。
  const legacyChildrenByRoot = new Map<string, ChildCommentRecord[]>();
  let legacyChildrenReadFailed = false;
  const needLegacyChildMerge =
    Boolean(input.partial) || input.roots.some(root => !root.isChildrenComplete);
  if (needLegacyChildMerge) {
    try {
      const legacyResult = await database.prepare(`
        SELECT id, parent_comment_id, author_name, author_avatar, be_replied, content_md,
               img_url, time_text, location, likes, is_author
        FROM comments
        WHERE content_pk = ? AND parent_comment_id IS NOT NULL AND is_deleted = 0
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
      // 旧 D1 子评论状态未知：后续 partial 根不能基于半份数据盲写 R2。
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
      isAvatarUrlChanged(exists.author_avatar, root.authorAvatar) ||
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

  await runBatchedStatements(database, rootStmts, ROOT_BATCH_SIZE);

  // 2) 子评论写 R2；3) comment_threads 最后统一 upsert
  const threadStmts: any[] = [];

  // 评论整体清零时，残余线程索引里的子评论数与预览也必须一起清掉，
  // 否则列表页仍会展示已删除楼中楼的旧预览。
  // 而且只把 child_count 归零不够：thread_hash / incoming_hash 不清，R2 旧对象不删，
  // 原站清空后又新增子评论、下次 partial 同步时旧 R2 子评论会被「合并复活」。
  // 所有根评论此刻都已软删，直接删掉残余线程索引行最干净，下次从零重建。
  // 同时需合并无 comment_threads 索引的旧根（existingRoots），确保遗留 R2 对象一并清理；
  // 若 R2 删除有失败，主动反写正数 comment_count 保持下轮重试触发信号，绝不静默归 0。
  if (!input.partial && input.roots.length === 0 && (!input.allRootIds || input.allRootIds.length === 0)) {
    const clearRootIds = new Set<string>(existingThreads.keys());
    for (const row of existingRoots) clearRootIds.add(row.id);
    const keyEntries = Array.from(clearRootIds, rootId => ({
      rootId,
      key: childCommentsKey(rootId)
    }));
    const keysToDelete = keyEntries.map(entry => entry.key);
    let deleteResult = { ok: true, succeededKeys: [] as string[], failedKeys: [] as string[] };
    if (keysToDelete.length > 0) {
      deleteResult = await deleteR2KeysBatch(env.BUCKET, keysToDelete);
      const skipEdge = deleteResult.succeededKeys.length > MAX_SYNC_EDGE_PURGE_KEYS;
      for (const key of deleteResult.succeededKeys) {
        // 删完立刻失效缓存：超过 10 条时跳过同步边缘 cache.delete，避免击穿 Workers 50 子请求硬限
        await purgeR2EdgeCache(key, { skipEdge });
      }
    }
    if (deleteResult.failedKeys.length === 0) {
      threadStmts.push(database.prepare(`
        DELETE FROM comment_threads WHERE content_pk = ?
      `).bind(input.contentPk));
    } else if (deleteResult.succeededKeys.length > 0) {
      const succeededKeySet = new Set(deleteResult.succeededKeys);
      const succeededRootIds = keyEntries
        .filter(entry => succeededKeySet.has(entry.key))
        .map(entry => entry.rootId);
      // 仅清理已成功删除 R2 的线程索引，保留失败项供下次重试；单句 IN 参数不超过 90（含 content_pk）
      const maxIdsPerChunk = D1_MAX_SQL_PARAMS - 1;
      for (let i = 0; i < succeededRootIds.length; i += maxIdsPerChunk) {
        const chunk = succeededRootIds.slice(i, i + maxIdsPerChunk);
        const placeholders = chunk.map(() => "?").join(", ");
        threadStmts.push(database.prepare(`
          DELETE FROM comment_threads WHERE content_pk = ? AND root_id IN (${placeholders})
        `).bind(input.contentPk, ...chunk));
      }
    }
    const nextCommentCount = deleteResult.failedKeys.length > 0 ? deleteResult.failedKeys.length : 0;
    threadStmts.push(database.prepare(`
      UPDATE contents SET comment_count = ? WHERE pk = ?
    `).bind(nextCommentCount, input.contentPk));
  }
  for (const { root, children } of prepared) {
    const hasChildren = children.length > 0;
    const childCount = Math.max(root.childCount, children.length);
    const existingThread = existingThreads.get(root.id);
    const isChildrenClosed = Boolean(root.isChildrenClosed);

    // 单个根下的楼中楼在原站被删光：本次抓全且站点确认 childCount = 0。
    // 必须主动清空 R2 并建立 complete-empty 线程索引，不能依赖 existingThread.child_count > 0：
    // 旧扁平 D1 迁移根可能没有 comment_threads 行，或 R2 里仍有旧对象但索引计数被清零，
    // 跳过清空会让已删光的楼中楼一直展示旧预览，read API 也会回退 D1 历史子评论。
    if (!input.partial && !hasChildren && childCount === 0 && root.isChildrenComplete) {
      const key = childCommentsKey(root.id);
      const emptyThreadHash = await sha256(JSON.stringify({ children: [], complete: true }));
      const emptyIncomingHash = await sha256(JSON.stringify({ children: [], childCount: 0, complete: true }));

      // 快路径：上一轮已经是权威 complete-empty（R2 已落盘且索引一致）→ 0 R2 / 0 D1 写，
      // 避免每次重同步都重复 PUT 同一个空对象。
      if (
        existingThread &&
        existingThread.incoming_hash === emptyIncomingHash &&
        existingThread.thread_hash === emptyThreadHash &&
        existingThread.child_count === 0 &&
        existingThread.is_complete === 1 &&
        existingThread.preview_json === "[]"
      ) {
        continue;
      }

      let r2Ready = false;
      const stored = await readStoredChildThread(env.BUCKET, root.id, { bypassCache: true });
      if (stored.status === "error") {
        // 读取失败时状态未知：绝不盲写覆盖可能仍可读的旧对象，下面保留重试状态。
        console.warn(`[comments] skip empty R2 put for ${key}: previous object unreadable`);
      } else if (stored.status === "ok" && stored.complete && stored.children.length === 0) {
        // R2 已经是同一份 complete-empty 快照：省掉这次 PUT。
        r2Ready = true;
      } else {
        try {
          await env.BUCKET.put(key, JSON.stringify({ children: [], complete: true, updatedAt: now }), {
            httpMetadata: { contentType: "application/json; charset=utf-8" }
          });
          r2Puts++;
          // 清空也必须立即见效：边缘缓存里可能还留着旧楼中楼
          await purgeR2EdgeCache(key);
          r2Ready = true;
        } catch (err) {
          // R2 写失败则保留旧索引：避免出现「R2 仍是旧子评论、D1 却宣称 0 条」的不一致
          console.warn(`[comments] R2 put failed for ${key}:`, err);
        }
      }

      if (r2Ready) {
        threadStmts.push(database.prepare(`
          INSERT INTO comment_threads (
            root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at
          ) VALUES (?, ?, ?, 0, 1, ?, ?, '[]', ?)
          ON CONFLICT(root_id) DO UPDATE SET
            content_pk = excluded.content_pk,
            r2_key = excluded.r2_key,
            child_count = 0,
            is_complete = 1,
            thread_hash = excluded.thread_hash,
            incoming_hash = excluded.incoming_hash,
            preview_json = '[]',
            synced_at = excluded.synced_at
        `).bind(root.id, input.contentPk, key, emptyThreadHash, emptyIncomingHash, now));
      } else {
        // R2 读取/写入失败：没有旧索引时保持原样（本来就没有可回退状态），
        // 有旧索引时保留可能仍可读的计数与哈希，但把 is_complete 置 0、incoming_hash 清空，
        // 确保下一轮不会误命中快路径，会重新尝试清空。
        if (!existingThread) continue;
        const fallbackThreadHash = existingThread.thread_hash ?? "";
        if (
          existingThread.is_complete === 0 &&
          existingThread.incoming_hash === "" &&
          existingThread.thread_hash === fallbackThreadHash
        ) {
          continue;
        }
        threadStmts.push(database.prepare(`
          UPDATE comment_threads
          SET is_complete = 0, thread_hash = ?, incoming_hash = '', synced_at = ?
          WHERE root_id = ?
        `).bind(fallbackThreadHash, now, root.id));
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
    // thread_hash 非空保证上次 PUT 真的成功过；is_complete 分支保证「上次没抓全、这次抓全或新触发闭评冻结」仍会更新。
    if (
      existingThread &&
      existingThread.incoming_hash === incomingHash &&
      existingThread.child_count === childCount &&
      (existingThread.is_complete === 1 || (!root.isChildrenComplete && (!isChildrenClosed || existingThread.is_complete === 2))) &&
      (!hasChildren || existingThread.thread_hash !== "")
    ) {
      continue;
    }

    // hasChildren=false 且 childCount>0：子评论尚未抓取（或页 0 遇闭评），保留已有 R2 哈希/预览，绝不冲掉；
    // 遇闭评把 is_complete 置 2 冻结，未闭评则保持已有 is_complete（已冻结的 2 不降级回 0）
    if (!hasChildren) {
      const desiredComplete = isChildrenClosed ? 2 : (existingThread?.is_complete ?? 0);
      if (
        existingThread &&
        existingThread.child_count === childCount &&
        existingThread.is_complete === desiredComplete
      ) {
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
        childCount,
        desiredComplete,
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
      // 本次没抓全（含闭评）：与 R2 旧对象合并，只增改不删。
      // 读失败（error）时状态未知，绝不能把本次不完整数据当成合并结果写回去。
      const stored = await readStoredChildThread(env.BUCKET, root.id, { bypassCache: true });
      if (stored.status === "error") {
        readFailed = true;
      } else if (legacyChildrenReadFailed) {
        // D1 旧子评论状态未知：不能用一份看起来完整的 R2 合并结果盲写。
        readFailed = true;
      } else if (stored.status === "ok") {
        childrenToStore = mergeChildren(stored.children, children);
        // 已存在非空 R2 时按原逻辑只合并 R2；只有 R2 是不完整空对象
        // （迁移前既没有旧对象、也没有可用子评论）时才补入 D1 旧子评论，
        // 否则这次写回会把 D1 里仅存的历史回复永久挡在 R2 之外。
        // complete=true 的旧 R2 是权威快照，不能掺入可能早已在原站删除的 D1 旧行。
        if (stored.children.length === 0 && !stored.complete) {
          childrenToStore = mergeChildren(legacyChildrenByRoot.get(root.id) ?? [], childrenToStore);
        }
      } else {
        // R2 404：迁移前的旧扁平 D1 子评论与本次新抓到的子评论一起写入，避免丢失。
        childrenToStore = mergeChildren(legacyChildrenByRoot.get(root.id) ?? [], children);
      }
    }
    const complete = root.isChildrenComplete;
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
      // 恢复状态与 PUT 失败完全一致：is_complete 维持 0（若已闭评冻结为 2 则保持 2）、thread_hash 保留旧值、
      // incoming_hash 清空 → 下轮同输入不会误命中快路径，会自动重试合并。
      console.warn(`[comments] skip R2 put for ${key}: previous object unreadable`);
      isComplete = existingThread?.is_complete === 2 ? 2 : 0;
      storedThreadHash = existingThread?.thread_hash ?? "";
      storedIncomingHash = "";
    } else if (
      existingThread &&
      existingThread.thread_hash === nextThreadHash &&
      (complete ? existingThread.is_complete === 1 : existingThread.is_complete !== 1)
    ) {
      // R2 里已经是同一份内容：跳过这次 Class A 写入（若需从 0 升为闭评冻结 2，下面仍会写 D1）
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
        // thread_hash 保留旧值、incoming_hash 清空 → 下次同输入不会误命中快路径，会重新 PUT。
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
 *
 * 传了 bucket 时会透明回源外部扩容库：主 D1 为空（评论被 offload 到外部库）时直接读外部库；
 * overflow 模式下主库返回不足一页时，再合并外部库的新根评论并去重。
 */
export async function listRootComments(
  database: D1Database,
  contentPk: string,
  opts: { limit?: number; offset?: number } = {},
  bucket?: any
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
  const offloadTargets = bucket ? await listReadableCommentOffloadTargets(bucket).catch(() => []) : [];

  // 主 D1 一条都没有：评论整批被 offload 到外部扩容库（或位于主 D1 末尾之后），直接透明回源
  if (rows.length === 0) {
    if (offset > 0 && offloadTargets.length > 0) {
      const mainIdsResult = await database.prepare(
        `SELECT id FROM comments WHERE content_pk = ? AND parent_comment_id IS NULL AND is_deleted = 0`
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
          const remoteRows = await fetchOffloadRootComments(target, contentPk, fetchLimit, 0);
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
      const remoteRows = await fetchOffloadRootComments(target, contentPk, limit, offset);
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
        `SELECT id FROM comments WHERE content_pk = ? AND parent_comment_id IS NULL AND is_deleted = 0`
      ).bind(contentPk).all<{ id: string }>().catch(() => ({ results: [] as Array<{ id: string }> }));
      for (const r of mainIdsResult.results ?? []) {
        if (r.id) seen.add(r.id);
      }
    }
    for (const target of offloadTargets) {
      const remoteRows = await fetchOffloadRootComments(target, contentPk, limit + offset, 0);
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
const REMOTE_ROOT_COMMENTS_SQL = `
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
`;

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
      comment_hash: String(row.comment_hash ?? ""),
      first_seen_at: String(row.first_seen_at ?? ""),
      last_seen_at: String(row.last_seen_at ?? ""),
      child_count: Number(row.child_count ?? 0) || 0,
      is_complete: Number(row.is_complete ?? 0) || 0,
      thread_synced_at: row.thread_synced_at == null ? null : String(row.thread_synced_at),
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
  offset: number
): Promise<RootCommentRow[]> {
  try {
    const result = await executeRemoteSql(target, REMOTE_ROOT_COMMENTS_SQL, [contentPk, limit, offset]);
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
    child_count: Number(row.child_count ?? 0) || 0
  };
}

function toRemoteThreadRow(row: Record<string, any>): ExistingThreadRow {
  return {
    root_id: String(row.root_id ?? ""),
    child_count: Number(row.child_count ?? 0) || 0,
    is_complete: Number(row.is_complete ?? 0) || 0,
    thread_hash: String(row.thread_hash ?? ""),
    incoming_hash: String(row.incoming_hash ?? ""),
    preview_json: String(row.preview_json ?? "[]")
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

  const needLegacyChildMerge =
    Boolean(input.partial) || input.roots.some(root => !root.isChildrenComplete);
  // 远端现状：根评论 + 线程索引（需合并未完结楼中楼时顺带取旧扁平子评论）合成 1 次 pipeline 读取
  const readBatchStatements: RemoteSqlStatement[] = [
    {
      sql: `SELECT id, comment_hash, is_deleted, author_avatar, likes, time_text, location, child_count
            FROM comments
            WHERE content_pk = ? AND parent_comment_id IS NULL`,
      params: [input.contentPk]
    },
    {
      sql: `SELECT root_id, child_count, is_complete, thread_hash, incoming_hash, preview_json
            FROM comment_threads
            WHERE content_pk = ?`,
      params: [input.contentPk]
    }
  ];
  if (needLegacyChildMerge) {
    readBatchStatements.push({
      sql: `SELECT id, parent_comment_id, author_name, author_avatar, be_replied, content_md,
                   img_url, time_text, location, likes, is_author
            FROM comments
            WHERE content_pk = ? AND parent_comment_id IS NOT NULL AND is_deleted = 0
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
  const remoteLegacyReadFailed = needLegacyChildMerge && !remoteLegacyResult;
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

  let added = 0;
  let updated = 0;
  let deleted = 0;

  // 1) 根评论 upsert + 删除对账（SQLite 目标合并多行 INSERT 与 IN 删除，单句参数 <= 90）
  const rootStatements: RemoteSqlStatement[] = [];
  const newRootParamRows: unknown[][] = [];
  for (const { root, img, hash } of prepared) {
    const exists = existingMap.get(root.id);

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
        root.childCount,
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
          root.childCount,
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
      Number(exists.child_count ?? 0) !== root.childCount;

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
          root.childCount,
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
      if (!incomingRootIds.has(row.id) && row.is_deleted === 0) {
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
  // 评论被整体清空：删掉外部库残余楼中楼与线程索引，同时清理迁移前残留在主 D1/主 R2 的旧线程与评论行，
  // 防止外部库清空后 getChildComments / listRootComments 回退主库复活旧回复。
  if (!input.partial && input.roots.length === 0 && (!input.allRootIds || input.allRootIds.length === 0)) {
    const clearStatements: RemoteSqlStatement[] = [
      {
        sql: `DELETE FROM child_comment_blobs WHERE content_pk = ?`,
        params: [input.contentPk]
      },
      {
        sql: `DELETE FROM comment_threads WHERE content_pk = ?`,
        params: [input.contentPk]
      }
    ];
    // 清理失败不阻塞清零，但需反写正数 comment_count 保持下轮自动重试触发信号
    let remoteClearFailed = false;
    await executeRemoteSqlBatch(target, clearStatements).catch(() => {
      remoteClearFailed = true;
    });
    try {
      const mainThreadsResult = await env.DB.prepare(`
        SELECT root_id FROM comment_threads WHERE content_pk = ?
        UNION
        SELECT id AS root_id FROM comments WHERE content_pk = ? AND parent_comment_id IS NULL
      `).bind(input.contentPk, input.contentPk).all<{ root_id: string }>();
      const mainThreadEntries = Array.from(
        new Set((mainThreadsResult.results ?? []).map(r => r.root_id).filter(Boolean)),
        rootId => ({ rootId, key: childCommentsKey(rootId) })
      );

      let mainR2Delete = { ok: true, succeededKeys: [] as string[], failedKeys: [] as string[] };
      if (mainThreadEntries.length > 0) {
        mainR2Delete = await deleteR2KeysBatch(
          env.BUCKET,
          mainThreadEntries.map(entry => entry.key)
        );
        const skipEdge = mainR2Delete.succeededKeys.length > MAX_SYNC_EDGE_PURGE_KEYS;
        for (const key of mainR2Delete.succeededKeys) {
          await purgeR2EdgeCache(key, { skipEdge });
        }
      }

      const mainCleanupStmts: any[] = [];
      if (mainThreadEntries.length > 0) {
        if (mainR2Delete.failedKeys.length === 0) {
          mainCleanupStmts.push(env.DB.prepare(
            `DELETE FROM comment_threads WHERE content_pk = ?`
          ).bind(input.contentPk));
        } else if (mainR2Delete.succeededKeys.length > 0) {
          const succeededKeySet = new Set(mainR2Delete.succeededKeys);
          const succeededRootIds = mainThreadEntries
            .filter(entry => succeededKeySet.has(entry.key))
            .map(entry => entry.rootId);
          const maxIdsPerChunk = D1_MAX_SQL_PARAMS - 1;
          for (let i = 0; i < succeededRootIds.length; i += maxIdsPerChunk) {
            const chunk = succeededRootIds.slice(i, i + maxIdsPerChunk);
            const placeholders = chunk.map(() => "?").join(", ");
            mainCleanupStmts.push(env.DB.prepare(
              `DELETE FROM comment_threads WHERE content_pk = ? AND root_id IN (${placeholders})`
            ).bind(input.contentPk, ...chunk));
          }
        }
      }
      mainCleanupStmts.push(env.DB.prepare(`
        UPDATE comments
        SET is_deleted = 1, deleted_at = ?, last_seen_at = ?
        WHERE content_pk = ? AND is_deleted = 0
      `).bind(now, now, input.contentPk));
      const nextCommentCount = (remoteClearFailed || mainR2Delete.failedKeys.length > 0)
        ? Math.max(1, mainR2Delete.failedKeys.length)
        : 0;
      mainCleanupStmts.push(env.DB.prepare(
        `UPDATE contents SET comment_count = ? WHERE pk = ?`
      ).bind(nextCommentCount, input.contentPk));
      await runBatchedStatements(env.DB, mainCleanupStmts, ROOT_BATCH_SIZE);
    } catch { /* 主库残留清理失败不阻塞外部库已完成的清零 */ }
  }

  // 在进入根循环前向本地主 D1 与外部库各查一次该内容是否存在迁移前旧楼中楼/子评论计数，
  // 只有远端或主库确有旧楼中楼历史时，才为 0 回复根写入 complete-empty 墓碑，
  // 避免全新 0 回复根每批白白多发几十次子请求。
  const mainLegacyRootIds = new Set<string>();
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
      const [mainThreadsRes, mainChildrenRes] = await Promise.all([
        env.DB.prepare(`SELECT root_id FROM comment_threads WHERE content_pk = ?`)
          .bind(input.contentPk)
          .all<{ root_id: string }>(),
        env.DB.prepare(`
          SELECT id AS root_id FROM comments
          WHERE content_pk = ? AND parent_comment_id IS NULL AND child_count > 0
          UNION
          SELECT DISTINCT parent_comment_id AS root_id FROM comments
          WHERE content_pk = ? AND parent_comment_id IS NOT NULL AND is_deleted = 0
        `).bind(input.contentPk, input.contentPk).all<{ root_id: string }>()
      ]);
      for (const r of mainThreadsRes.results ?? []) {
        if (r.root_id) mainLegacyRootIds.add(r.root_id);
      }
      for (const r of mainChildrenRes.results ?? []) {
        if (r.root_id) mainLegacyRootIds.add(r.root_id);
      }
    } catch {
      mainLegacyQueryFailed = true;
    }
    try {
      const remoteLegacyRes = await executeRemoteSqlBatch(target, [{
        sql: `
          SELECT root_id FROM child_comment_blobs WHERE content_pk = ?
          UNION
          SELECT DISTINCT parent_comment_id AS root_id FROM comments
          WHERE content_pk = ? AND parent_comment_id IS NOT NULL AND is_deleted = 0
        `,
        params: [input.contentPk, input.contentPk]
      }]);
      for (const row of remoteLegacyRes[0]?.rows ?? []) {
        const rid = row.root_id == null ? "" : String(row.root_id);
        if (rid) remoteLegacyRootIds.add(rid);
      }
    } catch {
      remoteLegacyQueryFailed = true;
    }
  }

  // partial 合并所需的旧 JSON：按 <= 90 参数分块一次 IN 批量读回（大幅压低 cloudflare_d1 子请求数）
  const childStatements: RemoteSqlStatement[] = [];
  const blobUpsertRows: unknown[][] = [];
  const threadUpsertRows: unknown[][] = [];
  const threadCountOnlyKeepRows: unknown[][] = [];
  const threadCountOnlyClosedRows: unknown[][] = [];
  const mergeRootIds = prepared
    .filter(item => item.children.length > 0 && !item.root.isChildrenComplete)
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

  for (const { root, children } of prepared) {
    const hasChildren = children.length > 0;
    const childCount = Math.max(root.childCount, children.length);
    const existingThread = existingThreads.get(root.id);
    const isChildrenClosed = Boolean(root.isChildrenClosed);

    // 单个根的楼中楼被删光：仅当远端或主库存在历史线程/子评论记录时才落 complete-empty 快照，
    // 防止全新 0 回复根无谓放大远端写入与子请求；命中快路径时 0 写入。
    if (!input.partial && !hasChildren && childCount === 0 && root.isChildrenComplete) {
      const hadRemoteThreadData = Boolean(existingThread);
      const existingRootChildCount = Number(existingMap.get(root.id)?.child_count ?? 0);
      const hadMainLegacyData = mainLegacyQueryFailed || mainLegacyRootIds.has(root.id);
      const hadRemoteLegacyData = remoteLegacyQueryFailed || remoteLegacyRootIds.has(root.id);
      if (!hadRemoteThreadData && existingRootChildCount === 0 && !hadMainLegacyData && !hadRemoteLegacyData) {
        continue;
      }

      const emptyThreadHash = await sha256(JSON.stringify({ children: [], complete: true }));
      const emptyIncomingHash = await sha256(JSON.stringify({ children: [], childCount: 0, complete: true }));
      if (
        existingThread &&
        existingThread.incoming_hash === emptyIncomingHash &&
        existingThread.thread_hash === emptyThreadHash &&
        existingThread.child_count === 0 &&
        existingThread.is_complete === 1 &&
        existingThread.preview_json === "[]"
      ) {
        continue;
      }
      blobUpsertRows.push([
        root.id,
        input.contentPk,
        JSON.stringify({ children: [], complete: true, updatedAt: now }),
        1,
        now
      ]);
      threadUpsertRows.push([
        root.id,
        input.contentPk,
        childCommentsKey(root.id),
        0,
        1,
        emptyThreadHash,
        emptyIncomingHash,
        "[]",
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
      existingThread.child_count === childCount &&
      (existingThread.is_complete === 1 || (!root.isChildrenComplete && (!isChildrenClosed || existingThread.is_complete === 2))) &&
      (!hasChildren || existingThread.thread_hash !== "")
    ) {
      continue;
    }

    // 子评论尚未抓取（或页 0 遇闭评）：保留已有楼中楼 JSON/哈希/预览；闭评置 2 冻结，否则保留原 is_complete
    if (!hasChildren) {
      const desiredComplete = isChildrenClosed ? 2 : (existingThread?.is_complete ?? 0);
      if (
        existingThread &&
        existingThread.child_count === childCount &&
        existingThread.is_complete === desiredComplete
      ) {
        continue;
      }
      const rowParams = [
        root.id,
        input.contentPk,
        childCommentsKey(root.id),
        childCount,
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
    let childrenToStore = children;
    let readFailed = false;
    if (!root.isChildrenComplete) {
      // 本次没抓全（含闭评）：用前面批量读回的旧 JSON（以及缺失时的旧扁平子评论）合并。
      // 读取失败时状态未知，绝不能覆盖既有完整楼中楼。
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
            childrenToStore = mergeChildren(existingChildren, children);
            if (existingChildren.length === 0 && parsed.complete !== true) {
              childrenToStore = mergeChildren(remoteLegacyChildrenByRoot.get(root.id) ?? [], childrenToStore);
            }
          }
        } catch {
          readFailed = true;
        }
      } else {
        childrenToStore = mergeChildren(remoteLegacyChildrenByRoot.get(root.id) ?? [], children);
      }
    }

    const complete = root.isChildrenComplete;
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
      existingThread.child_count === childCount &&
      existingThread.preview_json === previewJson &&
      existingThread.is_complete === isComplete &&
      existingThread.thread_hash === storedThreadHash
    ) {
      continue;
    }

    threadUpsertRows.push([
      root.id,
      input.contentPk,
      key,
      childCount,
      isComplete,
      storedThreadHash,
      storedIncomingHash,
      previewJson,
      now
    ]);
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
        `SELECT 1 AS has_any FROM comments WHERE content_pk = ? AND is_deleted = 0 LIMIT 1`,
        [contentPk]
      );
      if (result.rows.length > 0) return true;
    } catch {
      // 单个外部库不可用时继续探测下一个目标
    }
  }
  return false;
}

/**
 * 按需读取某个根评论下的全部子评论。
 *
 * 读取顺序：
 * 1. 若配置了可读的外部扩容库（offloadTargets）：优先读外部库 child_comment_blobs（含 complete=true 空快照权威标记），
 *    blob 缺失时再查外部库 comments 子评论行，避免迁移前主 R2 的旧快照永久遮蔽外部库新数据；
 * 2. 主 R2 childcomments/{rootId}.json（未启用外部库 / overflow 旧线程所在）；
 * 3. 主 D1 comments 的子评论行（迁移前 / 早期数据兜底）。
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
      // 外部库 complete=true 是权威快照：即使 children 为空也直接返回 []，绝不回退主 R2 / D1 复活已删回复
      if (blob.status === "ok" && (blob.complete || blob.children.length > 0)) {
        return blob.children;
      }
      // blob 缺失、读取失败或是不完整空快照时，回查外部库扁平子评论行兼容历史写入
      const rowChildren = await readRemoteChildRows(target, rootId);
      if (rowChildren.length > 0) return rowChildren;
    }

    const stored = await readStoredChildThread(bucket, rootId);
    // complete=true 是原站确认的权威快照：即使 children 为空也必须直接返回 []，
    // 不能回退 D1 里的历史子评论（那些行可能早已在原站删除）。
    // 不完整对象只在确实读到子评论时返回，空的不完整对象仍走旧回退。
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

/** 外部库 comments 表里按 parent_comment_id 存的子评论行 */
async function readRemoteChildRows(
  target: ExternalStorageTarget,
  rootId: string
): Promise<ChildCommentRecord[]> {
  try {
    const result = await executeRemoteSql(target, `
      SELECT id, parent_comment_id, author_name, author_avatar, be_replied, content_md,
             img_url, time_text, location, likes, is_author
      FROM comments
      WHERE parent_comment_id = ? AND is_deleted = 0
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
    isAuthor: row.is_author === 1
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
    is_author: Number(row.is_author ?? 0) || 0
  });
}

