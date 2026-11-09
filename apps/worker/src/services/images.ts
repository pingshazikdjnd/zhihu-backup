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
 * - 单图失败只回退该图的外链，绝不影响正文入库；
 * - 单篇最多处理 MAX_IMAGES_PER_CONTENT 张，超出的保留外链，避免超长正文拖垮入库请求；
 * - 全局并发闸门：整个 isolate 同一时刻最多处理 IMAGE_FETCH_CONCURRENCY 张图，
 *   爬虫批量 POST 多篇正文时共享槽位，图片 buffer 峰值有硬上限；
 * - 图片质量按设置页的 imageQuality 决定：high/compressed 优先抓知乎图床官方
 *   _1440w / _720w 尺寸版本（Workers 无 Canvas，重新编码不可行），失败自动回退原图。
 */

// 图片对象在 R2 里的前缀，读取路由拼 key 时共用同一常量（避免两处写死）
export const IMAGE_KEY_PREFIX = "images/";
// 浏览器侧访问路径：Pages 的 _worker.js 会把 /api/* 反代到 Worker
const IMAGE_API_PREFIX = "/api/images/";
// 单篇正文最多本地化多少张图
const MAX_IMAGES_PER_CONTENT = 50;
// 单张图片下载超时
const IMAGE_FETCH_TIMEOUT_MS = 10_000;
// 单张图片体积上限：miniflare / Workers 单次请求的堆内存有限。
// 5MB 覆盖知乎图床 _1440w 版本的常见体积；更大的原图保留外链，
// 避免一张超大图就把 isolate 堆推高。
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// 图片并发数：既是单篇正文的分批大小，也是整个 isolate 的全局并发上限。
// 2 并发 × 5MB = 10MB 是图片下载可同时驻留的内存上界。
const IMAGE_FETCH_CONCURRENCY = 2;

// 进程内（isolate 内）全局槽位：爬虫批量 POST 时会有多篇内容同时入库，
// 若只按「每篇 2 并发」计算，N 个请求叠加仍会打爆 miniflare 的 V8 堆。
// 这里让所有请求共享 IMAGE_FETCH_CONCURRENCY 个槽位，超出部分排队等待。
let activeImageSlots = 0;
const imageSlotWaiters: Array<() => void> = [];

/** 占用一个全局图片槽位；返回的 Promise 在拿到槽位后 resolve */
function acquireImageSlot(): Promise<void> {
  if (activeImageSlots < IMAGE_FETCH_CONCURRENCY) {
    activeImageSlots += 1;
    return Promise.resolve();
  }
  return new Promise<void>(resolve => {
    imageSlotWaiters.push(resolve);
  });
}

/** 归还槽位：有等待者时直接移交（activeImageSlots 不变），否则计数减一 */
function releaseImageSlot(): void {
  const next = imageSlotWaiters.shift();
  if (next) {
    next();
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

  let parsed: URL;
  try {
    parsed = new URL(absolute);
  } catch {
    return null;
  }

  // 只备份知乎图床：任意 URL 都 fetch 会让入库接口变成 SSRF 跳板
  const host = parsed.hostname.toLowerCase();
  if (host !== "zhimg.com" && !host.endsWith(".zhimg.com")) return null;

  return parsed.toString();
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

/** 下载单张图片：10 秒超时，体积超限或非图片响应都按失败处理 */
async function fetchImage(url: string): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5" }
    });
    if (!res.ok) {
      warnImage(`download ${url} failed with HTTP ${res.status}`);
      return null;
    }

    const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    // 图床签名失效时经常回一段 HTML 错误页，不能当图片存进 R2
    if (contentType && !contentType.startsWith("image/") && contentType !== "application/octet-stream") {
      warnImage(`download ${url} returned non-image content-type: ${contentType}`);
      return null;
    }

    const declaredLength = Number(res.headers.get("content-length") || "0");
    if (declaredLength > MAX_IMAGE_BYTES) {
      warnImage(`download ${url} skipped: content-length ${declaredLength} exceeds limit`);
      return null;
    }

    const body = await res.arrayBuffer();
    if (body.byteLength === 0) {
      warnImage(`download ${url} returned empty body`);
      return null;
    }
    if (body.byteLength > MAX_IMAGE_BYTES) {
      warnImage(`download ${url} skipped: body ${body.byteLength} exceeds limit`);
      return null;
    }

    return { body, contentType: contentType || "application/octet-stream" };
  } catch (err) {
    warnImage(`download ${url} failed`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 单张图片：算 hash → 查 R2 → 未命中则下载并写入 → 返回站内路径。
 * 失败返回 null，由调用方保留原外链。
 */
async function localizeOne(
  sourceUrl: string,
  bucket: R2Bucket,
  quality: ImageQuality
): Promise<string | null> {
  // 哈希吃归一化后的身份串而不是完整 URL：图床子域/签名/尺寸抖动不能换来新 key
  const hash = await sha256(imageIdentity(sourceUrl));
  const urlExt = extensionFromUrl(sourceUrl);

  // URL 自带扩展名时先 HEAD：已备份过的图直接复用，不产生下载流量
  if (urlExt) {
    const expectedKey = `${IMAGE_KEY_PREFIX}${hash}.${urlExt}`;
    if (await bucket.head(expectedKey)) return `${IMAGE_API_PREFIX}${hash}.${urlExt}`;
  }

  // 非原图模式优先抓知乎图床的官方尺寸版本；该版本不存在（404/非图片）时
  // 回退原图，保证「压缩失败」永远不会变成「图片没备份」。
  const variantUrl = applySizeVariant(sourceUrl, quality);
  let downloaded: { body: ArrayBuffer; contentType: string } | null = null;
  if (variantUrl !== sourceUrl) {
    downloaded = await fetchImage(variantUrl);
    if (!downloaded) warnImage(`variant ${variantUrl} unavailable, fallback to original`);
  }
  if (!downloaded) {
    downloaded = await fetchImage(sourceUrl);
  }
  if (!downloaded) return null;

  const ext = urlExt ?? extensionFromContentType(downloaded.contentType) ?? "jpg";
  const key = `${IMAGE_KEY_PREFIX}${hash}.${ext}`;

  // urlExt 存在时上面已经 HEAD 过且 miss；只有「URL 无扩展名」才需要补一次 HEAD
  const stored = urlExt ? false : Boolean(await bucket.head(key));
  if (!stored) {
    await bucket.put(key, downloaded.body, {
      httpMetadata: { contentType: downloaded.contentType },
      // 留个来源线索方便排查；R2 customMetadata 值过长会写入失败，截断到 900 字符
      customMetadata: { kind: "image", quality, sourceUrl: sourceUrl.slice(0, 900) }
    });
  }

  // 显式断开大 buffer 引用：put 返回后它已无用途，尽早交给 GC，
  // 避免下一张图下载时旧 buffer 还挂在当前作用域里抬高峰值。
  downloaded = null;

  return `${IMAGE_API_PREFIX}${hash}.${ext}`;
}

/**
 * 把正文 HTML 里的知乎图片下载进 R2，并重写为站内路径。
 * 任何异常都返回原始 HTML：图片备份是增值能力，不能阻塞正文入库。
 * 第三个参数供调用方显式指定质量（测试/批量补采）；缺省时读设置页保存的 imageQuality。
 */
export async function processContentImages(
  html: string,
  bucket: R2Bucket,
  qualityOverride?: ImageQuality
): Promise<string> {
  if (!html || !/<img\b/i.test(html)) return html;

  try {
    const sources = extractImgSources(html);
    if (!sources.length) return html;

    const quality = qualityOverride ?? (await getImageQualitySetting(bucket));

    const targets = sources
      .map(src => ({ src, url: toFetchableUrl(src) }))
      .filter((item): item is { src: string; url: string } => item.url !== null)
      .slice(0, MAX_IMAGES_PER_CONTENT);

    const mapping = new Map<string, string>();
    // 分批并发：Promise.all 保证同批失败会等到全部 settle 后再进入下一批。
    // 每张图还要先抢全局槽位（跨请求共享），保证同一时刻最多 2 张大 buffer 驻留。
    for (let i = 0; i < targets.length; i += IMAGE_FETCH_CONCURRENCY) {
      const chunk = targets.slice(i, i + IMAGE_FETCH_CONCURRENCY);
      await Promise.all(
        chunk.map(async target => {
          try {
            await acquireImageSlot();
            try {
              const localPath = await localizeOne(target.url, bucket, quality);
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
    }

    if (!mapping.size) return html;
    return rewriteImgSources(html, mapping);
  } catch (err) {
    warnImage("processContentImages skipped", err);
    return html;
  }
}
