import { db } from "../db.js";
import { emitChange } from "./changes.js";
import type { IngestCollectionSnapshotInput } from "shared";

export async function upsertCollectionSnapshot(input: IngestCollectionSnapshotInput) {
  const now = new Date().toISOString();
  const collectionId = input.collection.id;

  const existingItems = await db.prepare(`
    SELECT collection_id, source_type, source_id, is_removed
    FROM collection_items
    WHERE collection_id = ? AND is_removed = 0
  `).all(collectionId) as Array<{
    collection_id: string;
    source_type: string;
    source_id: string;
    is_removed: number;
  }>;

  const existingKeys = new Set(existingItems.map(i => `${i.source_type}:${i.source_id}`));
  const incomingKeys = new Set(input.items.map(i => `${i.sourceType}:${i.sourceId}`));

  let added = 0;
  let removed = 0;

  await db.transaction(async () => {
    const existsCollection = await db.prepare(`SELECT id FROM collections WHERE id = ?`).get(collectionId);
    if (!existsCollection) {
      await db.prepare(`
        INSERT INTO collections (id, title, owner_token, first_seen_at, last_seen_at, updated_time)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        collectionId,
        input.collection.title,
        input.collection.ownerToken || null,
        now,
        now,
        input.collection.updatedTime || now
      );
    } else {
      await db.prepare(`
        UPDATE collections
        SET title = ?, owner_token = ?, last_seen_at = ?, updated_time = ?
        WHERE id = ?
      `).run(
        input.collection.title,
        input.collection.ownerToken || null,
        now,
        input.collection.updatedTime || now,
        collectionId
      );
    }

    for (const item of input.items) {
      const contentPk = `${item.sourceType}:${item.sourceId}`;
      const key = `${item.sourceType}:${item.sourceId}`;

      const row = await db.prepare(`
        SELECT id, is_removed
        FROM collection_items
        WHERE collection_id = ? AND source_type = ? AND source_id = ?
      `).get(collectionId, item.sourceType, item.sourceId) as
        | { id: number; is_removed: number }
        | undefined;

      if (!row) {
        await db.prepare(`
          INSERT INTO collection_items (
            collection_id, content_pk, source_type, source_id,
            title, author_name, source_url, first_seen_at, last_seen_at, is_removed, removed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
        `).run(
          collectionId,
          contentPk,
          item.sourceType,
          item.sourceId,
          item.title,
          item.authorName,
          item.sourceUrl,
          now,
          now
        );

        await emitChange({
          eventType: "collection.item_added",
          entityType: "collection_item",
          entityPk: `${collectionId}:${key}`,
          contentPk,
          summary: `${input.collection.title} + ${item.title}`,
          payload: item
        });

        added++;
      } else {
        await db.prepare(`
          UPDATE collection_items
          SET title = ?, author_name = ?, source_url = ?, last_seen_at = ?, is_removed = 0, removed_at = NULL
          WHERE id = ?
        `).run(
          item.title,
          item.authorName,
          item.sourceUrl,
          now,
          row.id
        );
      }
    }

    if (!input.incremental) {
      for (const key of existingKeys) {
        if (!incomingKeys.has(key)) {
          const [sourceType, sourceId] = key.split(":");
          await db.prepare(`
            UPDATE collection_items
            SET is_removed = 1, removed_at = ?, last_seen_at = ?
            WHERE collection_id = ? AND source_type = ? AND source_id = ?
          `).run(now, now, collectionId, sourceType, sourceId);

          await emitChange({
            eventType: "collection.item_removed",
            entityType: "collection_item",
            entityPk: `${collectionId}:${key}`,
            contentPk: key,
            summary: `${input.collection.title} - ${key}`,
            payload: { collectionId, sourceType, sourceId }
          });

          removed++;
        }
      }
    }

    await db.prepare(`
      INSERT INTO collection_snapshots (
        collection_id, snapshot_at, item_count, added_count, removed_count
      ) VALUES (?, ?, ?, ?, ?)
    `).run(collectionId, now, input.items.length, added, removed);
  });

  return { added, removed, count: input.items.length };
}

export async function listCollections() {
  return await db.prepare(`
    SELECT *
    FROM collections
    ORDER BY CASE WHEN title = '我的收藏' THEN 0 ELSE 1 END ASC, updated_time DESC
  `).all();
}

export async function listAllCollectionItems(params?: { page?: number }) {
  const page = params?.page || 1;
  const limit = 50;
  const offset = (page - 1) * limit;

  return await db.prepare(`
    SELECT ci.id, ci.collection_id, ci.source_type, ci.source_id, ci.title, ci.author_name, ci.source_url, ci.first_seen_at as created_time,
           CASE 
             WHEN c.excerpt IS NOT NULL AND c.excerpt != '' AND c.excerpt != 'null' THEN c.excerpt 
             WHEN c.content_md IS NOT NULL AND c.content_md != '' THEN SUBSTR(c.content_md, 1, 300) 
             ELSE SUBSTR(c.content_html, 1, 300) 
           END as excerpt, 
           c.voteup_count, c.comment_count, c.favorite_count, c.visit_count, c.author_url_token, c.pk as content_pk
    FROM collection_items ci
    LEFT JOIN contents c ON ci.content_pk = c.pk
    WHERE ci.is_removed = 0
    ORDER BY ci.first_seen_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `).all();
}

export async function getCollectionDetail(collectionId: string) {
  const collection = await db.prepare(`
    SELECT *
    FROM collections
    WHERE id = ?
  `).get(collectionId);

  const items = await db.prepare(`
    SELECT ci.*, 
           CASE 
             WHEN c.excerpt IS NOT NULL AND c.excerpt != '' AND c.excerpt != 'null' THEN c.excerpt 
             WHEN c.content_md IS NOT NULL AND c.content_md != '' THEN SUBSTR(c.content_md, 1, 300) 
             ELSE SUBSTR(c.content_html, 1, 300) 
           END as excerpt,
           c.author_name, c.voteup_count, c.comment_count, c.favorite_count, c.visit_count
    FROM collection_items ci
    LEFT JOIN contents c ON ci.content_pk = c.pk
    WHERE ci.collection_id = ?
    ORDER BY ci.is_removed ASC, ci.last_seen_at DESC
  `).all(collectionId);

  const snapshots = await db.prepare(`
    SELECT *
    FROM collection_snapshots
    WHERE collection_id = ?
    ORDER BY snapshot_at DESC
    LIMIT 20
  `).all(collectionId);

  return { collection, items, snapshots };
}
