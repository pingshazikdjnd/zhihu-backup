import { Hono } from "hono";
import { db } from "../db.js";
import { withKeyLock } from "../services/lock.js";
import type { Bindings } from "../types.js";

export const authRoutes = new Hono<{ Bindings: Bindings }>();

const COOKIE_KEY = "zhihu_cookie";
const WRITE_TOKEN_KEY = "cookie_write_token";
const SYNC_CONFIG_KEY = "sync_config";
const R2_SYNC_CONFIG_KEY = "meta/sync_config.json";
// 反代 DeepSeek（OpenAI 兼容接口）的 API Key 单独存 app_settings：
// 绝不写进 sync_config JSON / R2、绝不出现在任何 GET 响应里，前端只知道「有没有配」。
const FALLBACK_AI_KEY_KEY = "fallback_ai_api_key";
const DEFAULT_FALLBACK_AI_MODEL = "deepseek-v4.1-flash";
// 本地 Worker 默认把请求打到同机反代；云端未显式配置公网 https 地址时由 recommend.ts 拒绝直连回环地址
const DEFAULT_FALLBACK_AI_BASE_URL = "http://127.0.0.1:8788/v1";
export const EXTERNAL_TARGETS_KEY = "external_storage_targets";
export const R2_EXTERNAL_TARGETS_KEY = "meta/external_storage_targets.json";

export type ExternalProviderType = "turso" | "cloudflare_d1" | "supabase" | "s3_r2" | "webhook";
export type ExternalSyncScope = "contents" | "comments" | "collections" | "upvotes";

/**
 * 外部库的工作模式（决定它到底是「扩容」还是「备份」）：
 * - offload  ：直接分流扩容。勾选的数据只写外部库，主 D1 / 主 R2 零写入，网页读取时透明回源。
 * - overflow ：主库满额溢出。主 D1 评论行数达到 overflowThresholdRows 后自动切换成 offload。
 * - mirror   ：双写灾备。主库照写，同时异步复制一份到外部库（不省主库空间，只防丢）。
 */
export type ExternalStorageRole = "offload" | "overflow" | "mirror";

export const DEFAULT_STORAGE_ROLE: ExternalStorageRole = "offload";
/** 150 万条评论行 ≈ 3.5GB D1 水位（D1 免费额度 5GB，留 1.5GB 给正文/元数据/索引） */
export const DEFAULT_OVERFLOW_THRESHOLD_ROWS = 1_500_000;
const MAX_OVERFLOW_THRESHOLD_ROWS = 1_000_000_000;

export type ExternalStorageTarget = {
  id: string;
  name: string;
  provider: ExternalProviderType;
  enabled: boolean;
  syncScopes: ExternalSyncScope[];
  /** 默认 offload（直接分流扩容），老配置没有该字段时按扩容处理 */
  storageRole: ExternalStorageRole;
  /** overflow 模式的触发水位：主 D1 comments 行数达到该值后开始向外部库分流 */
  overflowThresholdRows: number;
  endpointUrl: string;        // Turso HTTP URL / Supabase URL / S3 Endpoint / Webhook URL / CF API URL
  databaseId?: string;        // CF AccountId:DatabaseId 或 Bucket 名称或表前缀
  authToken?: string;         // 仅在服务端内部存储，GET 返回前端时必须脱敏！
  createdAt: string;
  updatedAt: string;
  lastTestAt?: string | null;
  lastTestOk?: boolean | null;
  lastTestMsg?: string | null;
};

export type ClientExternalStorageTarget = Omit<ExternalStorageTarget, "authToken"> & {
  hasToken: boolean;
  maskedToken: string;
};

const VALID_PROVIDERS = new Set<ExternalProviderType>([
  "turso",
  "cloudflare_d1",
  "supabase",
  "s3_r2",
  "webhook"
]);
const VALID_SYNC_SCOPES = new Set<ExternalSyncScope>([
  "contents",
  "comments",
  "collections",
  "upvotes"
]);
const VALID_STORAGE_ROLES = new Set<ExternalStorageRole>(["offload", "overflow", "mirror"]);

function normalizeStorageRole(value: unknown, fallback: ExternalStorageRole = DEFAULT_STORAGE_ROLE): ExternalStorageRole {
  return VALID_STORAGE_ROLES.has(value as ExternalStorageRole) ? (value as ExternalStorageRole) : fallback;
}

function normalizeOverflowThreshold(value: unknown, fallback = DEFAULT_OVERFLOW_THRESHOLD_ROWS): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(Math.max(Math.trunc(num), 1), MAX_OVERFLOW_THRESHOLD_ROWS);
}

export function maskTargetForClient(t: ExternalStorageTarget): ClientExternalStorageTarget {
  const { authToken, ...rest } = t;
  const token = authToken || "";
  return {
    ...rest,
    hasToken: Boolean(token),
    maskedToken: token ? (token.length > 6 ? "••••••••" + token.slice(-4) : "••••••••") : ""
  };
}

// 外部存储目标在 99% 的情况下是空的，而 /ingest/* 每收一条内容都要判断一次。
// 没有缓存时每条内容都要打一次 D1 SELECT（D1 为空时还要再打一次 R2 GET），
// 爬虫连续入库几百条就是几百次无意义的读放大。这里做 isolate 内存 60 秒缓存，
// 写接口保存/删除/测试后立即刷新，保证配置变更在本 isolate 内即时生效。
const EXTERNAL_TARGETS_CACHE_TTL_MS = 60_000;
const EXTERNAL_TARGETS_LOCK_KEY = "external_storage_targets";
const EXTERNAL_TARGETS_MAX_CAS_RETRIES = 2;
let cachedExternalTargets: { at: number; list: ExternalStorageTarget[]; d1UpdatedAt: string | null } | null = null;
let lastExternalTargetsWriteMs = 0;

export class ExternalTargetsConflictError extends Error {
  readonly code = "CONFLICT";
  constructor(message = "外部存储配置已被并发修改，请刷新后重试") {
    super(message);
    this.name = "ExternalTargetsConflictError";
  }
}

export function invalidateExternalTargetsCache(): void {
  cachedExternalTargets = null;
}

/** 深拷贝一层：调用方修改返回数组/对象时不能污染内存缓存。 */
function cloneTargets(list: ExternalStorageTarget[]): ExternalStorageTarget[] {
  return list.map(t => ({ ...t, syncScopes: [...t.syncScopes] }));
}

function parseIsoMs(value: unknown): number {
  if (typeof value !== "string" || !value.trim()) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function resolveTargetsUpdatedMs(list: any[], explicitUpdatedAt?: unknown): number {
  let maxMs = explicitUpdatedAt instanceof Date
    ? (Number.isFinite(explicitUpdatedAt.getTime()) ? explicitUpdatedAt.getTime() : 0)
    : parseIsoMs(explicitUpdatedAt);
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    maxMs = Math.max(
      maxMs,
      parseIsoMs(item.updatedAt),
      parseIsoMs(item.lastTestAt),
      parseIsoMs(item.createdAt)
    );
  }
  return maxMs;
}

async function readExternalTargetsWithVersion(
  bucket?: any
): Promise<{ targets: ExternalStorageTarget[]; d1UpdatedAt: string | null }> {
  if (cachedExternalTargets && Date.now() - cachedExternalTargets.at < EXTERNAL_TARGETS_CACHE_TTL_MS) {
    return {
      targets: cloneTargets(cachedExternalTargets.list),
      d1UpdatedAt: cachedExternalTargets.d1UpdatedAt
    };
  }

  let d1Targets: any[] | null = null;
  let d1UpdatedMs = 0;
  let d1UpdatedAt: string | null = null;
  try {
    const row = await db.prepare(
      `SELECT value, updated_at FROM app_settings WHERE key = ?`
    ).get<{ value: string; updated_at?: string | null }>(EXTERNAL_TARGETS_KEY);
    if (row) {
      d1UpdatedAt = typeof row.updated_at === "string" ? row.updated_at : null;
    }
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (Array.isArray(parsed)) {
        d1Targets = parsed;
        d1UpdatedMs = resolveTargetsUpdatedMs(parsed, row.updated_at);
      }
    }
  } catch { /* ignore D1 read error */ }

  let r2Targets: any[] | null = null;
  let r2UpdatedMs = 0;
  if (bucket) {
    try {
      const obj = await bucket.get(R2_EXTERNAL_TARGETS_KEY);
      if (obj) {
        const parsed = JSON.parse(await obj.text());
        if (Array.isArray(parsed)) {
          r2Targets = parsed;
          r2UpdatedMs = resolveTargetsUpdatedMs(
            parsed,
            obj.customMetadata?.updatedAt ?? obj.uploaded
          );
        }
      }
    } catch { /* ignore R2 read error */ }
  }

  // 同时读取 D1 与 R2 并按最新 updatedAt 择新：D1 满额降级只写入 R2 后缓存过期时不会静默回滚到旧 D1 值
  let targets: any[] = [];
  if (d1Targets && r2Targets) {
    targets = r2UpdatedMs > d1UpdatedMs ? r2Targets : d1Targets;
  } else {
    targets = d1Targets ?? r2Targets ?? [];
  }

  if (!Array.isArray(targets)) targets = [];

  const cleaned: ExternalStorageTarget[] = [];
  for (const raw of targets) {
    if (!raw || typeof raw !== "object" || !raw.id || !raw.name) continue;
    if (!VALID_PROVIDERS.has(raw.provider)) continue;
    const scopes: ExternalSyncScope[] = Array.isArray(raw.syncScopes)
      ? raw.syncScopes.filter((s: any): s is ExternalSyncScope => VALID_SYNC_SCOPES.has(s))
      : ["contents", "comments"];
    cleaned.push({
      id: String(raw.id),
      name: String(raw.name).trim().slice(0, 60),
      provider: raw.provider,
      enabled: Boolean(raw.enabled),
      syncScopes: scopes.length ? scopes : ["contents", "comments"],
      // 老配置没有 storageRole：默认按「直接分流扩容」处理，才能真正帮主 D1/R2 省空间
      storageRole: normalizeStorageRole(raw.storageRole),
      overflowThresholdRows: normalizeOverflowThreshold(raw.overflowThresholdRows),
      endpointUrl: String(raw.endpointUrl || "").trim(),
      databaseId: raw.databaseId ? String(raw.databaseId).trim() : undefined,
      authToken: raw.authToken ? String(raw.authToken).trim() : undefined,
      createdAt: raw.createdAt || new Date().toISOString(),
      updatedAt: raw.updatedAt || new Date().toISOString(),
      lastTestAt: raw.lastTestAt ?? null,
      lastTestOk: raw.lastTestOk ?? null,
      lastTestMsg: raw.lastTestMsg ?? null
    });
    if (cleaned.length >= 10) break;
  }

  cachedExternalTargets = { at: Date.now(), list: cloneTargets(cleaned), d1UpdatedAt };
  return { targets: cleaned, d1UpdatedAt };
}

export async function getExternalTargetsRaw(bucket?: any): Promise<ExternalStorageTarget[]> {
  const { targets } = await readExternalTargetsWithVersion(bucket);
  return targets;
}

export async function saveExternalTargetsRaw(
  bucket: any,
  targets: ExternalStorageTarget[],
  opts?: { expectedUpdatedAt?: string | null }
): Promise<void> {
  const saved = targets.slice(0, 10);
  const payload = JSON.stringify(saved);
  const expectedMs = parseIsoMs(opts?.expectedUpdatedAt);
  const writeMs = Math.max(Date.now(), lastExternalTargetsWriteMs + 1, resolveTargetsUpdatedMs(saved), expectedMs + 1);
  lastExternalTargetsWriteMs = writeMs;
  const now = new Date(writeMs).toISOString();
  const hasExpected = Boolean(opts && "expectedUpdatedAt" in opts);

  let d1Err: unknown = null;
  let d1Conflict = false;
  try {
    let d1Res: any;
    if (hasExpected) {
      if (opts!.expectedUpdatedAt === null) {
        d1Res = await db.prepare(`
          INSERT OR IGNORE INTO app_settings (key, value, updated_at)
          VALUES (?, ?, ?)
        `).run(EXTERNAL_TARGETS_KEY, payload, now);
      } else {
        d1Res = await db.prepare(`
          UPDATE app_settings
          SET value = ?, updated_at = ?
          WHERE key = ? AND updated_at = ?
        `).run(payload, now, EXTERNAL_TARGETS_KEY, opts!.expectedUpdatedAt);
      }
    } else {
      d1Res = await db.prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        WHERE excluded.updated_at >= app_settings.updated_at
      `).run(EXTERNAL_TARGETS_KEY, payload, now);
    }
    const d1Changes = d1Res?.meta?.changes ?? d1Res?.changes;
    if (d1Changes === 0) {
      d1Conflict = true;
    }
  } catch (err) {
    d1Err = err;
  }

  if (d1Err === null && d1Conflict) {
    // D1 CAS 未命中：拒绝覆盖 R2，清空本地缓存并显式抛出冲突错误
    cachedExternalTargets = null;
    throw new ExternalTargetsConflictError();
  }

  let r2Ok = false;
  let r2Err: unknown = null;
  if (bucket) {
    try {
      await bucket.put(R2_EXTERNAL_TARGETS_KEY, payload, {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata: { updatedAt: now }
      });
      r2Ok = true;
    } catch (err) {
      r2Err = err;
    }
  }
  if (d1Err && (!bucket || !r2Ok)) {
    cachedExternalTargets = null;
    throw d1Err instanceof Error ? d1Err : (r2Err instanceof Error ? r2Err : new Error("保存外部存储目标失败"));
  }
  // 写入成功后刷新本 isolate 缓存（若本次是 D1 不可用降级写 R2，不伪造 d1UpdatedAt）
  cachedExternalTargets = {
    at: Date.now(),
    list: cloneTargets(saved),
    d1UpdatedAt: d1Err ? (opts?.expectedUpdatedAt ?? null) : now
  };
}

async function runWithExternalTargetsCas<T>(
  bucket: any,
  fn: (currentTargets: ExternalStorageTarget[], expectedUpdatedAt: string | null) => Promise<T>
): Promise<T> {
  return await withKeyLock(EXTERNAL_TARGETS_LOCK_KEY, async () => {
    for (let attempt = 0; attempt <= EXTERNAL_TARGETS_MAX_CAS_RETRIES; attempt++) {
      invalidateExternalTargetsCache();
      const { targets, d1UpdatedAt } = await readExternalTargetsWithVersion(bucket);
      try {
        return await fn(targets, d1UpdatedAt);
      } catch (err) {
        if (err instanceof ExternalTargetsConflictError && attempt < EXTERNAL_TARGETS_MAX_CAS_RETRIES) {
          continue;
        }
        throw err;
      }
    }
    throw new ExternalTargetsConflictError();
  });
}

// ---------------------------------------------------------------------------
// 远程 SQLite 执行器（Turso LibSQL / 跨账号 Cloudflare D1）
//
// 分流扩容的核心：评论、楼中楼 JSON、正文 HTML 都可以直接写进外部 SQLite 兼容库。
// 只要外部库能执行远程 SQL，就能扮演「主 D1 / 主 R2」的替身，网页读取时透明回源。
// ---------------------------------------------------------------------------

export type RemoteSqlResult = { rows: Record<string, any>[]; changes: number };
export type RemoteSqlStatement = { sql: string; params?: unknown[] };

/** Turso v2 pipeline 的参数编码：整数/浮点/文本/NULL 四种标量 */
function toTursoArg(p: unknown) {
  if (p === null || p === undefined) return { type: "null" };
  if (typeof p === "number") {
    return Number.isInteger(p)
      ? { type: "integer", value: String(p) }
      : { type: "float", value: p };
  }
  if (typeof p === "boolean") return { type: "integer", value: p ? "1" : "0" };
  if (p instanceof Uint8Array) {
    // 本项目只存文本，真遇到二进制按 base64 blob 传，避免静默丢字段
    let binary = "";
    for (const byte of p) binary += String.fromCharCode(byte);
    return { type: "blob", base64: btoa(binary) };
  }
  return { type: "text", value: String(p) };
}

/** Turso 返回的单元格 → JS 标量（integer/float 转 Number，null 转 null，其余转 String） */
function fromTursoCell(cell: any): any {
  if (cell === null || cell === undefined) return null;
  if (typeof cell !== "object") return cell;
  switch (cell.type) {
    case "null":
      return null;
    case "integer":
    case "float": {
      const num = Number(cell.value);
      return Number.isFinite(num) ? num : 0;
    }
    case "blob":
      return cell.base64 ?? null;
    default:
      return cell.value === undefined || cell.value === null ? null : String(cell.value);
  }
}

/** 单个 Turso pipeline 结果项 → { rows, changes } */
function parseTursoExecuteResult(first: any, index: number): RemoteSqlResult {
  if (!first) throw new Error(`Turso 返回缺少 results[${index}]`);
  if (first.type === "error") {
    throw new Error(`Turso SQL 错误: ${JSON.stringify(first.error ?? first).slice(0, 180)}`);
  }
  const result = first.response?.result ?? {};
  const cols: Array<{ name?: string }> = Array.isArray(result.cols) ? result.cols : [];
  const rawRows: any[][] = Array.isArray(result.rows) ? result.rows : [];
  const rows = rawRows.map(cells => {
    const row: Record<string, any> = {};
    for (let i = 0; i < cols.length; i++) {
      row[cols[i]?.name ?? String(i)] = fromTursoCell(Array.isArray(cells) ? cells[i] : undefined);
    }
    return row;
  });
  return { rows, changes: Number(result.affected_row_count ?? 0) || 0 };
}

function parseCloudflareD1DatabaseId(databaseId: string | undefined): { accId: string; dbId: string } | null {
  const raw = (databaseId || "").trim();
  if (!raw) return null;
  const parts = raw.includes("/") ? raw.split("/") : raw.split(":");
  const accId = parts[0]?.trim();
  const dbId = parts[1]?.trim();
  return accId && dbId ? { accId, dbId } : null;
}

async function executeTursoBatch(
  target: ExternalStorageTarget,
  statements: RemoteSqlStatement[]
): Promise<RemoteSqlResult[]> {
  const url = `${target.endpointUrl.replace(/\/+$/, "")}/v2/pipeline`;
  const res = await fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      ...(target.authToken ? { Authorization: `Bearer ${target.authToken}` } : {})
    },
    body: JSON.stringify({
      requests: [
        ...statements.map(stmt => ({
          type: "execute",
          stmt: { sql: stmt.sql, args: (stmt.params ?? []).map(toTursoArg) }
        })),
        { type: "close" }
      ]
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Turso ${res.status}: ${text.slice(0, 180)}`);
  }
  const json = await res.json().catch(() => null) as any;
  const results = Array.isArray(json?.results) ? json.results : [];
  // 每条 execute 都按序对应一个 result；close 的 result 在最后
  return statements.map((_, i) => parseTursoExecuteResult(results[i], i));
}

async function executeD1Statement(
  target: ExternalStorageTarget,
  sql: string,
  params: unknown[]
): Promise<RemoteSqlResult> {
  const ids = parseCloudflareD1DatabaseId(target.databaseId);
  if (!ids) throw new Error("跨账号 D1 需要按 AccountID/DatabaseID 填写数据库标识");
  // endpointUrl 默认 https://api.cloudflare.com；本地 mock 可传自定义 API 根地址
  const base = (target.endpointUrl || "https://api.cloudflare.com")
    .replace(/\/+$/, "")
    .replace(/\/client\/v4$/i, "");
  const url = `${base}/client/v4/accounts/${ids.accId}/d1/database/${ids.dbId}/query`;
  const res = await fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      ...(target.authToken ? { Authorization: `Bearer ${target.authToken}` } : {})
    },
    body: JSON.stringify({ sql, params: params.map(p => (p === undefined ? null : p)) })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Cloudflare D1 ${res.status}: ${text.slice(0, 180)}`);
  }
  const json = await res.json().catch(() => null) as any;
  if (json?.success === false) {
    throw new Error(`Cloudflare D1 错误: ${JSON.stringify(json?.errors || json).slice(0, 180)}`);
  }
  const first = json?.result?.[0];
  const rows = Array.isArray(first?.results) ? (first.results as Record<string, any>[]) : [];
  return { rows, changes: Number(first?.meta?.changes ?? 0) || 0 };
}

/**
 * 在外部 SQLite 兼容云库上按序执行多条 SQL。
 * - turso：一次 /v2/pipeline 里挂多个 execute request（20 根评论只占 1 个 Workers 子请求）
 * - cloudflare_d1：REST /query 一次只接受一条语句，只能逐条串行
 */
export async function executeRemoteSqlBatch(
  target: ExternalStorageTarget,
  statements: RemoteSqlStatement[]
): Promise<RemoteSqlResult[]> {
  if (!statements.length) return [];
  if (!target?.endpointUrl) throw new Error("外部库连接地址为空");

  if (target.provider === "turso") {
    return executeTursoBatch(target, statements);
  }
  if (target.provider === "cloudflare_d1") {
    const results: RemoteSqlResult[] = [];
    for (const statement of statements) {
      results.push(await executeD1Statement(target, statement.sql, statement.params ?? []));
    }
    return results;
  }
  throw new Error(`外部存储类型 ${target.provider} 不支持远程 SQL`);
}

/**
 * 在外部 SQLite 兼容云库上执行一条 SQL。
 * 任何 HTTP/协议错误都抛出，调用方决定降级（回写主库或跳过）。
 */
export async function executeRemoteSql(
  target: ExternalStorageTarget,
  sql: string,
  params: unknown[] = []
): Promise<RemoteSqlResult> {
  const results = await executeRemoteSqlBatch(target, [{ sql, params }]);
  return results[0] ?? { rows: [], changes: 0 };
}

// 每个 target（isolate 生命周期内）只建一次表：CREATE TABLE IF NOT EXISTS 也是网络往返
const initializedSchemaTargets = new Set<string>();

/** 远程库表结构（与主 D1 comments / comment_threads 同构，另加楼中楼 JSON 与正文 HTML 大对象表） */
const REMOTE_SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    content_pk TEXT NOT NULL,
    parent_comment_id TEXT,
    author_name TEXT,
    author_avatar TEXT,
    be_replied TEXT,
    content_md TEXT,
    img_url TEXT,
    time_text TEXT,
    location TEXT,
    likes INTEGER NOT NULL DEFAULT 0,
    is_author INTEGER NOT NULL DEFAULT 0,
    is_top INTEGER NOT NULL DEFAULT 0,
    is_featured INTEGER NOT NULL DEFAULT 0,
    comment_hash TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    child_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ext_comments_content ON comments(content_pk);`,
  `CREATE INDEX IF NOT EXISTS idx_ext_comments_parent ON comments(parent_comment_id);`,
  `CREATE TABLE IF NOT EXISTS comment_threads (
    root_id TEXT PRIMARY KEY,
    content_pk TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    child_count INTEGER NOT NULL DEFAULT 0,
    is_complete INTEGER NOT NULL DEFAULT 0,
    thread_hash TEXT NOT NULL DEFAULT '',
    incoming_hash TEXT NOT NULL DEFAULT '',
    preview_json TEXT NOT NULL DEFAULT '[]',
    synced_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ext_comment_threads_content ON comment_threads(content_pk);`,
  // 楼中楼整份 JSON 存外部 SQL 库：主 R2 的 childcomments/* 也就不必再写
  `CREATE TABLE IF NOT EXISTS child_comment_blobs (
    root_id TEXT PRIMARY KEY,
    content_pk TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    complete INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ext_child_comment_blobs_content ON child_comment_blobs(content_pk);`,
  // 正文大体积 HTML 存外部库：主 R2 的 html/* 也就不必再写
  `CREATE TABLE IF NOT EXISTS content_blobs (
    pk TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    content_html TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`
];

/**
 * 远程库建表（幂等）。每个 target 在一个 isolate 生命周期内只跑一次。
 * 建表失败会抛出且不记入缓存：下一批数据会自动重试，绝不会在没表时静默丢数据。
 */
export async function ensureRemoteCommentSchema(target: ExternalStorageTarget): Promise<void> {
  if (target.provider !== "turso" && target.provider !== "cloudflare_d1") return;
  const key = `${target.id}|${target.provider}|${target.endpointUrl}|${target.databaseId ?? ""}`;
  if (initializedSchemaTargets.has(key)) return;
  // Turso 一次 pipeline 完成全部建表（1 个子请求）；D1 REST 内部会按条串行
  await executeRemoteSqlBatch(
    target,
    REMOTE_SCHEMA_STATEMENTS.map(sql => ({ sql }))
  );
  initializedSchemaTargets.add(key);
}

/** 测试/配置切换用：清空「已建表」缓存 */
export function resetRemoteSchemaCache(): void {
  initializedSchemaTargets.clear();
}

// 主 D1 评论行数：overflow 水位判断用。每条 /ingest 都 COUNT(*) 太贵，缓存 5 分钟
const MAIN_COMMENT_COUNT_TTL_MS = 5 * 60_000;
let cachedMainCommentCount: { at: number; count: number } | null = null;

export function invalidateMainCommentCountCache(): void {
  cachedMainCommentCount = null;
}

async function getMainCommentRowCount(): Promise<number> {
  if (cachedMainCommentCount && Date.now() - cachedMainCommentCount.at < MAIN_COMMENT_COUNT_TTL_MS) {
    return cachedMainCommentCount.count;
  }
  try {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM comments`).get<{ n: number }>();
    const count = Number(row?.n ?? 0) || 0;
    cachedMainCommentCount = { at: Date.now(), count };
    return count;
  } catch {
    // 读不到就按「未达水位」处理：宁可继续写主库，也不能误判后把数据写进没配置好的外部库
    return 0;
  }
}

/** 该 provider 是否能真正承接同步分流（决定 /ingest 是否还要异步镜像转发） */
export function supportsSyncOffload(target: ExternalStorageTarget, scope: ExternalSyncScope): boolean {
  const sqlite = target.provider === "turso" || target.provider === "cloudflare_d1";
  if (scope === "contents") return sqlite || target.provider === "s3_r2";
  return scope === "comments" ? sqlite : false;
}

/**
 * 选出当前生效的「分流扩容」目标（写路径用）。
 * - offload  ：直接命中
 * - overflow ：主 D1 comments 行数达到阈值后才命中
 * - mirror   ：不参与分流（只做异步双写灾备）
 * 多个目标同时命中时取配置顺序里的第一个，避免同一份数据被拆到两个库。
 */
export async function resolveActiveOffloadTarget(
  bucket: any,
  scope: ExternalSyncScope
): Promise<ExternalStorageTarget | null> {
  const targets = await getExternalTargetsRaw(bucket).catch(() => [] as ExternalStorageTarget[]);
  for (const target of targets) {
    if (!target.enabled) continue;
    if (!Array.isArray(target.syncScopes) || !target.syncScopes.includes(scope)) continue;
    if (!supportsSyncOffload(target, scope)) continue;
    const role = target.storageRole || DEFAULT_STORAGE_ROLE;
    if (role === "offload") return target;
    if (role === "mirror") continue;
    const threshold = normalizeOverflowThreshold(target.overflowThresholdRows);
    if ((await getMainCommentRowCount()) >= threshold) return target;
  }
  return null;
}

/**
 * 可透明回读评论的外部库列表（读路径用）。
 * offload 与 overflow 都可能持有评论数据，读接口必须按顺序逐个回源查找。
 */
export async function listReadableCommentOffloadTargets(bucket: any): Promise<ExternalStorageTarget[]> {
  const targets = await getExternalTargetsRaw(bucket).catch(() => [] as ExternalStorageTarget[]);
  return targets.filter(t =>
    t.enabled &&
    Array.isArray(t.syncScopes) &&
    t.syncScopes.includes("comments") &&
    (t.provider === "turso" || t.provider === "cloudflare_d1") &&
    (t.storageRole || DEFAULT_STORAGE_ROLE) !== "mirror"
  );
}

/** 可透明回读正文的外部库列表（读路径用） */
export async function listReadableContentOffloadTargets(bucket: any): Promise<ExternalStorageTarget[]> {
  const targets = await getExternalTargetsRaw(bucket).catch(() => [] as ExternalStorageTarget[]);
  return targets.filter(t =>
    t.enabled &&
    Array.isArray(t.syncScopes) &&
    t.syncScopes.includes("contents") &&
    (t.provider === "turso" || t.provider === "cloudflare_d1" || t.provider === "s3_r2") &&
    (t.storageRole || DEFAULT_STORAGE_ROLE) !== "mirror"
  );
}

// S3 兼容对象存储：path-style key，写入与读取必须用同一套编码
function s3OffloadBase(target: ExternalStorageTarget): string | null {
  const bucketName = (target.databaseId || "").trim().replace(/^\/+|\/+$/g, "");
  if (!bucketName) return null;
  return `${target.endpointUrl.replace(/\/+$/, "")}/${encodeURIComponent(bucketName)}`;
}

/** 正文 HTML 写入外部库（SQLite 兼容库的 content_blobs 或 S3 兼容对象存储） */
export async function putOffloadedContentHtml(
  target: ExternalStorageTarget,
  pk: string,
  hash: string,
  html: string
): Promise<void> {
  if (target.provider === "s3_r2") {
    const base = s3OffloadBase(target);
    if (!base) throw new Error("S3 兼容存储需要填写 Bucket 名称");
    const objectUrl = `${base}/html/${encodeURIComponent(pk)}/${encodeURIComponent(hash || "latest")}`;
    const res = await fetch(objectUrl, {
      method: "PUT",
      redirect: "manual",
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...(target.authToken ? { Authorization: `Bearer ${target.authToken}` } : {})
      },
      body: html
    });
    if (!res.ok) throw new Error(`S3 PUT ${res.status}`);
    return;
  }
  await executeRemoteSql(
    target,
    `INSERT OR REPLACE INTO content_blobs (pk, content_hash, content_html, updated_at) VALUES (?, ?, ?, ?)`,
    [pk, hash, html, new Date().toISOString()]
  );
}

/** 正文 HTML 从外部库读回；未命中返回 null（调用方继续回落 md/ 或空正文） */
export async function readOffloadedContentHtml(
  target: ExternalStorageTarget,
  pk: string,
  hash?: string
): Promise<string | null> {
  if (target.provider === "s3_r2") {
    const base = s3OffloadBase(target);
    if (!base) return null;
    const candidates = hash
      ? [`${base}/html/${encodeURIComponent(pk)}/${encodeURIComponent(hash)}`, `${base}/html/${encodeURIComponent(pk)}`]
      : [`${base}/html/${encodeURIComponent(pk)}`];
    for (const objectUrl of candidates) {
      const res = await fetch(objectUrl, {
        redirect: "manual",
        headers: target.authToken ? { Authorization: `Bearer ${target.authToken}` } : {}
      }).catch(() => null);
      if (res?.ok) {
        const text = await res.text().catch(() => "");
        if (text) return text;
      }
    }
    return null;
  }
  const result = await executeRemoteSql(
    target,
    `SELECT content_html FROM content_blobs WHERE pk = ?`,
    [pk]
  );
  const html = result.rows[0]?.content_html;
  return typeof html === "string" && html ? html : null;
}

export type CommentSyncMode = "full" | "hot" | "none";

/**
 * 正文图片备份质量：
 * - original   ：原图字节，最大备份完整度（默认）
 * - high       ：抓知乎图床 _1440w 官方尺寸版本，视觉接近无损
 * - compressed ：抓知乎图床 _720w 官方尺寸版本，体积明显更省
 * 注意这是「取图床的官方压缩版本」，不是 Worker 内重新编码：
 * Workers / miniflare 没有 Canvas 或原生图像 API，纯 JS 编解码会打爆 CPU 与内存。
 */
export type ImageQuality = "original" | "high" | "compressed";

export const DEFAULT_IMAGE_QUALITY: ImageQuality = "original";
const VALID_IMAGE_QUALITIES = new Set<ImageQuality>(["original", "high", "compressed"]);

/** 归一化图片质量设置：非法/缺省值一律回退原图，避免脏配置让入库图片处理异常 */
export function normalizeImageQuality(
  value: unknown,
  fallback: ImageQuality = DEFAULT_IMAGE_QUALITY
): ImageQuality {
  return VALID_IMAGE_QUALITIES.has(value as ImageQuality) ? (value as ImageQuality) : fallback;
}

export type SyncConfig = {
  commentsMyAnswers: CommentSyncMode;
  commentsCollections: CommentSyncMode;
  commentsUpvotes: CommentSyncMode;
  commentsFollowing: CommentSyncMode;
  followingSensitivity: "strict" | "standard" | "relaxed";
  preferredAiModel: string;
  /** 正文图片备份质量，默认 original（原图） */
  imageQuality: ImageQuality;
  /** Workers AI 额度耗尽/不可用时的替补引擎 Base URL（OpenAI 兼容），空串=未配置 */
  fallbackAiBaseUrl?: string;
  /** 替补引擎模型名，默认 deepseek-v4.1-flash */
  fallbackAiModel?: string;
  /** 只读标记：替补引擎 Key 是否已保存（明文 Key 永不回传前端） */
  hasFallbackAiKey?: boolean;
  updatedAt?: string | null;
};

/** 写入用 patch：fallbackAiApiKey 只写不读（保存后只回 hasFallbackAiKey） */
export type SyncConfigPatch = Partial<SyncConfig> & {
  /** 非空=保存；"__CLEAR__"=清空；留空=保留原值 */
  fallbackAiApiKey?: string;
};

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  commentsMyAnswers: "full",
  // 收藏内容按用户要求默认全量抓评论；赞同基数太大（2.9 万条），默认只抓热门前 20 条 + 楼中楼
  commentsCollections: "full",
  commentsUpvotes: "hot",
  commentsFollowing: "hot",
  followingSensitivity: "standard",
  preferredAiModel: "@cf/qwen/qwen3-30b-a3b-fp8",
  imageQuality: DEFAULT_IMAGE_QUALITY,
  fallbackAiBaseUrl: "",
  fallbackAiModel: DEFAULT_FALLBACK_AI_MODEL,
  hasFallbackAiKey: false,
  updatedAt: null
};

const VALID_COMMENT_MODES = new Set<CommentSyncMode>(["full", "hot", "none"]);
const VALID_SENSITIVITY = new Set(["strict", "standard", "relaxed"]);
const VALID_AI_MODELS = new Set([
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
  "@cf/zai-org/glm-5.3-flash",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
]);

/** 替补引擎 Base URL 归一：只接受 http/https，去掉尾斜杠；非法值回退原值 */
function normalizeFallbackBaseUrl(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const raw = value.trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

/** 替补引擎模型名归一：trim + 截断，空则默认 deepseek-v4.1-flash */
function normalizeFallbackModel(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return fallback || DEFAULT_FALLBACK_AI_MODEL;
  return raw.slice(0, 120);
}

/** 读取替补引擎 Key（仅服务端内部使用，任何 GET 接口都不得回传明文） */
async function readFallbackAiApiKey(): Promise<string> {
  try {
    const row = await db.prepare(
      `SELECT value FROM app_settings WHERE key = ?`
    ).get<{ value: string }>(FALLBACK_AI_KEY_KEY);
    return typeof row?.value === "string" ? row.value.trim() : "";
  } catch {
    return "";
  }
}

export async function getSyncConfig(bucket: any): Promise<SyncConfig> {
  let r2Cfg: Partial<SyncConfig> | null = null;
  if (bucket) {
    try {
      const obj = await bucket.get(R2_SYNC_CONFIG_KEY);
      if (obj) r2Cfg = JSON.parse(await obj.text());
    } catch { /* ignore */ }
  }
  let d1Cfg: Partial<SyncConfig> | null = null;
  try {
    const row = await db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get<{ value: string }>(SYNC_CONFIG_KEY);
    if (row?.value) d1Cfg = JSON.parse(row.value);
  } catch { /* ignore */ }

  const r2Ts = r2Cfg?.updatedAt ? Date.parse(String(r2Cfg.updatedAt)) : NaN;
  const d1Ts = d1Cfg?.updatedAt ? Date.parse(String(d1Cfg.updatedAt)) : NaN;
  const preferD1 =
    d1Cfg &&
    (!r2Cfg ||
      (Number.isFinite(d1Ts) && (!Number.isFinite(r2Ts) || d1Ts >= r2Ts)));
  const merged = preferD1
    ? { ...DEFAULT_SYNC_CONFIG, ...(r2Cfg || {}), ...(d1Cfg || {}) }
    : { ...DEFAULT_SYNC_CONFIG, ...(d1Cfg || {}), ...(r2Cfg || {}) };
  return {
    commentsMyAnswers: VALID_COMMENT_MODES.has(merged.commentsMyAnswers as CommentSyncMode) ? (merged.commentsMyAnswers as CommentSyncMode) : "full",
    commentsCollections: VALID_COMMENT_MODES.has(merged.commentsCollections as CommentSyncMode) ? (merged.commentsCollections as CommentSyncMode) : "full",
    commentsUpvotes: VALID_COMMENT_MODES.has(merged.commentsUpvotes as CommentSyncMode) ? (merged.commentsUpvotes as CommentSyncMode) : "hot",
    commentsFollowing: VALID_COMMENT_MODES.has(merged.commentsFollowing as CommentSyncMode) ? (merged.commentsFollowing as CommentSyncMode) : "hot",
    followingSensitivity: VALID_SENSITIVITY.has(merged.followingSensitivity) ? merged.followingSensitivity : "standard",
    preferredAiModel: VALID_AI_MODELS.has(merged.preferredAiModel) ? merged.preferredAiModel : "@cf/qwen/qwen3-30b-a3b-fp8",
    imageQuality: normalizeImageQuality(merged.imageQuality),
    fallbackAiBaseUrl: normalizeFallbackBaseUrl(merged.fallbackAiBaseUrl, ""),
    fallbackAiModel: normalizeFallbackModel(merged.fallbackAiModel, DEFAULT_FALLBACK_AI_MODEL),
    // 只暴露布尔标记：明文 Key 只存在 app_settings.fallback_ai_api_key 与 env secret 中
    hasFallbackAiKey: (await readFallbackAiApiKey()) !== "",
    updatedAt: merged.updatedAt || null
  };
}

/**
 * 替补 AI 引擎（OpenAI 兼容）的运行时配置。
 * 优先级：网页保存的 D1/R2 配置 > 环境变量 > 默认值（本机 127.0.0.1:8788 反代）。
 * 注意：baseUrl 是否允许直连由 services/recommend.ts 的 resolveFallbackEndpoint 再做 SSRF 校验。
 */
export type FallbackAiConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** db=网页设置，env=环境变量，none=都没配（仍使用本地默认地址，仅本地可用） */
  source: "db" | "env" | "none";
};

export async function getFallbackAiConfig(env: Bindings): Promise<FallbackAiConfig> {
  let cfg: SyncConfig | null = null;
  try {
    cfg = await getSyncConfig(env.BUCKET);
  } catch {
    cfg = null;
  }
  const dbKey = await readFallbackAiApiKey();
  const envBase = String(env.FALLBACK_AI_BASE_URL || "").trim();
  const envKey = String(env.FALLBACK_AI_API_KEY || "").trim();
  const envModel = String(env.FALLBACK_AI_MODEL || "").trim();
  const dbBase = String(cfg?.fallbackAiBaseUrl || "").trim();
  const baseUrl = (dbBase || envBase || DEFAULT_FALLBACK_AI_BASE_URL).replace(/\/+$/, "");
  const apiKey = dbKey || envKey;
  const dbModel =
    cfg?.fallbackAiModel && cfg.fallbackAiModel !== DEFAULT_FALLBACK_AI_MODEL
      ? cfg.fallbackAiModel
      : "";
  const model = normalizeFallbackModel(dbModel, envModel || DEFAULT_FALLBACK_AI_MODEL);
  return {
    baseUrl,
    apiKey,
    model,
    source: dbBase || dbKey ? "db" : envBase || envKey ? "env" : "none"
  };
}

export async function saveSyncConfig(bucket: any, patch: SyncConfigPatch): Promise<SyncConfig> {
  const current = await getSyncConfig(bucket);
  const now = new Date().toISOString();
  const next: SyncConfig = {
    commentsMyAnswers: VALID_COMMENT_MODES.has(patch.commentsMyAnswers as CommentSyncMode) ? (patch.commentsMyAnswers as CommentSyncMode) : current.commentsMyAnswers,
    commentsCollections: VALID_COMMENT_MODES.has(patch.commentsCollections as CommentSyncMode) ? (patch.commentsCollections as CommentSyncMode) : current.commentsCollections,
    commentsUpvotes: VALID_COMMENT_MODES.has(patch.commentsUpvotes as CommentSyncMode) ? (patch.commentsUpvotes as CommentSyncMode) : current.commentsUpvotes,
    commentsFollowing: VALID_COMMENT_MODES.has(patch.commentsFollowing as CommentSyncMode) ? (patch.commentsFollowing as CommentSyncMode) : current.commentsFollowing,
    followingSensitivity: VALID_SENSITIVITY.has(patch.followingSensitivity as string) ? (patch.followingSensitivity as any) : current.followingSensitivity,
    preferredAiModel: VALID_AI_MODELS.has(patch.preferredAiModel as string) ? (patch.preferredAiModel as string) : current.preferredAiModel,
    imageQuality: normalizeImageQuality(patch.imageQuality, current.imageQuality),
    fallbackAiBaseUrl: normalizeFallbackBaseUrl(patch.fallbackAiBaseUrl, current.fallbackAiBaseUrl || ""),
    fallbackAiModel: normalizeFallbackModel(patch.fallbackAiModel, current.fallbackAiModel || DEFAULT_FALLBACK_AI_MODEL),
    updatedAt: now
  };

  // 替补引擎 Key：非空=保存，__CLEAR__=清空，留空=保留原值（前端只提交「有变化」的密钥）
  const rawKey = typeof patch.fallbackAiApiKey === "string" ? patch.fallbackAiApiKey.trim() : "";
  if (rawKey === "__CLEAR__") {
    try {
      await db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(FALLBACK_AI_KEY_KEY);
    } catch { /* ignore */ }
  } else if (rawKey) {
    try {
      await db.prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(FALLBACK_AI_KEY_KEY, rawKey, now);
    } catch { /* ignore */ }
  }

  if (bucket) {
    await bucket.put(R2_SYNC_CONFIG_KEY, JSON.stringify(next), {
      httpMetadata: { contentType: "application/json; charset=utf-8" }
    });
  }
  try {
    await db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(SYNC_CONFIG_KEY, JSON.stringify(next), now);
  } catch { /* D1 每日写入限额满时由 R2 持久化 */ }

  const savedKey = rawKey && rawKey !== "__CLEAR__" ? rawKey : await readFallbackAiApiKey();
  return { ...next, hasFallbackAiKey: Boolean(savedKey) };
}

function isValidCookieString(s: string): boolean {
  // 至少要带登录态 z_c0，否则存进去也是无效的
  return /(?:^|;\s*)z_c0=[^;]+/.test(s);
}

export function isOriginAllowed(c: any, requireHeader = false): boolean {
  const origin = c.req.header("origin");
  if (!origin) return !requireHeader;
  const allowed = String(c.env.ALLOWED_ORIGIN || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  if (allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return true;
  }
  for (const item of allowed) {
    if (item.startsWith("https://") && item.endsWith(".pages.dev")) {
      const host = item.slice("https://".length);
      if (origin.startsWith("https://") && origin.endsWith(`.${host}`)) return true;
    }
  }
  return false;
}

// ---------- 外部存储目标 SSRF 防护 ----------

// 云厂商元数据地址：任何环境都必须拦截（包括本地开发，没有任何合法用途）
const ALWAYS_BLOCKED_HOSTS = new Set([
  "169.254.169.254",        // AWS / GCP / Azure / 阿里云元数据
  "100.100.100.200",        // 阿里云元数据
  "fd00:ec2::254",          // AWS IPv6 元数据
  "::ffff:a9fe:a9fe",       // 169.254.169.254 的 IPv4-mapped IPv6 归一化形式
  "::ffff:169.254.169.254",
  "::ffff:6464:64c8",       // 100.100.100.200 的 IPv4-mapped IPv6 归一化形式
  "::ffff:100.100.100.200",
  "metadata.google.internal",
  "metadata"
]);

/** 归一化 SSRF 检查用 host：小写、剥离 IPv6 方括号及域名尾点 */
function normalizeHostForSsrf(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

/** 是否为内网 / 回环 / 链路本地地址（不含元数据判断）。 */
export function isPrivateOrLoopbackHost(host: string): boolean {
  const h = normalizeHostForSsrf(host);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  // IPv6 字面量必须带冒号：否则 "fc-xxx.turso.io" 这类正常域名会被误判为 fc00::/7
  if (h.includes(":")) {
    if (h === "::1" || h === "::") return true;
    if (/^::ffff:/i.test(h)) return true;
    if (/^(fc|fd|fe[89ab]|64:ff9b:)/.test(h)) return true;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * 当前请求是否来自本地开发（浏览器/脚本直连 localhost 或 127.0.0.1）。
 * 生产环境（Pages/worker 域名）返回 false，此时内网地址一律拦截；
 * 本地联调 Webhook 或自建 mock Turso 时允许 127.0.0.1。
 */
function isLocalDevRequest(c: any): boolean {
  try {
    const h = new URL(c.req.url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0";
  } catch {
    return false;
  }
}

/** 校验外部存储目标 URL，返回错误文案；合法返回 null。 */
function validateExternalTargetUrl(c: any, rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "无效的 URL 格式";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "连接地址必须是合法的 http:// 或 https:// URL";
  }
  if (parsed.username || parsed.password) {
    return "连接地址不能包含账号密码，请把凭据填写到访问凭据( authToken )中";
  }
  const host = normalizeHostForSsrf(parsed.hostname);
  if (ALWAYS_BLOCKED_HOSTS.has(host)) {
    return "不允许访问云元数据或链路本地地址";
  }
  if (!isLocalDevRequest(c) && isPrivateOrLoopbackHost(host)) {
    return "不允许访问内网/回环地址（仅本地开发环境允许）";
  }
  return null;
}

/**
 * 读取当前生效的凭据页写入口令：
 * 优先读 D1 app_settings 中的在线设置值，回退到环境变量 COOKIE_WRITE_TOKEN，
 * 最后回退到 API_SECRET —— 只要部署配了 API_SECRET，写接口就天然是 fail-closed，
 * 不存在「口令为空、裸奔放行」的窗口。用户在网页输入 API_SECRET 也能直接操作。
 */
export type WriteTokenSource = "db" | "env" | "api_secret" | "none";

/**
 * 逐层探测当前生效的写口令及其来源：
 * db（网页设置的 D1 密码）> env（COOKIE_WRITE_TOKEN）> api_secret（API_SECRET 兜底）> none。
 * 前端需要 tokenSource 区分「用户设过独立密码」和「只是拿 API_SECRET 兜底」。
 */
export async function getActiveWriteTokenInfo(
  c: any
): Promise<{ token: string; source: WriteTokenSource }> {
  let dbError: unknown = null;
  try {
    const row = await db.prepare(
      `SELECT value FROM app_settings WHERE key = ?`
    ).get<{ value: string }>(WRITE_TOKEN_KEY);
    if (row?.value && row.value.trim()) {
      return { token: row.value.trim(), source: "db" };
    }
  } catch (err) {
    dbError = err;
  }
  const envToken = String(c.env.COOKIE_WRITE_TOKEN || "").trim();
  if (envToken) return { token: envToken, source: "env" };
  const apiSecret = String(c.env.API_SECRET || "").trim();
  if (apiSecret) return { token: apiSecret, source: "api_secret" };
  if (dbError !== null) {
    throw new Error("Auth storage unavailable");
  }
  return { token: "", source: "none" };
}

export async function getActiveWriteToken(c: any): Promise<string> {
  return (await getActiveWriteTokenInfo(c)).token;
}

/**
 * 写入鉴权（fail-closed）：
 * - 必须携带 `Authorization: Bearer <token>`，不存在「仅 Origin 免密」分支；
 * - 带了 Origin 就必须命中白名单（CLI 无 Origin 时凭口令即可）；
 * - 依次接受 API_SECRET / 写入口令（D1 在线设置 > COOKIE_WRITE_TOKEN > API_SECRET）；
 * - 连 API_SECRET 都没配的空环境或 D1 不可用且无 env 兜底时直接拒绝，绝不默认放行。
 */
export async function authorizeWrite(c: any): Promise<{ ok: boolean }> {
  const apiSecret = c.env.API_SECRET;
  const auth = c.req.header("authorization") || "";

  if (!auth.startsWith("Bearer ")) return { ok: false };

  // 带了 Origin 才校验白名单；无 Origin 的脚本/CLI 仍可用 Bearer 调用
  if (c.req.header("origin") && !isOriginAllowed(c, true)) return { ok: false };

  if (apiSecret && auth === `Bearer ${apiSecret}`) return { ok: true };

  let writeToken = "";
  try {
    writeToken = await getActiveWriteToken(c);
  } catch {
    return { ok: false };
  }
  if (!writeToken) return { ok: false };

  return { ok: auth === `Bearer ${writeToken}` };
}

export const NO_WRITE_TOKEN_HINT =
  "尚未配置操作密码或 API_SECRET，请先在设置页初始化操作密码";

/**
 * 写鉴权失败的统一响应：纯本地空环境（D1 / COOKIE_WRITE_TOKEN / API_SECRET 都没配）时
 * 给出「先去设置页初始化操作密码」的可操作提示，而不是含糊的「密码错误」。
 */
async function denyWrite(c: any, fallback: string) {
  try {
    const token = await getActiveWriteToken(c);
    return c.json({ error: token ? fallback : NO_WRITE_TOKEN_HINT, needToken: true }, 401);
  } catch {
    return c.json({ error: "Auth storage unavailable" }, 503);
  }
}

/**
 * 保存 cookie。
 */
authRoutes.post("/zhihu-cookie", async c => {
  if (!(await authorizeWrite(c)).ok) {
    return denyWrite(c, "密码错误或未填写操作密码");
  }

  const body = await c.req.json().catch(() => null) as { cookieString?: unknown } | null;
  const cookieString = typeof body?.cookieString === "string" ? body.cookieString.trim() : "";

  if (!cookieString) {
    return c.json({ error: "cookieString is required" }, 400);
  }
  if (!isValidCookieString(cookieString)) {
    return c.json({ error: "cookie 里没有 z_c0，可能复制不完整或还没登录" }, 400);
  }
  if (cookieString.length > 20000) {
    return c.json({ error: "cookieString too long" }, 400);
  }

  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(COOKIE_KEY, cookieString, now);

  return c.json({
    ok: true,
    updatedAt: now,
    cookieCount: cookieString.split(";").filter(s => s.trim()).length
  });
});

/**
 * 在线设置或修改凭据页操作密码（口令）。
 * - 当前已有口令（D1 / COOKIE_WRITE_TOKEN / API_SECRET 任一）时，必须先校验 currentToken 正确才允许修改；
 * - 环境变量 COOKIE_WRITE_TOKEN 与 API_SECRET 均可作为应急恢复主钥，永远不锁死；
 * - 极端空环境（三者都没配）首次设置时仍需来自白名单网页，防止外部脚本抢设管理员密码。
 */
authRoutes.post("/write-token", async c => {
  if (!isOriginAllowed(c)) {
    return c.json({ error: "Forbidden origin" }, 403);
  }

  const body = await c.req.json().catch(() => null) as {
    currentToken?: unknown;
    newToken?: unknown;
  } | null;

  const currentInput = typeof body?.currentToken === "string" ? body.currentToken.trim() : "";
  const newToken = typeof body?.newToken === "string" ? body.newToken.trim() : "";

  if (newToken.length < 4 || newToken.length > 128) {
    return c.json({ error: "新密码长度需在 4 到 128 个字符之间" }, 400);
  }

  let activeToken = "";
  try {
    activeToken = await getActiveWriteToken(c);
  } catch {
    return c.json({ error: "Auth storage unavailable" }, 503);
  }
  const auth = c.req.header("authorization") || "";
  const hasApiSecret = Boolean(c.env.API_SECRET && auth === `Bearer ${c.env.API_SECRET}`);
  // 环境变量口令作为应急恢复主钥：D1 里的口令被写坏/忘记时可从 env 恢复
  const envToken = String(c.env.COOKIE_WRITE_TOKEN || "").trim();
  const apiSecretEnv = String(c.env.API_SECRET || "").trim();

  if (!activeToken) {
    // 纯本地 / 空环境首次初始化：三者都没配，此时不存在任何可校验的旧口令，
    // 只信任白名单网页（浏览器必带 Origin）直接设置初始操作密码，
    // 防止外部无头脚本抢设管理员密码。
    if (!isOriginAllowed(c, true)) {
      return c.json({ error: "Forbidden origin" }, 403);
    }
  } else if (
    !hasApiSecret &&
    currentInput !== activeToken &&
    !(envToken && currentInput === envToken) &&
    !(apiSecretEnv && currentInput === apiSecretEnv)
  ) {
    return c.json({ error: "当前密码不正确，无法修改" }, 401);
  }

  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(WRITE_TOKEN_KEY, newToken, now);

  return c.json({ ok: true, writeTokenRequired: true, updatedAt: now });
});

/**
 * 查 Apify 最后一次 run 的状态，带 60 秒 D1 缓存。
 */
async function getLastApifyRun(c: any) {
  const token = c.env.APIFY_TOKEN;
  const actorId = c.env.APIFY_ACTOR_ID;
  if (!token || !actorId) return null;

  const CACHE_KEY = "apify_last_run";
  const CACHE_MS = 60_000;

  try {
    const row = await db.prepare(
      `SELECT value, updated_at FROM app_settings WHERE key = ?`
    ).get(CACHE_KEY) as any;
    if (row?.value && row?.updated_at) {
      const age = Date.now() - Date.parse(row.updated_at);
      if (Number.isFinite(age) && age >= 0 && age < CACHE_MS) {
        return JSON.parse(row.value);
      }
    }
  } catch {
    // 表还没建，忽略缓存
  }

  let data: any = null;
  try {
    // token 放 Authorization 头：URL query 会出现在 Apify 的错误回显里，进而被写进 sync_runs.message
    const res = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs/last`, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (res.ok) {
      const j = await res.json() as any;
      data = {
        status: j.data?.status ?? null,
        startedAt: j.data?.startedAt ?? null,
        finishedAt: j.data?.finishedAt ?? null,
        message: j.data?.statusMessage ?? null
      };
    }
  } catch (e) {
    console.error("query apify last run failed", e);
  }

  if (data) {
    try {
      await db.prepare(`
        INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(CACHE_KEY, JSON.stringify(data), new Date().toISOString());
    } catch {
      // 缓存写失败不影响主流程
    }
  }

  return data;
}

/**
 * 登录状态。永远不返回 cookie 明文与密码明文。
 */
authRoutes.get("/zhihu-status", async c => {
  let row: { value: string; updated_at: string } | null = null;
  try {
    row = await db.prepare(
      `SELECT value, updated_at FROM app_settings WHERE key = ?`
    ).get(COOKIE_KEY) as any;
  } catch (e) {
    console.error("read app_settings failed (migration applied?):", e);
  }

  const envCookie = c.env.ZHIHU_COOKIE_STRING || c.env.ZHIHU_COOKIE_Z_C0 || "";
  const value = row?.value || envCookie;
  const source = row?.value ? "db" : (envCookie ? "env" : "none");

  const updatedAt = row?.updated_at ?? null;
  let ageHours: number | null = null;
  if (updatedAt) {
    const t = Date.parse(updatedAt);
    if (!Number.isNaN(t)) ageHours = Math.round((Date.now() - t) / 3600_000);
  }

  let activeTokenInfo: { token: string; source: WriteTokenSource };
  try {
    activeTokenInfo = await getActiveWriteTokenInfo(c);
  } catch (e) {
    console.error("read write token failed (migration applied?):", e);
    return c.json({ error: "Auth storage unavailable" }, 503);
  }
  const syncConfig = await getSyncConfig(c.env.BUCKET);
  // 环境变量注入的 Key 同样算「已配置」，但明文永不回传：只暴露 hasFallbackAiKey
  const hasFallbackAiKey =
    Boolean(syncConfig.hasFallbackAiKey) || Boolean(String(c.env.FALLBACK_AI_API_KEY || "").trim());
  let upvotesCursor: string | null = null;
  try {
    const cRow = await db.prepare(`SELECT value FROM app_settings WHERE key = 'upvotes_cursor'`).get<{ value: string }>();
    if (cRow?.value) upvotesCursor = cRow.value;
  } catch { /* ignore */ }

  const externalTargets = await getExternalTargetsRaw(c.env.BUCKET).catch(() => []);
  const externalTargetsCount = externalTargets.filter(t => t.enabled).length;

  return c.json({
    hasCookie: !!value,
    source,
    updatedAt,
    ageHours,
    cookieCount: value ? value.split(";").filter(s => s.trim()).length : 0,
    hasZC0: isValidCookieString(value),
    writeTokenRequired: Boolean(activeTokenInfo.token),
    // 当前生效的写口令来源：db=网页设的独立密码，env=COOKIE_WRITE_TOKEN，
    // api_secret=还没单独设密码、暂用 API_SECRET 兜底，none=纯本地空环境
    tokenSource: activeTokenInfo.source,
    // 读接口是否也要求 Bearer（默认关闭，保持前端直接可用）
    readAuthRequired: c.env.READ_AUTH_REQUIRED === "true",
    lastRun: await getLastApifyRun(c),
    syncConfig: { ...syncConfig, hasFallbackAiKey },
    upvotesCursor,
    externalTargetsCount
  });
});

/**
 * 读取与更新全局同步与评论抓取策略设置
 */
authRoutes.get("/settings", async c => {
  const syncConfig = await getSyncConfig(c.env.BUCKET);
  const hasFallbackAiKey =
    Boolean(syncConfig.hasFallbackAiKey) || Boolean(String(c.env.FALLBACK_AI_API_KEY || "").trim());
  return c.json({ ok: true, syncConfig: { ...syncConfig, hasFallbackAiKey } });
});

authRoutes.post("/settings", async c => {
  if (!(await authorizeWrite(c)).ok) {
    return denyWrite(c, "操作密码错误或未填写，请先在设置页输入操作密码");
  }
  const body = await c.req.json().catch(() => null) as SyncConfigPatch | null;
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid body" }, 400);
  }
  const saved = await saveSyncConfig(c.env.BUCKET, body);
  const hasFallbackAiKey =
    Boolean(saved.hasFallbackAiKey) || Boolean(String(c.env.FALLBACK_AI_API_KEY || "").trim());
  // 响应永不包含 fallbackAiApiKey 明文，只有 hasFallbackAiKey 标记
  return c.json({ ok: true, syncConfig: { ...saved, hasFallbackAiKey } });
});

/**
 * 清除 D1 里存的 cookie（env 里的不受影响）。
 */
authRoutes.post("/zhihu-cookie/clear", async c => {
  if (!(await authorizeWrite(c)).ok) {
    return denyWrite(c, "密码错误或未填写操作密码");
  }
  await db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(COOKIE_KEY);
  return c.json({ ok: true });
});

/**
 * 外部存储与多云数据库扩展列表
 */
authRoutes.get("/external-targets", async c => {
  const targets = await getExternalTargetsRaw(c.env.BUCKET);
  return c.json({ targets: targets.map(maskTargetForClient) });
});

/**
 * 新增或编辑外部存储目标
 */
authRoutes.post("/external-targets", async c => {
  if (!(await authorizeWrite(c)).ok) {
    return denyWrite(c, "操作密码错误或未填写，请先在设置页输入操作密码");
  }

  const body = await c.req.json().catch(() => null) as Partial<ExternalStorageTarget> | null;
  if (!body || typeof body !== "object") {
    return c.json({ error: "请求格式错误" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 60) {
    return c.json({ error: "名称必填且长度在 1~60 个字符之间" }, 400);
  }

  const provider = body.provider as ExternalProviderType;
  if (!VALID_PROVIDERS.has(provider)) {
    return c.json({ error: "无效的外部存储类型" }, 400);
  }

  let endpointUrl = typeof body.endpointUrl === "string" ? body.endpointUrl.trim() : "";
  if (provider === "cloudflare_d1" && !endpointUrl) {
    endpointUrl = "https://api.cloudflare.com";
  }

  if (!endpointUrl || (!endpointUrl.startsWith("http://") && !endpointUrl.startsWith("https://"))) {
    return c.json({ error: "连接地址必须是合法的 http:// 或 https:// URL" }, 400);
  }
  // 保存时也做 SSRF 校验：否则可以先存一个元数据地址，再靠每次 /ingest 转发去打内网
  const urlError = validateExternalTargetUrl(c, endpointUrl);
  if (urlError) {
    return c.json({ error: urlError }, 400);
  }

  const databaseId = typeof body.databaseId === "string" ? body.databaseId.trim() : undefined;
  const rawAuthToken = typeof body.authToken === "string" ? body.authToken.trim() : undefined;
  const enabled = body.enabled !== false;
  const scopes = Array.isArray(body.syncScopes)
    ? (body.syncScopes.filter((s: any): s is ExternalSyncScope => VALID_SYNC_SCOPES.has(s)) as ExternalSyncScope[])
    : (["contents", "comments"] as ExternalSyncScope[]);
  const syncScopes: ExternalSyncScope[] = scopes.length ? scopes : ["contents", "comments"];

  try {
    return await runWithExternalTargetsCas(c.env.BUCKET, async (currentTargets, expectedUpdatedAt) => {
      const now = new Date().toISOString();

      let targetId = typeof body.id === "string" ? body.id.trim() : "";
      const existingIdx = targetId ? currentTargets.findIndex(t => t.id === targetId) : -1;
      const existingTarget = existingIdx >= 0 ? currentTargets[existingIdx] : undefined;

      // 老前端（未传 storageRole）编辑时保留原值；新建时默认直接分流扩容
      const storageRole = normalizeStorageRole(
        body.storageRole,
        existingTarget?.storageRole ?? DEFAULT_STORAGE_ROLE
      );
      const overflowThresholdRows = normalizeOverflowThreshold(
        body.overflowThresholdRows,
        existingTarget?.overflowThresholdRows ?? DEFAULT_OVERFLOW_THRESHOLD_ROWS
      );

      let savedTarget: ExternalStorageTarget;

      if (existingIdx >= 0) {
        const existing = currentTargets[existingIdx];
        // 如果前端传来的 authToken 为空串或 undefined，保留旧的 existing.authToken
        const finalToken = rawAuthToken ? rawAuthToken : existing.authToken;
        savedTarget = {
          ...existing,
          name,
          provider,
          enabled,
          syncScopes,
          storageRole,
          overflowThresholdRows,
          endpointUrl,
          databaseId,
          authToken: finalToken,
          updatedAt: now
        };
        currentTargets[existingIdx] = savedTarget;
      } else {
        if (currentTargets.length >= 10) {
          return c.json({ error: "外部存储目标已达到上限（最多 10 个）" }, 400);
        }
        targetId = "ext-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
        savedTarget = {
          id: targetId,
          name,
          provider,
          enabled,
          syncScopes,
          storageRole,
          overflowThresholdRows,
          endpointUrl,
          databaseId,
          authToken: rawAuthToken || undefined,
          createdAt: now,
          updatedAt: now,
          lastTestAt: null,
          lastTestOk: null,
          lastTestMsg: null
        };
        currentTargets.push(savedTarget);
      }

      await saveExternalTargetsRaw(c.env.BUCKET, currentTargets, { expectedUpdatedAt });

      return c.json({
        ok: true,
        target: maskTargetForClient(savedTarget),
        targets: currentTargets.map(maskTargetForClient)
      });
    });
  } catch (err) {
    if (err instanceof ExternalTargetsConflictError) {
      return c.json({ error: err.message, conflict: true }, 409);
    }
    throw err;
  }
});

/**
 * 删除外部存储目标
 */
authRoutes.post("/external-targets/delete", async c => {
  if (!(await authorizeWrite(c)).ok) {
    return denyWrite(c, "操作密码错误或未填写，请先在设置页输入操作密码");
  }

  const body = await c.req.json().catch(() => null) as { id?: string } | null;
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!id) {
    return c.json({ error: "缺少目标 ID" }, 400);
  }

  try {
    return await runWithExternalTargetsCas(c.env.BUCKET, async (currentTargets, expectedUpdatedAt) => {
      const remaining = currentTargets.filter(t => t.id !== id);
      await saveExternalTargetsRaw(c.env.BUCKET, remaining, { expectedUpdatedAt });

      return c.json({
        ok: true,
        targets: remaining.map(maskTargetForClient)
      });
    });
  } catch (err) {
    if (err instanceof ExternalTargetsConflictError) {
      return c.json({ error: err.message, conflict: true }, 409);
    }
    throw err;
  }
});

/**
 * 真实连通性探测
 */
authRoutes.post("/external-targets/test", async c => {
  if (!(await authorizeWrite(c)).ok) {
    return denyWrite(c, "操作密码错误或未填写，请先在设置页输入操作密码");
  }

  const body = await c.req.json().catch(() => null) as {
    id?: string;
    provider?: ExternalProviderType;
    endpointUrl?: string;
    databaseId?: string;
    authToken?: string;
  } | null;

  if (!body || typeof body !== "object") {
    return c.json({ error: "请求格式错误" }, 400);
  }

  const currentTargets = await getExternalTargetsRaw(c.env.BUCKET);
  let targetId = typeof body.id === "string" ? body.id.trim() : "";
  const existing = targetId ? currentTargets.find(t => t.id === targetId) : undefined;

  let provider = body.provider || existing?.provider;
  let endpointUrl = typeof body.endpointUrl === "string" ? body.endpointUrl.trim() : (existing?.endpointUrl || "");
  let databaseId = typeof body.databaseId === "string" ? body.databaseId.trim() : (existing?.databaseId || "");
  let authToken = typeof body.authToken === "string" && body.authToken.trim()
    ? body.authToken.trim()
    : (existing?.authToken || "");

  if (provider === "cloudflare_d1" && !endpointUrl) {
    endpointUrl = "https://api.cloudflare.com";
  }

  if (!provider || !VALID_PROVIDERS.has(provider)) {
    return c.json({ ok: false, message: "请选择合法的外部存储类型" }, 400);
  }
  if (!endpointUrl || (!endpointUrl.startsWith("http://") && !endpointUrl.startsWith("https://"))) {
    return c.json({ ok: false, message: "连接地址必须是合法的 http:// 或 https:// URL" }, 400);
  }

  // SSRF 防护：生产环境拦截内网/回环地址与云元数据地址；本地开发允许 127.0.0.1 联调 mock 服务
  const urlError = validateExternalTargetUrl(c, endpointUrl);
  if (urlError) {
    return c.json({ ok: false, message: urlError }, 400);
  }

  const startTime = Date.now();
  let testOk = false;
  let testMsg = "";

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    if (provider === "turso") {
      const pingUrl = `${endpointUrl.replace(/\/+$/, "")}/v2/pipeline`;
      const res = await fetch(pingUrl, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
        },
        body: JSON.stringify({
          requests: [
            { type: "execute", stmt: { sql: "SELECT 1" } },
            { type: "close" }
          ]
        }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.ok) {
        const json = await res.json().catch(() => null) as any;
        const sqlErr = Array.isArray(json?.results) ? json.results.find((r: any) => r?.type === "error") : null;
        if (sqlErr) {
          testOk = false;
          testMsg = `Turso SQL 错误: ${JSON.stringify(sqlErr.error ?? sqlErr).slice(0, 120)}`;
        } else {
          testOk = true;
          testMsg = `Turso HTTP 探测成功 (${res.status} OK)`;
        }
      } else {
        const text = await res.text().catch(() => "");
        testOk = false;
        testMsg = `Turso 响应异常: ${res.status} ${text.slice(0, 100)}`;
      }
    } else if (provider === "cloudflare_d1") {
      const parts = databaseId.includes("/") ? databaseId.split("/") : databaseId.split(":");
      const accId = parts[0]?.trim();
      const dbId = parts[1]?.trim();
      if (!accId || !dbId) {
        clearTimeout(timer);
        testOk = false;
        testMsg = "请按 AccountID/DatabaseID 格式填写数据库标识";
      } else {
        const d1Base = (endpointUrl || "https://api.cloudflare.com")
          .replace(/\/+$/, "")
          .replace(/\/client\/v4$/i, "");
        const d1Url = `${d1Base}/client/v4/accounts/${accId}/d1/database/${dbId}/query`;
        const res = await fetch(d1Url, {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/json",
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {})
          },
          body: JSON.stringify({ sql: "SELECT 1" }),
          signal: controller.signal
        });
        clearTimeout(timer);
        if (res.ok) {
          const json = await res.json().catch(() => null) as any;
          if (json?.success !== false) {
            testOk = true;
            testMsg = `Cloudflare D1 探测成功 (${res.status} OK)`;
          } else {
            testOk = false;
            testMsg = `Cloudflare D1 错误: ${JSON.stringify(json?.errors || json)}`;
          }
        } else {
          const text = await res.text().catch(() => "");
          testOk = false;
          testMsg = `Cloudflare API 响应异常: ${res.status} ${text.slice(0, 100)}`;
        }
      }
    } else if (provider === "supabase") {
      const supaUrl = `${endpointUrl.replace(/\/+$/, "")}/rest/v1/`;
      const res = await fetch(supaUrl, {
        method: "GET",
        redirect: "manual",
        headers: {
          ...(authToken ? { apikey: authToken, Authorization: `Bearer ${authToken}` } : {})
        },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.ok) {
        testOk = true;
        testMsg = `Supabase REST API 探测成功 (${res.status} OK)`;
      } else {
        const text = await res.text().catch(() => "");
        testOk = false;
        testMsg = `Supabase 响应异常: ${res.status} ${text.slice(0, 100)}`;
      }
    } else {
      // s3_r2 或 webhook
      const reqHeaders: Record<string, string> = {};
      if (authToken) reqHeaders.Authorization = `Bearer ${authToken}`;

      let res = await fetch(endpointUrl, {
        method: "GET",
        redirect: "manual",
        headers: reqHeaders,
        signal: controller.signal
      }).catch(() => null);

      if (!res) {
        // 重试 HEAD
        res = await fetch(endpointUrl, {
          method: "HEAD",
          redirect: "manual",
          headers: reqHeaders,
          signal: controller.signal
        }).catch(() => null);
      }
      clearTimeout(timer);

      if (res && res.ok) {
        testOk = true;
        testMsg = `HTTP 连通成功 (响应码 ${res.status})`;
      } else if (res && res.status >= 300 && res.status < 400) {
        testOk = false;
        testMsg = `目标返回重定向 (HTTP ${res.status})，出于安全策略已禁止自动跟随`;
      } else if (res && res.status < 500) {
        testOk = false;
        testMsg = `目标返回客户端错误 (HTTP ${res.status})`;
      } else if (res) {
        testOk = false;
        testMsg = `目标返回服务器错误 (HTTP ${res.status})`;
      } else {
        testOk = false;
        testMsg = "无法连接到目标服务，请检查网络或地址";
      }
    }
  } catch (err: any) {
    testOk = false;
    testMsg = err?.name === "AbortError" ? "连接超时（>8秒）" : `连接失败: ${String(err?.message || err).slice(0, 100)}`;
  }

  const latencyMs = Date.now() - startTime;
  const now = new Date().toISOString();

  let updatedTarget: ExternalStorageTarget | undefined;
  if (targetId) {
    // 目标服务的错误响应可能回显 Authorization；落库前抹掉 token，避免 GET 列表二次泄漏
    const safeMsg = authToken ? testMsg.split(authToken).join("***") : testMsg;
    try {
      updatedTarget = await runWithExternalTargetsCas(c.env.BUCKET, async (latestTargets, expectedUpdatedAt) => {
        const latestExisting = latestTargets.find(t => t.id === targetId);
        // 若探测期间该目标已被删除，跳过写回、不复活已删目标
        if (!latestExisting) return undefined;
        latestExisting.lastTestAt = now;
        latestExisting.lastTestOk = testOk;
        latestExisting.lastTestMsg = `${safeMsg} (${latencyMs}ms)`;
        await saveExternalTargetsRaw(c.env.BUCKET, latestTargets, { expectedUpdatedAt });
        return latestExisting;
      });
    } catch (err) {
      if (err instanceof ExternalTargetsConflictError) {
        return c.json({ error: err.message, conflict: true }, 409);
      }
      throw err;
    }
  }

  return c.json({
    ok: testOk,
    latencyMs,
    message: testMsg,
    target: updatedTarget ? maskTargetForClient(updatedTarget) : undefined
  });
});
