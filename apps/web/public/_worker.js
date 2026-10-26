export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if ((url.pathname.startsWith("/api/") || url.pathname.startsWith("/ingest/")) && env.API) {
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
