/**
 * 知乎 API 统一请求入口。
 *
 * 背景：知乎在账号级风控下会对列表/评论接口返回 403/429/5xx、200+空页，
 * 甚至 200+HTML（res.json() 直接抛错）。旧代码只 count++ 然后 break，
 * 下一轮 run 继续撞墙。这里集中做「暂停 + 重试」：
 * - 401：登录态失效，暂停无意义，立刻失败（计入 authRejected）。
 * - 403/429/5xx / 200 空页且 paging.is_end !== true / 200 非 JSON：
 *   优先读 Retry-After（秒，封顶 120s），否则默认 60s，±10% 抖动；
 *   同一请求最多重试 2 次。
 * - 整个 run 累计暂停不超过 15 分钟；预算用尽即置 riskExhausted。
 * - 某请求重试耗尽仍被拒：置 riskExhausted，调用方所有循环应检测该标志
 *   直接结束，避免 60s × N × 几十个答主。
 *
 * 注意：本模块只负责单次请求的等待与重试；offset / nextUrl / 云端游标
 * 只在请求成功返回后由调用方推进，因此重试期间不会前移任何游标。
 */

export interface ZhihuRiskStats {
    /** 401/403 次数（403 在重试耗尽后计一次） */
    authRejected: number;
    /** 200 空页且 paging.is_end !== true 的次数（重试耗尽后计一次） */
    riskEmpty: number;
    /** 知乎侧其他请求失败（429/5xx/非 JSON/网络错误/非 401-403 的 4xx） */
    zhihuRejected: number;
    /** 连续重试耗尽次数：中间只要有一次 zhihuJson 成功就清零 */
    riskFailStreak: number;
    /** 本轮已因风控重试耗尽而终止后续知乎请求 */
    riskExhausted: boolean;
    /** 当前是否处于风控暂停中（观测用） */
    riskPaused: boolean;
    /** 本 run 累计暂停毫秒数 */
    riskPauseMs: number;
}

export type ZhihuFailureKind = "auth" | "risk" | "http" | "network" | "parse";

export class ZhihuRequestError extends Error {
    readonly status: number;
    readonly kind: ZhihuFailureKind;

    constructor(message: string, status: number, kind: ZhihuFailureKind) {
        super(message);
        this.name = "ZhihuRequestError";
        this.status = status;
        this.kind = kind;
    }
}

/** Playwright APIResponse 的最小结构，便于用假 response 自测 */
export interface ZhihuResponseLike {
    status(): number;
    ok(): boolean;
    json(): Promise<unknown>;
    text(): Promise<string>;
    headers?(): Record<string, string>;
    headerValue?(name: string): string | null;
}

/** Playwright BrowserContext 的最小结构（只用到带 cookie 的 request.get） */
export interface ZhihuContextLike {
    request: {
        get(url: string): Promise<ZhihuResponseLike>;
    };
}

export interface ZhihuJsonOptions {
    /** 日志里的接口名，例如「我的回答列表」「收藏夹 xxx 条目」 */
    label?: string;
    /** false 时不计入 stats（默认 true；知乎请求一般都应计数） */
    countStats?: boolean;
    /** 最多重试次数，默认 2（即最多发 3 次请求） */
    maxRetries?: number;
    /**
     * true 时 404 视为「资源不存在」的正常结果：仍抛 ZhihuRequestError，
     * 但不计入 stats.zhihuRejected。用于个别文章关闭评论/被删等场景，
     * 避免单篇 404 污染整轮风控计数（误判为 partial_risk_controlled）。
     */
    allow404?: boolean;
}

export interface ZhihuFetchDeps {
    /** 可注入的 sleep，便于自测不真的等 60 秒 */
    sleep?: (ms: number) => Promise<void>;
    /** 可注入的随机数源（0~1） */
    random?: () => number;
    /** 日志输出，默认 console.warn */
    log?: (message: string) => void;
}

export const ZHIHU_PAUSE_DEFAULT_MS = 60_000;
export const ZHIHU_PAUSE_MAX_MS = 120_000;
export const ZHIHU_PAUSE_BUDGET_MS = 15 * 60_000;
export const ZHIHU_MAX_RETRIES = 2;

const DEFAULT_MAX_RETRIES = ZHIHU_MAX_RETRIES;

function isRetryableStatus(status: number): boolean {
    return status === 403 || status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * 200 + data 为空 + 明确存在 paging 且 is_end 不为 true：知乎风控空页的典型形态。
 * 没有 paging 字段的 `{data: []}` 视为合法空结果（例如空收藏夹/新账号），不重试。
 */
function isEmptyRiskPage(json: unknown): boolean {
    if (!json || typeof json !== "object") return false;
    const rec = json as { data?: unknown; paging?: unknown };
    if (!Array.isArray(rec.data) || rec.data.length !== 0) return false;
    if (!rec.paging || typeof rec.paging !== "object") return false;
    return (rec.paging as { is_end?: unknown }).is_end !== true;
}

function readHeader(res: ZhihuResponseLike, name: string): string | null {
    try {
        if (typeof res.headers === "function") {
            const headers = res.headers();
            if (headers) {
                const value = headers[name] ?? headers[name.toLowerCase()];
                if (typeof value === "string" && value) return value;
            }
        }
    } catch {
        /* 读 header 失败按没有处理 */
    }
    try {
        if (typeof res.headerValue === "function") {
            const value = res.headerValue(name);
            if (typeof value === "string" && value) return value;
        }
    } catch {
        /* 同上 */
    }
    return null;
}

/** Retry-After 支持秒数与 HTTP 日期两种格式；统一封顶 120s */
function readRetryAfterMs(res: ZhihuResponseLike): number | null {
    const raw = readHeader(res, "retry-after");
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(Math.round(seconds * 1000), ZHIHU_PAUSE_MAX_MS);
    }
    const at = Date.parse(trimmed);
    if (!Number.isNaN(at)) {
        return Math.min(Math.max(0, at - Date.now()), ZHIHU_PAUSE_MAX_MS);
    }
    return null;
}

/** 默认 60s，±10% 抖动，避免同账号多个 actor 同一秒重试再次撞限流 */
function computePauseMs(retryAfterMs: number | null, random: () => number): number {
    const base = retryAfterMs !== null && Number.isFinite(retryAfterMs) ? retryAfterMs : ZHIHU_PAUSE_DEFAULT_MS;
    const jittered = base * (1 - 0.1 + random() * 0.2);
    return Math.max(1_000, Math.min(ZHIHU_PAUSE_MAX_MS, Math.round(jittered)));
}

function safeText(value: unknown): string {
    return String(value ?? "")
        .replace(/[\r\n\t]+/g, " ")
        .slice(0, 180);
}

export function createZhihuJson(stats: ZhihuRiskStats, deps: ZhihuFetchDeps = {}) {
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const random = deps.random ?? Math.random;
    const log = deps.log ?? ((message: string) => console.warn(message));

    function pauseForRisk(
        label: string,
        attemptNo: number,
        retryAfterMs: number | null,
        reason: string
    ): Promise<boolean> {
        const desired = computePauseMs(retryAfterMs, random);
        const remaining = ZHIHU_PAUSE_BUDGET_MS - stats.riskPauseMs;
        if (remaining <= 0) {
            stats.riskExhausted = true;
            log(
                `⚠️ [${label}] 风控暂停预算已用尽（累计 ${Math.round(stats.riskPauseMs / 1000)} 秒），不再暂停: ${reason}`
            );
            return Promise.resolve(false);
        }
        const delay = Math.max(0, Math.min(desired, remaining));
        const cumulativeMs = stats.riskPauseMs + delay;
        log(
            `⚠️ [${label}] 风控暂停 ${Math.round(delay / 1000)}s（第 ${attemptNo} 次重试，累计 ${Math.round(
                cumulativeMs / 1000
            )} 秒）: ${reason}`
        );
        stats.riskPaused = true;
        return sleep(delay).then(
            () => {
                stats.riskPaused = false;
                stats.riskPauseMs += delay;
                return true;
            },
            (err) => {
                stats.riskPaused = false;
                stats.riskPauseMs += delay;
                throw err;
            }
        );
    }

    function recordFailure(
        kind: ZhihuFailureKind,
        status: number,
        _label: string,
        message: string,
        exhausted: boolean,
        countStats: boolean
    ): ZhihuRequestError {
        if (countStats) {
            if (kind === "auth") stats.authRejected++;
            else if (kind === "risk") stats.riskEmpty++;
            else stats.zhihuRejected++;
        }
        if (exhausted) {
            stats.riskFailStreak++;
            // 401 是账号级登录态失效，立即终止；其他 403/429/5xx/空页/非 JSON
            // 可能只是单个答主/单条内容被封禁或私密，必须连续 3 个不同请求都耗尽
            // 才判定为账号级风控，避免一个异常对象让整轮白暂停后提前结束
            if ((kind === "auth" && status === 401) || stats.riskFailStreak >= 3) {
                stats.riskExhausted = true;
            }
        }
        return new ZhihuRequestError(message, status, kind);
    }

    async function zhihuJson(
        context: ZhihuContextLike,
        url: string,
        opts: ZhihuJsonOptions = {}
    ): Promise<{ json: any; status: number }> {
        const label = opts.label || "知乎请求";
        const countStats = opts.countStats !== false;
        const maxRetries =
            Number.isFinite(opts.maxRetries) && (opts.maxRetries as number) >= 0
                ? Math.floor(opts.maxRetries as number)
                : DEFAULT_MAX_RETRIES;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const isLastAttempt = attempt >= maxRetries;

            let res: ZhihuResponseLike;
            try {
                res = await context.request.get(url);
            } catch (e: any) {
                const reason = `网络错误: ${safeText(e?.message ?? e)}`;
                if (!isLastAttempt) {
                    const paused = await pauseForRisk(label, attempt + 1, null, reason);
                    if (paused) continue;
                }
                throw recordFailure(
                    "network",
                    0,
                    label,
                    `知乎请求网络错误 (${label})${isLastAttempt ? `（已重试 ${attempt} 次仍失败）` : ""}: ${reason}`,
                    false,
                    countStats
                );
            }

            const status = res.status();

            // 401 是 cookie 失效，不是限流；暂停重试没有意义，直接终止本轮
            if (status === 401) {
                throw recordFailure(
                    "auth",
                    401,
                    label,
                    `知乎登录态失效 (${label}): HTTP 401，cookie 可能已过期，暂停重试无意义`,
                    true,
                    countStats
                );
            }

            if (status >= 200 && status < 300) {
                let json: unknown;
                try {
                    json = await res.json();
                } catch (e: any) {
                    const reason = `HTTP 200 响应不是 JSON（疑似风控 HTML 页）: ${safeText(e?.message ?? e)}`;
                    if (!isLastAttempt) {
                        const paused = await pauseForRisk(label, attempt + 1, readRetryAfterMs(res), reason);
                        if (paused) continue;
                    }
                    throw recordFailure(
                        "parse",
                        status,
                        label,
                        `知乎返回非 JSON (${label})（已重试 ${attempt} 次仍失败）: ${reason}`,
                        true,
                        countStats
                    );
                }

                if (isEmptyRiskPage(json)) {
                    const reason = "data 为空且 paging.is_end !== true（疑似风控空页）";
                    if (!isLastAttempt) {
                        const paused = await pauseForRisk(label, attempt + 1, readRetryAfterMs(res), reason);
                        if (paused) continue;
                    }
                    throw recordFailure(
                        "risk",
                        status,
                        label,
                        `知乎风控空页 (${label})（已重试 ${attempt} 次仍失败）: ${reason}`,
                        true,
                        countStats
                    );
                }

                // 防御：合法响应必须是对象（null/数组等按非 JSON 处理，避免调用方 json.data 崩掉）
                if (!json || typeof json !== "object") {
                    const reason = "HTTP 200 响应不是对象";
                    if (!isLastAttempt) {
                        const paused = await pauseForRisk(label, attempt + 1, readRetryAfterMs(res), reason);
                        if (paused) continue;
                    }
                    throw recordFailure(
                        "parse",
                        status,
                        label,
                        `知乎返回异常响应 (${label})（已重试 ${attempt} 次仍失败）: ${reason}`,
                        true,
                        countStats
                    );
                }

                // 任何成功返回（含合法空页/无 paging 的空列表）都清除连续失败计数
                stats.riskFailStreak = 0;
                return { json, status };
            }

            // 非 2xx：先取响应体摘要，便于日志区分 429/5xx 与 400/404
            let detail = "";
            try {
                detail = safeText(await res.text());
            } catch {
                /* 读 body 失败不影响主流程 */
            }

            // 知乎对「评论已关闭 / 内容已删除或无权查看评论」会返回 HTTP 403（如 code=106 "评论已关闭"）：
            // 这是业务态无评论，不是账号风控，绝不能暂停 60s 重试，也不计入 authRejected / riskFailStreak
            if (status === 403 && /评论已关闭|"code"\s*:\s*106\b|评论功能已关闭|暂时无法查看评论/.test(detail)) {
                throw recordFailure(
                    "http",
                    status,
                    label,
                    `知乎内容已关闭评论 (${label}): HTTP 403 ${detail}`,
                    false,
                    false
                );
            }

            if (isRetryableStatus(status)) {
                const reason = `HTTP ${status}${detail ? `: ${detail}` : ""}`;
                if (!isLastAttempt) {
                    const paused = await pauseForRisk(label, attempt + 1, readRetryAfterMs(res), reason);
                    if (paused) continue;
                }
                if (status === 403) {
                    throw recordFailure(
                        "auth",
                        status,
                        label,
                        `知乎拒绝访问 (${label}): HTTP 403（已重试 ${attempt} 次仍失败）${detail ? ` ${detail}` : ""}`,
                        true,
                        countStats
                    );
                }
                throw recordFailure(
                    "http",
                    status,
                    label,
                    `知乎限流/服务端错误 (${label}): HTTP ${status}（已重试 ${attempt} 次仍失败）${
                        detail ? ` ${detail}` : ""
                    }`,
                    true,
                    countStats
                );
            }

            // 400/404/410 等：游标失效或参数错误，重试无意义；计入知乎侧失败但不终止全轮。
            // allow404：单篇内容关闭评论/被删时返回 404 属正常业务结果，不污染风控计数。
            throw recordFailure(
                "http",
                status,
                label,
                `知乎请求失败 (${label}): HTTP ${status}${detail ? ` ${detail}` : ""}`,
                false,
                status === 404 && opts.allow404 === true ? false : countStats
            );
        }

        // 理论不可达：循环内每个分支都会 return/throw
        stats.riskExhausted = true;
        throw new ZhihuRequestError(`知乎请求失败 (${label}): 重试次数已用尽`, 0, "http");
    }

    return zhihuJson;
}
