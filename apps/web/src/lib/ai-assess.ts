import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { api } from "./api.js";
import { recommendStore } from "./store.js";

export function safeSetWriteToken(token: string) {
  try {
    localStorage.setItem("cookie_write_token", token);
  } catch {
    // 禁用存储/隐私模式不阻断当前请求
  }
}

export interface AssessContentRiskParams {
  pk: string;
  aiResults: Record<string, any>;
  aiLoadingSetRef: MutableRefObject<Set<string>>;
  setAiLoadingPks: Dispatch<SetStateAction<Record<string, boolean>>>;
  setAiResults: Dispatch<SetStateAction<Record<string, any>>>;
  errorPrefix?: string;
}

/**
 * 共享 AI 风险鉴定调用逻辑：
 * - 首次请求不主动读取 localStorage 拼 Authorization，交由 api() 同源策略控制；
 * - 仅 401/403 弹窗输入非空口令重试后，才传入 Authorization 并写入 cookie_write_token；
 * - 按 pk 维度防止双击重入并同步更新 recommendStore.aiCache。
 */
export async function assessContentRisk({
  pk,
  aiResults,
  aiLoadingSetRef,
  setAiLoadingPks,
  setAiResults,
  errorPrefix = "AI 风险鉴定失败"
}: AssessContentRiskParams): Promise<void> {
  if (aiResults[pk] || aiLoadingSetRef.current.has(pk)) return;
  aiLoadingSetRef.current.add(pk);
  setAiLoadingPks(prev => ({ ...prev, [pk]: true }));
  const callAssess = (tokenStr?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (tokenStr && tokenStr.trim()) headers.authorization = `Bearer ${tokenStr.trim()}`;
    return api<any>(`/api/recommend/ai-assess`, {
      method: "POST",
      headers,
      body: JSON.stringify({ pk })
    });
  };
  try {
    let res: any;
    try {
      res = await callAssess();
    } catch (err: any) {
      const msg = String(err?.message || "");
      const needAuth = msg.startsWith("401") || (msg.startsWith("403") && !/Forbidden origin/i.test(msg));
      if (!needAuth) throw err;
      const input = window.prompt("AI 风险鉴定需验证操作密码（验证后本浏览器自动记住）：", "");
      const trimmed = input?.trim() || "";
      if (!trimmed) return;
      res = await callAssess(trimmed);
      safeSetWriteToken(trimmed);
    }
    if (res?.ai) {
      setAiResults(prev => {
        const next = { ...prev, [pk]: res.ai };
        recommendStore.aiCache = next;
        return next;
      });
    }
  } catch (err: any) {
    alert(`${errorPrefix}: ${err?.message || err}`);
  } finally {
    aiLoadingSetRef.current.delete(pk);
    setAiLoadingPks(prev => {
      if (!prev[pk]) return prev;
      const next = { ...prev };
      delete next[pk];
      return next;
    });
  }
}
