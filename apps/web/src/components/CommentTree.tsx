import { useState, useEffect, useMemo } from "react";
import { sanitizeHtml } from "../lib/sanitize.js";

type CommentItem = {
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

export default function CommentTree({ comments }: { comments: CommentItem[] }) {
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
    const map = new Map<string | null, CommentItem[]>();
    for (const c of comments) {
      const key = c.parent_comment_id || null;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    
    const result: { item: CommentItem, depth: number }[] = [];
    function traverse(parentId: string | null, depth: number) {
      const list = map.get(parentId) || [];
      for (const item of list) {
        result.push({ item, depth });
        traverse(item.id, depth + 1);
      }
    }
    traverse(null, 0);
    // 父评论不在集合中的孤儿评论：挂到末尾，避免丢失
    const inTree = new Set(result.map(r => r.item.id));
    for (const c of comments) {
      if (!inTree.has(c.id)) result.push({ item: c, depth: 0 });
    }
    return result;
  }, [comments]);

  const fmtTime = (t?: string) => {
    if (!t) return "";
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
  };

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
