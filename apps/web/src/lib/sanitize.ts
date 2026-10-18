import DOMPurify from "dompurify";

/**
 * 知乎正文/评论是第三方 HTML，直接 dangerouslySetInnerHTML 会被注入
 * <img onerror=...> 这类 payload。这里做白名单清洗。
 */
const CONFIG = {
  ALLOWED_TAGS: [
    "p", "br", "b", "strong", "i", "em", "u", "s", "del", "ins",
    "a", "img", "blockquote", "pre", "code",
    "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
    "table", "thead", "tbody", "tr", "th", "td", "hr",
    "figure", "figcaption", "span", "div", "sub", "sup"
  ],
  ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "colspan", "rowspan", "target", "rel"],
  // 显式禁掉，双保险
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "style", "srcset"],
  ALLOW_DATA_ATTR: false,
  // 不允许 javascript: 协议
  ALLOW_UNKNOWN_PROTOCOLS: false
} as const;

export function sanitizeHtml(html?: string | null): string {
  if (!html) return "";
  // dompurify 在启用 Trusted Types 的环境下返回 TrustedHTML，统一收敛成 string
  const out = DOMPurify.sanitize(html, CONFIG as any);
  return typeof out === "string" ? out : String(out);
}
