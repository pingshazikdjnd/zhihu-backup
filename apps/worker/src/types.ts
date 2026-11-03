export type Bindings = {
  DB: D1Database;
  BUCKET?: R2Bucket;
  /** Cloudflare Workers AI binding */
  AI?: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };
  API_SECRET?: string;
  APIFY_TOKEN?: string;
  APIFY_ACTOR_ID?: string;
  ZHIHU_USERNAME?: string;
  ZHIHU_COOKIE_STRING?: string;
  ZHIHU_COOKIE_Z_C0?: string;
  WORKER_URL?: string;
  ALLOWED_ORIGIN?: string;
  // 可选：给网页的 cookie 写入口令。不配则回退到 API_SECRET（仍为 fail-closed）。
  COOKIE_WRITE_TOKEN?: string;
  // 可选：设为 "true" 时所有 /api/* 读接口也要求 Bearer（API_SECRET 或写入口令）
  READ_AUTH_REQUIRED?: string;
};
