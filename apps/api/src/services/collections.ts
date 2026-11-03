import { db } from "../db.js";
import { emitChange } from "./changes.js";
import type { IngestCollectionSnapshotInput } from "shared";

type CollectionItemRow = {
  id: number;
  source_type: string;
  source_id: string;
  title: string | null;
  author_name: string | null;
  source_url: string | null;
  is_removed: number;
};

type CollectionItemInput = IngestCollectionSnapshotInput["items"][number];

export function upsertCollectionSnapshot(input: IngestCollectionSnapshotInput): {
  added: number;
  removed: number;
  count: number;
  unchanged?: boolean;
} {
  const now = new Date().toISOString();
  const collectionId = input.collection.id;

  // 开头一次 SELECT 全量（不过滤 is_removed=0）：已移除的行也要查出来，用 Map 建索引，
  // 命中时走「更新并复位」。旧版在循环里逐条 SELECT 且只看未移除行，
  // 既放大读次数，又会让已移除条目被当成不存在 → INSERT 撞 UNIQUE(collection_id, source_type, source_id)
  const existingItems = db.prepare(`
    SELECT id, source_type, source_id, title, author_name, source_url, is_removed
    FROM collection_items
    WHERE collection_id = ?
  `).all(collectionId) as CollectionItemRow[];

  const existingByKey = new Map<string, CollectionItemRow>(
    existingItems.map(i => [`${i.source_type}:${i.source_id}`, i] as [string, CollectionItemRow])
  );
  // 删除对账基准与旧版一致：只有快照前仍处于未移除状态的行参与
  const existingKeys = new Set(
    existingItems.filter(i => i.is_removed === 0).map(i => `${i.source_type}:${i.source_id}`)
  );

  // 同一批 payload 里重复出现的 key（分页重叠）保留最后一次出现的值：
  // 与旧版「先插后更、末次值生效」等价，但不会产生多余的 INSERT/UPDATE
  const uniqueItems = new Map<string, CollectionItemInput>();
  for (const item of input.items) {
    uniqueItems.set(`${item.sourceType}:${item.sourceId}`, item);
  }
  const incomingKeys = new Set(uniqueItems.keys());

  let added = 0;
  let removed = 0;

  const tx = db.transaction(() => {
    const existsCollection = db.prepare(`
      SELECT id, title, owner_token, updated_time
      FROM collections
      WHERE id = ?
    `).get(collectionId) as {
      id: string;
      title: string;
      owner_token: string | null;
      updated_time: string;
    } | undefined;

    // 完全重复快照直接 0 写：最近一次快照的 item_count 与当前有效条目一致，
    // 且标题/owner、每个有效条目字段都没变时，collections UPDATE、逐条 collection_items UPDATE
    // 与 collection_snapshots INSERT 全是纯写入放大。
    // 不能只信 collections.updated_time（弱数据源并不可靠），必须逐条比较字段；
    // 历史已移除行只要不在本次输入中就不影响判断，增删改与恢复仍走原对账流程。
    if (existsCollection) {
      const latestSnapshot = db.prepare(`
        SELECT item_count
        FROM collection_snapshots
        WHERE collection_id = ?
        ORDER BY snapshot_at DESC, id DESC
        LIMIT 1
      `).get(collectionId) as { item_count: number } | undefined;

      if (latestSnapshot) {
        const activeItems = existingItems.filter(i => i.is_removed === 0);
        // uniqueItems 必须与当前有效条目集合完全一致：数量相同且每个有效条目都能在输入中找到，
        // 才算「本次快照覆盖全部有效条目」。增量分片若只带了部分条目，条件不满足，仍走原修复流程。
        const itemsUnchanged =
          latestSnapshot.item_count === activeItems.length &&
          uniqueItems.size === activeItems.length &&
          activeItems.every(row => {
            const item = uniqueItems.get(`${row.source_type}:${row.source_id}`);
            if (!item) return false;
            return (row.title || "") === (item.title || "") &&
              (row.author_name || "") === (item.authorName || "") &&
              (row.source_url || "") === (item.sourceUrl || "");
          });

        // 爬虫通常拿不到收藏夹 updated_time（输入固定为空串），而库里是每次保存时的历史时间：
        // 只有本次输入明确给出非空可信值时才比较，空值不得否定完全重复，也不能因此写库。
        const updatedTimeUnchanged =
          !input.collection.updatedTime ||
          (existsCollection.updated_time || "") === input.collection.updatedTime;

        if (
          itemsUnchanged &&
          updatedTimeUnchanged &&
          (existsCollection.title || "") === (input.collection.title || "") &&
          (existsCollection.owner_token || "") === (input.collection.ownerToken || "")
        ) {
          return { added: 0, removed: 0, count: activeItems.length, unchanged: true };
        }
      }
    }

    if (!existsCollection) {
      db.prepare(`
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
      db.prepare(`
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

    for (const item of uniqueItems.values()) {
      const key = `${item.sourceType}:${item.sourceId}`;
      const row = existingByKey.get(key);

      if (!row) {
        db.prepare(`
          INSERT INTO collection_items (
            collection_id, content_pk, source_type, source_id,
            title, author_name, source_url, first_seen_at, last_seen_at, is_removed, removed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
        `).run(
          collectionId,
          key,
          item.sourceType,
          item.sourceId,
          item.title,
          item.authorName,
          item.sourceUrl,
          now,
          now
        );

        emitChange({
          eventType: "collection.item_added",
          entityType: "collection_item",
          entityPk: `${collectionId}:${key}`,
          contentPk: key,
          summary: `${input.collection.title} + ${item.title}`,
          payload: item
        });

        added++;
      } else {
        // 条目字段完全一致且未处于移除态：没有新信息，跳过 UPDATE 与事件。
        // 旧逻辑每轮同步都把全量条目重写一遍，收藏夹稍大就会放大写入
        if (
          (row.title || "") === (item.title || "") &&
          (row.author_name || "") === (item.authorName || "") &&
          (row.source_url || "") === (item.sourceUrl || "") &&
          row.is_removed === 0
        ) {
          continue;
        }

        db.prepare(`
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

        // 从「已移除」复活也要发事件：否则按事件流重放得不到库内状态
        // （收条目 → 移除 → 再收回来，事件流里中间断了一截）
        if (row.is_removed === 1) {
          emitChange({
            eventType: "collection.item_added",
            entityType: "collection_item",
            entityPk: `${collectionId}:${key}`,
            contentPk: key,
            summary: `${input.collection.title} + ${item.title}（重新加入）`,
            payload: item
          });
        }
      }
    }

    if (!input.incremental) {
      for (const key of existingKeys) {
        if (!incomingKeys.has(key)) {
          const [sourceType, sourceId] = key.split(":");
          db.prepare(`
            UPDATE collection_items
            SET is_removed = 1, removed_at = ?, last_seen_at = ?
            WHERE collection_id = ? AND source_type = ? AND source_id = ?
          `).run(now, now, collectionId, sourceType, sourceId);

          emitChange({
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

    // item_count 用去重后的条目数：分页重叠的重复 key 不是真实条目，
    // 若记录未去重前的长度，下次相同快照的 item_count 对账会永远对不上、去重短路失效
    db.prepare(`
      INSERT INTO collection_snapshots (
        collection_id, snapshot_at, item_count, added_count, removed_count
      ) VALUES (?, ?, ?, ?, ?)
    `).run(collectionId, now, uniqueItems.size, added, removed);

    return { added, removed, count: input.items.length };
  });

  return tx();
}

export function listCollections() {
  return db.prepare(`
    SELECT *
    FROM collections
    ORDER BY CASE WHEN title = '我的收藏' THEN 0 ELSE 1 END ASC, updated_time DESC
  `).all();
}

export function listAllCollectionItems(params?: { page?: number }) {
  const page = params?.page || 1;
  const limit = 50;
  const offset = (page - 1) * limit;

  return db.prepare(`
    SELECT ci.id, ci.collection_id, ci.source_type, ci.source_id, ci.title, ci.author_name, ci.source_url, ci.first_seen_at as created_time,
           c.content_html, c.excerpt, c.voteup_count, c.comment_count, c.favorite_count, c.visit_count, c.author_url_token, c.pk as content_pk
    FROM collection_items ci
    LEFT JOIN contents c ON ci.content_pk = c.pk
    WHERE ci.is_removed = 0
    ORDER BY ci.first_seen_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `).all();
}

export function getCollectionDetail(collectionId: string) {
  const collection = db.prepare(`
    SELECT *
    FROM collections
    WHERE id = ?
  `).get(collectionId);

  const items = db.prepare(`
    SELECT ci.*, c.content_html, c.excerpt, c.author_name, c.voteup_count, c.comment_count, c.favorite_count, c.visit_count
    FROM collection_items ci
    LEFT JOIN contents c ON ci.content_pk = c.pk
    WHERE ci.collection_id = ?
    ORDER BY ci.is_removed ASC, ci.last_seen_at DESC
  `).all(collectionId);

  const snapshots = db.prepare(`
    SELECT *
    FROM collection_snapshots
    WHERE collection_id = ?
    ORDER BY snapshot_at DESC
    LIMIT 20
  `).all(collectionId);

  return { collection, items, snapshots };
}
