import { Hono } from "hono";
import { listUpvotes } from "../services/upvotes.js";

export const upvoteRoutes = new Hono();

upvoteRoutes.get("/", async c => {
  const page = parseInt(c.req.query("page") || "1", 10);
  const sort = c.req.query("sort");
  return c.json({ data: await listUpvotes({ page, sort }) });
});
