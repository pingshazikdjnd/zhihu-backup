import { Actor, log } from "apify";
import { chromium } from "playwright";
import { createZhihuJson, ZhihuRequestError } from "./zhihu-fetch.js";

interface InputSchema {
    runType: "all" | "answers" | "articles" | "collections" | "upvotes" | "following" | "following-list" | "repair-comments";
    isFast: boolean;
    apiUrl: string;
    apiSecret?: string;
    zhihuUsername: string;
    cookieString: string;
    /** 赞同段断点游标（moments 的 paging.next）：从上次中断处继续补历史 */
    upvotesCursor?: string;
    /** 开启了「全量备份」的关注答主 url_token 列表 */
    fullModeUsers?: string[];
    /**
     * 存量评论补采目标（runType=repair-comments 专用）：元素形如 "answer:123" / "article:456"。
     * 只重抓这些内容的评论，不枚举答主、不受 history_done 影响。
     */
    repairTargets?: string[];
    /** 每位关注答主的历史扫描进度（断点 offset、是否已完成首次历史摸底、上次最新回答标记点） */
    followedProgress?: Record<string, { resumeOffset: number; historyDone: boolean; syncMode: "default" | "full"; lastCheckedAnswerId?: string }>;
    /** 同步租约持有者：每次 /ingest 请求都会带上 x-sync-owner，Worker 侧自动续租 */
    syncOwnerId?: string;
    /** 全局同步与评论抓取策略设置 */
    syncConfig?: {
      commentsMyAnswers?: "full" | "hot" | "none";
      commentsCollections?: "full" | "hot" | "none";
      commentsUpvotes?: "full" | "hot" | "none";
      commentsFollowing?: "full" | "hot" | "none";
      followingSensitivity?: "strict" | "standard" | "relaxed";
    };
}

await Actor.init();
const input = await Actor.getInput<InputSchema>();
if (!input) throw new Error("Missing input");
const { runType, isFast, apiUrl, apiSecret, zhihuUsername, cookieString, upvotesCursor, fullModeUsers, followedProgress, syncConfig, repairTargets } = input;
const fullModeSet = new Set(Array.isArray(fullModeUsers) ? fullModeUsers : []);
const followedProgMap = followedProgress && typeof followedProgress === "object" ? followedProgress : {};
// 同步租约：云端 Apify 由 Worker 注入 input.syncOwnerId，本地同步由 local-sync.mjs
// 通过环境变量 SYNC_OWNER_ID 传入；每批 /ingest 请求带 x-sync-owner 自动续租 15 分钟。
const syncOwnerId = String(input.syncOwnerId || process.env.SYNC_OWNER_ID || "").trim();
const cfg = {
  commentsMyAnswers: syncConfig?.commentsMyAnswers || "full",
  commentsCollections: syncConfig?.commentsCollections || "hot",
  commentsUpvotes: syncConfig?.commentsUpvotes || "hot",
  commentsFollowing: syncConfig?.commentsFollowing || "hot",
  followingSensitivity: syncConfig?.followingSensitivity || "standard"
};

// 关注答主风险阈值：规则评估与 AI 失败兜底必须使用同一阈值，避免两套口径
function followingRiskThreshold(): number {
  return cfg.followingSensitivity === "strict" ? 40 : cfg.followingSensitivity === "relaxed" ? 18 : 25;
}

// 真人阅读节奏：固定毫秒连续翻页（实测楼中楼 300ms + 根评论 350ms 连打 1 小时）
// 会被知乎判定为脚本，触发 HTTP 403 code=40352 (/account/unhuman) 临时风控。
// 所有分页节流统一走随机抖动：既没有固定节奏指纹，也拉高了平均间隔。
function jitterSleep(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(minMs + Math.random() * (maxMs - minMs));
  return new Promise(r => setTimeout(r, ms));
}

// 失败上报：所有异常都被吞掉的爬虫在 Apify 上永远显示 SUCCEEDED，
// cookie 失效后零数据入库也毫无感知。这里集中统计，结束时据此决定 run 状态。
const MAX_DAILY_ESTIMATED_WRITES = 90000; // 90000 < D1 免费版硬顶 100000 行/天：留 10% 余量给配置写入与并发，避免撞墙后整轮 500
// 本地全量重扒开关：本地 wrangler D1 是磁盘上的 SQLite，没有云端「10 万行/天」硬顶，
// 因此 UNLIMITED_LOCAL_WRITES=1 时同时放开「写入预算熔断」和「AI 复核调用次数上限」，
// 否则 102 位关注答主的候选回答/文章会在前 3 次 AI 复核之后全部按规则跳过。
const UNLIMITED_LOCAL_WRITES =
  process.env.UNLIMITED_LOCAL_WRITES === "1" || process.env.UNLIMITED_LOCAL_WRITES === "true";
const stats = {
  saved: 0,
  failed: 0,
  authRejected: 0,
  riskEmpty: 0,
  // 知乎侧 429/5xx/非 JSON/网络错误等请求失败：与 Worker 入库失败（failed）分开统计
  zhihuRejected: 0,
  // 连续重试耗尽次数：zhihuJson 任意一次成功返回就清零，达到 3 才判定账号级风控
  riskFailStreak: 0,
  // 账号级风控标志：连续 3 个请求重试耗尽仍被拒后置位，后续所有循环直接结束
  riskExhausted: false,
  riskPaused: false,
  riskPauseMs: 0,
  consecutiveFailures: 0,
  circuitBroken: false,
  estimatedWrites: 0
};

// 评论分页硬上限（与热评链路 full 模式的 200 页一致），防止 paging.is_end
// 缺失/被风控时无限翻页
const MAX_COMMENT_PAGES = 200;

/**
 * 存量评论补采（runType=repair-comments）的本轮统计。
 * 补采只走 /ingest/comments-by-root，不写 /ingest/content，stats.saved 恒为 0；
 * 终态判定必须用这里的 ok 数代替 saved，否则「补采成功」会被误报成「本轮零数据入库」。
 * 其它 runType 保持 null，原有终态语义完全不变。
 */
interface RepairCommentSummary {
  total: number;
  ok: number;
  skipped: number;
  failed: number;
  stopped: boolean;
}
// 用对象持有而不是裸 let：模块级 let 只会被 TS 控制流分析窄化成初始值 null，
// 终态读取时看不到函数体内的赋值（否则报 TS2339: Property 'ok' does not exist on type 'never'）
const repairState: { summary: RepairCommentSummary | null } = { summary: null };

// 异常信息脱敏：cookie / authorization 一旦被拼进日志或 Actor.fail 消息，
// 就会随 run 记录永久留在 Apify 控制台，等于把账号凭据公开
function sanitizeErrorForLog(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : err && typeof err === "object" && "message" in err
      ? String((err as { message?: unknown }).message ?? "")
      : String(err ?? "");
  return raw
    .replace(/cookie:[^\r\n]*/gi, "cookie: [REDACTED]")
    .replace(/authorization:[^\r\n]*/gi, "authorization: [REDACTED]")
    .slice(0, 500);
}

// 模型返回的 reason 属于不可信文本，进日志前统一去掉换行/控制字符，防日志注入
function sanitizeReasonForLog(reason: unknown): string {
  return String(reason ?? "").replace(/[\r\n\t\x00-\x1f]/g, " ").slice(0, 120);
}

async function post(path: string, body: unknown, opts?: { countStats?: boolean }): Promise<any> {
  // countStats=false 用于 AI 复核等旁路请求：不写 D1，计数与熔断判定也不得被污染，
  // 否则「零数据入库」终态会被 AI 调用成功/失败掩盖
  const countStats = opts?.countStats !== false;
  // apiUrl 尾斜杠归一，避免拼出 //ingest/content 的 404
  const base = apiUrl.endsWith("/") ? apiUrl.slice(0, -1) : apiUrl;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiSecret) headers["authorization"] = `Bearer ${apiSecret}`;
  // 每批 ingest 请求都带上租约持有者，Worker 侧据此顺延 15 分钟租约：
  // 长抓取期间只要还在回传数据，锁就不会被其他实例抢走；爬虫崩溃后停止发请求，锁自然过期。
  if (syncOwnerId) headers["x-sync-owner"] = syncOwnerId;

  // 熔断后立即拒绝：只置位不拦截的话，评论分块/热评发送等路径仍会继续
  // 打出成百上千行写入，直接撞穿 D1 当日硬顶
  if (stats.circuitBroken) {
    throw new Error("circuit_open: 已达当日写入预算，跳过后续请求");
  }

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
  } catch (e: any) {
    if (countStats) {
      stats.failed++;
      stats.consecutiveFailures++;
      if (stats.consecutiveFailures >= 5) stats.circuitBroken = true;
    }
    throw new Error(sanitizeErrorForLog(e));
  }
  if (!res.ok) {
    if (countStats) {
      stats.failed++;
      stats.consecutiveFailures++;
      if (stats.consecutiveFailures >= 5) stats.circuitBroken = true;
    }
    throw new Error(sanitizeErrorForLog(`${path} -> ${res.status} ${await res.text()}`));
  }
  // 成功计数放在 JSON 解析之后：200+非 JSON 体时避免 saved/failed 双计
  let json: any;
  try {
    json = await res.json();
  } catch (e: any) {
    if (countStats) {
      stats.failed++;
      stats.consecutiveFailures++;
      if (stats.consecutiveFailures >= 5) stats.circuitBroken = true;
    }
    throw e;
  }

  // 旁路请求（countStats=false）不计入入库统计，也不重置连续失败计数——
  // 否则一次 AI 复核成功就能把真实的入库失败序列清零，掩盖熔断信号
  if (countStats) {
    stats.saved++;
    stats.consecutiveFailures = 0;

    let cost = 1;
    if (path === "/ingest/content") cost = 3;
    else if (path === "/ingest/comments") cost = Math.max(1, ((body as any)?.comments?.length || 1) * 2);
    else if (path === "/ingest/comments-by-root") {
      if (
        json &&
        typeof json === "object" &&
        (typeof json.added === "number" || typeof json.updated === "number" || typeof json.deleted === "number")
      ) {
        const rootWrites = ((Number(json.added) || 0) + (Number(json.updated) || 0) + (Number(json.deleted) || 0)) * 2;
        const threadWrites = typeof json.threadUpserts === "number" ? json.threadUpserts : (Number(json.r2Puts) || 0);
        cost = rootWrites + threadWrites;
      } else {
        const roots: any[] = Array.isArray((body as any)?.roots) ? (body as any).roots : [];
        cost = roots.length * 2;
      }
    }
    else if (path === "/ingest/upvote") cost = 2;
    else if (path === "/ingest/collection-snapshot") cost = Math.max(1, (body as any)?.items?.length || 1);
    else if (path === "/ingest/followed-users") cost = Math.max(1, (body as any)?.users?.length || 1);

    stats.estimatedWrites += cost;
    // 本地无限写模式：不按云端 D1 每日行数判定熔断（本地 SQLite 无硬顶），
    // 仅保留「连续 5 次入库失败」的故障熔断
    if (!UNLIMITED_LOCAL_WRITES && stats.estimatedWrites >= MAX_DAILY_ESTIMATED_WRITES) {
      if (!stats.circuitBroken) {
        stats.circuitBroken = true;
        console.warn(`\n🛑 [D1每日限额保护] 今日预估写入已达 ${stats.estimatedWrites} 行（已充分吃满 CF 官方 100k 额度并适度利用缓冲）。主动安全挂起，已保存断点，等待明日 08:05 额度刷新后自动续跑！`);
      }
    }
  }

  return json;
}

// 评论按根分组提交的结构：服务端按根 upsert，并据 isChildrenComplete 决定是否对账子评论。
// 每请求最多 20 根（服务端每根固定 R2 GET + PUT 两个子请求），
// 20 根 ≈ 40 + D1 batch，低于 Workers 每请求 50 子请求上限。
type ChildComment = {
  id: string;
  parentId: string;
  author: string;
  authorAvatar?: string;
  beReplied?: string;
  content: string;
  img?: string;
  imageUrl?: string;
  time?: string;
  location?: string;
  likes: number;
  isAuthor?: boolean;
};

type RootCommentGroup = {
  id: string;
  author: string;
  authorAvatar?: string;
  content: string;
  img?: string;
  imageUrl?: string;
  time?: string;
  location?: string;
  likes: number;
  isAuthor?: boolean;
  isTop?: boolean;
  isFeatured?: boolean;
  childCount: number;
  children: ChildComment[];
  isChildrenComplete: boolean;
};

function toChildComment(child: any, rootId: string): ChildComment {
  const normalizedImage = normalizeCommentImage(child.content, child);
  return {
    id: String(child.id),
    parentId: rootId,
    // comment_v5 把作者拍平成 author.name / author.avatar_url，旧版 v4 是 author.member.*
    author: child.author?.member?.name || child.author?.name || "匿名",
    authorAvatar: child.author?.member?.avatar_url || child.author?.avatar_url || "",
    // 服务端 schema 是 optional string：null 会被 zod 拒绝，缺失时必须给 undefined
    beReplied:
      child.reply_to_author?.member?.name || child.reply_to_author?.name || undefined,
    content: normalizedImage.content,
    img: normalizedImage.img,
    imageUrl: normalizedImage.imageUrl,
    time: toIsoOrNull(child.created_time),
    location: child.address_text || "",
    likes: Number(
      child.vote_count ?? child.like_count ?? child.reaction?.statistics?.like_count ?? 0
    ) || 0,
    isAuthor: child.is_author === true || child.is_author === 1 || child.author?.role === "author"
  };
}

function toRootCommentGroup(
  root: any,
  children: ChildComment[],
  isChildrenComplete: boolean
): RootCommentGroup {
  const normalizedImage = normalizeCommentImage(root.content, root);
  return {
    id: String(root.id),
    // 兼容 comment_v5 扁平字段（author.name / author.avatar_url）与 v4 的 author.member.*
    author: root.author?.member?.name || root.author?.name || "匿名",
    authorAvatar: root.author?.member?.avatar_url || root.author?.avatar_url || "",
    content: normalizedImage.content,
    img: normalizedImage.img,
    imageUrl: normalizedImage.imageUrl,
    time: toIsoOrNull(root.created_time),
    location: root.address_text || "",
    likes: Number(
      root.vote_count ?? root.like_count ?? root.reaction?.statistics?.like_count ?? 0
    ) || 0,
    isAuthor: root.is_author === true || root.is_author === 1 || root.author?.role === "author",
    isTop: root.top === true || root.top === 1,
    isFeatured: root.featured === true || root.featured === 1,
    childCount: Number(root.child_comment_count) || 0,
    children,
    isChildrenComplete
  };
}

/**
 * 按根分组提交评论（POST /ingest/comments-by-root）。
 * - 内部按 20 根分批，复用 post()，入库失败重试与熔断由 post() 统一处理；
 * - 中间批一律 partial=true（跳过删除对账），避免后一批把前一批刚写入的根误判为已删除；
 * - 最后一批沿用 opts.partial，且只有 partial=false（全量模式）才带 allRootIds 供对账；
 * - stats.riskExhausted / stats.circuitBroken 后立即停止，不再产生入库请求。
 */
async function postCommentsByRoot(
  contentPk: string,
  rootComments: RootCommentGroup[],
  opts: { partial?: boolean; allRootIds?: string[] } = {}
): Promise<{ batches: number; roots: number; children: number; aborted: boolean }> {
  const BATCH = 20;
  const partial = opts.partial ?? true;
  let batches = 0;
  let roots = 0;
  let children = 0;
  let aborted = false;

  // 零根评论 + 非 partial：原站评论被整体删光（comment_count 归零）。
  // 必须仍发一次空 roots 的全量对账请求，Worker 才会把旧根评论软删、
  // 清零 contents.comment_count 与线程索引，否则列表页会永远显示旧评论。
  if (rootComments.length === 0) {
    if (!partial) {
      const payload = {
        contentPk,
        roots: [] as RootCommentGroup[],
        partial: false,
        allRootIds: opts.allRootIds ?? []
      };
      try {
        await post("/ingest/comments-by-root", payload);
      } catch (e: any) {
        console.warn(`⚠️ 评论清零对账失败，重试一次 (${contentPk}): ${sanitizeErrorForLog(e)}`);
        await post("/ingest/comments-by-root", payload);
      }
      batches = 1;
    }
    return { batches, roots, children, aborted };
  }

  for (let i = 0; i < rootComments.length; i += BATCH) {
    if (stats.riskExhausted || stats.circuitBroken) {
      aborted = true;
      break;
    }
    const isLast = i + BATCH >= rootComments.length;
    const batch = rootComments.slice(i, i + BATCH);
    const payload: {
      contentPk: string;
      roots: RootCommentGroup[];
      partial: boolean;
      allRootIds?: string[];
    } = {
      contentPk,
      roots: batch,
      partial: isLast ? partial : true
    };
    if (isLast && !partial && opts.allRootIds && opts.allRootIds.length > 0) {
      payload.allRootIds = opts.allRootIds;
    }
    try {
      await post("/ingest/comments-by-root", payload);
    } catch (e: any) {
      // 瞬时失败重试一次：接口按根幂等 upsert，整批重发安全
      console.warn(`⚠️ 评论根批次失败，重试一次 (第 ${batches + 1} 批): ${sanitizeErrorForLog(e)}`);
      await post("/ingest/comments-by-root", payload);
    }
    batches++;
    roots += batch.length;
    children += batch.reduce((n, r) => n + r.children.length, 0);
  }

  return { batches, roots, children, aborted };
}

/**
 * 评论同步触发条件：评论数任何变化都值得重抓，包括被删除导致的减少。
 * - 新增（now > prev）要抓；
 * - 被删（now < prev，含删光为 0）也要抓，否则本地会永久残留已删评论；
 * - prev === now === 0 时不发无意义请求。
 */
function shouldSyncComments(commentCount: number, prevCommentCount: number | null | undefined): boolean {
  const now = Number(commentCount) || 0;
  const prev = Number(prevCommentCount) || 0;
  return now !== prev && (now > 0 || prev > 0);
}

// 本轮评论抓取失败/中断的内容：同一进程后续阶段再次遇到时必须补抓，
// 不能因为 contents.comment_count 已写成新值就跳过。
const commentSyncIncomplete = new Set<string>();

type StoredCommentState = { roots: number; storedComments: number; incompleteRoots: number };
type StoredRootCommentRow = { is_complete?: unknown; child_count?: unknown };

function isStoredRootCommentRow(value: unknown): value is StoredRootCommentRow {
  return Boolean(value) && typeof value === "object";
}

/**
 * 读取 Worker 已落库的评论线程状态（只读，不请求知乎）。
 * 返回 null 表示探测失败：不能据此把内容误判为「评论已完整」。
 */
async function fetchStoredCommentState(contentPk: string): Promise<StoredCommentState | null> {
  const base = apiUrl.endsWith("/") ? apiUrl.slice(0, -1) : apiUrl;
  const headers: Record<string, string> = {};
  if (apiSecret) headers.authorization = `Bearer ${apiSecret}`;
  try {
    const res = await fetch(
      `${base}/api/contents/${encodeURIComponent(contentPk)}/root-comments?limit=50`,
      { headers }
    );
    if (!res.ok) return null;
    const json: unknown = await res.json();
    let rows: StoredRootCommentRow[] = [];
    if (json && typeof json === "object" && "data" in json) {
      const data = json.data;
      rows = Array.isArray(data) ? data.filter(isStoredRootCommentRow) : [];
    }
    let incompleteRoots = 0;
    let storedComments = rows.length;
    for (const row of rows) {
      if (Number(row.is_complete ?? 0) !== 1) incompleteRoots++;
      storedComments += Number(row.child_count) || 0;
    }
    return { roots: rows.length, storedComments, incompleteRoots };
  } catch {
    return null;
  }
}

/**
 * 评论是否需要（重新）抓取：
 * - 评论数变化（原有规则，覆盖新增/被删/清零）；
 * - full 模式下 Worker 的 comment_threads 存在 is_complete=0（上次楼中楼抓取失败）；
 * - full 模式下已落库的根评论+子评论不足内容评论数的一半（整页根评论漏抓）；
 * - 本轮内该内容评论抓取失败过（同一轮多阶段重复遇到时立即补抓）。
 * hot 模式只抓前 20 条热评，is_complete=0 属预期，不做完整性探测。
 */
async function shouldSyncCommentsDeep(
  contentPk: string,
  commentCount: number,
  prevCommentCount: number | null | undefined,
  mode: "full" | "hot" | "none"
): Promise<boolean> {
  if (shouldSyncComments(commentCount, prevCommentCount)) return true;
  if (mode !== "full") return false;
  if (commentSyncIncomplete.has(contentPk)) return true;
  const expected = Number(commentCount) || 0;
  if (expected <= 0) return false;
  const [sourceType] = contentPk.split(":");
  if (sourceType !== "answer" && sourceType !== "article") return false;
  const state = await fetchStoredCommentState(contentPk);
  if (!state) return false;
  if (state.incompleteRoots > 0) return true;
  // 只读到 50 根时无法判断根评论是否抓全，不做「明显偏少」推断
  if (state.roots >= 50) return false;
  // 根评论数本身明显不足：知乎 v4 answers/root_comments 对高评论回答会假 is_end，
  // 把根评论截断在第一页（20 根），但这些根的子评论往往已抓全。仅看 storedComments
  // （根+子）会把这类截断误判为「够完整」而永久跳过。评论 = 根 + 子，正常根数极少
  // 低于评论总数的 1/3；低于即视为根评论被截断，强制重抓（端点已改走 comment_v5 能翻全）。
  if (state.roots * 3 < expected) return true;
  return state.storedComments * 2 < expected;
}

// 知乎 API 统一请求入口（实现见 zhihu-fetch.ts）：
// - 401 立即失败并计入 authRejected（cookie 失效，暂停无意义）；
// - 403/429/5xx、200 风控空页、200 非 JSON 会暂停后重试（Retry-After 优先，封顶 120s，
//   否则 60s ±10%），同一请求最多重试 2 次；整个 run 累计暂停封顶 15 分钟；
// - 重试耗尽仍被拒时置 stats.riskExhausted，所有外层循环看到后立刻结束；
// - 重试只发生在单次请求内部，调用方只有成功返回后才推进 offset / nextUrl / 游标。
const zhihuJson = createZhihuJson(stats, {
  log: (message) => console.warn(message)
});

const sendContent = (b: any) => post("/ingest/content", b);
// 旧扁平接口 /ingest/comments 仍由 Worker 保留兼容，但爬虫已统一走按根分组接口
const sendCollectionSnapshot = (b: any) => post("/ingest/collection-snapshot", b);

/**
 * 补全单篇回答的真实统计（赞同数 / 浏览量 / 评论数）。
 *
 * 根因（10-live-answers 真机实测）：members/{token}/answers 列表接口不返回顶层
 * voteup_count / visit_count；其 reaction.statistics.like_count 是右下角「❤️ 喜欢数」，
 * 通常只有「▲ 赞同数」的 1%~5%（例：13,026 收藏的回答 like_count 只有 354，
 * 1,431 赞的回答 like_count 只有 25），visit_count 更是恒缺。
 * 真实顶层 voteup_count / visit_count 只有回答详情接口
 * /api/v4/answers/{id}?include=voteup_count,visit_count,comment_count 才返回。
 *
 * 单篇 404/被删/风控单条失败时返回 null，调用方回退列表原有字段，绝不中断主流程。
 */
async function fetchAnswerTrueStats(
  context: any,
  answerId: string
): Promise<{ voteupCount: number; visitCount: number; commentCount?: number } | null> {
  // 温和节流：逐篇详情请求是额外流量，固定 250ms 连打容易被判定为脚本
  await jitterSleep(250, 550);
  try {
    const { json } = await zhihuJson(
      context,
      `https://www.zhihu.com/api/v4/answers/${answerId}?include=voteup_count,visit_count,comment_count`,
      { label: `回答详情统计 ${answerId}`, allow404: true }
    );
    return {
      voteupCount: Number(json.voteup_count ?? json.reaction?.statistics?.up_vote_count ?? 0) || 0,
      visitCount: Number(json.visit_count ?? json.reaction?.statistics?.pv_count ?? 0) || 0,
      commentCount: typeof json.comment_count === "number" ? json.comment_count : undefined
    };
  } catch (e: any) {
    console.warn(`⚠️ 回答真实统计获取失败 (${answerId})，回退列表字段: ${sanitizeErrorForLog(e)}`);
    return null;
  }
}


const ZHIHU_USERNAME = zhihuUsername;
const ZHIHU_COOKIE_STRING = cookieString;
const ZHIHU_COOKIE_Z_C0 = undefined;

async function setupBrowser() {
  return chromium.launch({ headless: true });
}

// 已知内容类型：收藏夹里会出现 zvideo 等未知类型，直接透传会被服务端
// zod enum 拒掉（400），映射到 pin 又会写出错误的 URL——两处必须用同一映射
const KNOWN_TYPES = new Set(["answer", "article", "pin"]);

// 秒级时间戳转 ISO；缺失时返回空串而不是 1970-01-01 哨兵
// （哨兵入库会污染排序，服务端也会把 1970 视为无效值回退旧数据）
const toIsoOrNull = (sec?: number) => (sec ? new Date(sec * 1000).toISOString() : "");

function getCookiesArray() {
  const cookies: Array<{name: string, value: string, domain: string, path: string}> = [];

  // 如果用户粘贴了全量 Cookie 字符串，自动拆解。
  // 逐条过滤而不是整串直接交给 addCookies：Playwright 遇到含控制字符
  // （换行粘贴很常见）的值或 __Host-/__Secure- 前缀（要求 secure:true）
  // 会直接 throw，一条脏 cookie 就炸掉整轮抓取。
  if (ZHIHU_COOKIE_STRING) {
    const pairs = ZHIHU_COOKIE_STRING.split(";").map(s => s.trim()).filter(Boolean);
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (/[\x00-\x1f\x7f]/.test(value) || name.startsWith("__Host-") || name.startsWith("__Secure-")) continue;
      cookies.push({ name, value, domain: ".zhihu.com", path: "/" });
    }
  } else if (ZHIHU_COOKIE_Z_C0) {
    // 兼容只填了 z_c0 的情况
    cookies.push({ name: "z_c0", value: ZHIHU_COOKIE_Z_C0, domain: ".zhihu.com", path: "/" });
  }

  if (cookies.length === 0) {
    throw new Error("cookieString 里没有可用的知乎 cookie（解析结果为空）");
  }
  return cookies;
}

function cleanHtml(html: any) {
  if (typeof html !== "string") return "";
  let cleaned = html.replace(/<img([^>]*)>/g, (match, attrs) => {
     const realSrc = attrs.match(/data-(?:original|actualsrc)="([^"]+)"/);
     if (!realSrc) return match;
     const src = realSrc[1];
      // 懒加载图常见 src="" 或没有 src 属性；注意 \s 前缀——不带的话正则会
      // 误配到 data-actualsrc 属性名内部的 "src="，替换错位置后图片仍空白
      if (/\ssrc="[^"]*"/.test(attrs)) {
        return `<img${attrs.replace(/\ssrc="[^"]*"/, ` src="${src}"`)}>`;
      }
     return `<img${attrs} src="${src}">`;
  });
  // Remove data-pid to prevent spurious text updates
  cleaned = cleaned.replace(/\sdata-pid="[^"]*"/g, "");
  return cleaned;
}

/**
 * 评论图片归一化：主回答链路与收藏/赞同/关注链路必须产出同一份 content/img，
 * 否则同一评论换通道后 comment_hash 变化，会反复追加 comment_versions + change_events。
 * 优先级：标准 img 字段 > imageUrl 兼容字段 > 正文里的「查看图片」链接。
 * 图片 URL 只落在 img/imageUrl，正文中的链接会被移除，不把 URL 写进正文。
 */
function pickCommentImageUrl(comment: { img?: unknown; imageUrl?: unknown; image_url?: unknown }): string {
  for (const value of [comment.img, comment.imageUrl, comment.image_url]) {
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function normalizeCommentImage(
  rawContent: unknown,
  comment: { img?: unknown; imageUrl?: unknown; image_url?: unknown }
): { content: string; img: string; imageUrl: string } {
  let text = typeof rawContent === "string" ? rawContent : "";
  let contentImg = "";
  // 先锁定单个 <a ...>...</a> 块再验文本，属性段用 [^>]* 禁止跨过标签边界：
  // 同一条评论前文若有普通 link.zhihu.com 链接、后文才是「查看图片」，
  // 旧写法 .*? 会跨 </a> 误抓前文链接。
  const imgMatch = text.match(/<a\b[^>]*?\bhref=["']([^"']+)["'][^>]*>\s*查看图片\s*<\/a>/i);
  if (imgMatch) {
    contentImg = imgMatch[1];
    text = text.replace(imgMatch[0], "").trim();
  }
  const img = pickCommentImageUrl(comment) || contentImg;
  return { content: cleanHtml(text), img, imageUrl: img };
}

export async function runScraper() {
  const browser = await setupBrowser();
  try {
    await runScraperBody(browser);
  } finally {
    // 异常/中止退出也必须关闭 Chromium，否则本地脚本反复跑会残留僵尸浏览器进程
    await browser.close().catch(() => {});
  }
}

async function runScraperBody(browser: Awaited<ReturnType<typeof setupBrowser>>) {
  console.log("🚀 开始知乎回答自动同步...");
  
  const context = await browser.newContext();
  await context.addCookies(getCookiesArray());

  const pendingCommentsQueue: Array<{ answerId: string; url: string; commentCount: number }> = [];

  let isEnd = false;
  let existingCount = 0;
  let pagesScanned = 0;
  let submitted = 0;
  let createdCount = 0;
  let noChangeCount = 0;
  let duplicateSkipped = 0;
  let limitIgnoredWarned = false;
  
  console.log("🌐 正在通过 API 拉取回答列表...");
  // 真机实测（10-live-answers）：answers 列表 include 只保留真实生效的键。
  // annotation_detail / label_info / is_recognized / voteup_count / visit_count /
  // favorite_count 与 author.badge[?(type=best_answerer)].topics 均严格不返回，已删除。
  const includeStr = encodeURIComponent("data[*].is_normal,admin_closed_comment,reward_info,is_collapsed,annotation_action,collapse_reason,collapsed_by,suggest_edit,comment_count,can_comment,content,reshipment_settings,comment_permission,mark_infos,created_time,updated_time,review_info,question,excerpt,is_labeled,relationship.is_authorized,voting,is_author,is_thanked,is_nothelp");

  // answers 接口会忽略 limit（实测 offset=0/20/40 返回 37/38/20 条），
  // 继续按 offset += 20 翻页会把相邻页 40% 的重复项当成"无变化"，
  // 极速模式下 20 条重复就能凑满早停阈值，562 篇只入库 57 篇。
  // 改为跟随服务端 paging.next 翻页，并用 seenIds 去重后计早停。
  let nextUrl: string = `https://www.zhihu.com/api/v4/members/${ZHIHU_USERNAME}/answers?include=${includeStr}&limit=20&offset=0`;
  // 服务端 offset 坐标系：记录当前页请求实际使用的 offset。
  // paging.next 缺失时按服务端步长（limit=20）推进；不能按「实际返回条数」累加，
  // 否则第 1 页 37 条 + 第 2 页 38 条会让下一跳 offset=75，而服务端坐标系应为 40，漏抓 40~74。
  let currentOffset = 0;
  const seenIds = new Set<string>();

  while (!isEnd && nextUrl && !stats.riskExhausted) {
    let json: any;
    try {
      json = (await zhihuJson(context, nextUrl, { label: "我的回答列表" })).json;
    } catch (e: any) {
      // 401/403/429/5xx/风控空页的暂停重试与统计都已在 zhihuJson 内完成，这里只结束本段
      console.error(`❌ 获取回答失败: ${sanitizeErrorForLog(e)}`);
      break;
    }

    if (!json.data || json.data.length === 0) {
      // 风控空页（!paging.is_end）已在 zhihuJson 内重试并计入 riskEmpty；
      // 能走到这里的是服务端明确 is_end 的合法空页
      break;
    }

    pagesScanned++;
    const pageLen = Array.isArray(json.data) ? json.data.length : 0;
    if (pageLen !== 20 && !limitIgnoredWarned) {
      limitIgnoredWarned = true;
      console.warn(`⚠️ answers 分页返回 ${pageLen} 条（limit 未生效），已按 paging.next 翻页`);
    }
    for (const item of json.data) {
      if (!item?.id || item.type !== "answer") continue;
      const idStr = String(item.id);
      // 分页重叠去重：同一回答可能在相邻页重复出现，重复项不得计入
      // existingCount（否则重复项会被当成"无变化"凑满 20 条触发假早停）
      if (seenIds.has(idStr)) {
        duplicateSkipped++;
        continue;
      }
      seenIds.add(idStr);

      // ⚠️ 列表字段的真实语义（10-live-answers 真机实测）：
      // - 顶层 voteup_count / visit_count / favorite_count 在 members/answers 列表里严格不返回；
      // - reaction.statistics.like_count 是右下角「❤️ 喜欢数」，不是「▲ 赞同数」，
      //   通常只有赞同数的 1%~5%（13026 收藏的回答 like_count 仅 354，1431 赞的仅 25）；
      // - visit_count 列表不存在。
      // 因此真实赞同数与真实浏览量必须走回答详情 /api/v4/answers/{id}：
      // - 全量模式：逐篇补全（539 篇约 3 分钟），换取 100% 准确的赞同数与十万级真实浏览量；
      // - 极速模式：只补前 2 页（新回答/涨赞集中在这两页头部，第 3 页后很快触发 20 条早停），
      //   其余条目沿用列表字段，避免每一轮都为全量历史多打几百次详情请求。
      const shouldFetchTrueStats = !isFast || pagesScanned <= 2;
      const trueStats = shouldFetchTrueStats ? await fetchAnswerTrueStats(context, idStr) : null;
      const finalVoteup = trueStats?.voteupCount ?? item.voteup_count ?? item.reaction?.statistics?.like_count ?? 0;
      const finalFavorite = item.favorite_count ?? item.reaction?.statistics?.favorites ?? 0;
      const finalVisit = trueStats?.visitCount ?? item.visit_count ?? 0;
      const finalCommentCount = trueStats?.commentCount ?? item.comment_count ?? 0;


      const contentInput = {
        sourceType: "answer" as const,
        sourceId: String(item.id),
        title: item.question?.title || "未知问题",
        sourceUrl: `https://www.zhihu.com/question/${item.question?.id}/answer/${item.id}`,
        author: { name: item.author?.name, urlToken: item.author?.url_token, avatarUrl: item.author?.avatar_url, headline: item.author?.headline },
        question: { id: String(item.question?.id), title: item.question?.title },
        contentHtml: cleanHtml(item.content),
        contentMd: "",
        excerpt: item.excerpt || "",
        voteupCount: finalVoteup,
        commentCount: finalCommentCount,
        favoriteCount: finalFavorite,
        visitCount: finalVisit,
        isCollapsed: item.is_collapsed,
        isLabeled: item.is_labeled,
        labelInfo: item.label_info ? JSON.stringify(item.label_info) : "",
        createdTime: toIsoOrNull(item.created_time),
        updatedTime: toIsoOrNull(item.updated_time)
      };

      try {
        const dbRes = await sendContent(contentInput);
        submitted++;
        if (dbRes.created) createdCount++;
        else if (!dbRes.changed) noChangeCount++;
        console.log(`✅ 保存回答: ${contentInput.title}${dbRes.created ? " [新增]" : dbRes.changed ? " [有正文/元数据变更]" : " [无变化·仅计数同步]"}`);
        
        const needComments =
          cfg.commentsMyAnswers !== "none" &&
          await shouldSyncCommentsDeep(
            `answer:${idStr}`,
            contentInput.commentCount,
            dbRes.prevCommentCount,
            cfg.commentsMyAnswers
          );
        if (needComments) {
          console.log(`💬 发现待备份/更新评论 (${dbRes.prevCommentCount || 0} -> ${contentInput.commentCount})，加入抓取队列`);
          pendingCommentsQueue.push({
            answerId: String(item.id),
            url: contentInput.sourceUrl,
            commentCount: contentInput.commentCount
          });
          existingCount = 0;
        } else if (!dbRes.created && !dbRes.changed) {
          existingCount++;
          if (existingCount >= 20 && isFast) {
            console.log("🛑 连续20个条目及评论均无更新，停止本轮极速同步。");
            isEnd = true;
            break;
          }
        } else {
          existingCount = 0;
        }
      } catch (err: any) {
        console.error(`❌ 保存回答失败: ${sanitizeErrorForLog(err)}`);
        if (stats.circuitBroken) {
          console.error("🛑 连续 5 次入库失败（可能触发 D1 每日写入限额），暂停回答同步。");
          isEnd = true;
          break;
        }
      }
    }

    if (stats.circuitBroken || stats.riskExhausted) break;
    if (!isEnd) isEnd = Boolean(json.paging?.is_end);
    const nextFromApi = typeof json.paging?.next === "string" ? json.paging.next : "";
    if (nextFromApi) {
      // 跟随服务端分页游标，并同步记录它使用的 offset（服务端坐标系）
      try {
        const o = new URL(nextFromApi).searchParams.get("offset");
        if (o !== null && Number.isFinite(Number(o))) currentOffset = Number(o);
        else currentOffset += 20;
      } catch {
        currentOffset += 20;
      }
      nextUrl = nextFromApi;
    } else {
      currentOffset += 20; // limit 参数固定 20，服务端 offset 步长同为 20
      nextUrl = isEnd ? "" : `https://www.zhihu.com/api/v4/members/${ZHIHU_USERNAME}/answers?include=${includeStr}&limit=20&offset=${currentOffset}`;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (duplicateSkipped > 0) {
    console.log(`🔁 answers 分页重叠去重：跳过 ${duplicateSkipped} 条重复条目`);
  }

  if (pendingCommentsQueue.length > 0 && !stats.circuitBroken && !stats.riskExhausted) {
    console.log(`💬 正在抓取 ${pendingCommentsQueue.length} 篇回答的评论...`);
    for (const task of pendingCommentsQueue) {
      if (stats.circuitBroken || stats.riskExhausted) break;
      let cOffset = 0;
      let cIsEnd = false;
      let cIncomplete = false;
      let cFailed = false;
      let rootPages = 0;
      let rootEnded = false;
      const contentPk = `answer:${task.answerId}`;
      // 评论被彻底删光（comment_count === 0 且此前 > 0）：无须再请求知乎评论接口，
      // 直接发一次空 roots 的全量对账，让 Worker 软删旧根、清零 comment_count 与线程索引。
      if ((task.commentCount || 0) === 0) {
        try {
          await postCommentsByRoot(contentPk, [], { partial: false, allRootIds: [] });
          console.log(`🧹 评论已清零，完成删除对账 (回答 ID: ${task.answerId})`);
        } catch (e: any) {
          console.warn(`⚠️ 评论清零对账失败 (回答 ${task.answerId}): ${sanitizeErrorForLog(e)}`);
        }
        continue;
      }
      const allRootIds: string[] = [];
      const seenRootIds = new Set<string>();
      let pendingRoots: RootCommentGroup[] = [];
      let submittedRoots = 0;
      let submittedChildren = 0;

      // 根评论每 20 条一批提交；最后一批先留在 pendingRoots，
      // 等翻页结束再发，才能带上完整 allRootIds 做删除对账。
      const enqueueRoot = async (group: RootCommentGroup) => {
        allRootIds.push(group.id);
        pendingRoots.push(group);
        if (pendingRoots.length > 20) {
          const batch = pendingRoots.slice(0, 20);
          pendingRoots = pendingRoots.slice(20);
          try {
            const res = await postCommentsByRoot(contentPk, batch, { partial: true });
            submittedRoots += res.roots;
            submittedChildren += res.children;
            if (res.aborted) {
              cIncomplete = true;
              cFailed = true;
            }
          } catch (e: any) {
            // 瞬时失败已在 postCommentsByRoot 内重试过一次；这里只记录，
            // 整轮标记 partial，避免按不完整数据做删除对账
            cIncomplete = true;
            cFailed = true;
            console.warn(`⚠️ 评论根批次提交失败 (回答 ${task.answerId}): ${sanitizeErrorForLog(e)}`);
          }
        }
      };
      
      // 知乎 v4 answers/root_comments 对部分回答会在第 1~2 页就返回 is_end=true
      //（paging.totals 也明显偏小），根评论被假终止在 20~40 条；comment_v5 的
      // answers/root_comment 才返回完整游标分页，与文章链路对齐。
      // full 必须用 order_by=ts：score 排序实测在约 200 根处同样假 is_end。
      // comment_v5 answers 每页固定 10 条，offset 是游标字符串，需跟随 paging.next。
      const buildRootCommentsUrl = (offset: number) =>
        `https://www.zhihu.com/api/v4/comment_v5/answers/${task.answerId}/root_comment?order_by=${
          cfg.commentsMyAnswers === "full" ? "ts" : "score"
        }&limit=20&offset=${offset === 0 ? "" : offset}`;
      let cNextUrl = buildRootCommentsUrl(0);
      while (!cIsEnd && rootPages < MAX_COMMENT_PAGES && !stats.riskExhausted && !stats.circuitBroken) {
        let cJson: any;
        try {
          cJson = (await zhihuJson(context, cNextUrl, {
            label: `回答 ${task.answerId} 根评论`
          })).json;
        } catch (e: any) {
          // 401/403/429/5xx/风控空页都已在 zhihuJson 内重试并计入终态统计
          console.warn(`⚠️ 回答 ${task.answerId} 根评论中断: ${sanitizeErrorForLog(e)}`);
          cIncomplete = true;
          cFailed = true;
          break;
        }
        // 知乎风控会返回 200 + 空数组；该形态已在 zhihuJson 内重试并计数。
        // 能走到这里的是 is_end 的合法空页。
        if (!cJson.data || cJson.data.length === 0) {
          rootEnded = true;
          break;
        }
        rootPages++;
        if (cfg.commentsMyAnswers === "hot" && cOffset >= 20) {
          cIncomplete = true;
          break;
        }
        
        for (const c of cJson.data) {
          if (stats.riskExhausted || stats.circuitBroken) break;
          const rootId = String(c.id);
          // 点赞序 + offset 翻页期间点赞变化会让同一条根评论漂移到相邻页，
          // 重复根会重复累计子评论，必须按 id 去重
          if (seenRootIds.has(rootId)) continue;
          seenRootIds.add(rootId);

          const childCount = Number(c.child_comment_count) || 0;
          const children: ChildComment[] = [];
          const seenChildIds = new Set<string>();
          const pushChild = (child: any) => {
            const childId = String(child.id);
            if (seenChildIds.has(childId)) return;
            seenChildIds.add(childId);
            children.push(toChildComment(child, rootId));
          };
          // 内联 child_comments 通常只是前几条，先收进来，再翻页补齐（按 id 去重）
          if (Array.isArray(c.child_comments)) {
            for (const child of c.child_comments) pushChild(child);
          }

          let childrenComplete: boolean;
          if (childCount > children.length) {
            let chOffset = 0;
            let chIsEnd = false;
            let chPages = 0;
              while (!chIsEnd && chPages < MAX_COMMENT_PAGES && !stats.riskExhausted && !stats.circuitBroken) {
                // 必须复用带 cookie 的 context.request：裸 fetch 不带登录态，知乎直接 401，
                // 结果就是该回答的评论永远同步不了。
                let chJson: any;
                try {
                  chJson = (await zhihuJson(
                    context,
                    `https://www.zhihu.com/api/v4/comments/${c.id}/child_comments?limit=20&offset=${chOffset}`,
                    { label: `评论 ${c.id} 子评论` }
                  )).json;
                } catch (e: any) {
                  console.warn(`⚠️ 评论 ${c.id} 子评论中断: ${sanitizeErrorForLog(e)}`);
                  cIncomplete = true;
                  cFailed = true;
                  break;
                }
                if (!chJson.data || chJson.data.length === 0) {
                  chIsEnd = true;
                  break;
                }
                chPages++;
                for (const child of chJson.data) pushChild(child);
                chIsEnd = Boolean(chJson.paging?.is_end);
                chOffset += 20;
                await jitterSleep(900, 1700);
              }
            if (!chIsEnd && chPages >= MAX_COMMENT_PAGES) {
              cIncomplete = true;
              console.warn(`⚠️ 评论 ${c.id} 子评论达到 ${MAX_COMMENT_PAGES} 页上限，本轮标记 partial`);
            }
            // 翻到 is_end 或已补齐 child_comment_count 才算子评论完整
            childrenComplete = chIsEnd || children.length >= childCount;
          } else {
            childrenComplete = children.length >= childCount;
          }

          await enqueueRoot(toRootCommentGroup(c, children, childrenComplete));
        }
        
        if (stats.riskExhausted || stats.circuitBroken) {
          cIncomplete = true;
          cFailed = true;
          break;
        }
        cIsEnd = Boolean(cJson.paging?.is_end);
        if (cIsEnd) rootEnded = true;
        cOffset += 20;
        if (!cIsEnd) {
          // comment_v5 的 offset 是游标字符串（如 1380238650_151692731_0），不能按数字步进；
          // 优先跟随 paging.next，相对路径按知乎域名补全
          const pagingNext = typeof cJson.paging?.next === "string" ? cJson.paging.next : "";
          let resolvedNext = "";
          if (pagingNext) {
            try {
              resolvedNext = new URL(pagingNext, "https://www.zhihu.com").toString();
            } catch {
              resolvedNext = "";
            }
          }
          if (resolvedNext && resolvedNext !== cNextUrl) {
            cNextUrl = resolvedNext;
          } else {
            // 游标链断裂（paging.next 缺失或指向当前页）：数字 offset 只会重复拉第一页
            // 空转到页数上限，或拿空页误判翻完。立即结束本回答翻页并标记 partial。
            console.warn(`⚠️ 回答 ${task.answerId} 根评论游标链断裂（paging.next 缺失/重复），本轮标记 partial`);
            cIncomplete = true;
            break;
          }
        }
        await jitterSleep(1100, 2000);
      }
      // 没正常翻到 is_end（风控/熔断/页数上限/hot 截断）时本轮必须标记 partial，
      // 否则最后一批会按不完整的根列表做删除对账
      if (!rootEnded) cIncomplete = true;
      if (!cIsEnd && rootPages >= MAX_COMMENT_PAGES) {
        cIncomplete = true;
        console.warn(`⚠️ 回答 ${task.answerId} 根评论达到 ${MAX_COMMENT_PAGES} 页上限，本轮标记 partial`);
      }
      
      if (pendingRoots.length > 0) {
        // 最后一批：全量且完整时 partial=false 并带完整 allRootIds 供删除对账；
        // 抓取中断时保持 partial=true，绝不能按不完整列表删数据
        const batch = pendingRoots;
        pendingRoots = [];
        try {
          const res = await postCommentsByRoot(contentPk, batch, {
            partial: cIncomplete,
            allRootIds
          });
          submittedRoots += res.roots;
          submittedChildren += res.children;
          if (res.aborted) {
            cIncomplete = true;
            cFailed = true;
          }
        } catch (err: any) {
          cIncomplete = true;
          cFailed = true;
          console.error(`❌ 保存评论失败: ${sanitizeErrorForLog(err)}`);
          if (stats.circuitBroken) {
            commentSyncIncomplete.add(contentPk);
            break;
          }
        }
      }
      if (submittedRoots > 0) {
        console.log(`✅ 保存评论: 根 ${submittedRoots} 条 / 子 ${submittedChildren} 条 (回答 ID: ${task.answerId})${cIncomplete ? " [partial]" : ""}`);
      } else if (cIncomplete) {
        console.warn(`⚠️ 回答 ${task.answerId} 评论抓取中断且无数据，跳过本轮提交`);
      }
      if (cFailed) {
        commentSyncIncomplete.add(contentPk);
      } else if (!cIncomplete) {
        commentSyncIncomplete.delete(contentPk);
      }
    }
  }

  console.log("🎉 回答和评论同步完成！");
  console.log(
    `📊 本轮我的回答：扫描 ${pagesScanned} 页 / 提交 ${submitted} 条 / 新增 ${createdCount} 条 / 无变化 ${noChangeCount} 条 / 重复跳过 ${duplicateSkipped} 条` +
    (isFast && existingCount >= 20 ? "（命中连续无更新早停）" : "")
  );
}

/**
 * 备份「用户自己写的专栏文章」。
 *
 * 关注答主链路（runFollowingScraper）只覆盖别人写的文章，本人文章此前没有任何入口，
 * 知乎侧一旦删文就无从恢复。这里独立成一条链路而不是塞进 runScraper：
 * scripts/db-write-regression.test.mjs 的 mock 只实现 /answers 与 /root_comments，
 * runScraper 内一旦请求 /articles 会直接抛 "unexpected crawler URL" 让回归测试挂掉。
 */
export async function runArticleScraper() {
  const browser = await setupBrowser();
  try {
    await runArticleScraperBody(browser);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runArticleScraperBody(browser: Awaited<ReturnType<typeof setupBrowser>>) {
  console.log("🚀 开始知乎专栏文章自动同步...");

  const context = await browser.newContext();
  await context.addCookies(getCookiesArray());

  // include 与关注答主文章段（12-live-articles 真机验证）保持一致：
  // content/voteup_count/comment_count/is_labeled 生效；favorite_count/visit_count 会被静默忽略。
  const includeStr = encodeURIComponent(
    "data[*].content,voteup_count,comment_count,is_labeled;data[*].author.avatar_url,headline"
  );
  const buildUrl = (pageOffset: number) =>
    `https://www.zhihu.com/api/v4/members/${encodeURIComponent(ZHIHU_USERNAME)}/articles?include=${includeStr}&offset=${pageOffset}&limit=20&sort_by=created`;

  const seenArticleIds = new Set<string>();
  let offset = 0;
  let nextUrl = buildUrl(offset);
  let pagesScanned = 0;
  let submitted = 0;
  let unchangedStreak = 0;

  while (nextUrl && !stats.circuitBroken && !stats.riskExhausted) {
    const currentUrl = nextUrl;
    let artJson: any;
    try {
      artJson = (await zhihuJson(context, currentUrl, { label: "我的文章列表" })).json;
    } catch (e: any) {
      // 401/403/429/5xx/风控空页的暂停重试与统计都已在 zhihuJson 内完成，这里只结束本段
      console.error(`❌ 获取我的文章列表失败: ${sanitizeErrorForLog(e)}`);
      break;
    }

    if (!artJson.data || artJson.data.length === 0) {
      // 风控空页（!paging.is_end）已在 zhihuJson 内重试并计入 riskEmpty；
      // 能走到这里的是服务端明确 is_end 的合法空页
      break;
    }

    pagesScanned++;

    for (const art of artJson.data) {
      if (stats.circuitBroken || stats.riskExhausted) break;
      if (!art?.id) continue;
      const articleIdStr = String(art.id);
      // 分页重叠/游标回退去重：同一篇文章重复入库只会白烧 D1 配额
      if (seenArticleIds.has(articleIdStr)) continue;
      seenArticleIds.add(articleIdStr);

      // 自有文章不做风险/价值过滤：用户自己写的内容必须全部无条件存档
      const contentInput = {
        sourceType: "article" as const,
        sourceId: articleIdStr,
        title: art.title || "无标题文章",
        excerpt: art.excerpt || art.excerpt_title || "",
        contentHtml: cleanHtml(art.content || ""),
        contentMd: "",
        author: {
          name: art.author?.name || ZHIHU_USERNAME,
          urlToken: art.author?.url_token || ZHIHU_USERNAME,
          avatarUrl: art.author?.avatar_url || "",
          headline: art.author?.headline || ""
        },
        voteupCount: Number(art.voteup_count ?? 0) || 0,
        commentCount: Number(art.comment_count ?? 0) || 0,
        favoriteCount: Number(art.favorite_count ?? art.reaction?.statistics?.favorites ?? 0) || 0,
        visitCount: Number(art.visit_count ?? 0) || 0,
        isCollapsed: false,
        isLabeled: Boolean(art.is_labeled),
        createdTime: toIsoOrNull(art.created ?? art.created_time),
        updatedTime: toIsoOrNull(art.updated ?? art.updated_time),
        sourceUrl: `https://zhuanlan.zhihu.com/p/${art.id}`
      };

      try {
        const res = await sendContent(contentInput);
        submitted++;
        // 自有文章与回答链路一致：评论数新增或被删（含删光为 0）都要重抓/对账
        if (
          cfg.commentsMyAnswers !== "none" &&
          await shouldSyncCommentsDeep(
            `article:${articleIdStr}`,
            contentInput.commentCount,
            res?.prevCommentCount,
            cfg.commentsMyAnswers
          ) &&
          !stats.circuitBroken &&
          !stats.riskExhausted
        ) {
          await syncHotCommentsForContent(context, "article", articleIdStr, cfg.commentsMyAnswers);
        }
        // 极速模式的连续无变化计数：res?.changed === false 才算无变化
        if (isFast && res?.changed === false) {
          unchangedStreak++;
        } else {
          unchangedStreak = 0;
        }
      } catch (e: any) {
        console.error(`❌ 保存我的文章失败: ${contentInput.title}`, sanitizeErrorForLog(e));
        if (stats.circuitBroken) break;
      }
    }

    if (isFast && unchangedStreak >= 5) {
      console.log("🛑 连续 5 篇文章无变化，停止本轮极速同步。");
      break;
    }
    if (stats.circuitBroken || stats.riskExhausted) break;

    // 明确翻到末页才结束；否则跟随 paging.next（优先解析其中的 offset）
    if (artJson.paging?.is_end === true) break;
    const pagingNext = typeof artJson.paging?.next === "string" ? artJson.paging.next : "";
    if (pagingNext && pagingNext !== currentUrl) {
      nextUrl = pagingNext;
      try {
        const nextOffset = Number(new URL(pagingNext).searchParams.get("offset"));
        if (Number.isFinite(nextOffset) && nextOffset >= 0) offset = nextOffset;
      } catch {
        /* 非绝对 URL：保持原 offset，下一页按步长推进 */
      }
    } else {
      // 没有可用 next（或 next 与当前页相同，防止死循环）：按 limit 步长推进
      offset += 20;
      nextUrl = buildUrl(offset);
    }

    await new Promise(r => setTimeout(r, 800));
  }

  console.log(`📊 本轮我的专栏文章：扫描 ${pagesScanned} 页 / 提交 ${submitted} 篇`);
}

/**
 * 按设置策略（none: 不抓 / hot: 前1页20条高赞热评+内联子评论 / full: 全量分页抓取）
 * 为收藏夹/赞同/关注答主的回答或文章抓取评论。
 *
 * - 回答：/api/v4/comment_v5/answers/{id}/root_comment（v4 的 answers/root_comments 对部分回答
 *   第 1~2 页就假 is_end，根评论被截断在 20~40 条；comment_v5 才能完整游标分页。
 *   full 用 order_by=ts：score 排序实测在约 200 根处同样假 is_end）
 * - 专栏文章：/api/v4/comment_v5/articles/{id}/root_comment（v4 的 root_comments 端点已废弃恒 404；
 *   comment_v5 的 offset 可能是游标字符串，因此优先跟随 paging.next）
 * - full 模式正常翻到 is_end 时，最后一批带 allRootIds + partial=false 做删除对账；
 *   hot 模式或中途风控/页数上限中断一律 partial=true，绝不按不完整数据删。
 * - 第 1 页合法空页 + is_end（评论被整体删光/关闭评论）且 full 模式：发空 roots 对账清零。
 */
export async function syncHotCommentsForContent(
  context: any,
  sourceType: "answer" | "article" | "pin",
  sourceId: string,
  mode: "full" | "hot" | "none" = "hot"
) {
  if (mode === "none") return;
  if (sourceType !== "answer" && sourceType !== "article") return;
  if (stats.circuitBroken || stats.riskExhausted) return;

  const contentPk = `${sourceType}:${sourceId}`;
  const isArticle = sourceType === "article";
  const buildUrl = (offset: number) =>
    isArticle
      ? `https://www.zhihu.com/api/v4/comment_v5/articles/${sourceId}/root_comment?order_by=score&limit=20&offset=${offset === 0 ? "" : offset}`
      : `https://www.zhihu.com/api/v4/comment_v5/answers/${sourceId}/root_comment?order_by=${
          mode === "full" ? "ts" : "score"
        }&limit=20&offset=${offset === 0 ? "" : offset}`;

  // 中途风控/异常/撞页数上限 → 不允许做删除对账；
  // cFailed 单独记录「请求失败/风控中断」，供下一轮强制重抓，不把页数上限误判为失败
  let cIncomplete = false;
  let cFailed = false;

  try {
    let cOffset = 0;
    let cIsEnd = false;
    let nextUrl = buildUrl(cOffset);
    const maxPages = mode === "full" ? MAX_COMMENT_PAGES : 1;
    let pagesFetched = 0;
    const seenRootIds = new Set<string>();
    const allRootIds: string[] = [];
    let rootsBuffer: RootCommentGroup[] = [];

    // 每 20 根一批提交（服务端每根 2 个子请求，仍在 Workers 50 子请求限制内）。
    // 非最后一批一律 partial=true；最后一批是否对账由调用点按 full + 完整性决定。
    const flushRoots = async (isLast: boolean) => {
      if (rootsBuffer.length === 0) return;
      const batch = rootsBuffer;
      rootsBuffer = [];
      const canReconcile = isLast && mode === "full" && !cIncomplete;
      await postCommentsByRoot(
        contentPk,
        batch,
        canReconcile ? { partial: false, allRootIds } : { partial: true }
      );
    };

    while (!cIsEnd && pagesFetched < maxPages && !stats.circuitBroken && !stats.riskExhausted) {
      let cJson: any;
      try {
        const res = await zhihuJson(context, nextUrl, {
          label: `${sourceType} ${sourceId} 热评`,
          // 单篇文章关闭评论/被删会 404：属正常业务结果，不能污染整轮风控计数
          ...(isArticle ? { allow404: true } : {})
        });
        cJson = res.json;
      } catch (e: any) {
        console.warn(`⚠️ 抓取评论中断 (${sourceType}:${sourceId}): ${sanitizeErrorForLog(e)}`);
        cIncomplete = true;
        cFailed = true;
        break;
      }

      const pageData: any[] = Array.isArray(cJson.data) ? cJson.data : [];
      if (pageData.length === 0) {
        // 合法空页：知乎明确 is_end 才可信（风控空页已在 zhihuJson 内重试并计数）
        const emptyIsEnd = cJson.paging?.is_end === true;
        if (pagesFetched === 0 && emptyIsEnd && mode === "full") {
          // 评论被整体删光/关闭评论：空 roots 全量对账，让 Worker 软删旧根并清零计数
          await postCommentsByRoot(contentPk, [], { partial: false, allRootIds: [] });
        } else if (!emptyIsEnd) {
          cIncomplete = true;
          cFailed = true;
        }
        cIsEnd = emptyIsEnd;
        break;
      }

      for (const c of pageData) {
        if (stats.circuitBroken || stats.riskExhausted) break;
        const rootId = String(c.id);
        // 点赞序翻页可能让同一根评论漂移到相邻页，重复根会重复写子评论
        if (seenRootIds.has(rootId)) continue;
        seenRootIds.add(rootId);
        allRootIds.push(rootId);

        const childCount = Number(c.child_comment_count) || 0;
        const children: ChildComment[] = [];
        const seenChildIds = new Set<string>();
        const pushChild = (child: any) => {
          const childId = String(child.id);
          if (seenChildIds.has(childId)) return;
          seenChildIds.add(childId);
          children.push(toChildComment(child, rootId));
        };
        // 根评论接口内联的 child_comments 通常只有前 2~5 条，先收进来再按需翻页补齐
        if (Array.isArray(c.child_comments)) {
          for (const child of c.child_comments) pushChild(child);
        }

        // full 模式：楼中楼必须翻页抓全（知乎根评论接口只内联前几条）。
        // hot 模式（赞同内容）保持轻量：只取 1 页根评论 + 内联楼中楼，不额外翻子评论页。
        let childrenComplete = children.length >= childCount;
        if (mode === "full" && childCount > children.length) {
          const buildChildUrl = (offset: number) =>
            isArticle
              ? `https://www.zhihu.com/api/v4/comment_v5/comment/${c.id}/child_comment?order_by=ts&limit=20&offset=${offset === 0 ? "" : offset}`
              : `https://www.zhihu.com/api/v4/comments/${c.id}/child_comments?offset=${offset}&limit=20`;
          let chOffset = 0;
          let chIsEnd = false;
          let chPages = 0;
          let chNextUrl = buildChildUrl(chOffset);
          while (!chIsEnd && chPages < MAX_COMMENT_PAGES && !stats.riskExhausted && !stats.circuitBroken) {
            let chJson: any;
            try {
              // 必须复用带 cookie 的 context.request：裸 fetch 不带登录态，知乎直接 401
              chJson = (await zhihuJson(context, chNextUrl, {
                label: `${sourceType} ${sourceId} 楼中楼 ${c.id}`,
                // 文章关闭评论/被删会 404：属正常业务结果，不污染整轮风控计数
                ...(isArticle ? { allow404: true } : {})
              })).json;
            } catch (e: any) {
              console.warn(
                `⚠️ 楼中楼抓取中断 (${sourceType}:${sourceId} 评论 ${c.id}): ${sanitizeErrorForLog(e)}`
              );
              cIncomplete = true;
              cFailed = true;
              break;
            }
            const chData: any[] = Array.isArray(chJson.data) ? chJson.data : [];
            if (chData.length === 0) {
              // 合法空页：只有明确 is_end 才算翻完
              chIsEnd = chJson.paging?.is_end === true;
              break;
            }
            chPages++;
            // 内联与翻页结果按 id 合并去重（同一楼中楼可能两边都返回）
            for (const child of chData) pushChild(child);
            // 收够 child_comment_count 即视为完整，不必再多打一页
            chIsEnd = chJson.paging?.is_end === true || children.length >= childCount;
            if (!chIsEnd) {
              // 子评论分页游标：文章 comment_v5 的 offset 可能是游标字符串，回答接口也可能下发
              // paging.next；两者都优先跟随 next（相对路径按知乎补全），否则按 limit=20 步进
              const pagingNext = typeof chJson.paging?.next === "string" ? chJson.paging.next : "";
              let resolvedNext = "";
              if (pagingNext) {
                try {
                  resolvedNext = new URL(pagingNext, "https://www.zhihu.com").toString();
                } catch {
                  resolvedNext = "";
                }
              }
              if (resolvedNext && resolvedNext !== chNextUrl) {
                chNextUrl = resolvedNext;
              } else {
                chOffset += 20;
                chNextUrl = buildChildUrl(chOffset);
              }
              await jitterSleep(900, 1700);
            }
          }
          if (!chIsEnd && chPages >= MAX_COMMENT_PAGES) {
            cIncomplete = true;
            console.warn(`⚠️ 评论 ${c.id} 楼中楼达到 ${MAX_COMMENT_PAGES} 页上限，本轮标记 partial`);
          }
          // 翻到 is_end 或已补齐 child_comment_count 才算子评论完整；中途异常/风控一律不完整
          childrenComplete = chIsEnd || children.length >= childCount;
        }
        rootsBuffer.push(toRootCommentGroup(c, children, childrenComplete));
        if (rootsBuffer.length >= 20) await flushRoots(false);
      }

      if (stats.circuitBroken || stats.riskExhausted) {
        // 中途熔断/风控：本页根评论未抓全，绝不能进入删除对账
        cIncomplete = true;
        cFailed = true;
        break;
      }

      cIsEnd = Boolean(cJson.paging?.is_end);
      pagesFetched++;
      if (!cIsEnd) {
        // comment_v5 的 offset 是游标字符串：回答与文章链路都优先跟随 paging.next。
        // paging.next 也可能是相对路径（/api/v4/comment_v5/...&offset=xxx），
        // 必须按 www.zhihu.com 补全，否则会退回数字 cOffset 拼 URL 导致游标断页。
        const pagingNext = typeof cJson.paging?.next === "string" ? cJson.paging.next : "";
        let resolvedNext = "";
        if (pagingNext) {
          try {
            resolvedNext = new URL(pagingNext, "https://www.zhihu.com").toString();
          } catch {
            resolvedNext = "";
          }
        }
        if (resolvedNext && resolvedNext !== nextUrl) {
          nextUrl = resolvedNext;
        } else {
          // 游标链断裂（paging.next 缺失或指向当前页）：数字 offset 只会重复拉第一页空转；
          // 立即结束翻页并标记不完整，绝不能按残缺根列表做删除对账。
          console.warn(`⚠️ ${sourceType} ${sourceId} 评论游标链断裂（paging.next 缺失/重复），本轮标记 partial`);
          cIncomplete = true;
          break;
        }
      }
      if (!cIsEnd && pagesFetched < maxPages) {
        await jitterSleep(1100, 2000);
      }
    }

    if (!cIsEnd) cIncomplete = true;
    if (mode === "full" && !cIsEnd && pagesFetched >= maxPages) {
      console.warn(`⚠️ ${sourceType} ${sourceId} 评论达到 ${maxPages} 页上限，本轮标记 partial`);
    }

    if (rootsBuffer.length > 0) {
      // 最后一批：只有 full 且完整翻到 is_end 才做删除对账
      await flushRoots(true);
    } else if (mode === "full" && !cIncomplete && allRootIds.length > 0) {
      // 根评论恰好是 20 的整数倍：最后一批已作为中间批发出，这里补一次空 roots 的全量对账
      await postCommentsByRoot(contentPk, [], { partial: false, allRootIds });
    }
  } catch (e: any) {
    console.warn(`⚠️ 抓取评论跳过 (${sourceType}:${sourceId}): ${sanitizeErrorForLog(e)}`);
    cFailed = true;
  }

  // 失败内容登记到本轮重抓集合：contents.comment_count 已被本次入库改成新值，
  // 仅靠评论数比较下一轮会永久跳过；本轮内再次遇到（多阶段重叠）必须补抓。
  if (cFailed) {
    commentSyncIncomplete.add(contentPk);
  } else if (!cIncomplete) {
    commentSyncIncomplete.delete(contentPk);
  }
}

/**
 * 存量评论补采入口（runType=repair-comments）。
 *
 * 背景：旧 v4 回答根评论端点对高评论回答会假 is_end，存量内容只入库了第一页 20 条根评论；
 * 端点改走 comment_v5 游标分页后，需要一条独立通道把这些内容按 full 模式重抓
 * （翻到 is_end + 删除对账），不枚举答主、不受 history_done 跳过逻辑影响。
 * 目标由编排脚本按「根评论数明显少于评论总数」从本地 D1 查出后分批传入。
 */
export async function runCommentRepairScraper() {
  const browser = await setupBrowser();
  try {
    await runCommentRepairScraperBody(browser);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runCommentRepairScraperBody(browser: Awaited<ReturnType<typeof setupBrowser>>) {
  const context = await browser.newContext();
  await context.addCookies(getCookiesArray());

  // 去重：多阶段收藏夹/赞同/关注可能把同一条内容重复排进补采清单，
  // 重复条目会白白多打一遍全部评论分页
  const uniqueTargets: string[] = [];
  const seenPk = new Set<string>();
  for (const raw of Array.isArray(repairTargets) ? repairTargets : []) {
    const pk = String(raw || "").trim();
    if (!pk || seenPk.has(pk)) continue;
    seenPk.add(pk);
    uniqueTargets.push(pk);
  }

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  let stopped = false;
  console.log(`🩹 开始存量评论补采：目标 ${uniqueTargets.length} 条（full 模式，翻到 is_end 并做删除对账）`);

  for (const pk of uniqueTargets) {
    // 每条前检查全局风控/熔断：命中立即停止，剩余目标由编排脚本下轮重新下发
    if (stats.circuitBroken || stats.riskExhausted) {
      stopped = true;
      break;
    }
    const sep = pk.indexOf(":");
    const sourceType = sep > 0 ? pk.slice(0, sep) : "";
    const sourceId = sep > 0 ? pk.slice(sep + 1) : "";
    if ((sourceType !== "answer" && sourceType !== "article") || !sourceId) {
      // pin 没有公开根评论接口，其余是无法解析的脏数据：不计失败，只跳过
      skipped++;
      continue;
    }
    // 评论链路内部会吞掉单条失败（只打 warn + 登记 commentSyncIncomplete），
    // 用失败计数增量判定本条是否真的成功，失败条数会随终态输出给编排脚本
    const failureBefore = stats.authRejected + stats.riskEmpty + stats.zhihuRejected + stats.failed;
    try {
      await syncHotCommentsForContent(context, sourceType, sourceId, "full");
    } catch (e) {
      console.warn(`⚠️ 补采评论异常 (${pk}): ${sanitizeErrorForLog(e)}`);
    }
    const failureAfter = stats.authRejected + stats.riskEmpty + stats.zhihuRejected + stats.failed;
    if (failureAfter > failureBefore) failed++;
    else ok++;
    console.log(`🩹 评论补采进度 ${ok + skipped + failed}/${uniqueTargets.length}（${pk}）`);
    // 与既有评论链路一致的条目间隔：补采是长时间连续请求，固定节奏同样会触发 40352
    await jitterSleep(800, 1500);
  }

  if (stats.circuitBroken || stats.riskExhausted) stopped = true;
  repairState.summary = { total: uniqueTargets.length, ok, skipped, failed, stopped };
  console.log(
    `📊 本轮评论补采：成功 ${ok} 条 / 跳过 ${skipped} 条 / 失败 ${failed} 条 / 目标 ${uniqueTargets.length} 条` +
      (stopped ? "（风控/熔断提前中止，重跑本模式可继续剩余目标）" : "")
  );
}

export async function runCollectionScraper() {
  const browser = await setupBrowser();
  try {
    await runCollectionScraperBody(browser);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runCollectionScraperBody(browser: Awaited<ReturnType<typeof setupBrowser>>) {
  console.log("🚀 开始知乎收藏夹自动同步...");
  
  const context = await browser.newContext();
  await context.addCookies(getCookiesArray());

  const foundCollections: Array<{ id: string; title: string; updatedTime?: string }> = [];
  
  console.log("🌐 正在通过 API 获取收藏夹列表...");
  let offset = 0;
  let isEnd = false;
  
  while (!isEnd && !stats.riskExhausted) {
    let json: any;
    try {
      json = (await zhihuJson(
        context,
        `https://www.zhihu.com/api/v4/members/${ZHIHU_USERNAME}/favlists?limit=20&offset=${offset}`,
        { label: "收藏夹列表" }
      )).json;
    } catch (e: any) {
      // 401/403/429/5xx/风控空页已在 zhihuJson 内重试并计入终态统计
      console.error(`❌ 获取收藏夹列表失败: ${sanitizeErrorForLog(e)}`);
      break;
    }
    // 与 answers/upvotes 对齐：风控空页（!paging.is_end）已在 zhihuJson 内重试并计数，
    // 能走到这里的是 is_end 的合法空页
    if (!json.data || json.data.length === 0) {
      break;
    }
    
    for (const item of json.data) {
       if (item.id && item.title) {
         const updatedTime = item.updated_time ? new Date(item.updated_time * 1000).toISOString() : undefined;
         foundCollections.push({ id: String(item.id), title: item.title, updatedTime });
         console.log(`👀 发现收藏夹: ${item.title}`);
       }
    }
    
    if (!isEnd) isEnd = json.paging?.is_end;
    offset += 20;
    await new Promise(r => setTimeout(r, 1000));
  }

  if (foundCollections.length > 0) {
    console.log(`📥 开始抓取 ${foundCollections.length} 个收藏夹的条目...`);
    // 收藏夹条目端点 100% 忽略 include（13-live-collections 实测 B/C/D 三组逐键一致），
    // 不再拼接无效 include 参数，只保留 offset/limit 分页。
    
    for (const coll of foundCollections) {
      if (stats.circuitBroken || stats.riskExhausted) break;
      console.log(`-> 正在抓取收藏夹: ${coll.title}`);
      
      const items: any[] = [];
      let cOffset = 0;
      let cIsEnd = false;
      let existingCount = 0;
      let cIncomplete = false;

      while (!cIsEnd && !stats.riskExhausted) {
         let cJson: any;
         try {
           cJson = (await zhihuJson(
             context,
             `https://www.zhihu.com/api/v4/collections/${coll.id}/items?offset=${cOffset}&limit=20`,
             { label: `收藏夹 ${coll.title} 条目` }
           )).json;
         } catch (e: any) {
           // 401/403/429/5xx/风控空页都已在 zhihuJson 内重试并计入终态统计；
           // 单独风控 items 接口时 cIncomplete 必须置位，避免服务端把未抓到的条目判为移除
           console.error(`❌ 收藏夹 [${coll.title}] 条目获取失败: ${sanitizeErrorForLog(e)}`);
           cIncomplete = true;
           break;
         }

         // 风控空页（!paging.is_end）已在 zhihuJson 内重试并计数；
         // 能走到这里的是 is_end 的合法空页，不需要标记不完整
         if (!cJson.data || cJson.data.length === 0) {
           break;
         }
         
         for (const row of cJson.data) {
            // 风控/熔断中断：本页只处理了一部分，绝不能让后续快照按「全量」对账，
            // 否则未扫到的收藏条目会被服务端标成 is_removed=1（软删除）。
            if (stats.circuitBroken || stats.riskExhausted) {
              cIncomplete = true;
              break;
            }
            const item = row.content;
            if (!item || !item.type) continue;

            const sourceType = KNOWN_TYPES.has(item.type) ? item.type : "pin";
            // item.url 可能为空串或相对路径，zod .url() 会拒掉整个快照（不是丢一条）。
            // 拼接 URL 永远语法合法，item.url 仅在通过 URL 校验时才采用。
            const fallbackUrl = item.type === "answer"
                 ? `https://www.zhihu.com/question/${item.question?.id}/answer/${item.id}`
                 : item.type === "article" ? `https://zhuanlan.zhihu.com/p/${item.id}` : `https://www.zhihu.com/pin/${item.id}`;
            let sourceUrl = fallbackUrl;
            if (typeof item.url === "string" && item.url) {
              try {
                const u = new URL(item.url);
                if (u.protocol === "http:" || u.protocol === "https:") sourceUrl = item.url;
              } catch { /* item.url 非法则用拼接值 */ }
            }
            const title = item.question?.title || item.title || "无标题";

            // 只有正文真正入库成功才写入收藏快照：contentSaved 初值不能为 true，
            // 否则 item.content 缺失的条目会被当成「内容已保存」写进快照。
            let contentSaved = false;
            if (item.content && KNOWN_TYPES.has(item.type)) {
              // pin 的 content 是块数组 [{type:"text",content:"..."}] 而非 HTML 字符串，
              // 直接给 cleanHtml 会因非字符串返回空串——想法正文就全丢了
              const rawContent = Array.isArray(item.content)
                ? (item.content as any[]).map(b => (typeof b?.content === "string" ? b.content : "")).filter(Boolean).join("\n")
                : item.content;
              const contentInput = {
                sourceType: item.type as "answer" | "article" | "pin",
                sourceId: String(item.id),
                title,
                sourceUrl,
                author: { name: item.author?.name, urlToken: item.author?.url_token, avatarUrl: item.author?.avatar_url, headline: item.author?.headline },
                question: item.question ? { id: String(item.question.id), title: item.question.title } : undefined,
                contentHtml: cleanHtml(rawContent),
                contentMd: "",
                // 收藏夹里的专栏文章没有 excerpt，摘要只在 excerpt_title（13-live-collections 实测）
                excerpt: item.excerpt || item.excerpt_title || "",
                voteupCount: item.voteup_count || item.reaction?.statistics?.like_count || 0,
                commentCount: item.comment_count || 0,
                favoriteCount: item.favorite_count ?? item.reaction?.statistics?.favorites ?? 0,
                visitCount: item.visit_count ?? 0,
                isCollapsed: item.is_collapsed,
                isLabeled: item.is_labeled,
                labelInfo: item.label_info ? JSON.stringify(item.label_info) : "",
                // 收藏夹条目里专栏文章用 created/updated，回答/想法用 created_time/updated_time，
                // 只读后者会让文章时间恒为空串（服务端回退旧值，排序长期错误）
                createdTime: toIsoOrNull(item.created ?? item.created_time),
                updatedTime: toIsoOrNull(item.updated ?? item.updated_time)
              };
              try {
                const dbRes = await sendContent(contentInput);
                contentSaved = true;
                const needHotComments =
                  cfg.commentsCollections !== "none" &&
                  await shouldSyncCommentsDeep(
                    `${sourceType}:${item.id}`,
                    contentInput.commentCount,
                    dbRes.prevCommentCount,
                    cfg.commentsCollections
                  );
                if (needHotComments && !stats.circuitBroken) {
                  await syncHotCommentsForContent(context, item.type as "answer" | "article" | "pin", String(item.id), cfg.commentsCollections);
                  // 每抓完一篇带新评论的条目额外缓冲：收藏夹是「条目 → 评论 → 楼中楼」
                  // 三连请求最密集的链路，最容易连续高频触发 40352
                  await jitterSleep(600, 1200);
                }
                if (!dbRes.created && !dbRes.changed && !needHotComments) {
                  existingCount++;
                  if (existingCount >= 20 && isFast) {
                    console.log("🛑 连续20个收藏条目及评论均无更新，停止本收藏夹的极速同步。");
                    cIsEnd = true;
                    break;
                  }
                } else {
                  existingCount = 0;
                }
              } catch (e: any) {
                cIncomplete = true;
                console.error(`❌ 收藏条目入库失败: ${title}`, sanitizeErrorForLog(e));
                if (stats.circuitBroken) {
                  console.error("🛑 连续 5 次入库失败（可能触发 D1 每日写入限额），暂停收藏夹同步。");
                  cIsEnd = true;
                  break;
                }
              }
            } else {
              // 正文缺失/类型不支持：不写入快照条目，并标记本轮收藏夹不完整，
              // 避免全量对账把仍在收藏夹里的条目误标 is_removed。
              cIncomplete = true;
              console.warn(`⚠️ 收藏条目缺正文或类型不支持，跳过快照: ${sourceType}:${item.id}`);
            }

            if (contentSaved) {
              items.push({
                 sourceType,
                 sourceId: String(item.id),
                 title,
                 authorName: item.author?.name || "匿名",
                 sourceUrl
              });
            }
         }
         
         // 中断退出必须标记本收藏夹不完整：下面按此决定 incremental，不能拿半份列表做删除对账
         if (stats.circuitBroken || stats.riskExhausted) {
           cIncomplete = true;
           break;
         }
         if (!cIsEnd) cIsEnd = cJson.paging?.is_end;
         cOffset += 20;
         await jitterSleep(800, 1500);
      }
      
      if (items.length > 0 && !stats.circuitBroken) {
        // schema 单请求上限 1000 条：大收藏夹分片提交。
        // 分片提交时不做移除对账，避免末片把前片条目标删（服务端以「本片 items」
        // 为全量基准，非 incremental 快照会把不在本片内的现有条目全部标 is_removed=1）。
        // 会话内聚合 allKeys 后统一对账的协议尚未实现，多片本轮一律跳过对账。
        const MAX_ITEMS = 1000;
        const chunks: any[][] = [];
        for (let i = 0; i < items.length; i += MAX_ITEMS) chunks.push(items.slice(i, i + MAX_ITEMS));
        // 只有真正翻到 paging.is_end === true 且中途无任何中断才允许全量对账；
        // 未明确到达末页 / 中途被风控熔断 / 极速早停（isFast）一律 incremental:true，
        // 绝不把「没扫到的条目」误判为「已被移出收藏夹」而软删除。
        const stopReconcile = cIncomplete || !cIsEnd || isFast;
        const multiChunk = chunks.length > 1;
        if (multiChunk) {
          console.warn(`⚠️ 收藏夹 [${coll.title}] 共 ${items.length} 条，分 ${chunks.length} 片提交；本轮跳过移除对账（分片与会话聚合未实现）`);
        }
        try {
          for (let ci = 0; ci < chunks.length; ci++) {
            const isLastChunk = ci === chunks.length - 1;
            if (stats.circuitBroken) break;
            await sendCollectionSnapshot({
              collection: { id: coll.id, title: coll.title, ownerToken: ZHIHU_USERNAME || "", updatedTime: coll.updatedTime },
              // 多片时所有片一律 incremental（跳过移除对账）；单片且抓取完整时才允许全量对账
              incremental: multiChunk || !isLastChunk || stopReconcile,
              items: chunks[ci]
            });
          }
        } catch (e: any) {
           console.error(`❌ 收藏夹保存失败: ${sanitizeErrorForLog(e)}`);
        }
      } else if (!stats.circuitBroken) {
        console.log(`⚠️ 收藏夹 [${coll.title}] 为空或未抓取到条目`);
      }
    }
  }

  console.log("🎉 收藏夹同步完成！");
}

export async function runUpvotesScraper() {
  const browser = await setupBrowser();
  try {
    await runUpvotesScraperBody(browser);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runUpvotesScraperBody(browser: Awaited<ReturnType<typeof setupBrowser>>) {
  console.log("🚀 开始同步你的赞同记录...");
  
  const context = await browser.newContext();
  await context.addCookies(getCookiesArray());

  // 断点续传游标上报：moments 按 paging.next（before_id 游标）向更旧翻页。
  // 每翻完一页把"下一页游标"存到 Worker，run 无论何时中断（超时/额度/风控），
  // 下次都从断点继续，不用从头重翻几千条已入库的动态（实测重复成本会卡死进度）。
  // 游标到达末尾（is_end）或断点失效时上报 null 清除，下次恢复全量。
  const reportCursor = (url: string | null) =>
    // countStats:false：游标上报不是数据入库，不能虚增 saved/estimatedWrites，
    // 也不能把 consecutiveFailures 清零而掩盖真实的入库失败序列
    post("/ingest/sync-state", { key: "upvotes_cursor", value: url }, { countStats: false })
      .catch(() => { /* 上报失败不阻塞抓取：最多下次多翻一段 */ });

  // 判断当前翻页游标是否已经自然追上或越过上次保存的断点（处理上次断点前已存在赞同不足 20 条的边界）
  function hasReachedCursor(candidateUrl: string, savedCursor?: string): boolean {
    if (!savedCursor || !candidateUrl) return false;
    if (candidateUrl === savedCursor) return true;
    try {
      const u1 = new URL(candidateUrl);
      const u2 = new URL(savedCursor);
      const p1 = Number(u1.searchParams.get("page_num"));
      const p2 = Number(u2.searchParams.get("page_num"));
      if (Number.isFinite(p1) && Number.isFinite(p2) && p1 > 0 && p2 > 0 && p1 >= p2) return true;
      const o1 = Number(u1.searchParams.get("offset"));
      const o2 = Number(u2.searchParams.get("offset"));
      if (Number.isFinite(o1) && Number.isFinite(o2) && o1 > 0 && o2 > 0 && o1 <= o2) return true;
    } catch { /* ignore */ }
    return false;
  }

  let nextUrl = `https://www.zhihu.com/api/v3/moments/${ZHIHU_USERNAME}/activities?limit=20`;
  // resuming=true 表示当前处于"从断点补历史"阶段（不做已存在早停）
  let resuming = false;
  let wantResume = false;
  let isEnd = false;
  let count = 0;
  let existingCount = 0;
  let consecutiveFailures = 0;

  while (!isEnd && nextUrl && !stats.riskExhausted) {
    let json: any;
    try {
      json = (await zhihuJson(context, nextUrl, { label: "赞同动态" })).json;
    } catch (e: any) {
      const status = e instanceof ZhihuRequestError ? e.status : 0;
      console.error(`❌ 获取动态失败: ${sanitizeErrorForLog(e)}`);
      // 仅当游标 URL 本身失效（400/404/410）时才清掉断点；
      // 401/403 风控或 Cookie 过期、429 限流、5xx 服务端抖动必须保留断点！
      if (resuming && (status === 400 || status === 404 || status === 410)) {
        await reportCursor(null);
      }
      break;
    }
    if (!json.data || json.data.length === 0) {
      // 风控空页已在 zhihuJson 内重试并计数；能到这里的是 is_end 的合法空页。
      // 合法空页意味着历史已到底，必须清掉断点游标：否则每轮都从末尾断点空转，
      // 总控会把「0 新增 + 秒级结束」误判成风控，冷却几轮后要求人机验证（实际并没有滑块）。
      if (json.paging?.is_end) await reportCursor(null);
      break;
    }

    let pageFailures = 0;

    for (const item of json.data) {
      if (stats.riskExhausted) break;
      if (!item.action_text || !item.action_text.includes("赞同")) continue;
      
      const target = item.target;
      if (!target || !target.id) continue;

      let sourceType: "answer" | "article" | "pin";
      let sourceId = String(target.id);
      let title = "";
      let sourceUrl = "";
      
      if (target.type === "answer") {
        sourceType = "answer";
        title = target.question?.title || "未知问题";
        sourceUrl = `https://www.zhihu.com/question/${target.question?.id}/answer/${target.id}`;
      } else if (target.type === "article") {
        sourceType = "article";
        title = target.title || "未知文章";
        sourceUrl = `https://zhuanlan.zhihu.com/p/${target.id}`;
      } else {
        continue; // skip other types for now
      }

      const voteupCount = target.voteup_count || target.reaction?.statistics?.like_count || 0;
      
      const contentInput = {
        sourceType,
        sourceId,
        title,
        sourceUrl,
        author: { name: target.author?.name, urlToken: target.author?.url_token, avatarUrl: target.author?.avatar_url, headline: target.author?.headline },
        question: target.question ? { id: String(target.question.id), title: target.question.title } : undefined,
        contentHtml: cleanHtml(target.content),
        contentMd: "",
        excerpt: target.excerpt || "",
        voteupCount,
        commentCount: target.comment_count || 0,
        // 动态 target 不返回收藏数（reaction.statistics 也不存在）；thanks_count 是感谢数，
        // 不能混写成收藏数。缺失时写 0，Worker 侧 contents.ts 会保留既有非零真值。
        favoriteCount: target.favorite_count ?? target.reaction?.statistics?.favorites ?? 0,
        visitCount: target.visit_count ?? 0,
        isCollapsed: target.is_collapsed,
        isLabeled: target.is_labeled,
        labelInfo: target.label_info ? JSON.stringify(target.label_info) : "",
        // 赞同动态同理：文章 target 只下发 created/updated，回答用 *_time
        createdTime: toIsoOrNull(target.created ?? target.created_time),
        updatedTime: toIsoOrNull(target.updated ?? target.updated_time)
      };

      try {
        const pk = await sendContent(contentInput);
        if (pk) {
           if (
             cfg.commentsUpvotes !== "none" &&
             await shouldSyncCommentsDeep(
               `${sourceType}:${sourceId}`,
               contentInput.commentCount,
               pk.prevCommentCount,
               cfg.commentsUpvotes
             ) &&
             !stats.circuitBroken &&
             !stats.riskExhausted
           ) {
             await syncHotCommentsForContent(context, sourceType, sourceId, cfg.commentsUpvotes);
           }
           const upvoteTime = toIsoOrNull(item.created_time);
           // created_time 缺失时为空串：/ingest/upvote 对空串返回 400，
           // 整条赞同上报会失败——内容已入库，跳过时间戳上报即可
           if (upvoteTime) {
             const upRes = await post(`/ingest/upvote`, { contentPk: pk.pk, upvoteTime });
             count++;

             if (!upRes.created) {
               existingCount++;
               if (existingCount >= 20 && isFast && !upvotesCursor) {
                 console.log("🛑 连续20个赞同记录无更新，停止本轮极速同步。");
                 isEnd = true;
                 break;
               }
               // 有断点：新增段撞到已入库的，标记切换到断点继续补历史
               // （快速/全量都走这条路径，实际跳转在页尾统一处理）
               if (existingCount >= 20 && upvotesCursor && !resuming) {
                 console.log("🔁 新增段完成（连续 20 条已存在），跳到上次断点继续补历史");
                 wantResume = true;
                 existingCount = 0;
                 break;
               }
             } else {
               existingCount = 0;
             }
           }
        }
        // content 与 upvote 两步都成功才清零连续失败计数
        consecutiveFailures = 0;
      } catch (err: any) {
        pageFailures++;
        consecutiveFailures++;
        console.error(`❌ 保存赞同失败: ${title}`, sanitizeErrorForLog(err));
        if (consecutiveFailures >= 5 || stats.circuitBroken) {
          console.error("🛑 连续 5 次入库失败（可能触发 D1 每日写入限额），暂停抓取并保留当前断点游标，下次从本页继续。");
          break;
        }
      }
    }

    // 风控重试耗尽：本页可能只处理了一部分（例如评论抓取触发风控），
    // 绝不能推进 nextUrl / 覆盖云端游标，保留断点下次从本页重跑
    if (stats.riskExhausted) break;

    // 只要本页有任何入库失败（pageFailures > 0），严禁推进内存 nextUrl 或覆盖云端游标，
    // 否则若下一页恰好无赞同（0 次调用 post）或恢复成功，就会把本页失败的条目永久跳过！
    if (pageFailures > 0 || consecutiveFailures >= 5 || stats.circuitBroken) {
      if (pageFailures > 0 && consecutiveFailures < 5 && !stats.circuitBroken) {
        console.warn(`⚠️ 本页有 ${pageFailures} 条赞同入库失败，暂停翻页并保留当前断点游标，下次从本页重跑以防漏存。`);
      }
      break;
    }

    console.log(`💬 已拉取并保存 ${count} 条赞同记录...`);

    // 页尾统一决定下一页：跳断点 > 正常游标
    if (wantResume) {
      nextUrl = upvotesCursor as string;
      wantResume = false;
      resuming = true;
    } else {
      if (!isEnd) isEnd = Boolean(json.paging?.is_end);
      nextUrl = json.paging?.next || "";
      // 若新增段自然翻到了历史断点所在页（或已越过），自动进入 resuming 状态
      if (upvotesCursor && !resuming && hasReachedCursor(nextUrl, upvotesCursor)) {
        resuming = true;
      }
      // 当存在历史断点且尚未进入 resuming 阶段时（正在扫最新动态），
      // 严禁上报游标（不论快速/全量），否则第 1 页未凑齐 20 条已存在记录时就会把深水区断点覆盖回第 2 页！
      const inHeadBeforeResume = Boolean(upvotesCursor) && !resuming && !isEnd;
      // isEnd 时必须无条件清游标：否则 fast 模式下头部自然翻到末尾且未进入上报分支，
      // 失效游标会一直留在服务端，之后每轮都从它空转
      if (isEnd) {
        await reportCursor(null);
      } else if (!inHeadBeforeResume && (resuming || !isFast)) {
        await reportCursor(nextUrl);
      }
    }

    if (json.data.length === 0) break;

    // 与其他三段对齐的节流：老账号动态可达数千页，背靠背请求极易触发 429
    // 并升级为账号级风控，连坐 answers/collections 两段
    await jitterSleep(800, 1500);
  }

  if (stats.circuitBroken) {
    console.log("⏸️ 赞同同步因写入限额断路器暂停，断点已保留。");
  } else {
    console.log("🎉 赞同同步完成！");
  }
}

// 关注答主「AI 价值/风险复核」候选：规则未通过但落在候选池（高赞/长文/中风险）的条目。
type FollowingAiCandidate = {
  sourceType: "answer" | "article";
  sourceId: string;
  title: string;
  questionTitle: string;
  excerpt: string;
  voteupCount: number;
  commentCount: number;
  favoriteCount: number;
  isCollapsed: boolean;
  isLabeled: boolean;
  riskScore: number;
  riskTags: string[];
  contentInput: Record<string, unknown>;
};

// 额度保护：每位答主每轮最多 10 条，整个 run 默认最多 3 次「成功」复核调用（失败不消耗配额）。
// 本地全量模式（UNLIMITED_LOCAL_WRITES=1）放宽到 500 次：本地反代 DeepSeek 不吃 CF 额度，
// 必须保证 102 位关注答主的候选回答/文章都能轮到 AI 复核，而不是前 3 位之后全部饿死。
const MAX_AI_CANDIDATES_PER_USER = 10;
// worker 侧单批 10 条总字符上限 12000：excerpt 先截到 300 字，10*300 留足余量
const AI_EXCERPT_MAX_CHARS = 300;
let aiEvalCalls = 0;
const MAX_AI_EVAL_CALLS = UNLIMITED_LOCAL_WRITES ? 500 : 3;

async function evaluateFollowingCandidatesWithAI(
  userName: string,
  candidates: FollowingAiCandidate[]
): Promise<FollowingAiCandidate[]> {
  const capped = candidates.slice(0, MAX_AI_CANDIDATES_PER_USER);
  const overCap = candidates.length - capped.length;
  if (overCap > 0) {
    console.log(`  ⏭️ [${userName}] ${overCap} 条候选超出单次 ${MAX_AI_CANDIDATES_PER_USER} 条 AI 复核上限，按规则跳过`);
  }
  if (capped.length === 0) return [];
  if (aiEvalCalls >= MAX_AI_EVAL_CALLS) {
    console.log(`  ⏭️ [${userName}] 本轮 AI 复核已达 ${MAX_AI_EVAL_CALLS} 次成功调用上限，${capped.length} 条候选按规则跳过`);
    return [];
  }

  // AI 失败/响应异常时的本地兜底：不整批丢弃，按同一风险阈值保留高危候选
  const fallbackByRisk = (): FollowingAiCandidate[] => {
    const threshold = followingRiskThreshold();
    const kept = capped.filter(c => c.riskScore >= threshold);
    console.log(
      `  ↩️ [${userName}] 本地规则兜底：${kept.length}/${capped.length} 条候选风险>=${threshold} 保留，${
        capped.length - kept.length
      } 条跳过`
    );
    return kept;
  };

  try {
    const res = await post("/api/recommend/evaluate-following", {
      items: capped.map(c => ({
        sourceId: c.sourceId,
        sourceType: c.sourceType,
        title: c.title,
        questionTitle: c.questionTitle,
        // 截断到 300 字，确保一批 10 条总字符不超 worker 的 12000 限制
        excerpt: typeof c.excerpt === "string" ? c.excerpt.slice(0, AI_EXCERPT_MAX_CHARS) : "",
        voteupCount: c.voteupCount,
        commentCount: c.commentCount,
        favoriteCount: c.favoriteCount,
        isCollapsed: c.isCollapsed,
        isLabeled: c.isLabeled,
        riskScore: c.riskScore,
        riskTags: c.riskTags
      }))
    }, { countStats: false });
    const rawResults: unknown = res?.results;
    if (!Array.isArray(rawResults)) {
      throw new Error("AI 复核响应缺少 results 数组");
    }
    // 成功响应才消耗调用配额：非 2xx / 异常 / 响应结构错误都不应挤占后续答主的额度
    aiEvalCalls++;
    const worthMap = new Map<string, { risk: number; reason: string }>();
    for (const row of rawResults) {
      if (!row || typeof row !== "object") continue;
      const rec = row as Record<string, unknown>;
      const sid = typeof rec.sourceId === "string" ? rec.sourceId : "";
      if (!sid || rec.worth !== true) continue;
      const riskNum = Number(rec.risk);
      worthMap.set(sid, {
        risk: Number.isFinite(riskNum) ? riskNum : 0,
        reason: typeof rec.reason === "string" ? rec.reason : ""
      });
    }
    const kept: FollowingAiCandidate[] = [];
    for (const c of capped) {
      const verdict = worthMap.get(c.sourceId);
      if (!verdict) continue;
      console.log(`🤖 [AI判定值得备份] risk=${verdict.risk} reason=${sanitizeReasonForLog(verdict.reason)}: ${c.title}`);
      kept.push(c);
    }
    const aiSkipped = capped.length - kept.length;
    if (aiSkipped > 0) {
      console.log(`  ⏭️ [${userName}] AI 判定 ${aiSkipped} 条候选无需保存（已复核，不再走规则兜底）`);
    }
    return kept;
  } catch (e) {
    // 异常/非 2xx/响应结构错误：本批候选回退本地规则（风险>=阈值才保存），绝不整批丢弃
    console.warn(
      `⚠️ [${userName}] AI 复核调用失败，本批 ${capped.length} 条候选回退本地规则（不消耗调用配额）: ${sanitizeErrorForLog(e)}`
    );
    return fallbackByRisk();
  }
}

export async function runFollowingScraper(onlyList = false) {
  const browser = await setupBrowser();
  try {
    await runFollowingScraperBody(browser, onlyList);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runFollowingScraperBody(browser: Awaited<ReturnType<typeof setupBrowser>>, onlyList: boolean) {
  console.log("🚀 开始同步你关注的人...");

  const context = await browser.newContext();
  await context.addCookies(getCookiesArray());

  const followedUsers: Array<{
    urlToken: string;
    userId: string;
    name: string;
    avatarUrl: string;
    headline: string;
    answerCount: number;
    articlesCount: number;
    followerCount: number;
  }> = [];

  let offset = 0;
  let isEnd = false;
  let fIncomplete = false;

  while (!isEnd && !stats.riskExhausted) {
    let json: any;
    try {
      json = (await zhihuJson(
        context,
        `https://www.zhihu.com/api/v4/members/${ZHIHU_USERNAME}/followees?include=data%5B*%5D.answer_count,articles_count,follower_count,headline,avatar_url&limit=20&offset=${offset}`,
        { label: "关注列表" }
      )).json;
    } catch (e: any) {
      // 401/403/429/5xx/风控空页已在 zhihuJson 内重试并计入终态统计
      console.error(`❌ 获取关注列表失败: ${sanitizeErrorForLog(e)}`);
      fIncomplete = true;
      break;
    }
    if (!json.data || json.data.length === 0) {
      // 风控空页已在 zhihuJson 内重试并计数；能到这里的是 is_end 的合法空页
      break;
    }

    for (const u of json.data) {
      if (!u.url_token || !u.name) continue;
      followedUsers.push({
        urlToken: String(u.url_token),
        userId: String(u.id || ""),
        name: String(u.name),
        avatarUrl: String(u.avatar_url || ""),
        headline: String(u.headline || ""),
        answerCount: Number(u.answer_count) || 0,
        articlesCount: Number(u.articles_count) || 0,
        followerCount: Number(u.follower_count) || 0
      });
    }

    isEnd = Boolean(json.paging?.is_end);
    offset += 20;
    await new Promise(r => setTimeout(r, 400));
  }

  if (followedUsers.length > 0) {
    try {
      await post("/ingest/followed-users", {
        users: followedUsers,
        incremental: fIncomplete
      });
      console.log(`✅ 已同步 ${followedUsers.length} 位关注答主名录`);
    } catch (e: any) {
      console.error(`❌ 上报关注答主名录失败: ${sanitizeErrorForLog(e)}`);
    }
  }

  if (onlyList || stats.circuitBroken || stats.riskExhausted) {
    return;
  }

  // 同步关注答主的回答：
  // - 开启了「全量备份（full）」的答主优先排在前面，抓取全量（快速模式下连续 15 条未变则早停）
  // - 默认精选模式的答主：首次历史摸底按 voteups 抓「最热 60 篇」，这 60 篇无条件保存；
  //   风险/价值规则 + AI 复核只作用于 60 篇之外的内容（增量窗口等）
  const sortedUsers = [...followedUsers].sort((a, b) => {
    const aFull = fullModeSet.has(a.urlToken) ? 1 : 0;
    const bFull = fullModeSet.has(b.urlToken) ? 1 : 0;
    return bFull - aFull;
  });

  // 字段可用性依据 docs/知乎字段审计-2026-11-01（10-live-answers / 12-live-articles）真机实测：
  // - 回答列表：include 里的 voteup_count/favorite_count/visit_count/label_info 严格不返回，
  //   reaction.statistics（like_count/favorites）是默认字段，因此 contentInput 走 reaction 回退；
  // - 文章列表：include 对 content/voteup_count/comment_count/is_labeled 生效（voteup_count 有效！）；
  //   favorite_count/visit_count/thanks_count 会被服务端静默忽略（不报错也不返回），
  //   收藏数只能读默认下发的 reaction.statistics.favorites；is_collapsed 未验证，
  //   评估器对缺失字段按 false 处理。
  const includeStr = encodeURIComponent(
    "data[*].is_normal,comment_count,content,created_time,updated_time,question,excerpt,is_collapsed,is_labeled"
  );
  const articleIncludeStr = encodeURIComponent(
    "data[*].content,voteup_count,comment_count,created,updated,title,excerpt,is_labeled"
  );

  // 抓取侧实时「和谐风险 + 内容含金量」评估器：
  // 扫描关注答主的回答时，自动甄别「写得好但容易被和谐」的高危/精品回答入库，跳过日常普通水贴，兼顾容量与抢救质量！
  const HIGH_RISK_KWS = [
    "审查", "封禁", "删帖", "河蟹", "和谐", "敏感", "禁评", "夹总", "小管家",
    "文革", "苏联", "解体", "政治", "政权", "意识形态", "官僚", "特权", "权贵", "既得利益",
    "阶级", "阶层固化", "剥削", "牛马", "人矿", "烂尾", "维权", "赋红码", "公信力",
    "人口崩塌", "生育率", "断交", "制裁", "房价崩盘", "失业率", "洗脑", "润学", "润出", "亡国",
    "贪腐", "腐败", "垄断", "内幕", "真相", "反思", "历史虚无", "拜金", "男女对立", "彩礼"
  ];
  const MED_RISK_KWS = [
    "华为", "公知", "民族", "爱国", "资本家", "996", "劳动法", "工会", "裁员",
    "房地产", "土地财政", "城投", "地方债", "集采", "医保", "养老金", "延迟退休",
    "教育公平", "学区房", "考公", "编制", "国企", "央企", "体制内", "贫富差距",
    "俄乌", "中东", "以色列", "巴勒斯坦", "台海", "关税", "贸易战", "芯片封锁"
  ];

  // following 列表接口常不下发 voteup_count/favorite_count（只在 reaction.statistics 里），
  // 只读顶层字段会让自动抢救判定把高赞神贴当成 0 赞，漏掉该抢救的内容。
  // 文章列表实测（12-live-articles）：顶层 favorite_count 永不返回，收藏数只能读
  // 默认下发的 reaction.statistics.favorites；is_collapsed/label_info 未验证（不 include），
  // 缺失时按下文的 Boolean(undefined)=false 处理，不会误判成已折叠/已黄标。
  //
  // 关键：reaction.statistics.like_count 是「❤️ 喜欢数」（约为▲赞同数的 1%~5%），
  // 不能直接当赞同数用。未拉回答详情前，用保守上界估算赞同量级：
  // 1 个喜欢 ≈ 10~20 赞、1 个收藏 ≈ 2~4 赞，取二者较大值，确保筛选候选时
  // 绝不会漏掉真高赞回答（宁可多存，不可漏存）。
  function effectiveVotes(item: any): number {
    const likeCount = Number(item?.reaction?.statistics?.like_count) || 0;
    const favorites = Number(item?.favorite_count ?? item?.reaction?.statistics?.favorites) || 0;
    return Number(item?.voteup_count ?? Math.max(likeCount * 10, favorites * 2)) || 0;
  }

  function evaluateForAutoBackup(item: any, rawHtml: string): { shouldBackup: boolean; reason: string; riskScore: number; valueScore: number } {
    let risk = 0;
    let value = 0;
    const reasons: string[] = [];

    const voteup = effectiveVotes(item);
    const comments = Number(item?.comment_count) || 0;
    const favs = Number(item?.favorite_count ?? item?.reaction?.statistics?.favorites) || 0;
    const isCollapsed = Boolean(item?.is_collapsed);
    const isLabeled = Boolean(item?.is_labeled) || Boolean(item?.label_info);
    const text = `${item?.question?.title || ""} ${item?.title || ""} ${item?.excerpt || ""} ${rawHtml.slice(0, 1500)}`.toLowerCase();
    const textLen = rawHtml.replace(/<[^>]+>/g, "").trim().length;

    if (isCollapsed) { risk += 45; reasons.push("原站已折叠"); }
    if (isLabeled) { risk += 30; reasons.push("风险黄标"); }
    if (voteup >= 1000 && comments === 0) { risk += 35; reasons.push("千赞零评疑似禁评"); }
    else if (voteup >= 200 && comments === 0) { risk += 25; reasons.push("高赞零评疑似禁评"); }
    else if (voteup >= 1500 && comments > 0 && voteup / comments >= 80) { risk += 18; reasons.push("评论严控"); }

    let highHits = 0;
    for (const kw of HIGH_RISK_KWS) {
      if (text.includes(kw)) { highHits++; if (highHits >= 3) break; }
    }
    let medHits = 0;
    for (const kw of MED_RISK_KWS) {
      if (text.includes(kw)) { medHits++; if (medHits >= 3) break; }
    }
    if (highHits > 0) { risk += 22 + (highHits - 1) * 10; reasons.push("高敏议题"); }
    else if (medHits > 0) { risk += 14 + (medHits - 1) * 7; reasons.push("争议议题"); }

    // “写得好”含金量：赞同数 + 收藏赞同比 + 深度长文
    if (voteup >= 5000) value += 40;
    else if (voteup >= 1000) value += 30;
    else if (voteup >= 300) value += 22;
    else if (voteup >= 80) value += 14;

    const favRatio = voteup >= 30 ? favs / voteup : 0;
    if (favRatio >= 0.45) { value += 28; risk += 10; reasons.push("极高收藏比神贴"); }
    else if (favRatio >= 0.25 || favs >= 500) { value += 18; reasons.push("高收藏干货"); }

    if (textLen >= 1200) value += 15;
    else if (textLen >= 500) value += 8;

    if ((highHits > 0 || medHits > 0) && (voteup >= 100 || textLen >= 400)) {
      risk += 10;
    }

    // 判定准则（支持 sensitivity: strict | standard | relaxed）：
    const riskThreshold = followingRiskThreshold();
    const valueThreshold = cfg.followingSensitivity === "strict" ? 50 : cfg.followingSensitivity === "relaxed" ? 24 : 38;
    const isHighRiskWorthSaving = risk >= riskThreshold && (value >= 8 || textLen >= 150 || isCollapsed || isLabeled);
    const isHighQuality = value >= valueThreshold;

    return {
      shouldBackup: isHighRiskWorthSaving || isHighQuality,
      reason: reasons.join("+") || (isHighQuality ? "高赞深度精品" : "常规"),
      riskScore: Math.min(100, risk),
      valueScore: Math.min(100, value)
    };
  }

  /**
   * 仅对「最终决定入库」的关注答主回答补真实统计。
   * 被规则跳过的成千上万条水贴不额外打详情接口（否则每条 250~550ms 节流会拖垮整轮同步），
   * 只有 forceSave 前 60 篇 / 规则通过 / AI 复核通过的回答才值得多一次详情请求。
   */
  async function fillTrueAnswerStats(contentInput: any, answerId: string): Promise<void> {
    const trueStats = await fetchAnswerTrueStats(context, answerId);
    if (!trueStats) return;
    contentInput.voteupCount = trueStats.voteupCount;
    contentInput.visitCount = trueStats.visitCount;
    if (trueStats.commentCount !== undefined) contentInput.commentCount = trueStats.commentCount;
  }

  const reportUserProgress = (urlToken: string, resumeOffset: number, historyDone: boolean, lastCheckedAnswerId?: string) =>
    // countStats:false：进度上报是旁路请求，不参与 saved/estimatedWrites/熔断统计
    post("/ingest/followed-user-progress", { urlToken, resumeOffset, historyDone, lastCheckedAnswerId }, { countStats: false }).catch(() => {});

  for (const u of sortedUsers) {
    if (stats.circuitBroken || stats.riskExhausted) break;
    if (u.answerCount <= 0 && u.articlesCount <= 0) continue;

    const isUserFull = fullModeSet.has(u.urlToken);
    const prog = followedProgMap[u.urlToken] || { resumeOffset: 0, historyDone: false, lastCheckedAnswerId: "" };
    const isHistoryDone = Boolean(prog.historyDone);
    const lastMarkAnswerId = String(prog.lastCheckedAnswerId || "");
    let newestSeenAnswerId = "";
    // 规则未通过但值得 AI 复核的候选（每类最多 10 条，扫描结束后批量复核一次）
    const answerAiCandidates: FollowingAiCandidate[] = [];
    const articleAiCandidates: FollowingAiCandidate[] = [];
    // 每个答主独立的页内去重集合：answers/articles 端点相邻页重叠严重（answers 实测约 47%），
    // 重复项若参与 eval/sendContent/unchanged，会凑满 earlyStop 触发假早停。按答主隔离避免 id 冲突。
    const seenAnswerIds = new Set<string>();
    const seenArticleIds = new Set<string>();
    let duplicateAnswerSkipped = 0;
    let duplicateArticleSkipped = 0;
    // 规则候选超出单轮 10 条 AI 上限的数量：不能静默丢弃，结束时汇总日志
    let answerAiOverflow = 0;
    let articleAiOverflow = 0;

    // 核心分流逻辑：
    // - 若该答主已完成首次历史存量扫描（historyDone === true）且当前为日常快速同步（isFast === true）：
    //   只从最新第 1 页（offset=0, sort_by=created）往后看，遇到连续已存在记录（碰到上次的标记点）立即停止！
    // - 若该答主尚未完成首次历史存量扫描（historyDone === false）或手动跑全量（!isFast）：
    //   - 默认模式：按 voteups 扫描最热 60 篇。首次摸底（!historyDone）时这 60 篇无条件保存，
    //     规则/AI 过滤只作用于 60 篇之外的内容；扫完即标 historyDone = true；
    //   - 全量模式：先看第 1 页最新增量，然后直接从上次保存的断点 prog.resumeOffset 继续往后抓全量，每页更新断点，抓到底标 historyDone = true！
    // 本地全量重扒断点续跑优化：已经在前几轮完成完整历史摸底（isHistoryDone=true）的答主，
    // 直接 0 请求秒跳过，把知乎请求预算 100% 留给尚未摸底的后续答主，避免重扫前人再撞 40352
    if (UNLIMITED_LOCAL_WRITES && isHistoryDone) {
      console.log(`⏭️ 关注答主 [${u.name}] 已完成全量摸底，断点秒跳过`);
      continue;
    }

    const onlyIncrementalNow = isFast && isHistoryDone;
    // 首次历史摸底：voteups 前 60 篇是用户明确要保存的存量，必须绕过 evaluateForAutoBackup；
    // 增量模式（historyDone=true）不置位，避免每轮把 voteups 前 20 当新内容重复 POST
    const forceSaveTop60 = !isUserFull && !isHistoryDone;

    console.log(
      `👤 同步关注答主 [${u.name}] (${
        onlyIncrementalNow
          ? "日常增量 · 扫描最新动态至上次标记点"
          : isUserFull
          ? `全量断点续传 · 从第 ${prog.resumeOffset || 0} 篇继续 (共 ${u.answerCount} 回答)`
          : "首次历史摸底 · 最热 60 篇无条件保存"
      })...`
    );

    let completedAllPlans = true;
    // 已注销/不可见账号（HTTP 410）：标记后跳过该答主后续的文章扫描，但仍按终态上报 historyDone
    let userGone410 = false;
    // voteups 首页异常空页时是否已追加 created 回退计划（防止重复追加、并在回退仍空时判定未完成）
    let fallbackCreatedTop60 = false;

    if (u.answerCount > 0 && !stats.circuitBroken && !stats.riskExhausted) {
      const plans: Array<{ sortBy: "created" | "voteups"; startOffset: number; maxScan: number; earlyStop: number; trackResume: boolean }> =
        onlyIncrementalNow
          ? [
              // 有标记点时按它继续翻到撞见为止：两次同步之间新增 >40 篇也不能漏；
              // 没有标记点时仍限 40 条（首次增量摸底）。
              { sortBy: "created", startOffset: 0, maxScan: lastMarkAnswerId ? 100000 : 40, earlyStop: 5, trackResume: false },
              // 补一轮「最热 20」：后来涨赞或被折叠的内容早已沉出 created 最新 40 条，
              // 只有按 voteups 重扫才能捞进规则/AI 候选池；不做早停、不跟踪断点
              { sortBy: "voteups", startOffset: 0, maxScan: 20, earlyStop: 999999, trackResume: false }
            ]
          : isUserFull
          ? [
              ...(prog.resumeOffset > 0
                ? [{ sortBy: "created" as const, startOffset: 0, maxScan: 20, earlyStop: 5, trackResume: false }]
                : []),
              { sortBy: "created" as const, startOffset: prog.resumeOffset || 0, maxScan: 100000, earlyStop: 999999, trackResume: true }
            ]
          : [{ sortBy: "voteups", startOffset: 0, maxScan: 60, earlyStop: 999999, trackResume: false }];

      let savedForUser = 0;
      // plans 是可变队列：voteups 首页异常空页时会向队尾追加 created 回退计划。
      // 用下标 while 而非 for-of，保证追加的计划一定会被消费。
      let planIndex = 0;
      while (planIndex < plans.length) {
        const plan = plans[planIndex++];
        if (stats.circuitBroken || stats.riskExhausted) { completedAllPlans = false; break; }
        let aOffset = plan.startOffset;
        let aIsEnd = false;
        let unchanged = 0;
        // 首次摸底 voteups 前 60 篇计数（在 seenAnswerIds 去重之后计）
        let top60Seen = 0;

        while (!aIsEnd && aOffset < plan.maxScan && !stats.circuitBroken && !stats.riskExhausted) {
          const batchLimit = Math.min(20, plan.maxScan - aOffset);
          let aJson: any;
          try {
            aJson = (await zhihuJson(
              context,
              `https://www.zhihu.com/api/v4/members/${u.urlToken}/answers?include=${includeStr}&limit=${batchLimit}&offset=${aOffset}&sort_by=${plan.sortBy}`,
              {
                label: `[${u.name}] 回答列表(${plan.sortBy})`,
                // voteups 是知乎的静默过滤列表：被折叠/删除/降权的回答不进该索引，实测同一批答主
                // 连续 13 轮冷却后仍返回 data:[] + paging 存在且 is_end !== true，属合法空页而非滑窗风控。
                // 不显式放行会每轮白暂停 3×60s 并计入 riskEmpty，阶段永远无法完成
                ...(plan.sortBy === "voteups" ? { allowEmptyPage: true } : {})
              }
            )).json;
          } catch (e: any) {
            // 已注销/不可见账号（AccountDestroyError）稳定返回 HTTP 410，重试无意义：
            // 必须当作终态收敛，否则每轮重跑都会重复打一次 410 且永远无法标记 historyDone。
            const status = e instanceof ZhihuRequestError ? e.status : Number(e?.status);
            if (status === 410) {
              console.warn(`⏭️ [${u.name}] 账号已注销或不可见 (HTTP 410)，标记为已完成不再重试`);
              userGone410 = true;
              break;
            }
            // 401/403/429/5xx/风控空页已在 zhihuJson 内重试并计入终态统计
            console.error(`❌ [${u.name}] 获取回答列表失败: ${sanitizeErrorForLog(e)}`);
            completedAllPlans = false;
            break;
          }
          if (!aJson.data || aJson.data.length === 0) {
            // 首次摸底 voteups 首页就空：有回答的答主不可能是真的没内容，
            // 多半是知乎对该列表静默过滤或滑窗风控。直接 break 会被误判为扫完并永久标记
            // historyDone，导致高产答主 0 篇入库即被跳过；回退按 created 扫前 60 篇兜底。
            if (
              plan.sortBy === "voteups" &&
              aOffset === 0 &&
              u.answerCount > 0 &&
              !onlyIncrementalNow &&
              !isUserFull
            ) {
              if (!fallbackCreatedTop60) {
                fallbackCreatedTop60 = true;
                console.warn(
                  `⚠️ [${u.name}] voteups 首页为空（共 ${u.answerCount} 回答），回退按 created 扫描前 60 篇以防漏采`
                );
                plans.push({ sortBy: "created", startOffset: 0, maxScan: 60, earlyStop: 999999, trackResume: false });
              }
              break;
            }
            // 回退到 created 首页仍为空：answerCount > 0 却 0 篇扫到属异常空页，
            // 绝不能标记 historyDone，留待下轮重试。
            if (fallbackCreatedTop60 && plan.sortBy === "created" && aOffset === 0 && u.answerCount > 0) {
              console.warn(
                `⚠️ [${u.name}] created 回退首页仍为空（共 ${u.answerCount} 回答），本轮不标记已完成，下轮重试`
              );
              completedAllPlans = false;
              break;
            }
            // 风控空页已在 zhihuJson 内重试并计数；voteups 排序的合法空页已由调用处
            // allowEmptyPage 放行，其余接口能到这里的是 is_end 的合法空页。
            // 但没有 paging 字段就无法证明「真的扫到底了」，不能据此上报历史摸底完成
            if (!aJson.paging) completedAllPlans = false;
            break;
          }

          let pageFailed = false;
          for (const item of aJson.data) {
            if (stats.riskExhausted) break;
            if (!item?.id) continue;
            const itemIdStr = String(item.id);
            // 分页重叠去重：重复项不参与 eval、不 sendContent、不计入 unchanged/savedForUser
            if (seenAnswerIds.has(itemIdStr)) {
              duplicateAnswerSkipped++;
              continue;
            }
            seenAnswerIds.add(itemIdStr);
            if (plan.sortBy === "created" && aOffset === 0 && !newestSeenAnswerId) {
              newestSeenAnswerId = itemIdStr;
            }
            // 阶段二日常增量：一旦撞到上次扫描记录的最新回答标记点 lastMarkAnswerId，立即停下（哪怕中间跳过了水贴也能精确停住，0 次多余数据库写入！）
            if (onlyIncrementalNow && lastMarkAnswerId && itemIdStr === lastMarkAnswerId) {
              aIsEnd = true;
              break;
            }

            const cleanedHtml = cleanHtml(item.content);
            // 首次历史摸底：voteups 前 60 篇无条件保存（不计入 60 篇之外才走规则/AI）；
            // voteups 首页异常空页时回退的 created 前 60 篇同样享受首次摸底保护
            const forceSave = forceSaveTop60 && (plan.sortBy === "voteups" || fallbackCreatedTop60) && top60Seen < 60;
            if (forceSave) top60Seen++;
            const evalRes = isUserFull || forceSave ? null : evaluateForAutoBackup(item, cleanedHtml);
            if (forceSave) {
              console.log(`  📌 [首次摸底 ${u.name}] 最热第 ${top60Seen} 篇无条件保存: ${item.question?.title || item.id}`);
            }

            const contentInput = {
              sourceType: "answer" as const,
              sourceId: String(item.id),
              title: item.question?.title || "未知问题",
              sourceUrl: `https://www.zhihu.com/question/${item.question?.id}/answer/${item.id}`,
              author: {
                name: item.author?.name || u.name,
                urlToken: item.author?.url_token || u.urlToken,
                avatarUrl: item.author?.avatar_url || u.avatarUrl,
                headline: item.author?.headline || u.headline
              },
              question: item.question ? { id: String(item.question.id), title: item.question.title } : undefined,
              contentHtml: cleanedHtml,
              contentMd: "",
              excerpt: item.excerpt || "",
              // following 列表不下发顶层 voteup_count/favorite_count（include 也拿不到），
              // reaction.statistics.like_count/favorites 是默认字段，这里仅作候选评估时的占位回退；
              // 真正入库前会由 fillTrueAnswerStats 用 /api/v4/answers/{id} 覆盖成
              // 真实 voteup_count 与真实 visit_count（like_count 是「喜欢数」不是赞同数）。
              voteupCount: item.voteup_count ?? item.reaction?.statistics?.like_count ?? 0,
              commentCount: item.comment_count || 0,
              favoriteCount: item.favorite_count ?? item.reaction?.statistics?.favorites ?? 0,
              visitCount: item.visit_count ?? 0,
              isCollapsed: item.is_collapsed,
              isLabeled: item.is_labeled,
              labelInfo: item.label_info ? JSON.stringify(item.label_info) : "",
              createdTime: toIsoOrNull(item.created_time),
              updatedTime: toIsoOrNull(item.updated_time)
            };

            if (evalRes) {
              if (evalRes.shouldBackup) {
                // 规则已通过：直接保存，不浪费 AI 额度
                console.log(`  🛡️ [自动抢救 ${u.name}] 风险${evalRes.riskScore}分/质量${evalRes.valueScore}分 (${evalRes.reason}): ${item.question?.title || item.id}`);
              } else {
                // 规则未通过：只有落在候选池（高赞/长文/中风险）才进入本轮的 AI 复核队列
                const plainTextLen = cleanedHtml.replace(/<[^>]+>/g, "").trim().length;
                // 用估算赞同量级（like_count 只是喜欢数，直接比较会把高赞回答挡在 AI 复核池外）
                const voteup = effectiveVotes(item);
                const isAiCandidate = voteup >= 100 || plainTextLen >= 600 || evalRes.riskScore >= 18;
                if (isAiCandidate) {
                  if (answerAiCandidates.length < MAX_AI_CANDIDATES_PER_USER) {
                    answerAiCandidates.push({
                      sourceType: "answer",
                      sourceId: String(item.id),
                      title: item.question?.title || "未知问题",
                      questionTitle: item.question?.title || "",
                      excerpt: item.excerpt || "",
                      voteupCount: voteup,
                      commentCount: Number(item.comment_count) || 0,
                      favoriteCount: Number(item.favorite_count ?? item.reaction?.statistics?.favorites) || 0,
                      isCollapsed: Boolean(item.is_collapsed),
                      isLabeled: Boolean(item.is_labeled) || Boolean(item.label_info),
                      riskScore: evalRes.riskScore,
                      riskTags: evalRes.reason ? evalRes.reason.split("+").filter(Boolean) : [],
                      contentInput
                    });
                  } else {
                    answerAiOverflow++;
                  }
                }
                continue; // 普通低风险水贴直接跳过，不占 D1 / R2 容量
              }
            }

            try {
              // 入库前补真实赞同数/真实浏览量：列表里的 like_count 只是「❤️ 喜欢数」
              await fillTrueAnswerStats(contentInput, String(item.id));
              const dbRes = await sendContent(contentInput);
              if (
                cfg.commentsFollowing !== "none" &&
                await shouldSyncCommentsDeep(
                  `answer:${item.id}`,
                  contentInput.commentCount,
                  dbRes.prevCommentCount,
                  cfg.commentsFollowing
                ) &&
                !stats.circuitBroken &&
                !stats.riskExhausted
              ) {
                await syncHotCommentsForContent(context, "answer", String(item.id), cfg.commentsFollowing);
              }
              savedForUser++;
              if (!dbRes.created && !dbRes.changed) {
                unchanged++;
                if (unchanged >= plan.earlyStop) {
                  aIsEnd = true;
                  break;
                }
              } else {
                unchanged = 0;
              }
            } catch (err: any) {
              pageFailed = true;
              completedAllPlans = false;
              console.error(`❌ 保存关注答主回答失败: ${sanitizeErrorForLog(err)}`);
              if (stats.circuitBroken) break;
            }
          }

          if (pageFailed || stats.circuitBroken || stats.riskExhausted) {
            completedAllPlans = false;
            break;
          }

          if (!aIsEnd) aIsEnd = Boolean(aJson.paging?.is_end);
          // 按实际返回条数推进（服务端忽略 limit 时避免与上一页大面积重叠），seenAnswerIds 兜底去重
          aOffset += (aJson.data?.length || batchLimit);
          if (plan.trackResume && !aIsEnd) {
            await reportUserProgress(u.urlToken, aOffset, false);
          }
          await jitterSleep(800, 1500);
        }
      }
      // 扫描结束后对本轮候选做一次批量 AI 复核（最多 10 条/答主、全局最多 3 次成功调用）
      if (!isUserFull && answerAiOverflow > 0) {
        console.log(`  ⏭️ [${u.name}] 另有 ${answerAiOverflow} 条回答候选超出单轮 ${MAX_AI_CANDIDATES_PER_USER} 条 AI 复核上限，本轮按规则跳过`);
      }
      if (answerAiCandidates.length > 0 && !stats.circuitBroken && !stats.riskExhausted) {
        const aiKept = await evaluateFollowingCandidatesWithAI(u.name, answerAiCandidates);
        for (const cand of aiKept) {
          if (stats.circuitBroken) break;
          try {
            // AI 复核通过、真正要入库的回答：补真实赞同数与真实浏览量后再提交
            if (cand.sourceType === "answer") await fillTrueAnswerStats(cand.contentInput, cand.sourceId);
            const dbRes = await sendContent(cand.contentInput);
            if (
              cfg.commentsFollowing !== "none" &&
              await shouldSyncCommentsDeep(
                `answer:${cand.sourceId}`,
                cand.commentCount,
                dbRes?.prevCommentCount,
                cfg.commentsFollowing
              ) &&
              !stats.circuitBroken &&
              !stats.riskExhausted
            ) {
              await syncHotCommentsForContent(context, "answer", cand.sourceId, cfg.commentsFollowing);
            }
            savedForUser++;
          } catch (err) {
            completedAllPlans = false;
            console.error(`❌ 保存 AI 判定回答失败: ${sanitizeErrorForLog(err)}`);
            if (stats.circuitBroken) break;
          }
        }
      }
      if (!isUserFull && savedForUser > 0) {
        console.log(`  ✅ [${u.name}] 智能风险抢救共入库 ${savedForUser} 篇高危/精品回答`);
      }
    }

    // 2. 抓取专栏文章（全量模式下抓全部文章；智能模式下扫描最新 40 篇文章并只自动备份高危/高质文章）
    // 回答列表已 410（账号注销/不可见）时直接跳过文章扫描，避免再白打一次必然失败的请求
    if (u.articlesCount > 0 && !userGone410 && !stats.circuitBroken && !stats.riskExhausted) {
      let artOffset = 0;
      let artIsEnd = false;
      let unchanged = 0;
      // 增量窗口：fast 模式下最多扫 40 篇（与回答增量无标记点时的 40 条窗口对齐），
      // 否则 isFast + onlyIncrementalNow 会沿 created 一路扫穿全量文章，白烧请求与入库配额
      const maxArticles = isUserFull ? 100000 : (onlyIncrementalNow ? (isFast ? 40 : 100000) : (isFast ? 20 : 40));
      const artEarlyStop = isFast ? 5 : 999999;

      while (!artIsEnd && artOffset < maxArticles && !stats.circuitBroken && !stats.riskExhausted) {
        const batchLimit = Math.min(20, maxArticles - artOffset);
        let artJson: any;
        try {
          artJson = (await zhihuJson(
            context,
            `https://www.zhihu.com/api/v4/members/${u.urlToken}/articles?include=${articleIncludeStr}&limit=${batchLimit}&offset=${artOffset}`,
            { label: `[${u.name}] 文章列表` }
          )).json;
        } catch (e: any) {
          // 已注销/不可见账号（HTTP 410）可直接收敛，不把 completedAllPlans 打折
          const status = e instanceof ZhihuRequestError ? e.status : Number(e?.status);
          if (status === 410) {
            console.warn(`⏭️ [${u.name}] 账号已注销或不可见 (HTTP 410)，标记为已完成不再重试`);
            userGone410 = true;
            break;
          }
          // 401/403/429/5xx/风控空页已在 zhihuJson 内重试并计入终态统计
          console.error(`❌ [${u.name}] 获取文章列表失败: ${sanitizeErrorForLog(e)}`);
          completedAllPlans = false;
          break;
        }
        if (!artJson.data || artJson.data.length === 0) {
          // 风控空页已在 zhihuJson 内重试并计数；能到这里的是 is_end 的合法空页。
          // 无 paging 时同理：不能把「不知道是否到底」当作摸底完成
          if (!artJson.paging) completedAllPlans = false;
          break;
        }

        for (const item of artJson.data) {
          if (stats.riskExhausted) break;
          if (!item?.id) continue;
          const articleIdStr = String(item.id);
          // 文章端点去重兜底：重复项不参与 eval/sendContent/unchanged
          if (seenArticleIds.has(articleIdStr)) {
            duplicateArticleSkipped++;
            continue;
          }
          seenArticleIds.add(articleIdStr);
          const cleanedHtml = cleanHtml(item.content);
          const evalRes = isUserFull ? null : evaluateForAutoBackup(item, cleanedHtml);
          const contentInput = {
            sourceType: "article" as const,
            sourceId: String(item.id),
            title: item.title || "未知文章",
            sourceUrl: `https://zhuanlan.zhihu.com/p/${item.id}`,
            author: {
              name: item.author?.name || u.name,
              urlToken: item.author?.url_token || u.urlToken,
              avatarUrl: item.author?.avatar_url || u.avatarUrl,
              headline: item.author?.headline || u.headline
            },
            contentHtml: cleanedHtml,
            contentMd: "",
            excerpt: item.excerpt || "",
            // 文章列表实测（12-live-articles）：voteup_count 需 include 才返回（本路径已带 include，
            // 实测有效）；顶层 favorite_count/visit_count 即使 include 也被静默忽略，
            // 收藏数只能回退默认下发的 reaction.statistics.favorites；
            // visit_count 在文章列表/详情都拿不到，reaction.statistics.visit_count 也不存在，缺失即 0。
            // 注意：文章 reaction.statistics.like_count 是伪值（恒 0，不是赞同数），仅作兜底。
            voteupCount: item.voteup_count ?? item.reaction?.statistics?.like_count ?? 0,
            commentCount: item.comment_count || 0,
            favoriteCount: item.favorite_count ?? item.reaction?.statistics?.favorites ?? 0,
            visitCount: item.visit_count ?? 0,
            // 与回答链路对齐补传：include 里已带 is_labeled，缺失时 Boolean(undefined)=false
            isLabeled: Boolean(item.is_labeled),
            createdTime: toIsoOrNull(item.created || item.created_time),
            updatedTime: toIsoOrNull(item.updated || item.updated_time)
          };

          if (evalRes) {
            if (evalRes.shouldBackup) {
              console.log(`  🛡️ [自动抢救文章 ${u.name}] 风险${evalRes.riskScore}分/质量${evalRes.valueScore}分 (${evalRes.reason}): ${item.title}`);
            } else {
              // 文章路径同一套候选池与 AI 复核策略：规则通过直接存，否则入候选池
              const plainTextLen = cleanedHtml.replace(/<[^>]+>/g, "").trim().length;
              const voteup = Number(item.voteup_count ?? item.reaction?.statistics?.like_count) || 0;
              const isAiCandidate = voteup >= 100 || plainTextLen >= 600 || evalRes.riskScore >= 18;
              if (isAiCandidate) {
                if (articleAiCandidates.length < MAX_AI_CANDIDATES_PER_USER) {
                  articleAiCandidates.push({
                    sourceType: "article",
                    sourceId: String(item.id),
                    title: item.title || "未知文章",
                    questionTitle: "",
                    excerpt: item.excerpt || "",
                    voteupCount: voteup,
                    commentCount: Number(item.comment_count) || 0,
                    favoriteCount: Number(item.favorite_count ?? item.reaction?.statistics?.favorites) || 0,
                    isCollapsed: Boolean(item.is_collapsed),
                    isLabeled: Boolean(item.is_labeled) || Boolean(item.label_info),
                    riskScore: evalRes.riskScore,
                    riskTags: evalRes.reason ? evalRes.reason.split("+").filter(Boolean) : [],
                    contentInput
                  });
                } else {
                  articleAiOverflow++;
                }
              }
              continue;
            }
          }

          try {
            const dbRes = await sendContent(contentInput);
            // 关注答主文章：与回答分支一致，评论数新增或被删（含清零）都要同步
            if (
              cfg.commentsFollowing !== "none" &&
              await shouldSyncCommentsDeep(
                `article:${articleIdStr}`,
                contentInput.commentCount,
                dbRes.prevCommentCount,
                cfg.commentsFollowing
              ) &&
              !stats.circuitBroken &&
              !stats.riskExhausted
            ) {
              await syncHotCommentsForContent(context, "article", articleIdStr, cfg.commentsFollowing);
            }
            if (!dbRes.created && !dbRes.changed) {
              unchanged++;
              if (unchanged >= artEarlyStop) {
                artIsEnd = true;
                break;
              }
            } else {
              unchanged = 0;
            }
          } catch (err: any) {
            completedAllPlans = false;
            console.error(`❌ 保存关注答主文章失败: ${sanitizeErrorForLog(err)}`);
            if (stats.circuitBroken) break;
          }
        }

        if (stats.riskExhausted) {
          completedAllPlans = false;
          break;
        }
        if (!artIsEnd) artIsEnd = Boolean(artJson.paging?.is_end);
        // 按实际返回条数推进，seenArticleIds 兜底去重
        artOffset += (artJson.data?.length || batchLimit);
        await jitterSleep(800, 1500);
      }

      // 文章候选同样批量 AI 复核（共用全局 3 次成功调用上限，失败按规则兜底）
      if (!isUserFull && articleAiOverflow > 0) {
        console.log(`  ⏭️ [${u.name}] 另有 ${articleAiOverflow} 条文章候选超出单轮 ${MAX_AI_CANDIDATES_PER_USER} 条 AI 复核上限，本轮按规则跳过`);
      }
      if (articleAiCandidates.length > 0 && !stats.circuitBroken && !stats.riskExhausted) {
        const aiKept = await evaluateFollowingCandidatesWithAI(u.name, articleAiCandidates);
        for (const cand of aiKept) {
          if (stats.circuitBroken) break;
          try {
            await sendContent(cand.contentInput);
          } catch (err) {
            completedAllPlans = false;
            console.error(`❌ 保存 AI 判定文章失败: ${sanitizeErrorForLog(err)}`);
            if (stats.circuitBroken) break;
          }
        }
      }
    }

    const duplicateTotal = duplicateAnswerSkipped + duplicateArticleSkipped;
    if (duplicateTotal > 0) {
      console.log(`🔁 [${u.name}] 分页重叠去重 ${duplicateTotal} 条`);
    }

    if (completedAllPlans && !stats.circuitBroken && !stats.riskExhausted && (!isHistoryDone || (newestSeenAnswerId && newestSeenAnswerId !== lastMarkAnswerId))) {
      await reportUserProgress(
        u.urlToken,
        onlyIncrementalNow ? (prog.resumeOffset || 0) : 0,
        true,
        newestSeenAnswerId || lastMarkAnswerId || undefined
      );
    }
  }

  console.log("🎉 关注答主同步完成！");
}


// --- Apify Entry Point ---
// 失败必须让 run 状态可见。之前所有异常都被吞掉后正常 exit，
// cookie 失效后 run 依然 SUCCEEDED，Worker /auth 页据此误报"一切正常"。
try {
  // runType 是外部输入：未知取值不能被 else 分支静默吞掉，必须显式失败让调用方感知
  const knownRunTypes: ReadonlySet<string> = new Set([
    "all",
    "answers",
    "articles",
    "collections",
    "upvotes",
    "following",
    "following-list",
    "repair-comments"
  ]);
  if (!knownRunTypes.has(String(runType))) {
    throw new Error(`Unknown runType: ${String(runType)}`);
  }
  if (runType === "repair-comments") {
    // 存量评论补采：独立通道，只重抓 repairTargets 里的评论，不枚举答主、不受 history_done 影响
    await runCommentRepairScraper();
  } else if (runType === "following-list") {
    await runFollowingScraper(true);
  } else if (runType === "following") {
    await runFollowingScraper(false);
  } else {
    if (runType === "all") {
      // 先同步关注人名录（写 R2 + D1，耗时仅 3 秒）
      await runFollowingScraper(true);
    }
    if ((runType === "all" || runType === "answers") && !stats.circuitBroken && !stats.riskExhausted) {
      await runScraper();
      // 回答同步结束后顺带备份本人专栏文章；风控/熔断后不再发起新请求
      if (!stats.circuitBroken && !stats.riskExhausted) await runArticleScraper();
    }
    if (runType === "articles" && !stats.circuitBroken && !stats.riskExhausted) {
      await runArticleScraper();
    }
    if ((runType === "all" || runType === "collections") && !stats.circuitBroken && !stats.riskExhausted) {
      await runCollectionScraper();
    }
    if ((runType === "all" || runType === "upvotes") && !stats.circuitBroken && !stats.riskExhausted) {
      await runUpvotesScraper();
    }
    if (runType === "all" && !stats.circuitBroken && !stats.riskExhausted) {
      // 若自身回答/收藏/赞同跑完后当日 D1 配额仍有富余，继续同步关注答主的回答
      await runFollowingScraper(false);
    }
  }
} catch (e) {
  const errMsg = sanitizeErrorForLog(e);
  log.error(errMsg);
  await Actor.fail(`crawler_error: ${errMsg}`);
  process.exit(1);
}

// 补采评论模式只走 /ingest/comments-by-root，不写 /ingest/content，stats.saved 恒为 0；
// 用本轮实际补采成功的内容条数参与终态判定，避免「补采成功」被误判成「本轮零数据入库」。
// 其它 runType 下 repairSummary 为 null，savedForTerminal 恒等于 stats.saved，语义不变。
const repairSummary = repairState.summary;
const savedForTerminal = repairSummary ? repairSummary.ok : stats.saved;

if (stats.circuitBroken) {
  log.warning(`本轮触发连续失败断路器暂停（已保存 ${savedForTerminal} 条数据，失败 ${stats.failed} 次），断点已保留供下次继续`);
  await Actor.exit({ exitCode: 2 });
  process.exit(2);
}

if ((stats.authRejected > 0 || stats.riskEmpty > 0 || stats.riskExhausted) && savedForTerminal === 0) {
  await Actor.fail(
    `zhihu_auth_failed: 被知乎 401/403 拒绝 ${stats.authRejected} 次、疑似风控空页 ${stats.riskEmpty} 次、` +
      `风控暂停重试耗尽 ${stats.riskExhausted ? "是" : "否"}（cookie 可能已失效或被风控），本轮零数据入库`
  );
  process.exit(1);
}
if (savedForTerminal === 0 && stats.failed > 0) {
  // failed 只统计 Worker 入库失败；知乎侧 429/5xx 已独立计入 zhihuRejected
  await Actor.fail(`ingest_failed: Worker 回传 ${stats.failed} 次全部失败（检查 API_SECRET / WORKER_URL），本轮零数据入库`);
  process.exit(1);
}
if (savedForTerminal === 0 && stats.zhihuRejected > 0) {
  await Actor.fail(`zhihu_request_failed: 知乎侧请求失败 ${stats.zhihuRejected} 次（429/5xx/非 JSON/网络错误），本轮零数据入库`);
  process.exit(1);
}

// 有部分数据入库但存在未恢复的单条失败/风控：不能静默成功。
// 终态消息里显式给出未恢复次数，本地编排脚本据此判定阶段未完成并冷却续跑
// （续跑轮次上限由脚本控制，不会无限重试）；退出码语义保持不变。
const partialRisk =
  stats.riskExhausted || stats.authRejected > 0 || stats.riskEmpty > 0 || stats.zhihuRejected > 0;
let finalStatusMessage: string | undefined;
if (partialRisk && savedForTerminal > 0) {
  const pauseSec = Math.round(stats.riskPauseMs / 1000);
  const unresolved = stats.authRejected + stats.riskEmpty + stats.zhihuRejected;
  const msg = repairSummary
    ? `partial_risk_controlled: 补采评论被风控中断，已完成 ${repairSummary.ok}/${repairSummary.total} 条` +
      `（未恢复请求失败 ${unresolved} 次；暂停重试 ${pauseSec} 秒、重试耗尽 ${stats.riskExhausted ? "是" : "否"}），重跑补采命令可继续`
    : `partial_risk_controlled: 未恢复请求失败 ${unresolved} 次（401/403 ${stats.authRejected} 次、` +
      `风控空页 ${stats.riskEmpty} 次、429/5xx/网络 ${stats.zhihuRejected} 次），本轮数据可能不完整` +
      `（已保存 ${savedForTerminal} 条；暂停重试 ${pauseSec} 秒、重试耗尽 ${stats.riskExhausted ? "是" : "否"}）`;
  log.warning(msg);
  // 作为 run 终态状态消息输出（Actor.exit 会标记为 terminal），让控制台/本地脚本都能看到「部分被风控」
  finalStatusMessage = msg.slice(0, 200);
}
if (stats.failed > 0 || stats.zhihuRejected > 0 || stats.riskExhausted) {
  log.warning(
    `本轮完成：${repairSummary ? "补采" : "交付"} ${savedForTerminal} 条数据；Worker 入库失败 ${stats.failed} 次；` +
      `知乎侧请求失败 ${stats.zhihuRejected} 次（429/5xx/非 JSON/网络）；累计风控暂停 ${Math.round(
        stats.riskPauseMs / 1000
      )} 秒`
  );
}

if (finalStatusMessage) {
  await Actor.exit({ statusMessage: finalStatusMessage });
} else {
  await Actor.exit();
}
