// 生产环境：默认走同源空 base（由 Pages _worker.js 通过 Service Binding 内部直连 Worker，
// 无论部署在 *.pages.dev 还是 Pages 自定义域名，均彻底绕开国内对 *.workers.dev 的 DNS 污染且免去 CORS 预检）；
// 除非显式设置了 VITE_API_BASE（例如独立部署在其他 CDN/静态托管需直连 Worker 时）。
// 开发环境默认回退到本地 127.0.0.1:3001。
function resolveApiBase(): string {
  if (import.meta.env.VITE_API_BASE) {
    return import.meta.env.VITE_API_BASE;
  }
  if (import.meta.env.PROD) {
    return "";
  }
  return import.meta.env.DEV ? "http://127.0.0.1:3001" : "";
}

const API_BASE = resolveApiBase();

// AbortSignal.timeout 需要 Chrome 103+ / Safari 16+，老浏览器没有这个方法，
// 直接调用会 TypeError 让整个 api() 挂掉，这里做降级。
function timeoutSignal(): AbortSignal | undefined {
  const anySignal = AbortSignal as any;
  if (typeof anySignal?.timeout === "function") {
    return anySignal.timeout(30_000);
  }
  if (typeof AbortController !== "undefined") {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 30_000);
    return ctrl.signal;
  }
  return undefined;
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

  const headers = new Headers(options?.headers);
  // 调用方显式传了 Authorization 就尊重调用方；否则自动带设置页保存的操作口令，
  // 这样 AI 鉴定、私有读模式等所有 API 请求都无需逐个页面手写凭据。
  if (!headers.has("authorization")) {
    const token = resolveWriteToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    // 没设超时的话，后端挂起会让页面永久转圈
    signal: options?.signal ?? timeoutSignal()
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }

  return res.json();
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

