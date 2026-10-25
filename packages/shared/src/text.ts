/**
 * 把知乎正文 HTML 转成用于检索的纯文本。
 * 注意：只用于 content_md（搜索与兜底展示），原始 HTML 仍然单独保存。
 */

/**
 * 代理对安全截断：String.slice 按 UTF-16 单元切，4 字节 emoji（占 2 个
 * 单元）恰好横跨截断边界时会产生孤立高代理——SQLite 会以 WTF-8 存储、
 * 读回时变异成 U+FFFD，导致该 emoji 永远搜不到。边界处多退一个单元。
 */
export function safeTruncate(s: string, limit: number): string {
  if (s.length <= limit) return s;
  let out = s.slice(0, limit);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

export function htmlToPlainText(input: string, limit = 4000): string {
  if (!input || typeof input !== "string") return "";

  let text = input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (limit > 0 && text.length > limit) text = safeTruncate(text, limit);
  return text;
}

/** 生成入库用的可搜索正文：优先用已有的 md，否则从 html 提取 */
export function buildSearchText(contentMd: string, contentHtml: string, limit = 4000): string {
  if (contentMd && contentMd.trim()) {
    return limit > 0 && contentMd.length > limit ? safeTruncate(contentMd, limit) : contentMd;
  }
  return htmlToPlainText(contentHtml, limit);
}
