import { Hono } from "hono";
import { listUpvotes } from "../services/upvotes.js";

export const upvoteRoutes = new Hono();

upvoteRoutes.get("/", c => {
  const page = parseInt(c.req.query("page") || "1", 10);
  return c.json({ data: listUpvotes({ page }) });
});
