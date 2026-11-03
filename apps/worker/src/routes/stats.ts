import { Hono } from "hono";
import { db } from "../db.js";

export const statsRoutes = new Hono();

// 7 条 COUNT(*) 全表扫描，每次页面刷新都跑一遍会放大 D1 读取；
// 60 秒内的重复请求直接返回缓存（统计数字对分钟级延迟不敏感）
const STATS_CACHE_MS = 60_000;
let cachedStats: { at: number; data: any } | null = null;

statsRoutes.get("/", async c => {
  if (cachedStats) {
    const age = Date.now() - cachedStats.at;
    if (age >= 0 && age < STATS_CACHE_MS) {
      return c.json(cachedStats.data);
    }
  }

  const contentsCount = await db.prepare(`SELECT count(*) as c FROM contents WHERE is_deleted = 0`).get() as { c: number };
  const answersCount = await db.prepare(`SELECT count(*) as c FROM contents WHERE source_type = 'answer' AND is_deleted = 0`).get() as { c: number };
  const articlesCount = await db.prepare(`SELECT count(*) as c FROM contents WHERE source_type = 'article' AND is_deleted = 0`).get() as { c: number };
  const upvotesCount = await db.prepare(`SELECT count(*) as c FROM upvotes`).get() as { c: number };
  const commentsCount = await db.prepare(`SELECT count(*) as c FROM comments WHERE is_deleted = 0`).get() as { c: number };
  const collectionsCount = await db.prepare(`SELECT count(*) as c FROM collections`).get() as { c: number };
  const collectionItemsCount = await db.prepare(`SELECT count(*) as c FROM collection_items WHERE is_removed = 0`).get() as { c: number };

  const data = {
    total_contents: contentsCount.c,
    total_answers: answersCount.c,
    total_articles: articlesCount.c,
    total_upvotes: upvotesCount.c,
    total_comments: commentsCount.c,
    total_collections: collectionsCount.c,
    total_collection_items: collectionItemsCount.c
  };
  cachedStats = { at: Date.now(), data };
  return c.json(data);
});
