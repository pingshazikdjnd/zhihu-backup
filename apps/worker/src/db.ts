import { AsyncLocalStorage } from "node:async_hooks";

// D1Database is provided by @cloudflare/workers-types
export const dbContext = new AsyncLocalStorage<any>();

/**
 * 共享收藏聚合 JOIN（配合 0004 的 idx_collection_items_content_removed 覆盖索引）。
 * - local_fav_count：该内容在所有收藏夹里未移除的条目数（GROUP BY 去重，避免行数膨胀）
 * - fav_added_at：最早收藏时间（问题详情页「收藏于」展示仍依赖）
 * 调用方统一写 `LEFT JOIN ${FAV_JOIN_SQL}`，别名固定为 fav。
 */
export const FAV_JOIN_SQL = "LEFT JOIN (SELECT content_pk, COUNT(*) AS local_fav_count, MAX(first_seen_at) AS fav_added_at FROM collection_items WHERE is_removed = 0 GROUP BY content_pk) fav ON fav.content_pk = c.pk";

function d1OrThrow() {
  const d1 = dbContext.getStore();
  if (!d1) throw new Error("DB context missing");
  return d1;
}

export const db = {
  prepare: (query: string) => {
    const build = (params: any[]) => {
      const d1 = d1OrThrow();
      return params.length > 0 ? d1.prepare(query).bind(...params) : d1.prepare(query);
    };

    return {
      get: async <T = any>(...params: any[]): Promise<T | null> => {
        return await build(params).first();
      },
      all: async <T = any>(...params: any[]): Promise<T[]> => {
        const res = await build(params).all();
        return res.results;
      },
      run: async (...params: any[]) => {
        return await build(params).run();
      },
      /** 返回原生 D1 prepared statement，供 batch() 使用 */
      raw: (...params: any[]) => build(params)
    };
  },

  /**
   * 原子批量写入。
   * D1 没有交互式事务（BEGIN/COMMIT），batch() 内部串行执行且整体成功或整体失败，
   * 这是 D1 上唯一的原子手段。成对写入（比如更新正文 + 插版本快照）必须走这里。
   */
  batch: async (stmts: any[]) => {
    if (!stmts.length) return [];
    return await d1OrThrow().batch(stmts);
  },

  /**
   * @deprecated D1 不支持交互式事务（BEGIN/COMMIT）：此方法只是把回调顺序执行一遍，
   * 中途抛错不会回滚已执行的语句。需要原子写入请直接使用 db.batch()。
   */
  transaction: async (fn: Function) => {
    // 保留兼容：D1 上它只是顺序执行，不会回滚。
    // 新代码请直接用 db.batch()。
    return await fn();
  }
};
