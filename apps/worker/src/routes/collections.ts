import { Hono } from "hono";
import { getCollectionDetail, listCollections, listAllCollectionItems } from "../services/collections.js";

export const collectionRoutes = new Hono();

collectionRoutes.get("/", async c => {
  return c.json({ data: await listCollections() });
});

collectionRoutes.get("/items", async c => {
  const page = parseInt(c.req.query("page") || "1");
  const sort = c.req.query("sort");
  return c.json({ data: await listAllCollectionItems({ page, sort }) });
});

collectionRoutes.get("/:id", async c => {
  return c.json(await getCollectionDetail(c.req.param("id")));
});
