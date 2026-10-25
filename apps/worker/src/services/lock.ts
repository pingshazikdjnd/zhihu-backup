/**
 * 按 key 的进程内串行化锁。
 *
 * upsertContent / replaceComments / upsertCollectionSnapshot 都是
 * 「SELECT 在 batch 外、UPDATE 无版本条件」的读-比-写：并发同 pk 请求
 * 互相覆盖对方的写入（实测 60 并发 6/6 复现，最多 48/60 条更新被静默
 * 覆盖且全部响应 200 changed=true）。Workers 单 isolate 内并发请求
 * 共享模块状态，用它把同 key 的写串行化即可消除绝大多数竞态窗口
 * （跨 isolate 场景由 sync 防重入锁兜底——两个 run 并发本身已被挡）。
 */
const tails = new Map<string, Promise<unknown>>();

export async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(() => fn());
  // 新尾链吞掉错误，后续排队者不会被前一个的失败卡死
  const nextTail = run.catch(() => undefined);
  tails.set(key, nextTail);
  // 自己就是尾链时清理，避免 Map 随 key 无限增长
  nextTail.finally(() => {
    if (tails.get(key) === nextTail) tails.delete(key);
  });
  return run;
}
