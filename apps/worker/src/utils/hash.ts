export function normalizeForHash(input: string) {
  return (input || "")
    .replace(/\sdata-pid="[^"]*"/g, "")
    .replace(/\sdata-original-token="[^"]*"/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function sha256(input: string) {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  return hashHex;
}

/**
 * 归一化作者头像 URL，仅用于入库判重（不改落库原始地址）：
 * 知乎头像图床会轮换 pic1/picx/pica 等子域并附带签名 query，
 * 同一头像字符串不同会误判「头像更新」并触发无意义 D1 UPDATE。
 */
export function normalizeAvatarUrlForCompare(url?: string | null): string {
  const raw = (url || "").trim();
  if (!raw) return "";
  const candidate = raw.startsWith("//") ? `https:${raw}` : raw;
  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.toLowerCase();
    const isZhimgPic = /^pic[0-9a-z-]*\.zhimg\.com$/i.test(host) || host === "zhimg.com";
    const canonicalProtocol = isZhimgPic ? "https:" : parsed.protocol.toLowerCase();
    const canonicalHost = isZhimgPic ? "zhimg.com" : parsed.host.toLowerCase();
    return `${canonicalProtocol}//${canonicalHost}${parsed.pathname}${isZhimgPic ? "" : parsed.search}`;
  } catch {
    if (/^https?:\/\/(?:pic[0-9a-z-]*\.)?zhimg\.com(?:[/:?#]|$)/i.test(candidate)) {
      return candidate
        .replace(/^https?:\/\/pic[0-9a-z-]*\.zhimg\.com/i, "https://zhimg.com")
        .replace(/[?#].*$/, "");
    }
    return candidate;
  }
}

/** 仅当入参非空且「原值为空或归一化路径确有变化」时返回 true */
export function isAvatarUrlChanged(existing?: string | null, incoming?: string | null): boolean {
  const next = (incoming || "").trim();
  if (!next) return false;
  const prev = (existing || "").trim();
  if (!prev) return true;
  return normalizeAvatarUrlForCompare(prev) !== normalizeAvatarUrlForCompare(next);
}
