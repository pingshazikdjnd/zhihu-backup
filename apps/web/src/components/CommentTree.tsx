import { useState, useEffect, useMemo, useRef } from "react";
import { sanitizeHtml } from "../lib/sanitize.js";
import { fetchChildComments, fetchRootComments } from "../lib/api.js";

export type PreviewReply = {
  id: string;
  author: string;
  beReplied?: string | null;
  content: string;
  likes: number;
  isAuthor?: boolean;
};

export type RootComment = {
  id: string;
  content_pk: string;
  content_md: string;
  author_name: string;
  author_avatar?: string;
  img_url?: string;
  time_text?: string;
  location?: string;
  likes: number;
  is_author: number;
  is_top: number;
  is_featured: number;
  is_deleted: number;
  child_count: number;
  is_complete: number;
  preview_replies?: PreviewReply[];
};

export type ChildComment = {
  id: string;
  parentId?: string;
  author: string;
  authorAvatar?: string;
  beReplied?: string;
  content: string;
  img?: string;
  img_url?: string;
  time?: string;
  location?: string;
  likes: number;
  isAuthor?: boolean;
};

// 兼容旧接口扁平数据结构
type LegacyCommentItem = {
  id: string;
  parent_comment_id?: string | null;
  author_name?: string;
  content_md?: string;
  likes?: number;
  is_deleted?: number;
  time_text?: string;
  be_replied?: string | null;
  author_avatar?: string;
  location?: string;
  is_author?: number;
  is_top?: number;
  is_featured?: number;
};

interface CommentTreeProps {
  comments: (RootComment | LegacyCommentItem)[];
  contentPk?: string;
  initialHasMore?: boolean;
}

const fmtTime = (t?: string) => {
  if (!t) return "";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t : d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
};

// 楼中楼分批展示：展开先显示 5 条，每次「加载更多」再放 10 条
const INITIAL_CHILD_COUNT = 5;
const CHILD_LOAD_STEP = 10;

// 旧版扁平树状渲染组件（向后兼容）
function LegacyCommentTreeView({ comments }: { comments: LegacyCommentItem[] }) {
  const [visibleCount, setVisibleCount] = useState(50);

  useEffect(() => {
    setVisibleCount(50);
  }, [comments]);

  useEffect(() => {
    const handleScroll = () => {
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 800) {
        setVisibleCount(v => {
          if (v >= comments.length) return v;
          return Math.min(v + 20, comments.length);
        });
      }
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, [comments.length]);

  const flattenedComments = useMemo(() => {
    const map = new Map<string | null, LegacyCommentItem[]>();
    for (const c of comments) {
      const key = c.parent_comment_id || null;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }

    const result: { item: LegacyCommentItem; depth: number }[] = [];
    function traverse(parentId: string | null, depth: number) {
      const list = map.get(parentId) || [];
      for (const item of list) {
        result.push({ item, depth });
        traverse(item.id, depth + 1);
      }
    }
    traverse(null, 0);

    const inTree = new Set(result.map(r => r.item.id));
    for (const c of comments) {
      if (!inTree.has(c.id)) result.push({ item: c, depth: 0 });
    }
    return result;
  }, [comments]);

  return (
    <div>
      {flattenedComments.slice(0, visibleCount).map(({ item, depth }) => (
        <div
          id={`comment-${item.id}`}
          key={item.id}
          className={`comment ${item.is_deleted ? "is-deleted" : ""}`}
          style={depth > 0 ? { marginLeft: Math.min(depth, 4) * 18, paddingLeft: 12, borderLeft: "2px solid var(--zhihu-border-light)" } : undefined}
        >
          {item.author_avatar ? (
            <img className="comment-avatar" src={item.author_avatar} alt="" referrerPolicy="no-referrer" />
          ) : (
            <div className="comment-avatar-placeholder">?</div>
          )}
          <div className="comment-body">
            <div className="comment-head">
              <span className="name">{item.author_name || "匿名"}</span>
              {item.is_author === 1 && <span className="comment-badge">答主</span>}
              {item.is_top === 1 && <span className="comment-badge top">置顶</span>}
              {item.is_featured === 1 && <span className="comment-badge featured">精选</span>}
              {item.is_deleted === 1 && <span className="comment-badge deleted">已删除</span>}
              <span className="time">{fmtTime(item.time_text)}</span>
              {item.location && <span className="loc">IP 属地 {item.location}</span>}
            </div>
            {item.be_replied && (
              <div className="comment-reply-to">回复 <strong>{item.be_replied}</strong></div>
            )}
            <div
              className="comment-content"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(item.content_md) }}
            />
            <div className="comment-actions">
              <span className="likes">👍 {item.likes || 0}</span>
            </div>
          </div>
        </div>
      ))}
      {visibleCount < comments.length && (
        <p className="loading-state">下拉加载更多评论…</p>
      )}
      {comments.length === 0 && (
        <p className="empty-state">暂无评论</p>
      )}
    </div>
  );
}

// 单条根评论项（包含懒加载子评论状态）
function RootCommentItemView({ comment, contentPk }: { comment: RootComment; contentPk: string }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<ChildComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  // 当前已展示的子评论条数（展开后分批递增）
  const [visibleChildCount, setVisibleChildCount] = useState(INITIAL_CHILD_COUNT);

  const childCount = comment.child_count || 0;

  const loadChildren = async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetchChildComments(contentPk, comment.id);
      setChildren(res.data || []);
    } catch (e: any) {
      setLoadError(e?.message || "加载回复失败");
    } finally {
      setLoading(false);
    }
  };

  const toggleExpand = () => {
    if (expanded) {
      setExpanded(false);
      // 收起时重置分批进度，再次展开回到前 5 条
      setVisibleChildCount(INITIAL_CHILD_COUNT);
      return;
    }

    setExpanded(true);
    // 每次展开都从首批条数开始
    setVisibleChildCount(INITIAL_CHILD_COUNT);
    // 已经拉取过子评论则直接展开
    if (children.length > 0) return;

    loadChildren();
  };

  return (
    <div id={`comment-${comment.id}`} className={`comment ${comment.is_deleted ? "is-deleted" : ""}`}>
      {comment.author_avatar ? (
        <img className="comment-avatar" src={comment.author_avatar} alt="" referrerPolicy="no-referrer" />
      ) : (
        <div className="comment-avatar-placeholder">?</div>
      )}
      <div className="comment-body">
        <div className="comment-head">
          <span className="name">{comment.author_name || "匿名"}</span>
          {comment.is_author === 1 && <span className="comment-badge">答主</span>}
          {comment.is_top === 1 && <span className="comment-badge top">置顶</span>}
          {comment.is_featured === 1 && <span className="comment-badge featured">精选</span>}
          {comment.is_deleted === 1 && <span className="comment-badge deleted">已删除</span>}
          <span className="time">{fmtTime(comment.time_text)}</span>
          {comment.location && <span className="loc">IP 属地 {comment.location}</span>}
        </div>

        <div
          className="comment-content"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(comment.content_md) }}
        />

        {comment.img_url && (
          <div style={{ margin: "6px 0" }}>
            <img
              src={comment.img_url}
              alt=""
              referrerPolicy="no-referrer"
              style={{ maxWidth: "240px", maxHeight: "240px", borderRadius: "4px" }}
            />
          </div>
        )}

        <div className="comment-actions" style={{ alignItems: "center" }}>
          <span className="likes">👍 {comment.likes || 0}</span>
          {childCount > 0 && (!comment.preview_replies || comment.preview_replies.length === 0 || expanded) && (
            <button
              type="button"
              onClick={toggleExpand}
              className="text-blue-500 hover:text-blue-600 cursor-pointer text-sm"
              style={{
                background: "none",
                border: "none",
                padding: 0,
                color: "var(--zhihu-blue)",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "4px"
              }}
            >
              {loading ? (
                <>
                  <svg
                    className="animate-spin"
                    style={{
                      width: 14,
                      height: 14,
                      animation: "spin 1s linear infinite",
                      display: "inline-block"
                    }}
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" strokeOpacity="0.25" />
                    <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span>加载中…</span>
                </>
              ) : expanded ? (
                `收起回复 (${childCount})`
              ) : (
                `展开 ${childCount} 条回复`
              )}
            </button>
          )}
        </div>

        {/* 未展开时的知乎 App 风格楼中楼预览框 */}
        {!expanded && childCount > 0 && comment.preview_replies && comment.preview_replies.length > 0 && (
          <div
            className="bg-gray-50 rounded-lg"
            style={{
              marginTop: 8,
              padding: "8px 12px",
              backgroundColor: "var(--zhihu-border-light)",
              borderRadius: 6,
              fontSize: 13,
              lineHeight: 1.6
            }}
          >
            {comment.preview_replies.map(reply => (
              <div key={reply.id} style={{ margin: "3px 0" }}>
                <span style={{ fontWeight: 600 }}>{reply.author || "匿名"}</span>
                {reply.isAuthor && <span className="comment-badge" style={{ marginLeft: 4 }}>作者</span>}
                {reply.beReplied && (
                  <span style={{ color: "var(--zhihu-meta)", margin: "0 2px" }}>
                    {" "}回复 @{reply.beReplied}
                  </span>
                )}
                <span>：</span>
                <span dangerouslySetInnerHTML={{ __html: sanitizeHtml(reply.content) }} />
              </div>
            ))}
            <div style={{ marginTop: 6 }}>
              <button
                type="button"
                onClick={toggleExpand}
                className="text-blue-500 hover:text-blue-600 cursor-pointer text-sm"
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  color: "var(--zhihu-blue)",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px"
                }}
              >
                {loading ? (
                  <>
                    <svg
                      className="animate-spin"
                      style={{
                        width: 14,
                        height: 14,
                        animation: "spin 1s linear infinite",
                        display: "inline-block"
                      }}
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" strokeOpacity="0.25" />
                      <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span>加载中…</span>
                  </>
                ) : childCount > comment.preview_replies.length ? (
                  `查看全部 ${childCount} 条回复`
                ) : (
                  `展开 ${childCount} 条回复`
                )}
              </button>
            </div>
          </div>
        )}

        {/* 展开的子评论列表 */}
        {expanded && (
          <div
            className="bg-gray-50 rounded-lg"
            style={{
              marginTop: 10,
              padding: "10px 14px",
              backgroundColor: "var(--zhihu-border-light)",
              borderRadius: 6
            }}
          >
            {loading && children.length === 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--zhihu-meta)" }}>
                <svg
                  style={{
                    width: 14,
                    height: 14,
                    animation: "spin 1s linear infinite",
                    display: "inline-block"
                  }}
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" strokeOpacity="0.25" />
                  <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                正在加载回复…
              </div>
            )}

            {loadError && (
              <div style={{ fontSize: 13, color: "var(--zhihu-red)" }}>
                {loadError}
                <button
                  type="button"
                  onClick={loadChildren}
                  style={{ marginLeft: 8, color: "var(--zhihu-blue)", background: "none", border: "none", cursor: "pointer" }}
                >
                  重试
                </button>
              </div>
            )}

            {!loading && children.length === 0 && !loadError && (
              <div style={{ fontSize: 13, color: "var(--zhihu-meta)" }}>暂无子回复</div>
            )}

            {children.slice(0, visibleChildCount).map(child => (
              <div
                id={`comment-${child.id}`}
                key={child.id}
                style={{
                  display: "flex",
                  gap: 10,
                  padding: "8px 0",
                  borderBottom: "1px solid rgba(0, 0, 0, 0.05)"
                }}
              >
                {child.authorAvatar ? (
                  <img
                    className="comment-avatar"
                    src={child.authorAvatar}
                    alt=""
                    referrerPolicy="no-referrer"
                    style={{ width: 24, height: 24 }}
                  />
                ) : (
                  <div
                    className="comment-avatar-placeholder"
                    style={{ width: 24, height: 24, fontSize: 11 }}
                  >
                    ?
                  </div>
                )}
                <div className="comment-body">
                  <div className="comment-head" style={{ fontSize: 13 }}>
                    <span className="name">{child.author || "匿名"}</span>
                    {child.isAuthor && <span className="comment-badge">答主</span>}
                    <span className="time">{fmtTime(child.time)}</span>
                    {child.location && <span className="loc">IP 属地 {child.location}</span>}
                  </div>
                  {child.beReplied && (
                    <div className="comment-reply-to" style={{ fontSize: 12 }}>
                      回复 <strong>@{child.beReplied}</strong>
                    </div>
                  )}
                  <div
                    className="comment-content"
                    style={{ fontSize: 14, margin: "4px 0" }}
                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(child.content) }}
                  />
                  {(() => {
                    const childImg = child.img_url || child.img;
                    return childImg ? (
                      <div style={{ margin: "4px 0" }}>
                        <img
                          src={childImg}
                          alt=""
                          referrerPolicy="no-referrer"
                          style={{ maxWidth: "200px", maxHeight: "200px", borderRadius: "4px" }}
                        />
                      </div>
                    ) : null;
                  })()}
                  <div className="comment-actions" style={{ fontSize: 12 }}>
                    <span className="likes">👍 {child.likes || 0}</span>
                  </div>
                </div>
              </div>
            ))}

            {/* 分批加载：默认只显示前 5 条，剩余可继续展开 */}
            {visibleChildCount < children.length && (
              <div style={{ textAlign: "center", paddingTop: 8 }}>
                <button
                  type="button"
                  onClick={() => setVisibleChildCount(v => v + CHILD_LOAD_STEP)}
                  style={{
                    background: "none",
                    border: "none",
                    padding: "4px 8px",
                    color: "var(--zhihu-blue)",
                    cursor: "pointer",
                    fontSize: 13
                  }}
                >
                  加载更多回复（还剩 {children.length - visibleChildCount} 条）
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function CommentTree({ comments: initialComments, contentPk = "", initialHasMore }: CommentTreeProps) {
  // 5. 向后兼容检测：如果数组元素有 parent_comment_id 字段，走旧的扁平 DFS 树形渲染
  const isLegacy = useMemo(() => {
    if (initialComments.length === 0) return false;
    const first: any = initialComments[0];
    return "parent_comment_id" in first;
  }, [initialComments]);

  if (isLegacy) {
    return <LegacyCommentTreeView comments={initialComments as LegacyCommentItem[]} />;
  }

  return (
    <RootCommentList
      initialComments={initialComments as RootComment[]}
      contentPk={contentPk}
      initialHasMore={initialHasMore}
    />
  );
}

function RootCommentList({
  initialComments,
  contentPk,
  initialHasMore
}: {
  initialComments: RootComment[];
  contentPk: string;
  initialHasMore?: boolean;
}) {
  const [rootComments, setRootComments] = useState<RootComment[]>(initialComments);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(
    initialHasMore !== undefined ? initialHasMore : initialComments.length >= 20
  );
  const [offset, setOffset] = useState(initialComments.length);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    setRootComments(initialComments);
    setOffset(initialComments.length);
    setHasMore(initialHasMore !== undefined ? initialHasMore : initialComments.length >= 20);
    setLoadError("");
    setLoadingMore(false);
  }, [initialComments, initialHasMore]);

  const resolvedPk = contentPk || (rootComments[0]?.content_pk ?? "");
  // 异步返回后要拿最新的 pk 比对，闭包里的 resolvedPk 永远是发起时的旧值
  const resolvedPkRef = useRef(resolvedPk);
  resolvedPkRef.current = resolvedPk;

  const handleLoadMore = async () => {
    if (loadingMore || !resolvedPk) return;
    const reqPk = resolvedPk;
    setLoadingMore(true);
    setLoadError("");
    try {
      const limit = 20;
      const res = await fetchRootComments(reqPk, { limit, offset });
      if (reqPk !== resolvedPkRef.current) return;
      const newItems: RootComment[] = res.data || [];
      setRootComments(prev => [...prev, ...newItems]);
      setOffset(prev => prev + newItems.length);
      if (newItems.length < limit) {
        setHasMore(false);
      }
    } catch (e: any) {
      if (reqPk !== resolvedPkRef.current) return;
      setLoadError(e?.message || "加载更多评论失败");
    } finally {
      if (reqPk === resolvedPkRef.current) {
        setLoadingMore(false);
      }
    }
  };

  return (
    <div>
      {rootComments.map(c => (
        <RootCommentItemView key={c.id} comment={c} contentPk={resolvedPk} />
      ))}

      {rootComments.length === 0 && (
        <p className="empty-state">暂无评论</p>
      )}

      {hasMore && (
        <div style={{ textAlign: "center", padding: "16px 0" }}>
          <button
            type="button"
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="btn-ghost"
            style={{
              cursor: loadingMore ? "not-allowed" : "pointer",
              padding: "8px 20px",
              borderRadius: "4px",
              border: "1px solid var(--zhihu-border)",
              background: "var(--zhihu-card)",
              color: "var(--zhihu-blue)",
              fontSize: "14px",
              fontWeight: 500,
              display: "inline-flex",
              alignItems: "center",
              gap: "6px"
            }}
          >
            {loadingMore ? (
              <>
                <svg
                  style={{
                    width: 14,
                    height: 14,
                    animation: "spin 1s linear infinite",
                    display: "inline-block"
                  }}
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" strokeOpacity="0.25" />
                  <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span>正在加载…</span>
              </>
            ) : (
              "加载更多评论"
            )}
          </button>
          {loadError && (
            <div style={{ fontSize: 13, color: "var(--zhihu-red)", marginTop: 6 }}>
              {loadError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
