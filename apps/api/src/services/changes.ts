import { db } from "../db.js";

export type ChangeParams = {
  eventType: string;
  entityType: "content" | "comment" | "collection_item";
  entityPk: string;
  contentPk?: string | null;
  summary?: string;
  payload?: unknown;
};

/**
 * 评论事件只持久化引用字段：正文/头像/点赞等快照在 comments/comment_versions 里，
 * 再复制进 change_events 既浪费空间，也会让事件流变成第二份正文存档。
 * 这里做兜底裁剪，防止调用方再传整段评论对象。
 */
function compactCommentPayload(payload: unknown, contentPk?: string | null): unknown {
  if (payload === null || payload === undefined || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const commentId = typeof record.commentId === "string" && record.commentId
    ? record.commentId
    : typeof record.id === "string" && record.id
      ? record.id
      : "";
  const pk = typeof record.contentPk === "string" && record.contentPk
    ? record.contentPk
    : contentPk;
  const ref: Record<string, string> = {};
  if (commentId) ref.commentId = commentId;
  if (pk) ref.contentPk = pk;
  return ref;
}

function serializePayload(params: ChangeParams): string {
  // content / collection_item 事件的摘要与 payload 保持原样，仅裁剪评论事件
  if (params.entityType === "comment") {
    return JSON.stringify(compactCommentPayload(params.payload, params.contentPk)) ?? "null";
  }
  return JSON.stringify(params.payload ?? null) ?? "null";
}

export function emitChange(params: ChangeParams) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO change_events (
      event_type, entity_type, entity_pk, content_pk, summary, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.eventType,
    params.entityType,
    params.entityPk,
    params.contentPk ?? null,
    params.summary ?? "",
    serializePayload(params),
    now
  );
}
