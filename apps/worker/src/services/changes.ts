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
 * 构造一条 change_events 的 prepared statement，供 db.batch() 批量提交。
 * 评论同步一条一条 emitChange 的话，200 条评论就是 200 次 D1 往返。
 */
export function buildChangeStatement(params: ChangeParams) {
  const now = new Date().toISOString();
  return db.prepare(`
    INSERT INTO change_events (
      event_type, entity_type, entity_pk, content_pk, summary, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).raw(
    params.eventType,
    params.entityType,
    params.entityPk,
    params.contentPk ?? null,
    params.summary ?? "",
    JSON.stringify(params.payload ?? null),
    now
  );
}

export async function emitChange(params: ChangeParams) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO change_events (
      event_type, entity_type, entity_pk, content_pk, summary, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.eventType,
    params.entityType,
    params.entityPk,
    params.contentPk ?? null,
    params.summary ?? "",
    JSON.stringify(params.payload ?? null),
    now
  );
}
