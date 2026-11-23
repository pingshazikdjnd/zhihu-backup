const HTML_CSP =
  "default-src 'self'; img-src 'self' data: https:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

function isHtmlResponse(res) {
  const contentType = res.headers.get("content-type") || "";
  return contentType.toLowerCase().includes("text/html");
}

// 只包装 HTML：直接把原始 body（可能是 ReadableStream）传给新 Response，
// 绝不对二进制图片/字体做文本转换；API JSON 保持原样，不强制 CSP。
function withHtmlSecurityHeaders(res) {
  if (!isHtmlResponse(res)) return res;
  const headers = new Headers(res.headers);
  headers.set("content-security-policy", HTML_CSP);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  // frame-ancestors 之外的旧浏览器兜底
  headers.set("x-frame-options", "DENY");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // /ingest/* 仅对携带 Bearer 凭据的合法请求转发到 Worker Service Binding，
    // 由 Worker 侧 requireSecret 做严格校验（fail-closed）；无凭据直接返回 404。
    if (url.pathname.startsWith("/ingest/")) {
      const auth = request.headers.get("authorization") || "";
      if (!/^Bearer\s+\S+/i.test(auth) || !env.API) {
        return new Response("Not Found", {
          status: 404,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "x-content-type-options": "nosniff"
          }
        });
      }
      return env.API.fetch(request);
    }

    const isBackendRoute = url.pathname.startsWith("/api/");

    if (isBackendRoute) {
      if (!env.API) {
        return new Response(
          JSON.stringify({
            error: "service_binding_missing",
            hint: "Pages 项目需绑定 Service Binding 名称 API → worker"
          }),
          {
            status: 503,
            headers: {
              "content-type": "application/json; charset=utf-8"
            }
          }
        );
      }
      return env.API.fetch(request);
    }

    const res = await env.ASSETS.fetch(request);
    if (
      res.status === 404 &&
      request.method === "GET" &&
      !url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/ingest/") &&
      (request.headers.get("accept") || "").includes("text/html")
    ) {
      return withHtmlSecurityHeaders(await env.ASSETS.fetch(new URL("/index.html", request.url), request));
    }
    return withHtmlSecurityHeaders(res);
  }
};
