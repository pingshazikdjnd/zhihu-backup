// 生产环境：默认走同源空 base（由 Pages _worker.js 通过 Service Binding 内部直连 Worker，
// 无论部署在 *.pages.dev 还是 Pages 自定义域名，均彻底绕开国内对 *.workers.dev 的 DNS 污染且免去 CORS 预检）；
// 除非显式设置了 VITE_API_BASE（例如独立部署在其他 CDN/静态托管需直连 Worker 时）。
// 开发环境：默认返回空 base，让 /api/* 与 <img src="/api/images/..."> 统一走 vite.config.ts
// 配置的 /api 同源代理（转发到 127.0.0.1:18787）；仅有显式配置的其它地址才原样使用。
function resolveApiBase(): string {
  const raw = import.meta.env.VITE_API_BASE || "";
  if (import.meta.env.DEV) {
    // 根 .env 遗留的 VITE_API_BASE=http://localhost:3001 已无服务监听，
    // 必须忽略并回退同源代理，避免默认启动 vite 时所有请求打向 3001。
    if (!raw || /^https?:\/\/(localhost|127\.0\.0\.1):3001\/?$/i.test(raw)) {
      return "";
    }
    return raw;
  }
  if (raw) {
    return raw;
  }
  if (import.meta.env.PROD) {
    return "";
  }
  return "";
}

const API_BASE = resolveApiBase();

const REQUEST_TIMEOUT_MS = 30_000;

// 部分老浏览器没有 AbortSignal.timeout / AbortSignal.any，统一通过这个带可选方法的类型访问，
// 避免直接调用不存在的方法导致整个 api() 抛 TypeError。
type AbortSignalStatics = typeof AbortSignal & {
  timeout?: (ms: number) => AbortSignal;
  any?: (signals: AbortSignal[]) => AbortSignal;
};

const ABORT_SIGNAL_STATICS = AbortSignal as AbortSignalStatics;

type RequestAbort = {
  signal: AbortSignal | undefined;
  cleanup: () => void;
};

// 保持历史拼接语义（API_BASE 与 path 直接相连），只去掉两者交界处的重复斜杠，
// 避免 API_BASE 末尾带 / 时生成 //api/... 被浏览器当成协议相对 URL。
function joinApiBase(base: string, path: string): string {
  if (base && path && base.endsWith("/") && path.startsWith("/")) {
    return `${base.slice(0, -1)}${path}`;
  }
  return `${base}${path}`;
}

// 目标 URL 统一交给 new URL 解析：相对 path 以页面 origin 为基准，绝对/相对 API_BASE 都能正确合并，
// 查询参数与末尾斜杠原样保留。没有 window（Node/SSR）时退回历史字符串拼接。
function resolveRequestUrl(path: string, base: string, origin?: string): string {
  const combined = joinApiBase(base, path);
  if (!origin) return combined;
  try {
    return new URL(combined, origin).href;
  } catch {
    return combined;
  }
}

// 自动附带本地口令前必须确认最终请求目标与页面同源。
// 显式配置了跨源 API_BASE、或 origin 不可解析（file:// 等）时一律不自动发口令，
// 调用方显式传入的 Authorization 不受影响（由 api() 里 headers.has 的判断保留）。
function isSameOriginRequest(path: string, base: string, origin: string): boolean {
  try {
    const target = new URL(joinApiBase(base, path), origin);
    return target.origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

// AbortSignal.timeout 需要 Chrome 103+ / Safari 16+；缺失时用 AbortController + setTimeout 降级。
// 降级路径返回 cleanup，确保请求结束后清掉定时器，不让 30 秒计时器留在后台。
function createTimeoutAbort(): RequestAbort {
  if (typeof ABORT_SIGNAL_STATICS.timeout === "function") {
    return { signal: ABORT_SIGNAL_STATICS.timeout(REQUEST_TIMEOUT_MS), cleanup: () => {} };
  }
  if (typeof AbortController !== "undefined") {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    return { signal: ctrl.signal, cleanup: () => clearTimeout(timer) };
  }
  return { signal: undefined, cleanup: () => {} };
}

// 组合调用方 signal 与超时 signal：优先 AbortSignal.any；不支持时用控制器 + once 监听器，
// cleanup 同时清定时器并移除两个监听器，避免长页面里反复请求造成监听器泄漏。
function createRequestAbort(external?: AbortSignal | null): RequestAbort {
  const timeout = createTimeoutAbort();
  if (!external) return timeout;
  if (typeof ABORT_SIGNAL_STATICS.any === "function" && timeout.signal) {
    return {
      signal: ABORT_SIGNAL_STATICS.any([external, timeout.signal]),
      cleanup: timeout.cleanup
    };
  }
  if (typeof AbortController === "undefined") {
    return { signal: external, cleanup: timeout.cleanup };
  }
  const ctrl = new AbortController();
  const timeoutSignal = timeout.signal;
  const onAbort = () => ctrl.abort();
  if (external.aborted || (timeoutSignal && timeoutSignal.aborted)) {
    ctrl.abort();
  } else {
    external.addEventListener("abort", onAbort, { once: true });
    if (timeoutSignal) timeoutSignal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    cleanup: () => {
      timeout.cleanup();
      external.removeEventListener("abort", onAbort);
      if (timeoutSignal) timeoutSignal.removeEventListener("abort", onAbort);
    }
  };
}

/**
 * 读取设置页保存的写接口口令。
 * 主 key 统一为 cookie_write_token（设置页所有写入点都用这个），
 * 早期版本曾用 zhihu_write_token，只在其为空时做兼容回退，
 * 避免两个 key 各存一份、设置页改了密码但请求仍带旧口令的双源分裂。
 * 隐私模式 / 禁用 localStorage 时读取会抛错，静默忽略即可，不能影响正常请求。
 */
function resolveWriteToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return (
      window.localStorage.getItem("cookie_write_token") ||
      window.localStorage.getItem("zhihu_write_token") ||
      ""
    );
  } catch {
    return "";
  }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  // 当 API_BASE 为空时，浏览器端会发起同源请求（例如 /api/...）。
  // 若不在浏览器环境（例如 Node/SSR/测试）或没有可用的同源环境且未配置 base，则报错。
  if (API_BASE === "" && typeof window === "undefined") {
    throw new Error("API base is empty and window is undefined (cannot make relative origin requests)");
  }

  const requestOrigin = typeof window !== "undefined" ? window.location.origin : undefined;
  const headers = new Headers(options?.headers);
  // 调用方显式传了 Authorization 就尊重调用方；否则只对同源目标自动带设置页保存的操作口令。
  // API_BASE 显式指向其他源时绝不自动外发口令，避免第三方域名拿到本地管理凭据。
  if (
    !headers.has("authorization") &&
    requestOrigin &&
    isSameOriginRequest(path, API_BASE, requestOrigin)
  ) {
    const token = resolveWriteToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
  }

  const abort = createRequestAbort(options?.signal);
  try {
    const res = await fetch(resolveRequestUrl(path, API_BASE, requestOrigin), {
      ...options,
      headers,
      // 调用方 signal 与 30 秒超时信号都要生效，任一触发都会中止请求
      signal: abort.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${res.status} ${text.slice(0, 200)}`);
    }

    // await 让 finally 等到响应体真正读完再清超时定时器，body 卡住时同样能中止
    return await res.json();
  } finally {
    // 请求（含响应体读取）结束后清理降级定时器与监听器
    abort.cleanup();
  }
}

export async function fetchRootComments(contentPk: string, opts?: { limit?: number; offset?: number }) {
  return api<{ data: any[]; limit: number; offset: number }>(
    `/api/contents/${encodeURIComponent(contentPk)}/root-comments?limit=${opts?.limit ?? 20}&offset=${opts?.offset ?? 0}`
  );
}

export async function fetchChildComments(contentPk: string, rootId: string) {
  return api<{ data: any[] }>(
    `/api/contents/${encodeURIComponent(contentPk)}/comments/${encodeURIComponent(rootId)}/children`
  );
}
