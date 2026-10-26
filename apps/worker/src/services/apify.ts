import type { Bindings } from "../types.js";

/**
 * 取知乎 cookie：优先用扫码登录存进 D1 的那份，回落到环境变量。
 * 这样换了 cookie 不用重新 deploy。
 */
async function readZhihuCookie(env: Bindings): Promise<string> {
  try {
    const row = await env.DB.prepare(
      `SELECT value FROM app_settings WHERE key = ?`
    ).bind("zhihu_cookie").first() as any;
    if (row?.value) return row.value;
  } catch (e) {
    // migration 0001 未 apply 时会走到这里，静默回落到 env
    console.error("read zhihu_cookie from D1 failed:", e);
  }
  return env.ZHIHU_COOKIE_STRING || env.ZHIHU_COOKIE_Z_C0 || "";
}

export type TriggerResult = { ok: boolean; runId?: string; error?: string };

/**
 * 触发一次 Apify Actor run。
 * 所有前置校验集中在这里，避免"缺配置 → Actor 全 401 → 却记成功"的静默失败。
 */
export async function triggerApifyRun(
  env: Bindings,
  runType: string,
  isFast: boolean
): Promise<TriggerResult> {
  // API_SECRET 缺失时必须提前拒绝：否则 Actor 拿不到 apiSecret，
  // 回传全部 503，而 sync_runs 还会记成功。
  if (!env.API_SECRET) {
    return { ok: false, error: "API_SECRET not configured" };
  }
  if (!env.APIFY_TOKEN || !env.APIFY_ACTOR_ID) {
    return { ok: false, error: "APIFY_TOKEN / APIFY_ACTOR_ID not configured" };
  }

  const cookieStr = await readZhihuCookie(env);
  if (!cookieStr) {
    return { ok: false, error: "知乎 cookie 未配置：请先扫码登录" };
  }

  const apiUrl = env.WORKER_URL;
  if (!apiUrl || apiUrl.includes("example.workers.dev")) {
    // host.docker.internal 在云端 Actor 里不可达，必须是真实公网地址
    return { ok: false, error: "WORKER_URL is not configured with a public workers.dev URL" };
  }

  // 占位符/空值会让三段抓取全部 404 并静默空跑（run 显示成功、零数据入库）
  const zhihuUser = env.ZHIHU_USERNAME || "";
  if (!zhihuUser || zhihuUser === "your_zhihu_token") {
    return { ok: false, error: "ZHIHU_USERNAME is not configured" };
  }

  const payload = {
    runType,
    isFast,
    apiUrl,
    // Actor 的 INPUT_SCHEMA 必须声明 apiSecret，否则 Apify 会剥掉该字段
    apiSecret: env.API_SECRET,
    zhihuUsername: zhihuUser,
    cookieString: cookieStr
  };

  let res: Response;
  try {
    // timeout=12h：默认 1 小时在首次全量（数千回答/赞同的老账号）不够用。
    // 实测赞同段 ~1.65s/条且每次 run 从头翻页（重复段必须先过一遍），
    // 4h 只能推进 ~8700 条、进度会被重复成本卡死；12h 一次翻到底
    res = await fetch(
      `https://api.apify.com/v2/acts/${env.APIFY_ACTOR_ID}/runs?token=${env.APIFY_TOKEN}&timeout=43200`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }
    );
  } catch (e: any) {
    return { ok: false, error: `network error: ${e?.message || String(e)}` };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("Failed to trigger Apify", res.status, text);
    return { ok: false, error: `Failed to trigger Apify: ${res.status} ${text.slice(0, 200)}` };
  }

  const json = await res.json() as any;
  return { ok: true, runId: json.data?.id };
}
