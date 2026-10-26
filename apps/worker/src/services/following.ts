import { db } from "../db.js";
import { evaluateContentRisk } from "./risk.js";

export type FollowedUserRecord = {
  url_token: string;
  user_id?: string;
  name: string;
  avatar_url?: string;
  headline?: string;
  answer_count: number;
  articles_count: number;
  follower_count: number;
  sync_mode: "default" | "full";
  is_unfollowed: number;
  first_seen_at: string;
  last_seen_at: string;
  last_synced_at?: string | null;
  mode_updated_at?: string;
  /** 该答主在当前 sync_mode 下的历史扫描断点 offset（0 表示从头开始） */
  resume_offset?: number;
  /** 该答主在当前 sync_mode 下的历史存量是否已全部扫描完毕（完毕后日常只跑头部增量） */
  history_done?: boolean;
  /** 上次扫描时看到的该答主最新一篇回答 ID（阶段二日常增量直接扫到此标记点即停，0 多余写入） */
  last_checked_answer_id?: string;
};

const R2_FOLLOWED_KEY = "meta/followed_users.json";
const FAV_JOIN = `(SELECT content_pk, MAX(first_seen_at) AS fav_added_at FROM collection_items WHERE is_removed = 0 GROUP BY content_pk)`;

async function ensureTable() {
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS followed_users (
        url_token TEXT PRIMARY KEY,
        user_id TEXT,
        name TEXT NOT NULL,
        avatar_url TEXT,
        headline TEXT,
        answer_count INTEGER NOT NULL DEFAULT 0,
        articles_count INTEGER NOT NULL DEFAULT 0,
        follower_count INTEGER NOT NULL DEFAULT 0,
        sync_mode TEXT NOT NULL DEFAULT 'default' CHECK (sync_mode IN ('default', 'full')),
        is_unfollowed INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_synced_at TEXT
      )
    `).run();
  } catch {
    // D1 当日写入限额满时忽略，自动降级走 R2
  }
}

async function readR2Map(bucket: any): Promise<Record<string, FollowedUserRecord>> {
  if (!bucket) return {};
  try {
    const obj = await bucket.get(R2_FOLLOWED_KEY);
    if (!obj) return {};
    const text = await obj.text();
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeR2Map(bucket: any, map: Record<string, FollowedUserRecord>): Promise<void> {
  if (!bucket) return;
  await bucket.put(R2_FOLLOWED_KEY, JSON.stringify(map), {
    httpMetadata: { contentType: "application/json; charset=utf-8" }
  });
}

export async function getFollowedUsersMap(bucket: any): Promise<Record<string, FollowedUserRecord>> {
  const map = await readR2Map(bucket);
  try {
    const d1Rows = await db.prepare(`SELECT * FROM followed_users`).all<FollowedUserRecord>();
    for (const r of d1Rows) {
      if (!r?.url_token) continue;
      const existing = map[r.url_token];
      if (!existing) {
        map[r.url_token] = r;
      } else {
        // R2 (existing) 是 sync_mode 的权威最新源（每次切换均优先写 R2）
        const d1Newer = (r.last_seen_at || "") > (existing.last_seen_at || "");
        map[r.url_token] = {
          ...(d1Newer ? existing : r),
          ...(d1Newer ? r : existing),
          sync_mode: existing.sync_mode || r.sync_mode || "default",
          mode_updated_at: existing.mode_updated_at,
          resume_offset: existing.resume_offset ?? 0,
          history_done: Boolean(existing.history_done),
          last_checked_answer_id: existing.last_checked_answer_id || ""
        };
      }
    }
  } catch {
    // 表尚未创建时直接使用 R2 数据
  }
  return map;
}

/**
 * 批量写入关注的人列表（D1 + R2 双写，保留已设置的 sync_mode）
 */
export async function upsertFollowedUsersSnapshot(
  bucket: any,
  users: Array<{
    urlToken: string;
    userId?: string;
    name: string;
    avatarUrl?: string;
    headline?: string;
    answerCount?: number;
    articlesCount?: number;
    followerCount?: number;
  }>,
  incremental = false
) {
  const now = new Date().toISOString();
  const map = await getFollowedUsersMap(bucket);
  const incomingTokens = new Set<string>();

  for (const u of users) {
    const token = String(u.urlToken || "").trim();
    if (!token) continue;
    incomingTokens.add(token);
    const prev = map[token];
    map[token] = {
      url_token: token,
      user_id: u.userId || prev?.user_id || "",
      name: u.name || prev?.name || token,
      avatar_url: u.avatarUrl ?? prev?.avatar_url ?? "",
      headline: u.headline ?? prev?.headline ?? "",
      answer_count: Number(u.answerCount ?? prev?.answer_count ?? 0),
      articles_count: Number(u.articlesCount ?? prev?.articles_count ?? 0),
      follower_count: Number(u.followerCount ?? prev?.follower_count ?? 0),
      sync_mode: prev?.sync_mode === "full" ? "full" : "default",
      is_unfollowed: 0,
      first_seen_at: prev?.first_seen_at || now,
      last_seen_at: now,
      last_synced_at: prev?.last_synced_at ?? null,
      mode_updated_at: prev?.mode_updated_at,
      resume_offset: prev?.resume_offset ?? 0,
      history_done: Boolean(prev?.history_done),
      last_checked_answer_id: prev?.last_checked_answer_id || ""
    };
  }

  if (!incremental && incomingTokens.size > 0) {
    for (const token of Object.keys(map)) {
      if (!incomingTokens.has(token)) {
        map[token].is_unfollowed = 1;
      }
    }
  }

  // 1. 先写 R2（不受 D1 每日 100K 行写入限制影响，100% 实时成功）
  await writeR2Map(bucket, map);

  // 2. 尝试同步写 D1
  try {
    await ensureTable();
    const stmts: any[] = [];
    for (const r of Object.values(map)) {
      stmts.push(
        db.prepare(`
          INSERT INTO followed_users (
            url_token, user_id, name, avatar_url, headline,
            answer_count, articles_count, follower_count,
            sync_mode, is_unfollowed, first_seen_at, last_seen_at, last_synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(url_token) DO UPDATE SET
            user_id = excluded.user_id,
            name = excluded.name,
            avatar_url = excluded.avatar_url,
            headline = excluded.headline,
            answer_count = excluded.answer_count,
            articles_count = excluded.articles_count,
            follower_count = excluded.follower_count,
            sync_mode = excluded.sync_mode,
            is_unfollowed = excluded.is_unfollowed,
            last_seen_at = excluded.last_seen_at
        `).raw(
          r.url_token,
          r.user_id || "",
          r.name,
          r.avatar_url || "",
          r.headline || "",
          r.answer_count,
          r.articles_count,
          r.follower_count,
          r.sync_mode,
          r.is_unfollowed,
          r.first_seen_at,
          r.last_seen_at,
          r.last_synced_at ?? null
        )
      );
    }
    for (let i = 0; i < stmts.length; i += 50) {
      await db.batch(stmts.slice(i, i + 50));
    }
  } catch {
    // D1 配额满时静默跳过，R2 已完整保存
  }

  const allList = Object.values(map).filter(u => !u.is_unfollowed);
  return {
    ok: true,
    totalFollowed: allList.length,
    fullModeCount: allList.filter(u => u.sync_mode === "full").length
  };
}

/**
 * 切换某个关注答主的备份模式：default（默认精选前 50 篇） vs full（全量备份）
 */
export async function setFollowedUserSyncMode(
  bucket: any,
  urlToken: string,
  syncMode: "default" | "full"
) {
  const map = await getFollowedUsersMap(bucket);
  const target = map[urlToken];
  if (!target) {
    return { ok: false, error: "未找到该关注用户" };
  }
  const now = new Date().toISOString();
  const modeChanged = target.sync_mode !== syncMode;
  target.sync_mode = syncMode;
  target.mode_updated_at = now;
  if (modeChanged && syncMode === "full") {
    // 从默认模式切换为全量模式时，重置该答主的 history_done 标记，触发全量历史补抓
    target.history_done = false;
    target.resume_offset = 0;
  }
  map[urlToken] = target;

  await writeR2Map(bucket, map);

  try {
    await ensureTable();
    await db.prepare(
      `UPDATE followed_users SET sync_mode = ?, last_seen_at = ? WHERE url_token = ?`
    ).run(syncMode, now, urlToken);
  } catch {
    // D1 配额满时由 R2 持久化
  }

  const totalZhihu = (target.answer_count || 0) + (target.articles_count || 0);
  return {
    ok: true,
    url_token: urlToken,
    sync_mode: syncMode,
    total_zhihu_items: totalZhihu,
    planned_backup_items: syncMode === "full" ? totalZhihu : Math.min(totalZhihu, 50)
  };
}

/**
 * 爬虫上报某位关注答主的历史扫描进度（断点 resume_offset 与是否完成历史存量扫描 history_done）
 */
export async function updateFollowedUserProgress(
  bucket: any,
  urlToken: string,
  progress: { resumeOffset: number; historyDone: boolean; lastCheckedAnswerId?: string }
) {
  const map = await getFollowedUsersMap(bucket);
  const target = map[urlToken];
  if (!target) return { ok: false };
  target.resume_offset = Math.max(0, Math.trunc(Number(progress.resumeOffset) || 0));
  target.history_done = Boolean(progress.historyDone);
  if (progress.lastCheckedAnswerId) {
    target.last_checked_answer_id = String(progress.lastCheckedAnswerId);
  }
  target.last_synced_at = new Date().toISOString();
  map[urlToken] = target;
  await writeR2Map(bucket, map);
  return { ok: true };
}

/**
 * 获取关注的人列表 + 统计每位答主在本地库已备份篇数、赞同篇数、收藏篇数与预计备份量
 */
export async function listFollowedUsers(
  bucket: any,
  params?: { q?: string; mode?: string; sort?: string }
) {
  const map = await getFollowedUsersMap(bucket);
  let users = Object.values(map).filter(u => !u.is_unfollowed);

  // 从 contents 表聚合每位作者已入库的数量、赞同数、收藏数、最新时间
  const authorStatsByToken = new Map<string, { backed: number; upvoted: number; faved: number; latest: string | null }>();
  const authorStatsByName = new Map<string, { backed: number; upvoted: number; faved: number; latest: string | null }>();

  try {
    const statRows = await db.prepare(`
      SELECT
        c.author_url_token,
        c.author_name,
        count(*) AS backed_cnt,
        sum(CASE WHEN u.content_pk IS NOT NULL THEN 1 ELSE 0 END) AS upvoted_cnt,
        sum(CASE WHEN ci.content_pk IS NOT NULL THEN 1 ELSE 0 END) AS faved_cnt,
        max(COALESCE(c.updated_time, c.created_time, c.last_seen_at)) AS latest_time
      FROM contents c
      LEFT JOIN upvotes u ON u.content_pk = c.pk
      LEFT JOIN ${FAV_JOIN} ci ON ci.content_pk = c.pk
      WHERE c.author_name IS NOT NULL AND c.author_name != ''
      GROUP BY c.author_url_token, c.author_name
    `).all<any>();

    for (const r of statRows) {
      const token = String(r.author_url_token || "").trim();
      const name = String(r.author_name || "").trim();
      const item = {
        backed: Number(r.backed_cnt) || 0,
        upvoted: Number(r.upvoted_cnt) || 0,
        faved: Number(r.faved_cnt) || 0,
        latest: r.latest_time || null
      };
      if (token) {
        const prev = authorStatsByToken.get(token);
        authorStatsByToken.set(token, {
          backed: (prev?.backed || 0) + item.backed,
          upvoted: (prev?.upvoted || 0) + item.upvoted,
          faved: (prev?.faved || 0) + item.faved,
          latest: !prev?.latest || (item.latest && item.latest > prev.latest) ? item.latest : prev.latest
        });
      } else if (name) {
        const prev = authorStatsByName.get(name);
        authorStatsByName.set(name, {
          backed: (prev?.backed || 0) + item.backed,
          upvoted: (prev?.upvoted || 0) + item.upvoted,
          faved: (prev?.faved || 0) + item.faved,
          latest: !prev?.latest || (item.latest && item.latest > prev.latest) ? item.latest : prev.latest
        });
      }
    }
  } catch {
    // ignore
  }

  const enriched = users.map(u => {
    const byToken = authorStatsByToken.get(u.url_token);
    const byNameNoToken = authorStatsByName.get(u.name);
    const latestA = byToken?.latest || null;
    const latestB = byNameNoToken?.latest || null;
    const st = {
      backed: (byToken?.backed || 0) + (byNameNoToken?.backed || 0),
      upvoted: (byToken?.upvoted || 0) + (byNameNoToken?.upvoted || 0),
      faved: (byToken?.faved || 0) + (byNameNoToken?.faved || 0),
      latest: !latestA ? latestB : (!latestB || latestA > latestB ? latestA : latestB)
    };
    const totalZhihu = (u.answer_count || 0) + (u.articles_count || 0);
    const defaultQuota = Math.min(totalZhihu, 50);
    return {
      ...u,
      backed_up_count: st.backed,
      upvoted_count: st.upvoted,
      faved_count: st.faved,
      latest_content_time: st.latest,
      total_zhihu_items: totalZhihu,
      default_quota_items: defaultQuota,
      planned_backup_items: u.sync_mode === "full" ? totalZhihu : defaultQuota
    };
  });

  const q = (params?.q || "").trim().toLowerCase();
  let filtered = q
    ? enriched.filter(u =>
        u.name.toLowerCase().includes(q) ||
        (u.headline || "").toLowerCase().includes(q) ||
        u.url_token.toLowerCase().includes(q)
      )
    : enriched;

  if (params?.mode === "full") {
    filtered = filtered.filter(u => u.sync_mode === "full");
  } else if (params?.mode === "backed") {
    filtered = filtered.filter(u => u.backed_up_count > 0);
  }

  const sort = params?.sort || "backed";
  filtered.sort((a, b) => {
    if (sort === "zhihu_total") return b.total_zhihu_items - a.total_zhihu_items;
    if (sort === "full_first") {
      if (a.sync_mode !== b.sync_mode) return a.sync_mode === "full" ? -1 : 1;
      return b.backed_up_count - a.backed_up_count;
    }
    // 默认：全量开启优先 -> 已备份数倒序 -> 知乎总回答数倒序
    if (b.backed_up_count !== a.backed_up_count) return b.backed_up_count - a.backed_up_count;
    return b.total_zhihu_items - a.total_zhihu_items;
  });

  // 汇总全局配额预估
  const summary = {
    total_followed_users: enriched.length,
    full_mode_users: enriched.filter(u => u.sync_mode === "full").length,
    total_backed_up_items: enriched.reduce((s, u) => s + u.backed_up_count, 0),
    total_zhihu_all_items: enriched.reduce((s, u) => s + u.total_zhihu_items, 0),
    planned_total_items: enriched.reduce((s, u) => s + u.planned_backup_items, 0)
  };

  return { users: filtered, summary };
}

/**
 * 查看某位关注答主的详情与已备份回答/文章列表（附和谐风险评估）
 */
export async function getFollowedUserContents(
  bucket: any,
  urlToken: string,
  params?: { page?: number; onlyRisk?: boolean }
) {
  const map = await getFollowedUsersMap(bucket);
  const user = map[urlToken] || null;
  const parsedPage = Number(params?.page ?? 1);
  const page = Number.isFinite(parsedPage) ? Math.min(Math.max(Math.trunc(parsedPage), 1), 10000) : 1;
  const limit = 50;
  const offset = (page - 1) * limit;

  const whereSql = user?.name
    ? `(c.author_url_token = ? OR (c.author_name = ? AND (c.author_url_token IS NULL OR c.author_url_token = '')))`
    : `c.author_url_token = ?`;
  const bindArgs = user?.name ? [urlToken, user.name] : [urlToken];

  const rows = await db.prepare(`
    SELECT c.pk, c.source_type, c.source_id, c.title, c.question_id, c.question_title,
           c.source_url, c.author_name, c.author_url_token, c.author_avatar, c.author_headline,
           c.excerpt, c.voteup_count, c.comment_count, c.favorite_count, c.visit_count,
           c.is_deleted, c.is_collapsed, c.is_labeled, c.label_info,
           c.created_time, c.updated_time, c.last_seen_at,
           u.upvote_time,
           CASE WHEN ci.content_pk IS NOT NULL THEN 1 ELSE 0 END AS in_favorites
    FROM contents c
    LEFT JOIN upvotes u ON u.content_pk = c.pk
    LEFT JOIN ${FAV_JOIN} ci ON ci.content_pk = c.pk
    WHERE ${whereSql}
    ORDER BY COALESCE(c.updated_time, c.created_time, c.last_seen_at) DESC
    LIMIT 1000
  `).all<any>(...bindArgs);

  const backedUpTotal = rows.length;
  let enriched = rows.map(r => ({
    ...r,
    ...evaluateContentRisk(r)
  }));

  if (params?.onlyRisk) {
    enriched = enriched.filter(r => r.risk_level === "high" || r.risk_level === "medium");
    enriched.sort((a, b) => b.risk_score - a.risk_score);
  }

  return {
    user: user
      ? {
          ...user,
          backed_up_count: backedUpTotal,
          total_zhihu_items: (user.answer_count || 0) + (user.articles_count || 0),
          default_quota_items: Math.min((user.answer_count || 0) + (user.articles_count || 0), 50)
        }
      : { url_token: urlToken, name: rows[0]?.author_name || urlToken, answer_count: 0, articles_count: 0, backed_up_count: backedUpTotal, sync_mode: "default" },
    backed_up_count: backedUpTotal,
    total: enriched.length,
    data: enriched.slice(offset, offset + limit)
  };
}

/**
 * 关注的人混合动态流（展示所有已关注答主在库内的回答/文章，支持按高危易和谐过滤）
 */
export async function listFollowingFeed(
  bucket: any,
  params?: { page?: number; onlyRisk?: boolean; q?: string }
) {
  const map = await getFollowedUsersMap(bucket);
  const activeUsers = Object.values(map).filter(u => !u.is_unfollowed);
  if (activeUsers.length === 0) {
    return { data: [], total: 0 };
  }

  const parsedPage = Number(params?.page ?? 1);
  const page = Number.isFinite(parsedPage) ? Math.min(Math.max(Math.trunc(parsedPage), 1), 10000) : 1;
  const limit = 30;
  const offset = (page - 1) * limit;

  const sqlQuote = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
  const tokensIn = activeUsers
    .map(u => u.url_token)
    .filter(Boolean)
    .map(sqlQuote)
    .join(",");
  const namesIn = activeUsers
    .map(u => u.name)
    .filter(Boolean)
    .map(sqlQuote)
    .join(",");

  const rawQ = (params?.q ?? "").trim();
  const hasQ = rawQ.length > 0;
  const escapedQ = hasQ ? `%${rawQ.replace(/[\\%_]/g, "\\$&")}%` : "";
  const qClause = hasQ ? `AND (c.title LIKE ? ESCAPE '\\' OR c.excerpt LIKE ? ESCAPE '\\' OR c.author_name LIKE ? ESCAPE '\\')` : "";
  const bindArgs = hasQ ? [escapedQ, escapedQ, escapedQ] : [];

  const rows = await db.prepare(`
    SELECT c.pk, c.source_type, c.source_id, c.title, c.question_id, c.question_title,
           c.source_url, c.author_name, c.author_url_token, c.author_avatar, c.author_headline,
           c.excerpt, c.voteup_count, c.comment_count, c.favorite_count, c.visit_count,
           c.is_deleted, c.is_collapsed, c.is_labeled, c.label_info,
           c.created_time, c.updated_time, c.last_seen_at,
           u.upvote_time,
           CASE WHEN ci.content_pk IS NOT NULL THEN 1 ELSE 0 END AS in_favorites
    FROM contents c
    LEFT JOIN upvotes u ON u.content_pk = c.pk
    LEFT JOIN ${FAV_JOIN} ci ON ci.content_pk = c.pk
    WHERE (
      ${tokensIn ? `c.author_url_token IN (${tokensIn})` : "0"}
      OR ${namesIn ? `((c.author_url_token IS NULL OR c.author_url_token = '') AND c.author_name IN (${namesIn}))` : "0"}
    )
    ${qClause}
    ORDER BY COALESCE(c.updated_time, c.created_time, c.last_seen_at) DESC
    LIMIT 600
  `).all<any>(...bindArgs);

  let enriched = rows.map(r => ({
    ...r,
    ...evaluateContentRisk(r)
  }));

  if (params?.onlyRisk) {
    enriched = enriched.filter(r => r.risk_level === "high" || r.risk_level === "medium");
    enriched.sort((a, b) => b.risk_score - a.risk_score || b.value_score - a.value_score);
  }

  return {
    total: enriched.length,
    data: enriched.slice(offset, offset + limit)
  };
}
