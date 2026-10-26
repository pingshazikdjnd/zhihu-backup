import { Hono } from "hono";
import { db } from "../db.js";
import type { Bindings } from "../types.js";

export const authRoutes = new Hono<{ Bindings: Bindings }>();

const COOKIE_KEY = "zhihu_cookie";
const WRITE_TOKEN_KEY = "cookie_write_token";

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
 * 读取当前生效的凭据页写入口令：优先读 D1 app_settings 中的在线设置值，回退到环境变量 COOKIE_WRITE_TOKEN。
 */
export async function getActiveWriteToken(c: any): Promise<string> {
  try {
    const row = await db.prepare(
      `SELECT value FROM app_settings WHERE key = ?`
    ).get<{ value: string }>(WRITE_TOKEN_KEY);
    if (row?.value && row.value.trim()) {
      return row.value.trim();
    }
  } catch {
    // 忽略表未就绪
  }
  return String(c.env.COOKIE_WRITE_TOKEN || "").trim();
}

/**
 * 写入凭据的鉴权策略：
 * - 配了口令（D1 `cookie_write_token` 或环境变量 `COOKIE_WRITE_TOKEN`）：必须带该口令，或带 `API_SECRET`
 * - 没配口令：校验 Origin 白名单后允许网页直接提交
 */
export async function authorizeWrite(c: any): Promise<{ ok: boolean }> {
  const apiSecret = c.env.API_SECRET;
  const auth = c.req.header("authorization") || "";

  if (apiSecret && auth === `Bearer ${apiSecret}`) return { ok: true };
  if (!isOriginAllowed(c)) return { ok: false };

  const writeToken = await getActiveWriteToken(c);
  if (writeToken) {
    return { ok: auth === `Bearer ${writeToken}` };
  }

  return { ok: true };
}

/**
 * 保存 cookie。
 */
authRoutes.post("/zhihu-cookie", async c => {
  if (!(await authorizeWrite(c)).ok) {
    return c.json({ error: "密码错误或未填写操作密码", needToken: true }, 401);
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
 * - 若当前已有密码（D1 或环境变量 COOKIE_WRITE_TOKEN），必须先校验 currentToken 正确才允许修改
 * - 若当前未设密码，可直接设置初始密码
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

  if (activeToken && !hasApiSecret && currentInput !== activeToken) {
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
    const res = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs/last?token=${token}`);
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

  const activeToken = await getActiveWriteToken(c);

  return c.json({
    hasCookie: !!value,
    source,
    updatedAt,
    ageHours,
    cookieCount: value ? value.split(";").filter(s => s.trim()).length : 0,
    hasZC0: isValidCookieString(value),
    writeTokenRequired: Boolean(activeToken),
    lastRun: await getLastApifyRun(c)
  });
});

/**
 * 清除 D1 里存的 cookie（env 里的不受影响）。
 */
authRoutes.post("/zhihu-cookie/clear", async c => {
  if (!(await authorizeWrite(c)).ok) {
    return c.json({ error: "密码错误或未填写操作密码", needToken: true }, 401);
  }
  await db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(COOKIE_KEY);
  return c.json({ ok: true });
});
