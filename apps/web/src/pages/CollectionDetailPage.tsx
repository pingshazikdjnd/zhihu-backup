import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { collectionsStore } from "../lib/store.js";

const stripHtml = (html: string) => html ? html.replace(/<[^>]+>/g, '').substring(0, 150) + '...' : '';

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN", { hour12: false });
};

const fmtNum = (n: any) => {
  const num = Number(n) || 0;
  if (num >= 10000) return (num / 10000).toFixed(1).replace(/\.0$/, "") + " 万";
  return String(num);
};

type CollectionItem = {
  id: number;
  content_pk: string;
  is_removed?: number;
  voteup_count?: number | null;
  last_seen_at?: string | null;
  first_seen_at?: string | null;
  author_name?: string | null;
  author_avatar?: string | null;
  title?: string | null;
  excerpt?: string | null;
  comment_count?: number | null;
  favorite_count?: number | null;
  visit_count?: number | null;
  source_type?: string | null;
};

export default function CollectionDetailPage() {
  const { id = "" } = useParams();
  // 用 key 让 id 变化时整页状态重建：A 收藏夹的 detail 不会短暂出现在 B 的 URL 下，
  // 也不会因内部 detail 非空而跳过 B 的请求。
  return <CollectionDetail key={id} id={id} />;
}

function CollectionDetail({ id }: { id: string }) {
  const cached = collectionsStore[id] || { data: null, scrollPosition: 0, visibleCount: 50 };
  
  const [detail, setDetail] = useState<any>(cached.data);
  const [loadError, setLoadError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const [visibleCount, setVisibleCount] = useState(cached.visibleCount);
  const [sortBy, setSortBy] = useState<"time" | "vote">("time");

  const timeValue = (item: CollectionItem): number => {
    const raw = item.last_seen_at || item.first_seen_at || "";
    const t = new Date(raw).getTime();
    return Number.isNaN(t) ? 0 : t;
  };

  // 详情接口按 is_removed ASC, last_seen_at DESC 返回；排序只在前端同一份数据上做，
  // 已移除条目始终沉底，组内再按时间或赞数降序
  const rawItems: CollectionItem[] = Array.isArray(detail?.items) ? detail.items : [];
  const sortedItems = [...rawItems].sort((a: CollectionItem, b: CollectionItem) => {
    const removedDiff = (a.is_removed ? 1 : 0) - (b.is_removed ? 1 : 0);
    if (removedDiff !== 0) return removedDiff;
    if (sortBy === "vote") {
      const voteDiff = (Number(b.voteup_count) || 0) - (Number(a.voteup_count) || 0);
      if (voteDiff !== 0) return voteDiff;
    }
    return timeValue(b) - timeValue(a);
  });

  const handleSortChange = (nextSort: "time" | "vote") => {
    if (nextSort === sortBy) return;
    setSortBy(nextSort);
    setVisibleCount(50);
    if (collectionsStore[id]) collectionsStore[id].visibleCount = 50;
  };

  useEffect(() => {
    if (!id) return;
    const entry = collectionsStore[id];
    setVisibleCount(entry?.visibleCount ?? 50);
    if (entry?.data) {
      setDetail(entry.data);
      setLoadError("");
      return;
    }
    let alive = true;
    setDetail(null);
    setLoadError("");
    api<{ collection: any; items: any[]; snapshots: any[] }>(`/api/collections/${id}`).then(data => {
      if (!alive) return;
      // Worker 对未知 id 返回 { collection: null, ...}：与网络错误区分开
      if (!data?.collection) {
        setLoadError("收藏夹不存在或已被删除");
        return;
      }
      setDetail(data);
      setLoadError("");
      setVisibleCount(50);
      // 只写闭包里的这个 id，旧请求回包不能写进当前 URL 对应的收藏夹
      collectionsStore[id] = { data, scrollPosition: 0, visibleCount: 50 };
    }).catch((e: any) => {
      if (!alive) return;
      setLoadError(e?.message || "收藏夹加载失败");
    });
    return () => { alive = false; };
  }, [id, retryKey]);

  useEffect(() => {
    if (cached.scrollPosition > 0 && detail) {
      setTimeout(() => window.scrollTo(0, cached.scrollPosition), 0);
    }
    const handleScroll = () => {
      if (collectionsStore[id]) {
        collectionsStore[id].scrollPosition = window.scrollY;
      }
      if (window.innerHeight + document.documentElement.scrollTop >= document.documentElement.offsetHeight - 800) {
        setVisibleCount(v => {
          const next = Math.min(v + 20, detail?.items?.length || 0);
          if (collectionsStore[id]) collectionsStore[id].visibleCount = next;
          return next;
        });
      }
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [id, detail?.items?.length]);

  if (!detail?.collection) {
    if (loadError) {
      return (
        <div className="loading-state">
          <p style={{ marginBottom: 12 }}>{loadError}</p>
          <button
            onClick={() => { setLoadError(""); setRetryKey(k => k + 1); }}
            style={{ padding: "8px 20px", border: "none", borderRadius: 6, background: "var(--zhihu-blue)", color: "#fff", cursor: "pointer" }}
          >
            重试
          </button>
        </div>
      );
    }
    return <div className="loading-state">加载中...</div>;
  }

  return (
    <>
      <button className="back-fab" onClick={() => window.history.back()}>
        ← <span>返回</span>
      </button>

      <div className="card" style={{ marginBottom: 10 }}>
        <h1 className="question-title" style={{ marginBottom: 4 }}>{detail.collection.title}</h1>
        <p style={{ color: "var(--zhihu-meta)", fontSize: 14, margin: 0 }}>
          共 {detail.items.filter((i: any) => !i.is_removed).length} 个条目在收藏夹中
          {detail.items.some((i: any) => i.is_removed) && ` · ${detail.items.filter((i: any) => i.is_removed).length} 条已被移除`}
        </p>
        <div className="detail-sort-bar">
          <span className="detail-sort-label">排序</span>
          <button
            className={`sort-chip ${sortBy === "time" ? "active" : ""}`}
            onClick={() => handleSortChange("time")}
            aria-pressed={sortBy === "time"}
          >
            最新
          </button>
          <button
            className={`sort-chip ${sortBy === "vote" ? "active" : ""}`}
            onClick={() => handleSortChange("vote")}
            aria-pressed={sortBy === "vote"}
          >
            赞数最多
          </button>
        </div>
      </div>

      <div className="cards">
        {sortedItems.slice(0, visibleCount).map((item: CollectionItem) => (
          <Link className="card" key={item.id} to={`/contents/${encodeURIComponent(item.content_pk)}`}>
            {item.author_name && (
              <div className="card-author">
                {item.author_avatar && <img src={item.author_avatar} alt="" referrerPolicy="no-referrer" />}
                <span className="author-name">{item.author_name}</span>
                {item.is_removed ? (
                  <span className="detail-tag red">已移除</span>
                ) : (
                  <span className="detail-tag" style={{ background: "rgba(46,125,50,0.08)", color: "#2e7d32" }}>仍在收藏夹</span>
                )}
              </div>
            )}
            <h3>{item.title || item.content_pk}</h3>
            {item.excerpt && <p className="card-excerpt">{stripHtml(item.excerpt)}</p>}
            <div className="card-footer">
              <span className="stat" style={{ color: "var(--zhihu-blue)", background: "var(--zhihu-blue-bg)", borderRadius: 4, padding: "2px 10px", fontWeight: 500 }}>
                ▲ 赞同 <span className="stat-num">{fmtNum(item.voteup_count)}</span>
              </span>
              <span className="stat">💬 <span className="stat-num">{fmtNum(item.comment_count)}</span> 条评论</span>
              {Number(item.favorite_count) > 0 && <span className="stat">⭐ <span className="stat-num">{fmtNum(item.favorite_count)}</span></span>}
              {Number(item.visit_count) > 0 && <span className="stat">👁 <span className="stat-num">{fmtNum(item.visit_count)}</span></span>}
              <span className="stat">{item.source_type === "answer" ? "回答" : item.source_type === "article" ? "文章" : item.source_type}</span>
            </div>
          </Link>
        ))}
      </div>
      {visibleCount < detail.items.length && (
        <div className="loading-state">向下滑动加载更多...</div>
      )}

      {detail.snapshots && detail.snapshots.length > 0 && (
        <div className="card" style={{ marginTop: 10 }}>
          <h2 style={{ fontSize: 18, margin: "0 0 12px" }}>快照</h2>
          <ul className="version-list">
            {detail.snapshots.map((s: any) => (
              <li key={s.id}>
                {fmtTime(s.snapshot_at)} · 共 {s.item_count} 项 · <span style={{ color: "#2e7d32" }}>+{s.added_count}</span> / <span style={{ color: "var(--zhihu-red)" }}>-{s.removed_count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
