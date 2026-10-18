// 生产环境：部署时通过 VITE_API_BASE 指定 Cloudflare Worker 域名。
// 开发环境：默认打到本地 Node API 的 3001。
// 原来的兜底是 8787（wrangler dev 端口），本地 API 在 3001，两边都对不上。
const API_BASE =
  import.meta.env.VITE_API_BASE ||
  (import.meta.env.DEV ? "http://127.0.0.1:3001" : "");

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
  if (!API_BASE) {
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

export { API_BASE };
