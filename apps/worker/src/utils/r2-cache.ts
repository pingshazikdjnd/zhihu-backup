/**
 * R2 读取的边缘缓存加速层。
 *
 * 背景：详情页每次刷新都会从 R2 读正文 HTML 与楼中楼 JSON，热数据会反复消耗
 * R2 Class B（get）配额。正文 HTML 带 content_hash、天然不可变；楼中楼 JSON
 * 只在评论同步时整体覆盖。两者都适合放在 Cloudflare 全球边缘缓存里。
 *
 * 实现为两层：
 * 1. 进程内 Map（最多 200 条、带 TTL）：wrangler dev / 单测环境没有
 *    `caches.default`，这一层仍能消除同一 isolate 内的重复 R2 读取；
 * 2. `caches.default`：生产环境跨 colo / 跨 isolate 的边缘缓存，命中时
 *    0 次 R2 Class B 调用。
 *
 * 一致性：写入方（comments.ts 的 replaceCommentsByRootInner）每次覆盖或删除
 * childcomments/* 后必须立刻调用 purgeR2EdgeCache，否则边缘缓存会读到旧楼中楼。
 */

const EDGE_CACHE_ORIGIN = "https://r2-edge-cache.internal";
const MEMORY_MAX_ENTRIES = 200;
const DEFAULT_TTL_SECONDS = 86400;
const IMMUTABLE_TTL_SECONDS = 31536000;

type MemoryEntry = {
  text: string;
  expiresAt: number;
  /** 用于区分同一个 isolate 内不同 R2 bucket 实例（生产只有一个；单测每个用例一个 mock） */
  bucket: R2Bucket;
};

const memoryCache = new Map<string, MemoryEntry>();

export type R2EdgeCacheOptions = {
  /** 内容不可变（例如带 content_hash 的正文 HTML）：缓存一年并标记 immutable */
  immutable?: boolean;
  /** 可变内容的缓存秒数，默认 86400 */
  ttlSeconds?: number;
};

function edgeCacheUrl(r2Key: string): string {
  return `${EDGE_CACHE_ORIGIN}/${encodeURIComponent(r2Key)}`;
}

function resolveTtlSeconds(opts: R2EdgeCacheOptions): number {
  if (opts.immutable) return IMMUTABLE_TTL_SECONDS;
  const ttl = opts.ttlSeconds;
  if (typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0) return Math.trunc(ttl);
  return DEFAULT_TTL_SECONDS;
}

/** 本地 dev / 单测没有 caches.default 时返回 null，全部读写静默跳过 */
function getDefaultCache(): any {
  try {
    const cache = (globalThis as any).caches?.default;
    if (cache && typeof cache.match === "function" && typeof cache.put === "function") return cache;
  } catch {
    /* 某些运行时不暴露 caches，按没有处理 */
  }
  return null;
}

function readMemory(r2Key: string, bucket: R2Bucket): string | null {
  const entry = memoryCache.get(r2Key);
  if (!entry) return null;
  if (entry.bucket !== bucket || entry.expiresAt <= Date.now()) {
    // 同 key 属于别的 bucket 实例（单测）或已过期：当作未命中并清掉
    memoryCache.delete(r2Key);
    return null;
  }
  return entry.text;
}

function writeMemory(r2Key: string, bucket: R2Bucket, text: string, ttlSeconds: number): void {
  const now = Date.now();
  // 先清过期项，再按插入顺序淘汰最老的，保证 Map 不超过上限
  for (const [key, entry] of memoryCache) {
    if (entry.expiresAt <= now) memoryCache.delete(key);
  }
  memoryCache.delete(r2Key);
  while (memoryCache.size >= MEMORY_MAX_ENTRIES) {
    const oldest = memoryCache.keys().next();
    if (oldest.done) break;
    memoryCache.delete(oldest.value);
  }
  memoryCache.set(r2Key, { text, expiresAt: now + ttlSeconds * 1000, bucket });
}

/**
 * 读 R2 文本，优先命中内存 Map 与 caches.default。
 * 命中缓存时不会产生任何 R2 `bucket.get`（Class B）调用。
 */
export async function getR2TextWithEdgeCache(
  bucket: R2Bucket,
  r2Key: string,
  opts: R2EdgeCacheOptions = {}
): Promise<string | null> {
  const ttlSeconds = resolveTtlSeconds(opts);

  const fromMemory = readMemory(r2Key, bucket);
  if (fromMemory !== null) return fromMemory;

  const cacheUrl = edgeCacheUrl(r2Key);
  const edge = getDefaultCache();
  if (edge) {
    try {
      const hit = await edge.match(cacheUrl);
      if (hit) {
        const text = await hit.text();
        writeMemory(r2Key, bucket, text, ttlSeconds);
        return text;
      }
    } catch {
      // 边缘缓存不可用时继续回源 R2，读取路径绝不能因此失败
    }
  }

  const obj = await bucket.get(r2Key);
  if (!obj) return null;
  const text = await obj.text();

  writeMemory(r2Key, bucket, text, ttlSeconds);

  if (edge) {
    try {
      const cacheControl = opts.immutable
        ? `public, max-age=${IMMUTABLE_TTL_SECONDS}, immutable`
        : `public, max-age=${ttlSeconds}`;
      await edge.put(
        cacheUrl,
        new Response(text, {
          headers: {
            "Cache-Control": cacheControl,
            "Content-Type": "text/plain; charset=utf-8"
          }
        })
      );
    } catch {
      // 写入边缘缓存失败只影响加速，不影响本次读取结果
    }
  }

  return text;
}

/**
 * 清掉某个 R2 key 的两层缓存。
 * 调用方在 BUCKET.put / BUCKET.delete 之后必须立即执行，保证更新立刻可见。
 */
export async function purgeR2EdgeCache(r2Key: string): Promise<void> {
  memoryCache.delete(r2Key);
  const edge = getDefaultCache();
  if (!edge || typeof (edge as any).delete !== "function") return;
  try {
    await (edge as any).delete(edgeCacheUrl(r2Key));
  } catch {
    // 缓存删除失败不应让写路径失败：最坏情况是缓存条目自然过期
  }
}
