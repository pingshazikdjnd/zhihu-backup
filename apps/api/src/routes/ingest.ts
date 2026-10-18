import { Hono } from "hono";
import {
  IngestCollectionSnapshotSchema,
  IngestCommentsSchema,
  IngestContentSchema
} from "shared";
import { upsertContent } from "../services/contents.js";
import { replaceComments } from "../services/comments.js";
import { upsertCollectionSnapshot } from "../services/collections.js";
import { upsertUpvote } from "../services/upvotes.js";

export const ingestRoutes = new Hono();

ingestRoutes.post("/content", async c => {
  const body = await c.req.json();
  const parsed = IngestContentSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const result = upsertContent(parsed.data);
  return c.json(result);
});

ingestRoutes.post("/comments", async c => {
  const body = await c.req.json();
  const parsed = IngestCommentsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const result = replaceComments(parsed.data);
  return c.json(result);
});

ingestRoutes.post("/collection-snapshot", async c => {
  const body = await c.req.json();
  const parsed = IngestCollectionSnapshotSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const result = upsertCollectionSnapshot(parsed.data);
  return c.json(result);
});

ingestRoutes.post("/upvote", async c => {
  const body = await c.req.json() as { contentPk?: unknown; upvoteTime?: unknown };
  if (typeof body.contentPk !== "string" || !body.contentPk) {
    return c.json({ error: "contentPk is required" }, 400);
  }
  if (typeof body.upvoteTime !== "string" || !body.upvoteTime) {
    return c.json({ error: "upvoteTime is required" }, 400);
  }
  const result = upsertUpvote(body.contentPk, body.upvoteTime);
  return c.json({ success: true, ...result });
});

ingestRoutes.post("/sync-all", async c => {
  const { spawn } = await import("child_process");
  
  // Windows 下 spawn("pnpm") 需要 shell: true，否则 ENOENT
  const spawnOpts = { stdio: 'ignore' as const, detached: true, cwd: process.cwd(), shell: true };

  // Trigger upvotes sync
  const upvotesProc = spawn("pnpm", ["sync:upvotes"], spawnOpts);
  upvotesProc.unref();

  // Trigger answers sync
  const answersProc = spawn("pnpm", ["sync"], spawnOpts);
  answersProc.unref();
  
  return c.json({ success: true, message: "Sync tasks started in background" });
});
