import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ingestRoutes } from "./routes/ingest.js";
import { contentRoutes } from "./routes/contents.js";
import { collectionRoutes } from "./routes/collections.js";
import { changeRoutes } from "./routes/changes.js";
import { syncRoutes } from "./routes/sync.js";
import { upvoteRoutes } from "./routes/upvotes.js";
import { statsRoutes } from "./routes/stats.js";
import { questionRoutes } from "./routes/questions.js";

const app = new Hono();

app.use("*", cors());

app.get("/api/health", c => c.json({ ok: true }));

app.route("/ingest", ingestRoutes);
app.route("/api/contents", contentRoutes);
app.route("/api/collections", collectionRoutes);
app.route("/api/changes", changeRoutes);
app.route("/api/sync", syncRoutes);
app.route("/api/upvotes", upvoteRoutes);
app.route("/api/stats", statsRoutes);
app.route("/api/questions", questionRoutes);

const port = Number(process.env.API_PORT || 3001);

serve(
  {
    fetch: app.fetch,
    port
  },
  info => {
    console.log(`API running at http://localhost:${info.port}`);
  }
);
