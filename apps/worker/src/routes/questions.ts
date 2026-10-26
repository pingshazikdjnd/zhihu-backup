import { Hono } from "hono";
import { listQuestions, getQuestionAnswers } from "../services/questions.js";
import type { Bindings } from "../types.js";

export const questionRoutes = new Hono<{ Bindings: Bindings }>();

// 按问题维度聚合用户赞同/收藏过的回答（只读公开，同其他读接口）
questionRoutes.get("/", async c => {
  const page = parseInt(c.req.query("page") || "1", 10);
  const { rows, total } = await listQuestions({ page });
  return c.json({ data: rows, total });
});

questionRoutes.get("/:id", async c => {
  const id = c.req.param("id");
  const result = await getQuestionAnswers(id);
  if (!result.question) return c.json({ question: null, answers: [] });
  return c.json(result);
});
