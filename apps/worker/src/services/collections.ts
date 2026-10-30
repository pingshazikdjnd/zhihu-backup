import { db } from "../db.js";
import { buildChangeStatement } from "./changes.js";
import { withKeyLock } from "./lock.js";
import type { IngestCollectionSnapshotInput } from "shared";

// D1 单次 batch 的语句数不宜过大；100 条一批兼顾往返次数和单批体积（同 comments.ts）
const BATCH_SIZE = 100;

export function upsertCollectionSnapshot(input: IngestCollectionSnapshotInput) {
  // 同收藏夹写串行化：并发快照的对账与复位互相干扰（详见 lock.ts）
  return withKeyLock(`collection:${input.collection.id}`, () => upsertCollectionSnapshotInner(input));
}

/**
 * 收藏夹快照同步。
 *
 * 原来套在 db.transaction 里逐条 await（collections upsert + 每条 item 的 SELECT/INSERT/UPDATE
 * + 每条事件一次独立 emitChange），几十条收藏就是几十上百次 D1 往返，会撞 Workers 子请求上限；
 * 且 db.transaction 在 D1 上只是顺序执行、不回滚，batch() 才是唯一的原子手段。
 * 现在改成「先查后批」：SELECT 全部在 batch 之前完成，写语句统一收进 stmts 分批 batch。
 */
async function upsertCollectionSnapshotInner(input: IngestCollectionSnapshotInput) {
  const now = new Date().toISOString();
  const collectionId = input.collection.id;

  // 一次性查全量（不过滤 is_removed=0）：已移除的行也要查出来，
  // 命中时走「更新并复位」，与旧版逐条 SELECT（无 is_removed 过滤）→ 无行才 INSERT 的判断等价
  const existingItems = await db.prepare(`
    SELECT id, source_type, source_id, title, author_name, source_url, is_removed
    FROM collection_items
    WHERE collection_id = ?
  `).all(collectionId) as Array<{
    id: number;
    source_type: string;
    source_id: string;
    title: string | null;
    author_name: string | null;
    source_url: string | null;
    is_removed: number;
  }>;

  const existingByKey = new Map(existingItems.map(i => [`${i.source_type}:${i.source_id}`, i]));
  // 对账基准与旧版一致：只有此快照前仍处于未移除状态的行参与删除对账
  const existingKeys = new Set(
    existingItems.filter(i => i.is_removed === 0).map(i => `${i.source_type}:${i.source_id}`)
  );
  const incomingKeys = new Set(input.items.map(i => `${i.sourceType}:${i.sourceId}`));

  // 同一批 payload 里重复出现的 key，旧版逐条查询天然是「先插后更、末次值生效」；
  // 批量路径下重复 INSERT 会造出脏行，这里先按 key 去重、保留最后一次出现的值
  const uniqueItems = new Map<string, IngestCollectionSnapshotInput["items"][number]>();
  for (const item of input.items) {
    uniqueItems.set(`${item.sourceType}:${item.sourceId}`, item);
  }

  let added = 0;
  let removed = 0;

  const existsCollection = await db.prepare(`
    SELECT id, title, owner_token, updated_time
    FROM collections
    WHERE id = ?
  `).get(collectionId) as {
    id: string;
    title: string;
    owner_token: string | null;
    updated_time: string;
  } | null;

  // 完全重复快照直接 0 写：最近一次快照的 item_count 与当前有效条目一致，
  // 且标题/owner、每个当前有效条目字段都没变时，collections UPDATE 与
  // collection_snapshots INSERT 都是纯写入放大。
  // 不能只信 collections.updated_time（弱数据源并不可靠），必须逐条比较字段；
  // 历史已移除行只要不在本次输入中就不影响判断，增删改与恢复仍走原对账流程。
  if (existsCollection) {
    const latestSnapshot = await db.prepare(`
      SELECT item_count
      FROM collection_snapshots
      WHERE collection_id = ?
      ORDER BY snapshot_at DESC, id DESC
      LIMIT 1
    `).get(collectionId) as { item_count: number } | null;

    if (latestSnapshot) {
      const activeItems = existingItems.filter(i => i.is_removed === 0);
      // uniqueItems 必须与当前有效条目集合完全一致：
      // 数量相同且每个有效条目都能在输入中找到，才算“本次快照覆盖全部有效条目”。
      // 增量分片若只带了部分条目，数量/覆盖条件不满足，仍会走原修复流程。
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

  const stmts: any[] = [];

  if (!existsCollection) {
    stmts.push(db.prepare(`
      INSERT INTO collections (id, title, owner_token, first_seen_at, last_seen_at, updated_time)
      VALUES (?, ?, ?, ?, ?, ?)
    `).raw(
      collectionId,
      input.collection.title,
      input.collection.ownerToken || null,
      now,
      now,
      input.collection.updatedTime || now
    ));
  } else {
    stmts.push(db.prepare(`
      UPDATE collections
      SET title = ?, owner_token = ?, last_seen_at = ?, updated_time = ?
      WHERE id = ?
    `).raw(
      input.collection.title,
      input.collection.ownerToken || null,
      now,
      input.collection.updatedTime || now,
      collectionId
    ));
  }

  for (const item of uniqueItems.values()) {
    const contentPk = `${item.sourceType}:${item.sourceId}`;
    const key = `${item.sourceType}:${item.sourceId}`;
    const row = existingByKey.get(key);

    if (!row) {
      stmts.push(db.prepare(`
        INSERT INTO collection_items (
          collection_id, content_pk, source_type, source_id,
          title, author_name, source_url, first_seen_at, last_seen_at, is_removed, removed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
      `).raw(
        collectionId,
        contentPk,
        item.sourceType,
        item.sourceId,
        item.title,
        item.authorName,
        item.sourceUrl,
        now,
        now
      ));

      stmts.push(buildChangeStatement({
        eventType: "collection.item_added",
        entityType: "collection_item",
        entityPk: `${collectionId}:${key}`,
        contentPk,
        summary: `${input.collection.title} + ${item.title}`,
        payload: item
      }));

      added++;
      } else {
        // 条目字段完全一致且未处于移除态：没有新信息，跳过 UPDATE 与事件。
        // 旧逻辑每轮同步都把全量条目重写一遍，收藏夹稍大就会打满 D1 每日写入额度
        if (
          (row.title || "") === (item.title || "") &&
          (row.author_name || "") === (item.authorName || "") &&
          (row.source_url || "") === (item.sourceUrl || "") &&
          row.is_removed === 0
        ) {
          continue;
        }
        stmts.push(db.prepare(`
          UPDATE collection_items
          SET title = ?, author_name = ?, source_url = ?, last_seen_at = ?, is_removed = 0, removed_at = NULL
          WHERE id = ?
        `).raw(
          item.title,
          item.authorName,
          item.sourceUrl,
          now,
          row.id
        ));
        // 从"已移除"复活也要发事件：否则按事件流重放得不到库内状态
        // （收条目 → 移除 → 再收回来，事件流里中间断了一截）
        if (row.is_removed === 1) {
          stmts.push(buildChangeStatement({
            eventType: "collection.item_added",
            entityType: "collection_item",
            entityPk: `${collectionId}:${key}`,
            contentPk,
            summary: `${input.collection.title} + ${item.title}（重新加入）`,
            payload: item
          }));
        }
      }
  }

  if (!input.incremental) {
    for (const key of existingKeys) {
      if (!incomingKeys.has(key)) {
        const [sourceType, sourceId] = key.split(":");
        stmts.push(db.prepare(`
          UPDATE collection_items
          SET is_removed = 1, removed_at = ?, last_seen_at = ?
          WHERE collection_id = ? AND source_type = ? AND source_id = ?
        `).raw(now, now, collectionId, sourceType, sourceId));

        stmts.push(buildChangeStatement({
          eventType: "collection.item_removed",
          entityType: "collection_item",
          entityPk: `${collectionId}:${key}`,
          contentPk: key,
          summary: `${input.collection.title} - ${key}`,
          payload: { collectionId, sourceType, sourceId }
        }));

        removed++;
      }
    }
  }

  stmts.push(db.prepare(`
    INSERT INTO collection_snapshots (
      collection_id, snapshot_at, item_count, added_count, removed_count
    ) VALUES (?, ?, ?, ?, ?)
  `).raw(collectionId, now, input.items.length, added, removed));

  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    await db.batch(stmts.slice(i, i + BATCH_SIZE));
  }

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
  // page 钳制：超大值会让 OFFSET 超出 SQLite int64 直接 500
  const parsedPage = Number(params?.page ?? 1);
  const page = Number.isFinite(parsedPage) ? Math.min(Math.max(Math.trunc(parsedPage), 1), 100000) : 1;
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
