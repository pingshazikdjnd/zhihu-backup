import { useEffect, useState, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { allCollectionsStore } from "../lib/store.js";

const stripHtml = (html: string) => html ? html.replace(/<[^>]+>/g, '').substring(0, 150) + '...' : '';

export default function CollectionsPage() {
  const [activeTab, setActiveTab] = useState<"collections" | "items">(allCollectionsStore.activeTab);
  
  const [collections, setCollections] = useState<any[]>(allCollectionsStore.collections);
  const [items, setItems] = useState<any[]>(allCollectionsStore.items);
  const [itemsPage, setItemsPage] = useState(allCollectionsStore.itemsPage);
  const [hasMoreItems, setHasMoreItems] = useState(allCollectionsStore.hasMoreItems);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const observer = useRef<IntersectionObserver | null>(null);

  // Scroll restoration
  useEffect(() => {
    if (allCollectionsStore.scrollPosition > 0) {
      setTimeout(() => window.scrollTo(0, allCollectionsStore.scrollPosition), 0);
    }
    const handleScroll = () => {
      allCollectionsStore.scrollPosition = window.scrollY;
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    allCollectionsStore.activeTab = activeTab;
  }, [activeTab]);

  useEffect(() => {
    if (collections.length === 0) {
      api<{ data: any[] }>("/api/collections")
        .then(res => {
          setCollections(res.data);
          allCollectionsStore.collections = res.data;
        })
        .catch(e => setError(e?.message || "收藏夹列表加载失败"));
    }
  }, []);

  const fetchItems = async (page: number) => {
    setIsLoading(true);
    setError("");
    try {
      const res = await api<{ data: any[] }>(`/api/collections/items?page=${page}`);

      if (res.data.length < 50) {
        setHasMoreItems(false);
        allCollectionsStore.hasMoreItems = false;
      }

      setItems(prev => {
        const next = page === 1 ? res.data : [...prev, ...res.data];
        allCollectionsStore.items = next;
        return next;
      });
      setItemsPage(page);
      allCollectionsStore.itemsPage = page;
    } catch (e: any) {
      setError(e?.message || "收藏条目加载失败");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === "items" && items.length === 0) {
      fetchItems(1);
    }
  }, [activeTab]);

  const lastElementRef = useCallback((node: HTMLAnchorElement) => {
    if (isLoading) return;
    if (observer.current) observer.current.disconnect();
    observer.current = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMoreItems) {
        fetchItems(itemsPage + 1);
      }
    });
    if (node) observer.current.observe(node);
  }, [isLoading, hasMoreItems, itemsPage]);

  const fmtNum = (n: any) => {
    const num = Number(n) || 0;
    if (num >= 10000) return (num / 10000).toFixed(1).replace(/\.0$/, "") + " 万";
    return String(num);
  };

  return (
    <div>
      {error && (
        <div className="card" style={{ color: "#dc2626", fontSize: 14 }}>
          {error}
        </div>
      )}
      <div className="tab-bar">
        <button 
          className={`tab ${activeTab === "collections" ? "active" : ""}`}
          onClick={() => setActiveTab("collections")} 
        >
          按收藏夹
        </button>
        <button 
          className={`tab ${activeTab === "items" ? "active" : ""}`}
          onClick={() => setActiveTab("items")} 
        >
          按内容
        </button>
      </div>

      <div className="cards">
        {activeTab === "collections" && collections.map(item => (
          <Link className="card" key={item.id} to={`/collections/${item.id}`}>
            <h3>{item.title}</h3>
            <p style={{ color: "var(--zhihu-meta)", fontSize: 14, margin: "4px 0 0" }}>
              {item.updated_time ? `最后更新：${new Date(item.updated_time).toLocaleDateString()}` : `收录于：${new Date(item.last_seen_at).toLocaleDateString()}`}
            </p>
          </Link>
        ))}

        {activeTab === "items" && items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <Link 
              className="card" 
              key={`${item.id}-${index}`} 
              to={`/contents/${encodeURIComponent(item.content_pk)}`}
              ref={isLast ? lastElementRef : null}
            >
              {item.author_name && (
                <div className="card-author">
                  {item.author_avatar && <img src={item.author_avatar} alt="" referrerPolicy="no-referrer" />}
                  <span className="author-name">{item.author_name}</span>
                </div>
              )}
              <h3>{item.title || item.content_pk}</h3>
              {item.excerpt && <p className="card-excerpt">{stripHtml(item.excerpt)}</p>}
              
              <div className="card-footer">
                <span className="stat" style={{ color: "var(--zhihu-blue)", background: "var(--zhihu-blue-bg)", borderRadius: 4, padding: "2px 10px", fontWeight: 500 }}>
                  ▲ 赞同 <span className="stat-num">{fmtNum(item.voteup_count)}</span>
                </span>
                <span className="stat">💬 <span className="stat-num">{fmtNum(item.comment_count)}</span> 条评论</span>
                <span className="stat">⭐ <span className="stat-num">{fmtNum(item.favorite_count)}</span></span>
                {Number(item.visit_count) > 0 && <span className="stat">👁 <span className="stat-num">{fmtNum(item.visit_count)}</span></span>}
                <span className="stat">{item.source_type === "answer" ? "回答" : item.source_type === "article" ? "文章" : item.source_type}</span>
                <span className="footer-right">收藏于 {new Date(item.created_time).toLocaleDateString()}</span>
              </div>
            </Link>
          );
        })}

        {activeTab === "items" && isLoading && <p className="loading-state">加载中...</p>}
        {activeTab === "items" && !isLoading && items.length === 0 && <p className="empty-state">这里空空如也~</p>}
        {activeTab === "collections" && collections.length === 0 && <p className="empty-state">还没有追踪任何收藏夹</p>}
      </div>
    </div>
  );
}
