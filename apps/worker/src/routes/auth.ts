import { Hono } from "hono";
import { db } from "../db.js";
import type { Bindings } from "../types.js";

export const authRoutes = new Hono<{ Bindings: Bindings }>();

const COOKIE_KEY = "zhihu_cookie";
const WRITE_TOKEN_KEY = "cookie_write_token";
const SYNC_CONFIG_KEY = "sync_config";
const R2_SYNC_CONFIG_KEY = "meta/sync_config.json";

export type CommentSyncMode = "full" | "hot" | "none";
export type SyncConfig = {
  commentsMyAnswers: CommentSyncMode;
  commentsCollections: CommentSyncMode;
  commentsUpvotes: CommentSyncMode;
  commentsFollowing: CommentSyncMode;
  followingSensitivity: "strict" | "standard" | "relaxed";
  preferredAiModel: string;
  updatedAt?: string | null;
};

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  commentsMyAnswers: "full",
  // 收藏内容按用户要求默认全量抓评论；赞同基数太大（2.9 万条），默认只抓热门前 20 条 + 楼中楼
  commentsCollections: "full",
  commentsUpvotes: "hot",
  commentsFollowing: "hot",
  followingSensitivity: "standard",
  preferredAiModel: "@cf/qwen/qwen3-30b-a3b-fp8",
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

  const merged = {
    ...DEFAULT_SYNC_CONFIG,
    ...(d1Cfg || {}),
    ...(r2Cfg || {})
  };
  return {
    commentsMyAnswers: VALID_COMMENT_MODES.has(merged.commentsMyAnswers as CommentSyncMode) ? (merged.commentsMyAnswers as CommentSyncMode) : "full",
    commentsCollections: VALID_COMMENT_MODES.has(merged.commentsCollections as CommentSyncMode) ? (merged.commentsCollections as CommentSyncMode) : "hot",
    commentsUpvotes: VALID_COMMENT_MODES.has(merged.commentsUpvotes as CommentSyncMode) ? (merged.commentsUpvotes as CommentSyncMode) : "hot",
    commentsFollowing: VALID_COMMENT_MODES.has(merged.commentsFollowing as CommentSyncMode) ? (merged.commentsFollowing as CommentSyncMode) : "hot",
    followingSensitivity: VALID_SENSITIVITY.has(merged.followingSensitivity) ? merged.followingSensitivity : "standard",
    preferredAiModel: VALID_AI_MODELS.has(merged.preferredAiModel) ? merged.preferredAiModel : "@cf/qwen/qwen3-30b-a3b-fp8",
    updatedAt: merged.updatedAt || null
  };
}

export async function saveSyncConfig(bucket: any, patch: Partial<SyncConfig>): Promise<SyncConfig> {
  const current = await getSyncConfig(bucket);
  const now = new Date().toISOString();
  const next: SyncConfig = {
    commentsMyAnswers: VALID_COMMENT_MODES.has(patch.commentsMyAnswers as CommentSyncMode) ? (patch.commentsMyAnswers as CommentSyncMode) : current.commentsMyAnswers,
    commentsCollections: VALID_COMMENT_MODES.has(patch.commentsCollections as CommentSyncMode) ? (patch.commentsCollections as CommentSyncMode) : current.commentsCollections,
    commentsUpvotes: VALID_COMMENT_MODES.has(patch.commentsUpvotes as CommentSyncMode) ? (patch.commentsUpvotes as CommentSyncMode) : current.commentsUpvotes,
    commentsFollowing: VALID_COMMENT_MODES.has(patch.commentsFollowing as CommentSyncMode) ? (patch.commentsFollowing as CommentSyncMode) : current.commentsFollowing,
    followingSensitivity: VALID_SENSITIVITY.has(patch.followingSensitivity as string) ? (patch.followingSensitivity as any) : current.followingSensitivity,
    preferredAiModel: VALID_AI_MODELS.has(patch.preferredAiModel as string) ? (patch.preferredAiModel as string) : current.preferredAiModel,
    updatedAt: now
  };

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

  return next;
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
  try {
    const row = await db.prepare(
      `SELECT value FROM app_settings WHERE key = ?`
    ).get<{ value: string }>(WRITE_TOKEN_KEY);
    if (row?.value && row.value.trim()) {
      return { token: row.value.trim(), source: "db" };
    }
  } catch {
    // 忽略表未就绪
  }
  const envToken = String(c.env.COOKIE_WRITE_TOKEN || "").trim();
  if (envToken) return { token: envToken, source: "env" };
  const apiSecret = String(c.env.API_SECRET || "").trim();
  if (apiSecret) return { token: apiSecret, source: "api_secret" };
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
 * - 连 API_SECRET 都没配的空环境直接拒绝，绝不默认放行。
 */
export async function authorizeWrite(c: any): Promise<{ ok: boolean }> {
  const apiSecret = c.env.API_SECRET;
  const auth = c.req.header("authorization") || "";

  if (!auth.startsWith("Bearer ")) return { ok: false };

  // 带了 Origin 才校验白名单；无 Origin 的脚本/CLI 仍可用 Bearer 调用
  if (c.req.header("origin") && !isOriginAllowed(c, true)) return { ok: false };

  if (apiSecret && auth === `Bearer ${apiSecret}`) return { ok: true };

  const writeToken = await getActiveWriteToken(c);
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
  const token = await getActiveWriteToken(c);
  return c.json({ error: token ? fallback : NO_WRITE_TOKEN_HINT, needToken: true }, 401);
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

  const activeToken = await getActiveWriteToken(c);
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

  const activeTokenInfo = await getActiveWriteTokenInfo(c);
  const syncConfig = await getSyncConfig(c.env.BUCKET);
  let upvotesCursor: string | null = null;
  try {
    const cRow = await db.prepare(`SELECT value FROM app_settings WHERE key = 'upvotes_cursor'`).get<{ value: string }>();
    if (cRow?.value) upvotesCursor = cRow.value;
  } catch { /* ignore */ }

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
    syncConfig,
    upvotesCursor
  });
});

/**
 * 读取与更新全局同步与评论抓取策略设置
 */
authRoutes.get("/settings", async c => {
  const syncConfig = await getSyncConfig(c.env.BUCKET);
  return c.json({ ok: true, syncConfig });
});

authRoutes.post("/settings", async c => {
  if (!(await authorizeWrite(c)).ok) {
    return denyWrite(c, "操作密码错误或未填写，请先在设置页输入操作密码");
  }
  const body = await c.req.json().catch(() => null) as Partial<SyncConfig> | null;
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid body" }, 400);
  }
  const saved = await saveSyncConfig(c.env.BUCKET, body);
  return c.json({ ok: true, syncConfig: saved });
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
