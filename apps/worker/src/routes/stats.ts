import { Hono } from "hono";
import { db } from "../db.js";

export const statsRoutes = new Hono();

statsRoutes.get("/", async c => {
  const contentsCount = await db.prepare(`SELECT count(*) as c FROM contents WHERE is_deleted = 0`).get() as { c: number };
  const answersCount = await db.prepare(`SELECT count(*) as c FROM contents WHERE source_type = 'answer' AND is_deleted = 0`).get() as { c: number };
  const articlesCount = await db.prepare(`SELECT count(*) as c FROM contents WHERE source_type = 'article' AND is_deleted = 0`).get() as { c: number };
  const upvotesCount = await db.prepare(`SELECT count(*) as c FROM upvotes`).get() as { c: number };
  const commentsCount = await db.prepare(`SELECT count(*) as c FROM comments WHERE is_deleted = 0`).get() as { c: number };
  const collectionsCount = await db.prepare(`SELECT count(*) as c FROM collections`).get() as { c: number };
  const collectionItemsCount = await db.prepare(`SELECT count(*) as c FROM collection_items WHERE is_removed = 0`).get() as { c: number };

  return c.json({
    total_contents: contentsCount.c,
    total_answers: answersCount.c,
    total_articles: articlesCount.c,
    total_upvotes: upvotesCount.c,
    total_comments: commentsCount.c,
    total_collections: collectionsCount.c,
    total_collection_items: collectionItemsCount.c
  });
});
