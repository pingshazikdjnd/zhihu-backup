export type Bindings = {
  DB: any; // D1Database
  BUCKET: any; // R2Bucket
  API_SECRET?: string;
  APIFY_TOKEN?: string;
  APIFY_ACTOR_ID?: string;
  ZHIHU_USERNAME?: string;
  ZHIHU_COOKIE_STRING?: string;
  ZHIHU_COOKIE_Z_C0?: string;
  WORKER_URL?: string;
  ALLOWED_ORIGIN?: string;
  // 可选：给网页的 cookie 写入口令。不配则允许网页直接提交。
  COOKIE_WRITE_TOKEN?: string;
};
