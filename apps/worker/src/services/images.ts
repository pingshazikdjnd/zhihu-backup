import { sha256 } from "../utils/hash.js";
import {
  DEFAULT_IMAGE_QUALITY,
  getSyncConfig,
  normalizeImageQuality,
  type ImageQuality
} from "../routes/auth.js";

/**
 * 正文图片本地化：把知乎图床（*.zhimg.com）的 <img src> 下载进 R2，
 * 并把 HTML 里的外链改写成 /api/images/{sha256}.{ext}。
 *
 * 背景：R2 以前只存正文 HTML 与子评论 JSON，图片仍指向 pic*.zhimg.com 外链；
 * 外链一旦失效（回答被删、签名过期）备份就不完整。
 *
 * 设计要点：
 * - 幂等：对象 key 由图片 URL 归一化身份串（pathname）的 sha256 决定，
 *   写入前先 HEAD，命中就不再下载；
 * - 入库与下载解耦（P1）：/ingest/content 只做纯 CPU 的确定性改写——按图片身份
 *   算出本地对象名、立刻改写 <img src>、把下载任务写入 image_tasks；真正的网络
 *   下载由 /ingest/image-batch 后台批量执行，正文入库不再被图片 IO 拖住；
 * - 改写是确定性的：同一篇正文每次算出的 <img src> 与 content_hash 完全一致，
 *   单张图下载失败也不会让哈希在「外链/本地路径」之间来回跳变；
 * - 本地对象缺失时（任务还没跑完或已失败），/api/images/* 会 302 回退到任务表里
 *   记录的原始外链，可见行为等同于旧版「下载失败保留外链」；
 * - 单篇最多处理 MAX_IMAGES_PER_CONTENT 张，超出的保留外链；
 * - 全局并发闸门：整个 isolate 同一时刻最多处理 IMAGE_FETCH_CONCURRENCY 张图，
 *   爬虫批量 POST 多篇正文时共享槽位；响应带 content-length 时直接把 body 流式
 *   写进 R2，图片字节不经过 JS 堆，峰值只剩流缓冲区块；
 * - 图片质量按设置页的 imageQuality 决定：high/compressed 优先抓知乎图床官方
 *   _1440w / _720w 尺寸版本（Workers 无 Canvas，重新编码不可行），失败自动回退原图。
 */

// 图片对象在 R2 里的前缀，读取路由拼 key 时共用同一常量（避免两处写死）
export const IMAGE_KEY_PREFIX = "images/";
// 浏览器侧访问路径：Pages 的 _worker.js 会把 /api/* 反代到 Worker
const IMAGE_API_PREFIX = "/api/images/";
// 单篇正文最多本地化多少张图：入库改写与异步任务入队共用同一个上限
const MAX_IMAGES_PER_CONTENT = 50;
// 单张图片下载超时
const IMAGE_FETCH_TIMEOUT_MS = 10_000;
// 单张图片体积上限：10MB 覆盖知乎图床原图/4K 截图，更大的响应直接拒绝。
// 流式写 R2 时用它拒绝超限响应；响应缺 content-length 时才退回「读进堆再 put」的
// 兜底路径，这条路径的堆占用同样被这个上限卡死。
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// 图片并发数：既是单篇正文的分批大小，也是整个 isolate 的全局并发上限。
// 流式路径下图片字节不进堆，并发可以放大到 4；最坏情况（响应缺 content-length）
// 是 4 × 10MB 的兜底 buffer 上界，仍在 Worker 128MB 内存限额之内。
export const IMAGE_FETCH_CONCURRENCY = 4;

// 进程内（isolate 内）全局槽位：爬虫批量 POST 时会有多篇内容同时入库，
// 若只按「每篇 IMAGE_FETCH_CONCURRENCY 并发」计算，N 个请求叠加仍会打爆 miniflare 的 V8 堆。
// 这里让所有请求共享 IMAGE_FETCH_CONCURRENCY 个槽位，超出部分排队等待。
let activeImageSlots = 0;

/** 排队中的槽位等待者：grant 在槽位移交时调用，abort 时整项从队列移除 */
interface ImageSlotWaiter {
  grant: () => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const imageSlotWaiters: ImageSlotWaiter[] = [];

/**
 * 占用一个全局图片槽位；拿到槽位时 resolve(true)。
 * 传入 signal 时，等待期间被取消会把自己从队列里摘掉并 resolve(false)，
 * 避免 resolver 和它背后的图片闭包永久挂在队列里。
 */
function acquireImageSlot(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (activeImageSlots < IMAGE_FETCH_CONCURRENCY) {
    activeImageSlots += 1;
    return Promise.resolve(true);
  }
  return new Promise<boolean>(resolve => {
    const waiter: ImageSlotWaiter = { grant: () => resolve(true) };
    if (signal) {
      const onAbort = () => {
        const index = imageSlotWaiters.indexOf(waiter);
        // 已经不在队列里说明槽位刚好移交，不能再按取消处理
        if (index < 0) return;
        imageSlotWaiters.splice(index, 1);
        resolve(false);
      };
      waiter.signal = signal;
      waiter.onAbort = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
    }
    imageSlotWaiters.push(waiter);
  });
}

/** 归还槽位：有等待者时直接移交（activeImageSlots 不变），否则计数减一 */
function releaseImageSlot(): void {
  const next = imageSlotWaiters.shift();
  if (next) {
    if (next.signal && next.onAbort) {
      next.signal.removeEventListener("abort", next.onAbort);
    }
    next.grant();
    return;
  }
  activeImageSlots -= 1;
}

// 图片质量设置在 isolate 内缓存 60 秒：每篇正文入库都读一次 R2/D1 是无意义的读放大。
// 设置页保存后最迟 1 分钟对新下载的图片生效；已备份对象按 key 命中，不会重复下载。
const IMAGE_QUALITY_CACHE_TTL_MS = 60_000;
let cachedImageQuality: { at: number; quality: ImageQuality } | null = null;

/** 读取设置页保存的图片备份质量；任何异常都退回原图，绝不阻塞正文入库 */
export async function getImageQualitySetting(bucket: R2Bucket): Promise<ImageQuality> {
  if (cachedImageQuality && Date.now() - cachedImageQuality.at < IMAGE_QUALITY_CACHE_TTL_MS) {
    return cachedImageQuality.quality;
  }
  let quality: ImageQuality = DEFAULT_IMAGE_QUALITY;
  try {
    const cfg = await getSyncConfig(bucket);
    quality = normalizeImageQuality(cfg.imageQuality);
  } catch {
    quality = DEFAULT_IMAGE_QUALITY;
  }
  cachedImageQuality = { at: Date.now(), quality };
  return quality;
}

/** 对象名（不含 images/ 前缀）：64 位 sha256 hex + 扩展名。读取路由据此挡住目录穿越 */
export const IMAGE_OBJECT_NAME_RE = /^[a-f0-9]{64}\.[a-z0-9]{2,5}$/;

const ALLOWED_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg", "heic", "heif"
]);

const CONTENT_TYPE_BY_EXT: Record<string, string | undefined> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  heic: "image/heic",
  heif: "image/heif"
};

const EXT_BY_CONTENT_TYPE: Record<string, string | undefined> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/pjpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/heic": "heic",
  "image/heif": "heif"
};

function warnImage(message: string, err?: unknown): void {
  if (err === undefined) {
    console.warn(`[images] ${message}`);
    return;
  }
  console.warn(`[images] ${message}`, err instanceof Error ? err.message : err);
}

/** 读取路由用：R2 的 httpMetadata 缺失时按扩展名兜底 Content-Type */
export function contentTypeForImageName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return CONTENT_TYPE_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}

/**
 * 是否知乎图床域名（zhimg.com 及其子域）。
 * 入库改写与 /api/images/* 失败回退共用：只备份/重定向知乎图床，
 * 任意 URL 都 fetch 会让入库接口变成 SSRF 跳板，任意 URL 都 302 则可能变成开放重定向。
 * 只接受 https：http 图片会降级为明文传输，且容易被中间人替换成任意字节。
 */
export function isZhihuImageUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return host === "zhimg.com" || host.endsWith(".zhimg.com");
}

/**
 * 把 <img src> 归一成可抓取的绝对 URL。
 * - HTML 属性里的 &amp; 要先还原，否则签名 query 带进请求会 404；
 * - 协议相对地址（//picx.zhimg.com/...）补 https:；
 * - 已经是站内路径（/api/images/...）、data:、blob: 等一律跳过，避免二次处理和重复下载。
 */
function toFetchableUrl(src: string): string | null {
  const decoded = src.trim().replace(/&amp;/gi, "&");
  if (!decoded) return null;

  const absolute = decoded.startsWith("//") ? `https:${decoded}` : decoded;
  if (!/^https?:\/\//i.test(absolute)) return null;

  try {
    if (!isZhihuImageUrl(absolute)) return null;
    return new URL(absolute).toString();
  } catch {
    return null;
  }
}

/**
 * 图片身份串：只取 pathname，并剥掉知乎图床的尺寸后缀（_720w 等）。
 *
 * 知乎同一张图会轮换 pic1/picx 子域、追加签名 query、切换尺寸后缀，
 * 这些都不改变图片内容；拿完整 URL 做哈希会让同一篇回答每轮同步都被判定
 * 「正文有更新」（与 services/contents.ts 的 normalizeHtmlForHash 同一条规则），
 * 从而无限追加版本、变更事件和 R2 图片副本。
 */
function imageIdentity(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return url;
  }
  return pathname.replace(/^\/+/, "").replace(/_\d+w(?=\.[^./]+$)/i, "");
}

/** 从 URL 路径后缀推断扩展名；识别不了时返回 null，等下载后按 Content-Type 推断 */
function extensionFromUrl(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const match = pathname.match(/\.([a-z0-9]+)$/i);
  if (!match) return null;
  const ext = match[1].toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) return null;
  return ext === "jpeg" ? "jpg" : ext;
}

function extensionFromContentType(contentType: string): string | null {
  const base = contentType.split(";")[0].trim().toLowerCase();
  return EXT_BY_CONTENT_TYPE[base] ?? null;
}

// 知乎图床自带多档尺寸后缀（_720w / _1440w 等），直接取官方压缩版本比在 Worker 里
// 重新编码更稳：Workers / miniflare 没有 Canvas 或原生图像 API，纯 JS 编解码会打爆 CPU 与内存。
// 只对常见位图追加尺寸后缀；GIF/SVG 等格式保持原图，避免请求必然 404 的变体。
const SIZE_VARIANT_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

/**
 * 把图片 URL 换成知乎图床的官方尺寸版本。
 * - high       → _1440w（最长边约 1440px，视觉接近无损）
 * - compressed → _720w（最长边约 720px，体积明显更省）
 * 已经是目标尺寸、无法识别扩展名或非位图时原样返回，由调用方回退原图。
 */
function applySizeVariant(url: string, quality: ImageQuality): string {
  if (quality === "original") return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const pathname = parsed.pathname;
  // 先剥掉 URL 里已有的尺寸后缀，避免拼成 _720w_1440w 这种无效路径
  const stripped = pathname.replace(/_\d+w(?=\.[^./]+$)/i, "");
  const dot = stripped.lastIndexOf(".");
  const slash = stripped.lastIndexOf("/");
  if (dot <= slash) return url;

  const ext = stripped.slice(dot + 1).toLowerCase();
  if (!SIZE_VARIANT_EXTENSIONS.has(ext)) return url;

  const suffix = quality === "high" ? "_1440w" : "_720w";
  const nextPath = `${stripped.slice(0, dot)}${suffix}${stripped.slice(dot)}`;
  if (nextPath === pathname) return url;

  parsed.pathname = nextPath;
  return parsed.toString();
}

/** 按文档顺序提取 <img src>，相同 URL 只保留一次 */
function extractImgSources(html: string): string[] {
  const seen = new Set<string>();
  const sources: string[] = [];
  const tagRe = /<img\b[^>]*>/gi;
  const srcAttrRe = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRe.exec(html)) !== null) {
    const attrMatch = srcAttrRe.exec(tagMatch[0]);
    if (!attrMatch) continue;
    const src = (attrMatch[1] ?? attrMatch[2] ?? "").trim();
    if (!src || seen.has(src)) continue;
    seen.add(src);
    sources.push(src);
  }
  return sources;
}

/** 把已本地化的 src 替换成站内路径，未命中的标签原样保留 */
function rewriteImgSources(html: string, mapping: Map<string, string>): string {
  const srcRe = /(<img\b[^>]*?\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
  return html.replace(
    srcRe,
    (match: string, prefix: string, doubleQuoted: string, singleQuoted: string): string => {
      const original = (doubleQuoted ?? singleQuoted ?? "").trim();
      const localPath = mapping.get(original);
      if (!localPath) return match;
      return `${prefix}"${localPath}"`;
    }
  );
}

/** 提前放弃响应：显式 cancel 未消费的 body，避免 workerd 的 pending read 钉住 Promise 与闭包 */
async function cancelResponseBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // body 已被读取或已关闭时 cancel 会抛，忽略即可
  }
}

/** 解析 content-length；缺失或非法时返回 0，表示长度未知 */
function declaredContentLength(res: Response): number {
  const raw = res.headers.get("content-length");
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * 缺 content-length 时的兜底：按块读取响应体，累计超过上限立即 cancel 并放弃。
 * 这条路径会把图片读进 JS 堆，但峰值被 MAX_IMAGE_BYTES 硬限制住。
 * 返回 null 表示空 body、超限或读取失败。
 */
async function readBodyWithLimit(body: ReadableStream, maxBytes: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch (err) {
    warnImage("read image body failed", err);
    await reader.cancel().catch(() => {});
    return null;
  } finally {
    reader.releaseLock();
  }
  if (total === 0) return null;

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * 下载单张图片并直接写入 R2：10 秒超时，体积超限或非图片响应都按失败处理。
 * 响应带 content-length 时把 res.body 交给 bucket.put 流式落盘，图片字节不经过
 * isolate 的 JS 堆；缺长度时才退回带 MAX_IMAGE_BYTES 上限的读入堆兜底。
 * 所有放弃路径都显式 cancel body；返回落盘用的扩展名。
 */
async function fetchImage(
  url: string,
  bucket: R2Bucket,
  hash: string,
  urlExt: string | null,
  quality: ImageQuality,
  sourceUrl: string,
  signal?: AbortSignal
): Promise<{ ext: string } | null> {
  if (signal?.aborted) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  // 外部请求取消（客户端断开）时一并中断下载与写盘
  const abortFromOuter = () => controller.abort();
  signal?.addEventListener("abort", abortFromOuter, { once: true });

  let res: Response | null = null;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      // 不跟随重定向：知乎图床不应 3xx，跟随会放大 SSRF/开放重定向面。
      // 3xx 一律按失败处理并显式 cancel body。
      redirect: "manual",
      headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5" }
    });
    if (res.status >= 300 && res.status < 400) {
      warnImage(`download ${url} rejected redirect with HTTP ${res.status}`);
      await cancelResponseBody(res);
      return null;
    }
    if (!res.ok) {
      warnImage(`download ${url} failed with HTTP ${res.status}`);
      await cancelResponseBody(res);
      return null;
    }

    const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    // 图床签名失效时经常回一段 HTML 错误页，不能当图片存进 R2
    if (contentType && !contentType.startsWith("image/") && contentType !== "application/octet-stream") {
      warnImage(`download ${url} returned non-image content-type: ${contentType}`);
      await cancelResponseBody(res);
      return null;
    }

    const declaredLength = declaredContentLength(res);
    if (declaredLength > MAX_IMAGE_BYTES) {
      warnImage(`download ${url} skipped: content-length ${declaredLength} exceeds limit`);
      await cancelResponseBody(res);
      return null;
    }

    const body = res.body;
    if (!body) {
      warnImage(`download ${url} returned empty body`);
      return null;
    }

    const ext = urlExt ?? extensionFromContentType(contentType) ?? "jpg";
    const key = `${IMAGE_KEY_PREFIX}${hash}.${ext}`;

    // urlExt 存在时调用方已 HEAD 过；无扩展名时这里补一次，命中就不必再消费响应体
    if (!urlExt && (await bucket.head(key))) {
      await cancelResponseBody(res);
      return { ext };
    }

    const putOptions = {
      httpMetadata: { contentType: contentType || "application/octet-stream" },
      // 留个来源线索方便排查；R2 customMetadata 值过长会写入失败，截断到 900 字符
      customMetadata: { kind: "image", quality, sourceUrl: sourceUrl.slice(0, 900) }
    };

    if (declaredLength > 0) {
      // 已知长度：直接把网络流交给 R2，图片字节不进入 JS 堆
      await bucket.put(key, body, putOptions);
      return { ext };
    }

    // 缺 content-length（chunked）时无法用 FixedLengthStream，只能退回流式读入堆再 put
    const buffered = await readBodyWithLimit(body, MAX_IMAGE_BYTES);
    if (!buffered) {
      warnImage(`download ${url} skipped: body empty or exceeds ${MAX_IMAGE_BYTES} bytes`);
      return null;
    }
    await bucket.put(key, buffered, putOptions);
    return { ext };
  } catch (err) {
    warnImage(`download ${url} failed`, err);
    if (res) await cancelResponseBody(res);
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromOuter);
  }
}

/**
 * 单张图片：算 hash → 查 R2 → 未命中则下载并写入 → 返回站内路径。
 * 失败返回 null，由调用方保留原外链。
 */
async function localizeOne(
  sourceUrl: string,
  bucket: R2Bucket,
  quality: ImageQuality,
  signal?: AbortSignal
): Promise<string | null> {
  // 哈希吃归一化后的身份串而不是完整 URL：图床子域/签名/尺寸抖动不能换来新 key
  const hash = await sha256(imageIdentity(sourceUrl));
  const urlExt = extensionFromUrl(sourceUrl);

  // URL 自带扩展名时先 HEAD：已备份过的图直接复用，不产生下载流量
  if (urlExt) {
    const expectedKey = `${IMAGE_KEY_PREFIX}${hash}.${urlExt}`;
    if (await bucket.head(expectedKey)) return `${IMAGE_API_PREFIX}${hash}.${urlExt}`;

    // 历史对象兼容：P0 之前用 sha256(完整 URL) 做 key，现在改用归一化 pathname。
    // 同一图片的旧 key 若已存在，直接复用避免重复下载（旧对象成孤儿可后续清理）。
    const legacyHash = await sha256(sourceUrl);
    if (legacyHash !== hash) {
      const legacyKey = `${IMAGE_KEY_PREFIX}${legacyHash}.${urlExt}`;
      if (await bucket.head(legacyKey)) {
        // 把旧对象复制到新 key，让新旧路径都能访问；只有复制真正成功才复用，否则回退重抓写入 expectedKey
        try {
          const obj = await bucket.get(legacyKey);
          if (obj) {
            await bucket.put(expectedKey, obj.body, {
              httpMetadata: { contentType: obj.httpMetadata?.contentType || "image/jpeg" },
              customMetadata: obj.customMetadata || {}
            });
            return `${IMAGE_API_PREFIX}${hash}.${urlExt}`;
          }
        } catch (err) {
          warnImage(`copy legacy image ${legacyKey} -> ${expectedKey} failed`, err);
        }
      }
    }
  }

  // 非原图模式优先抓知乎图床的官方尺寸版本；该版本不存在（404/非图片）时
  // 回退原图，保证「压缩失败」永远不会变成「图片没备份」。
  const variantUrl = applySizeVariant(sourceUrl, quality);
  const candidates = variantUrl === sourceUrl ? [sourceUrl] : [variantUrl, sourceUrl];
  for (const candidate of candidates) {
    // 请求已取消就别再发起下一次尝试（变体失败后的原图回退也一并跳过）
    if (signal?.aborted) return null;
    const stored = await fetchImage(candidate, bucket, hash, urlExt, quality, sourceUrl, signal);
    if (stored) return `${IMAGE_API_PREFIX}${hash}.${stored.ext}`;
    if (candidate !== sourceUrl) warnImage(`variant ${candidate} unavailable, fallback to original`);
  }
  return null;
}

/** 供图片任务队列调用：下载单张图片并返回站内路径（受全局并发槽位限制）；失败返回 null */
export async function localizeImage(
  sourceUrl: string,
  bucket: R2Bucket,
  qualityOverride?: ImageQuality,
  signal?: AbortSignal
): Promise<string | null> {
  if (!isZhihuImageUrl(sourceUrl)) return null;
  const quality = qualityOverride ?? (await getImageQualitySetting(bucket));
  const acquired = await acquireImageSlot(signal);
  if (!acquired) return null;
  try {
    return await localizeOne(sourceUrl, bucket, quality, signal);
  } finally {
    releaseImageSlot();
  }
}

/** 待本地化的图片：src 是 HTML 里的原始属性值，url 是归一化后的可抓取地址 */
interface ContentImageTarget {
  src: string;
  url: string;
}

/** 入库时生成的图片下载任务：路径已在改写阶段确定，批量消费只负责下载 */
export interface PreparedImageTask {
  /** HTML 里原始的 <img src>：下载失败时读取路由回退 302 的目标 */
  imageUrl: string;
  /** R2 对象名（含 images/ 前缀）：入库时即确定，任务表据此去重 */
  objectKey: string;
}

export interface PreparedContentImages {
  /** 已把可本地化的 <img src> 换成站内路径的 HTML（其余标签原样保留） */
  html: string;
  /** 需要异步下载的图片任务（按 objectKey 去重） */
  tasks: PreparedImageTask[];
}

/**
 * 入库阶段的图片预处理（P1）：只做纯 CPU 的确定性改写 + 生成下载任务，不发任何网络请求。
 *
 * 本地路径 = sha256(图片身份串) + URL 扩展名，和 localizeOne 的落盘 key 完全一致，
 * 所以 HTML 可以「先假设下载会成功」直接改写；下载失败时由 /api/images/* 回退到外链。
 * 这样 ingest 请求的内存与耗时恒定，也不会因为单图成败让 content_hash 抖动。
 *
 * URL 里识别不出扩展名时保持外链：扩展名是对象名的一部分，要下载后看 Content-Type
 * 才能确定，而异步回写 HTML 会连带改变 content_hash，得不偿失（这类 URL 极少）。
 */
export async function prepareContentImages(html: string): Promise<PreparedContentImages> {
  if (!html || !/<img\b/i.test(html)) return { html, tasks: [] };

  try {
    const sources = extractImgSources(html);
    if (!sources.length) return { html, tasks: [] };

    const targets: ContentImageTarget[] = sources
      .map(src => ({ src, url: toFetchableUrl(src) }))
      .filter((item): item is ContentImageTarget => item.url !== null)
      .slice(0, MAX_IMAGES_PER_CONTENT);
    if (!targets.length) return { html, tasks: [] };

    const mapping = new Map<string, string>();
    const tasks = new Map<string, PreparedImageTask>();
    for (const target of targets) {
      const urlExt = extensionFromUrl(target.url);
      if (!urlExt) continue;
      const hash = await sha256(imageIdentity(target.url));
      mapping.set(target.src, `${IMAGE_API_PREFIX}${hash}.${urlExt}`);
      const objectKey = `${IMAGE_KEY_PREFIX}${hash}.${urlExt}`;
      if (!tasks.has(objectKey)) {
        tasks.set(objectKey, { imageUrl: target.url, objectKey });
      }
    }
    if (!mapping.size) return { html, tasks: [] };

    return {
      html: rewriteImgSources(html, mapping),
      tasks: Array.from(tasks.values())
    };
  } catch (err) {
    // 图片备份是增值能力：预处理异常绝不能阻塞正文入库
    warnImage("prepareContentImages skipped", err);
    return { html, tasks: [] };
  }
}

/**
 * 下载一批目标图片，返回 src → 站内路径映射。
 *
 * 单独成函数是刻意的：并发 promise 只捕获这里的 targets / bucket / quality / signal，
 * 不再把整篇正文 html 挂进每个图片闭包；长正文 × 多图时少一份整篇 HTML 的驻留。
 */
async function downloadImages(
  targets: ContentImageTarget[],
  bucket: R2Bucket,
  quality: ImageQuality,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const mapping = new Map<string, string>();
  // 分批并发：Promise.all 保证同批失败会等到全部 settle 后再进入下一批。
  // 每张图还要先抢全局槽位（跨请求共享），保证同一时刻最多 IMAGE_FETCH_CONCURRENCY 张图在下载。
  for (let i = 0; i < targets.length; i += IMAGE_FETCH_CONCURRENCY) {
    const chunk = targets.slice(i, i + IMAGE_FETCH_CONCURRENCY);
    await Promise.all(
      chunk.map(async target => {
        if (signal?.aborted) return;
        try {
          const acquired = await acquireImageSlot(signal);
          // 排队期间请求被取消：槽位没拿到，放弃这张图
          if (!acquired) return;
          try {
            const localPath = await localizeOne(target.url, bucket, quality, signal);
            if (localPath) mapping.set(target.src, localPath);
          } finally {
            // 无论成功/失败/超时都归还槽位，否则一次异常会让后续图片永久排队
            releaseImageSlot();
          }
        } catch (err) {
          // 单图失败（HEAD/PUT 异常等）只保留原外链
          warnImage(`localize ${target.url} failed`, err);
        }
      })
    );
    if (signal?.aborted) break;
  }
  return mapping;
}

/**
 * 同步版图片本地化：下载成功才改写 <img src>，失败保留外链。
 * /ingest/content 已改为「确定性改写 + 任务队列」（见 prepareContentImages），
 * 常规入库不再调用本函数；保留它给一次性补采/脚本复用。
 * 第三个参数供调用方显式指定质量（测试/批量补采）；缺省时读设置页保存的 imageQuality。
 * 第四个参数是可选取消信号：请求取消时停止排队与下载，已排队的槽位等待者会立即出队。
 */
export async function processContentImages(
  html: string,
  bucket: R2Bucket,
  qualityOverride?: ImageQuality,
  signal?: AbortSignal
): Promise<string> {
  if (!html || !/<img\b/i.test(html)) return html;

  try {
    const sources = extractImgSources(html);
    if (!sources.length) return html;

    const quality = qualityOverride ?? (await getImageQualitySetting(bucket));

    const targets: ContentImageTarget[] = sources
      .map(src => ({ src, url: toFetchableUrl(src) }))
      .filter((item): item is ContentImageTarget => item.url !== null)
      .slice(0, MAX_IMAGES_PER_CONTENT);

    const mapping = await downloadImages(targets, bucket, quality, signal);
    if (!mapping.size) return html;
    return rewriteImgSources(html, mapping);
  } catch (err) {
    warnImage("processContentImages skipped", err);
    return html;
  }
}
