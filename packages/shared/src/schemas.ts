import { z } from "zod";

export const ContentTypeSchema = z.enum(["answer", "article", "pin"]);

export const IngestContentSchema = z.object({
  sourceType: ContentTypeSchema,
  sourceId: z.string(),
  title: z.string().optional().default(""),
  sourceUrl: z.string().url(),
  author: z.object({
    name: z.string().optional().default(""),
    urlToken: z.string().nullable().optional().default(null),
    avatarUrl: z.string().optional().default(""),
    headline: z.string().optional().default("")
  }).optional().default({ name: "", urlToken: null, avatarUrl: "", headline: "" }),
  question: z.object({
    id: z.string().optional().default(""),
    title: z.string().optional().default("")
  }).optional(),
  contentHtml: z.string().optional().default(""),
  contentMd: z.string().optional().default(""),
  excerpt: z.string().optional().default(""),
  voteupCount: z.number().int().optional().default(0),
  commentCount: z.number().int().optional().default(0),
  favoriteCount: z.number().int().optional().default(0),
  visitCount: z.number().int().optional().default(0),
  isCollapsed: z.boolean().optional().default(false),
  isLabeled: z.boolean().optional().default(false),
  labelInfo: z.string().optional().default(""),
  createdTime: z.string().optional().default(""),
  updatedTime: z.string().optional().default("")
});

export const IngestCommentSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable().optional().default(null),
  author: z.string().optional().default(""),
  authorAvatar: z.string().optional().default(""),
  beReplied: z.string().nullable().optional().default(null),
  content: z.string().optional().default(""),
  img: z.string().optional().default(""),
  time: z.string().optional().default(""),
  location: z.string().optional().default(""),
  likes: z.number().int().optional().default(0),
  isAuthor: z.boolean().optional().default(false),
  isTop: z.boolean().optional().default(false),
  isFeatured: z.boolean().optional().default(false)
});

export const IngestCommentsSchema = z.object({
  contentPk: z.string(),
  // 单请求上限：热榜回答动辄数千评论，单请求会撞 Workers 子请求限制，抓取端须分批
  comments: z.array(IngestCommentSchema).max(2000),
  // 分批提交时由最后一批附带本次抓取的全量评论 id：
  // 删除对账必须对全量做，否则前面批次刚插入的评论会被误判删除
  allIds: z.array(z.string()).optional(),
  // true = 本次抓取不完整（中途失败），跳过删除检测，避免误标删除
  partial: z.boolean().optional().default(false)
});

export const IngestCollectionItemSchema = z.object({
  sourceType: ContentTypeSchema,
  sourceId: z.string(),
  title: z.string().optional().default(""),
  authorName: z.string().optional().default(""),
  sourceUrl: z.string().url()
});

export const IngestCollectionSnapshotSchema = z.object({
  collection: z.object({
    id: z.string(),
    title: z.string(),
    ownerToken: z.string().optional().default(""),
    updatedTime: z.string().optional().default("")
  }),
  incremental: z.boolean().optional().default(false),
  items: z.array(IngestCollectionItemSchema)
});

export type IngestContentInput = z.infer<typeof IngestContentSchema>;
export type IngestCommentsInput = z.infer<typeof IngestCommentsSchema>;
export type IngestCollectionSnapshotInput = z.infer<typeof IngestCollectionSnapshotSchema>;
