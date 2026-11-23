import { z } from "zod";

export const ContentTypeSchema = z.enum(["answer", "article", "pin"]);

// zod 的 .url() 是宽松校验：javascript:/data:/file:/无主机 URL 都能过。
// sourceUrl 会被读接口原样返回给前端渲染，非 http(s) 协议就是存储型 XSS 载荷
const HttpUrl = z.string().url().refine(
  (u) => {
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
      // 抓取端缺字段时会拼出 /question/undefined/、/answer/null 这类占位 URL。
      // 只拒绝整段恰为 undefined/null 的路径段，普通单词（如 nullable）照常通过。
      return !parsed.pathname
        .split("/")
        .some(segment => segment === "undefined" || segment === "null");
    } catch {
      return false;
    }
  },
  { message: "sourceUrl must be an http(s) URL without undefined/null path segments" }
);

const NullableStringToEmpty = z.string().nullable().optional().transform(v => v ?? "");
const NullableOptionalBool = z.boolean().nullable().optional().transform(v => (v === null ? undefined : v));

export const IngestContentSchema = z.object({
  sourceType: ContentTypeSchema,
  sourceId: z.string(),
  title: NullableStringToEmpty,
  sourceUrl: HttpUrl,
  author: z.object({
    name: NullableStringToEmpty,
    urlToken: z.string().nullable().optional().default(null),
    avatarUrl: NullableStringToEmpty,
    headline: NullableStringToEmpty
  }).nullable().optional().transform(v => v ?? { name: "", urlToken: null, avatarUrl: "", headline: "" }),
  question: z.object({
    id: NullableStringToEmpty,
    title: NullableStringToEmpty
  }).nullable().optional().transform(v => (v === null ? undefined : v)),
  contentHtml: NullableStringToEmpty,
  contentMd: NullableStringToEmpty,
  excerpt: NullableStringToEmpty,
  voteupCount: z.number().int().optional().default(0),
  commentCount: z.number().int().optional().default(0),
  favoriteCount: z.number().int().optional().default(0),
  visitCount: z.number().int().optional().default(0),
  // 不给默认值：弱数据源（赞同/收藏动态）常不带这两个字段，
  // 默认 false 会在更新路径把库里已有的折叠/黄标状态冲成 0
  isCollapsed: NullableOptionalBool,
  isLabeled: NullableOptionalBool,
  labelInfo: NullableStringToEmpty,
  createdTime: NullableStringToEmpty,
  updatedTime: NullableStringToEmpty
});

export const IngestCommentSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable().optional().default(null),
  author: z.string().optional().default(""),
  authorAvatar: z.string().optional().default(""),
  beReplied: z.string().nullable().optional().default(null),
  content: z.string().optional().default(""),
  img: z.string().optional().default(""),
  // 旧通道/新通道的图片字段归一：img 仍是标准字段，imageUrl 仅作兼容回退
  imageUrl: z.string().optional().default(""),
  time: z.string().optional().default(""),
  location: z.string().optional().default(""),
  likes: z.number().int().optional().default(0),
  isAuthor: z.boolean().optional().default(false),
  isTop: z.boolean().optional().default(false),
  isFeatured: z.boolean().optional().default(false)
});

export const IngestCommentsSchema = z.object({
  contentPk: z.string(),
  // 单请求上限 1500：×3 语句/条 ÷100 语句/批 = 45 个 D1 batch，
  // 刚好压在 Workers 免费版 50 子请求限制之内（2000 条会到 61 批必炸）
  comments: z.array(IngestCommentSchema).max(1500),
  // 分批提交时由最后一批附带本次抓取的全量评论 id：
  // 删除对账必须对全量做，否则前面批次刚插入的评论会被误判删除
  allIds: z.array(z.string()).optional(),
  // true = 本次抓取不完整（中途失败），跳过删除检测，避免误标删除
  partial: z.boolean().optional().default(false)
});

// 按「根」分组的评论同步：根评论留 D1 comments，子评论写 R2 childcomments/{rootId}.json。
// 每请求 ≤20 个根：partial 合并最坏 20 GET + 20 PUT + D1 batch，压在 50 子请求限制内。
export const IngestCommentsByRootSchema = z.object({
  contentPk: z.string(),
  roots: z.array(z.object({
    id: z.string(),
    author: z.string(),
    authorAvatar: z.string().optional(),
    content: z.string(),
    img: z.string().optional(),
    imageUrl: z.string().optional(),
    time: z.string().optional(),
    location: z.string().optional(),
    likes: z.number(),
    isAuthor: z.boolean().optional(),
    isTop: z.boolean().optional(),
    isFeatured: z.boolean().optional(),
    childCount: z.number().default(0),
    children: z.array(z.object({
      id: z.string(),
      parentId: z.string(),
      author: z.string(),
      authorAvatar: z.string().optional(),
      beReplied: z.string().nullable().optional(),
      content: z.string(),
      img: z.string().optional(),
      imageUrl: z.string().optional(),
      time: z.string().optional(),
      location: z.string().optional(),
      likes: z.number(),
      isAuthor: z.boolean().optional()
    })).default([]),
    isChildrenComplete: z.boolean().default(false),
    isChildrenClosed: z.boolean().optional()
  })).max(20),  // ≤20 根/请求，避免超 50 子请求限制
  // 全量 root id 列表（分批时用于删除对账）
  allRootIds: z.array(z.string()).optional(),
  partial: z.boolean().optional()
});
export type IngestCommentsByRootInput = z.infer<typeof IngestCommentsByRootSchema>;
export type IngestRootCommentInput = IngestCommentsByRootInput["roots"][number];
export type IngestChildCommentInput = IngestRootCommentInput["children"][number];

export const IngestCollectionItemSchema = z.object({
  sourceType: ContentTypeSchema,
  sourceId: z.string(),
  title: z.string().optional().default(""),
  authorName: z.string().optional().default(""),
  sourceUrl: HttpUrl
});

export const IngestCollectionSnapshotSchema = z.object({
  collection: z.object({
    id: z.string(),
    title: z.string(),
    ownerToken: z.string().optional().default(""),
    updatedTime: z.string().optional().default("")
  }),
  incremental: z.boolean().optional().default(false),
  // 单请求上限：5000 条实测会生成 101 个 batch（超免费版 50 子请求限制且半提交）
  items: z.array(IngestCollectionItemSchema).max(1000)
});

export type IngestContentInput = z.infer<typeof IngestContentSchema>;
export type IngestCommentsInput = z.infer<typeof IngestCommentsSchema>;
export type IngestCollectionSnapshotInput = z.infer<typeof IngestCollectionSnapshotSchema>;
