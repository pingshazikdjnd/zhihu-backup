/**
 * 把知乎正文 HTML 转成用于检索的纯文本。
 * 注意：只用于 content_md（搜索与兜底展示），原始 HTML 仍然单独保存。
 */
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

  if (limit > 0 && text.length > limit) text = text.slice(0, limit);
  return text;
}

/** 生成入库用的可搜索正文：优先用已有的 md，否则从 html 提取 */
export function buildSearchText(contentMd: string, contentHtml: string, limit = 4000): string {
  if (contentMd && contentMd.trim()) {
    return limit > 0 && contentMd.length > limit ? contentMd.slice(0, limit) : contentMd;
  }
  return htmlToPlainText(contentHtml, limit);
}
