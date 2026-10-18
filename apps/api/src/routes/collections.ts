import { Hono } from "hono";
import { getCollectionDetail, listCollections, listAllCollectionItems } from "../services/collections.js";

export const collectionRoutes = new Hono();

collectionRoutes.get("/", c => {
  return c.json({ data: listCollections() });
});

collectionRoutes.get("/items", c => {
  const page = parseInt(c.req.query("page") || "1");
  return c.json({ data: listAllCollectionItems({ page }) });
});

collectionRoutes.get("/:id", c => {
  return c.json(getCollectionDetail(c.req.param("id")));
});
