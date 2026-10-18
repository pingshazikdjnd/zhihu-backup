import { db } from "../db.js";

export function emitChange(params: {
  eventType: string;
  entityType: "content" | "comment" | "collection_item";
  entityPk: string;
  contentPk?: string | null;
  summary?: string;
  payload?: unknown;
}) {
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
    JSON.stringify(params.payload ?? null),
    now
  );
}
