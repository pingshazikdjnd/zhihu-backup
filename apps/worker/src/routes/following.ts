import { Hono } from "hono";
import {
  getFollowedUserContents,
  listFollowedUsers,
  listFollowingFeed,
  setFollowedUserSyncMode
} from "../services/following.js";
import { authorizeWrite } from "./auth.js";
import type { Bindings } from "../types.js";

export const followingRoutes = new Hono<{ Bindings: Bindings }>();

// 获取关注的人列表与总备份量预估
followingRoutes.get("/users", async c => {
  const q = c.req.query("q") || "";
  const mode = c.req.query("mode") || "";
  const sort = c.req.query("sort") || "backed";
  const res = await listFollowedUsers(c.env.BUCKET, { q, mode, sort });
  return c.json(res);
});

// 获取关注的人动态流（支持 only_risk=1 只看高危易和谐回答）
followingRoutes.get("/feed", async c => {
  const page = parseInt(c.req.query("page") || "1", 10);
  const onlyRisk = c.req.query("only_risk") === "1";
  const q = c.req.query("q") || "";
  const res = await listFollowingFeed(c.env.BUCKET, { page, onlyRisk, q });
  return c.json(res);
});

// 获取单个关注答主的详情及已备份内容
followingRoutes.get("/users/:token", async c => {
  const token = c.req.param("token");
  const page = parseInt(c.req.query("page") || "1", 10);
  const onlyRisk = c.req.query("only_risk") === "1";
  const res = await getFollowedUserContents(c.env.BUCKET, token, { page, onlyRisk });
  return c.json(res);
});

// 切换单个关注答主的备份模式（default: 精选前 50 篇 vs full: 全量备份，受操作密码保护）
followingRoutes.post("/users/:token/mode", async c => {
  if (!(await authorizeWrite(c)).ok) {
    return c.json({ error: "操作密码错误或未填写，请验证凭据页密码", needToken: true }, 401);
  }
  const token = c.req.param("token");
  const body = await c.req.json().catch(() => null) as { syncMode?: unknown } | null;
  const syncMode = body?.syncMode === "full" ? "full" : "default";
  const res = await setFollowedUserSyncMode(c.env.BUCKET, token, syncMode);
  if (!res.ok) return c.json(res, 404);
  return c.json(res);
});
