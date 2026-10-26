import { AsyncLocalStorage } from "node:async_hooks";

// D1Database is provided by @cloudflare/workers-types
export const dbContext = new AsyncLocalStorage<any>();

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

  transaction: async (fn: Function) => {
    // 保留兼容：D1 上它只是顺序执行，不会回滚。
    // 新代码请直接用 db.batch()。
    return await fn();
  }
};
