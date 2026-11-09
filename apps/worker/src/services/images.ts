import { sha256 } from "../utils/hash.js";

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
 * - 单篇最多处理 MAX_IMAGES_PER_CONTENT 张，超出的保留外链，避免超长正文拖垮入库请求。
 */

// 图片对象在 R2 里的前缀，读取路由拼 key 时共用同一常量（避免两处写死）
export const IMAGE_KEY_PREFIX = "images/";
// 浏览器侧访问路径：Pages 的 _worker.js 会把 /api/* 反代到 Worker
const IMAGE_API_PREFIX = "/api/images/";
// 单篇正文最多本地化多少张图
const MAX_IMAGES_PER_CONTENT = 50;
// 单张图片下载超时
const IMAGE_FETCH_TIMEOUT_MS = 10_000;
// 单张图片体积上限：Workers 单次请求内存有限（并发 4 张同时驻留），
// 超大图直接保留外链，避免 4 份大 buffer 叠加打爆 isolate 内存
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// 并发下载数：太高容易被图床限流，太低 50 张图会把入库请求拖长
const IMAGE_FETCH_CONCURRENCY = 4;

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
async function localizeOne(sourceUrl: string, bucket: R2Bucket): Promise<string | null> {
  // 哈希吃归一化后的身份串而不是完整 URL：图床子域/签名/尺寸抖动不能换来新 key
  const hash = await sha256(imageIdentity(sourceUrl));
  const urlExt = extensionFromUrl(sourceUrl);

  // URL 自带扩展名时先 HEAD：已备份过的图直接复用，不产生下载流量
  if (urlExt) {
    const expectedKey = `${IMAGE_KEY_PREFIX}${hash}.${urlExt}`;
    if (await bucket.head(expectedKey)) return `${IMAGE_API_PREFIX}${hash}.${urlExt}`;
  }

  const downloaded = await fetchImage(sourceUrl);
  if (!downloaded) return null;

  const ext = urlExt ?? extensionFromContentType(downloaded.contentType) ?? "jpg";
  const key = `${IMAGE_KEY_PREFIX}${hash}.${ext}`;

  // urlExt 存在时上面已经 HEAD 过且 miss；只有「URL 无扩展名」才需要补一次 HEAD
  const stored = urlExt ? false : Boolean(await bucket.head(key));
  if (!stored) {
    await bucket.put(key, downloaded.body, {
      httpMetadata: { contentType: downloaded.contentType },
      // 留个来源线索方便排查；R2 customMetadata 值过长会写入失败，截断到 900 字符
      customMetadata: { kind: "image", sourceUrl: sourceUrl.slice(0, 900) }
    });
  }

  return `${IMAGE_API_PREFIX}${hash}.${ext}`;
}

/**
 * 把正文 HTML 里的知乎图片下载进 R2，并重写为站内路径。
 * 任何异常都返回原始 HTML：图片备份是增值能力，不能阻塞正文入库。
 */
export async function processContentImages(html: string, bucket: R2Bucket): Promise<string> {
  if (!html || !/<img\b/i.test(html)) return html;

  try {
    const sources = extractImgSources(html);
    if (!sources.length) return html;

    const targets = sources
      .map(src => ({ src, url: toFetchableUrl(src) }))
      .filter((item): item is { src: string; url: string } => item.url !== null)
      .slice(0, MAX_IMAGES_PER_CONTENT);

    const mapping = new Map<string, string>();
    // 分批并发：Promise.all 保证同批失败会等到全部 settle 后再进入下一批
    for (let i = 0; i < targets.length; i += IMAGE_FETCH_CONCURRENCY) {
      const chunk = targets.slice(i, i + IMAGE_FETCH_CONCURRENCY);
      await Promise.all(
        chunk.map(async target => {
          try {
            const localPath = await localizeOne(target.url, bucket);
            if (localPath) mapping.set(target.src, localPath);
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
