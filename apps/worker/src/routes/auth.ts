import { Hono } from "hono";
import { db } from "../db.js";
import type { Bindings } from "../types.js";

export const authRoutes = new Hono<{ Bindings: Bindings }>();

const COOKIE_KEY = "zhihu_cookie";

function isValidCookieString(s: string): boolean {
  // 至少要带登录态 z_c0，否则存进去也是无效的
  return /(?:^|;\s*)z_c0=[^;]+/.test(s);
}

/**
 * 写入凭据的鉴权策略（刻意做成"默认开放，可一键收紧"）：
 *
 * - 配了 `COOKIE_WRITE_TOKEN`：必须带该 token，或带 `API_SECRET`（脚本用）
 * - 没配 `COOKIE_WRITE_TOKEN`：网页可以直接提交
 *
 * 为什么默认开放：cookie 失效是低频但必须立刻处理的事，
 * 如果每次都要去 Cloudflare 后台或终端敲 secret，这个功能就没有意义了。
 *
 * 代价：任何知道 Worker 域名的人都能覆盖你库里的 cookie。
 * 介意的话执行 `npx wrangler secret put COOKIE_WRITE_TOKEN`，前端会提示你填一次。
 */
function authorizeWrite(c: any): { ok: boolean } {
  const apiSecret = c.env.API_SECRET;
  const writeToken = c.env.COOKIE_WRITE_TOKEN;
  const auth = c.req.header("authorization") || "";

  if (apiSecret && auth === `Bearer ${apiSecret}`) return { ok: true };

  if (writeToken) {
    return { ok: auth === `Bearer ${writeToken}` };
  }

  // 没有配置写入口令 → 开放
  return { ok: true };
}

/**
 * 保存 cookie。
 * 唯一入口是网页表单；带 API_SECRET 的脚本调用也兼容，但项目里已不再提供扫码脚本。
 */
authRoutes.post("/zhihu-cookie", async c => {
  if (!authorizeWrite(c).ok) {
    return c.json({ error: "Unauthorized", needToken: true }, 401);
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
 * 查 Apify 最后一次 run 的状态，带 60 秒 D1 缓存。
 * 用来回答一个关键问题：cookie 到底还有没有用。
 * Apify run 因为 cookie 失效而失败时，页面就能立刻看出来，而不是等数据不更新才发现。
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
 * 登录状态。永远不返回 cookie 明文。
 */
authRoutes.get("/zhihu-status", async c => {
  let row: { value: string; updated_at: string } | null = null;
  try {
    row = await db.prepare(
      `SELECT value, updated_at FROM app_settings WHERE key = ?`
    ).get(COOKIE_KEY) as any;
  } catch (e) {
    // migration 0001 还没 apply 时会走到这里；回落到 env
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

  return c.json({
    hasCookie: !!value,
    source,
    updatedAt,
    ageHours,
    cookieCount: value ? value.split(";").filter(s => s.trim()).length : 0,
    hasZC0: isValidCookieString(value),
    // 告诉前端这个部署是否要求写入口令
    writeTokenRequired: !!c.env.COOKIE_WRITE_TOKEN,
    // 上一次 Apify run 的状态：失败通常意味着 cookie 已失效
    lastRun: await getLastApifyRun(c)
  });
});

/**
 * 清除 D1 里存的 cookie（env 里的不受影响）。
 */
authRoutes.post("/zhihu-cookie/clear", async c => {
  if (!authorizeWrite(c).ok) {
    return c.json({ error: "Unauthorized", needToken: true }, 401);
  }
  await db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(COOKIE_KEY);
  return c.json({ ok: true });
});
