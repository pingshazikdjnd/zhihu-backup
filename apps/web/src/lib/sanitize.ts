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
  ALLOWED_ATTR: ["href", "src", "alt", "title", "class", "colspan", "rowspan", "target", "rel", "referrerpolicy"],
  // 显式禁掉，双保险
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "style", "srcset"],
  ALLOW_DATA_ATTR: false,
  // 不允许 javascript: 协议
  ALLOW_UNKNOWN_PROTOCOLS: false
} as const;

// 正文图片直连知乎图床时不要带 Referer（部分图床校验来源会 403），
// 外链统一新窗口打开并切断 window.opener。
// 模块级只注册一次，避免 HMR / 多次 import 重复挂 hook。
let hookInstalled = false;
if (!hookInstalled) {
  DOMPurify.addHook("afterSanitizeAttributes", (node: Element) => {
    if (node.tagName === "IMG") {
      node.setAttribute("referrerpolicy", "no-referrer");
    }
    if (node.tagName === "A") {
      const href = node.getAttribute("href") || "";
      if (href.startsWith("http://") || href.startsWith("https://")) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer nofollow");
      }
    }
  });
  hookInstalled = true;
}

export function sanitizeHtml(html?: string | null): string {
  if (!html) return "";
  // DOMPurify 不剥双向控制符（实测文本与属性双路径都原样穿透），
  // U+202E 等可把 "gnp.exe" 视觉翻转成 "exe.png" 做展示欺骗，先剥掉再清洗
  const stripped = html.replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F]/g, "");
  // dompurify 在启用 Trusted Types 的环境下返回 TrustedHTML，统一收敛成 string
  const out = DOMPurify.sanitize(stripped, CONFIG as any);
  return typeof out === "string" ? out : String(out);
}
