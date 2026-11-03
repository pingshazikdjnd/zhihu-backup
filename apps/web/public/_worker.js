export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isBackendRoute = url.pathname.startsWith("/api/") || url.pathname.startsWith("/ingest/");

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
      return env.ASSETS.fetch(new URL("/index.html", request.url), request);
    }
    return res;
  }
};
