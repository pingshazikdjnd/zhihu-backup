import { Hono } from "hono";
import { listQuestions, getQuestionAnswers } from "../services/questions.js";

export const questionRoutes = new Hono();

questionRoutes.get("/", c => {
  const page = parseInt(c.req.query("page") || "1", 10);
  const q = c.req.query("q") || "";
  const { rows, total } = listQuestions({ page, q });
  return c.json({ data: rows, total });
});

questionRoutes.get("/:id", c => {
  const id = c.req.param("id");
  const result = getQuestionAnswers(id);
  if (!result.question) return c.json({ question: null, answers: [] });
  return c.json(result);
});
