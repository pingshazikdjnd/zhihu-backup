/**
 * R2 读取的边缘缓存加速层。
 *
 * 背景：详情页每次刷新都会从 R2 读正文 HTML 与楼中楼 JSON，热数据会反复消耗
 * R2 Class B（get）配额。正文 HTML 带 content_hash、天然不可变；楼中楼 JSON
 * 只在评论同步时整体覆盖。两者都适合放在 Cloudflare 全球边缘缓存里。
 *
 * 实现为两层：
 * 1. 进程内 Map（按总字节数封顶、带 TTL）：wrangler dev / 单测环境没有
 *    `caches.default`，这一层仍能消除同一 isolate 内的重复 R2 读取。
 *    上限按字节而不是条数：一条正文 HTML 可能几百 KB，按「200 条」封顶
 *    最坏会驻留几十 MB；超过 MEMORY_ENTRY_MAX_BYTES 的大对象直接不进这一层；
 * 2. `caches.default`：生产环境跨 colo / 跨 isolate 的边缘缓存，命中时
 *    0 次 R2 Class B 调用。
 *
 * 一致性：写入方（comments.ts 的 replaceCommentsByRootInner）每次覆盖或删除
 * childcomments/* 后必须立刻调用 purgeR2EdgeCache，否则边缘缓存会读到旧楼中楼。
 */

const EDGE_CACHE_ORIGIN = "https://r2-edge-cache.internal";
// 进程内缓存的总字节上限（UTF-16 估算：text.length * 2）。
// 16MB 足够放下几十篇常见长度的正文，又不会像「200 条」那样被大 HTML 撑爆。
const MEMORY_MAX_BYTES = 16 * 1024 * 1024;
// 单条超过 64KB 的正文不进内存缓存：一条 300KB 的 HTML 会挤掉大量热数据，
// 且这类对象本来就会命中边缘缓存，进程内再留一份收益有限。
const MEMORY_ENTRY_MAX_BYTES = 64 * 1024;
// 条目数硬上限：只防「大量极小对象」让 Map 的 key 无限增长（字节上限对空串无效）
const MEMORY_MAX_ENTRIES = 500;
const DEFAULT_TTL_SECONDS = 86400;
const IMMUTABLE_TTL_SECONDS = 31536000;

type MemoryEntry = {
  text: string;
  /** UTF-16 估算占用的字节数：text.length * 2 */
  bytes: number;
  expiresAt: number;
  /** 用于区分同一个 isolate 内不同 R2 bucket 实例（生产只有一个；单测每个用例一个 mock） */
  bucket: R2Bucket;
};

const memoryCache = new Map<string, MemoryEntry>();
// 当前进程内缓存占用的总字节数，与 memoryCache 同步增删
let memoryBytes = 0;

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

/** 从内存缓存摘掉一个 key，并同步扣减总字节数 */
function evictMemory(r2Key: string): void {
  const entry = memoryCache.get(r2Key);
  if (!entry) return;
  memoryCache.delete(r2Key);
  memoryBytes -= entry.bytes;
}

function readMemory(r2Key: string, bucket: R2Bucket): string | null {
  const entry = memoryCache.get(r2Key);
  if (!entry) return null;
  if (entry.bucket !== bucket || entry.expiresAt <= Date.now()) {
    // 同 key 属于别的 bucket 实例（单测）或已过期：当作未命中并清掉
    evictMemory(r2Key);
    return null;
  }
  return entry.text;
}

function writeMemory(r2Key: string, bucket: R2Bucket, text: string, ttlSeconds: number): void {
  const now = Date.now();
  const bytes = text.length * 2;

  // 先清过期项，再腾出空间：总字节与条目数任一超限都按插入顺序淘汰最老的
  for (const [key, entry] of memoryCache) {
    if (entry.expiresAt <= now) evictMemory(key);
  }
  // 同 key 覆盖先摘掉旧值，避免同一份内容被重复计入字节数
  evictMemory(r2Key);

  // 大对象直接跳过进程内缓存，只走边缘缓存
  if (bytes > MEMORY_ENTRY_MAX_BYTES) return;

  while (
    memoryCache.size > 0 &&
    (memoryBytes + bytes > MEMORY_MAX_BYTES || memoryCache.size >= MEMORY_MAX_ENTRIES)
  ) {
    const oldest = memoryCache.keys().next();
    if (oldest.done) break;
    evictMemory(oldest.value);
  }

  memoryCache.set(r2Key, { text, bytes, expiresAt: now + ttlSeconds * 1000, bucket });
  memoryBytes += bytes;
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
  evictMemory(r2Key);
  const edge = getDefaultCache();
  if (!edge || typeof (edge as any).delete !== "function") return;
  try {
    await (edge as any).delete(edgeCacheUrl(r2Key));
  } catch {
    // 缓存删除失败不应让写路径失败：最坏情况是缓存条目自然过期
  }
}
