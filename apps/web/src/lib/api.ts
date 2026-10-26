// 生产环境：若部署在 Cloudflare Pages (*.pages.dev)，优先走同源 /api/*（由 Pages _worker.js
// 通过 Service Binding 内部直连 Worker，彻底绕开国内对 *.workers.dev 的 DNS 污染且免去 CORS 预检）；
// 其余自定义域名则使用 VITE_API_BASE。开发环境默认打到本地 3001。
function resolveApiBase(): string {
  if (typeof window !== "undefined" && window.location.hostname.endsWith(".pages.dev")) {
    return "";
  }
  return import.meta.env.VITE_API_BASE || (import.meta.env.DEV ? "http://127.0.0.1:3001" : "");
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

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  if (API_BASE === "" && typeof window !== "undefined" && !window.location.hostname.endsWith(".pages.dev")) {
    throw new Error("VITE_API_BASE is not configured for this build");
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    // 没设超时的话，后端挂起会让页面永久转圈
    signal: options?.signal ?? timeoutSignal()
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }

  return res.json();
}
