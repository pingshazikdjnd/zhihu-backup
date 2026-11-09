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
  const [sortBy, setSortBy] = useState<"time" | "vote">(allCollectionsStore.sortBy);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const observer = useRef<IntersectionObserver | null>(null);
  // 切换排序会让在途的旧排序分页请求过期，回包后不得再写入列表
  const itemsSeqRef = useRef(0);

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
    allCollectionsStore.sortBy = sortBy;
  }, [sortBy]);

  const loadCollections = () => {
    api<{ data: any[] }>("/api/collections")
      .then(res => {
        setCollections(res.data);
        allCollectionsStore.collections = res.data;
      })
      .catch(e => setError(e?.message || "收藏夹列表加载失败"));
  };

  useEffect(() => {
    if (collections.length === 0) {
      loadCollections();
    }
  }, []);

  const fetchItems = async (page: number, sort: "time" | "vote" = sortBy) => {
    const seq = ++itemsSeqRef.current;
    setIsLoading(true);
    setError("");
    try {
      const res = await api<{ data: any[] }>(`/api/collections/items?page=${page}&sort=${sort}`);
      if (seq !== itemsSeqRef.current) return;

      if (res.data.length < 50) {
        setHasMoreItems(false);
        allCollectionsStore.hasMoreItems = false;
      } else {
        setHasMoreItems(true);
        allCollectionsStore.hasMoreItems = true;
      }

      setItems(prev => {
        const next = page === 1 ? res.data : [...prev, ...res.data];
        allCollectionsStore.items = next;
        return next;
      });
      setItemsPage(page);
      allCollectionsStore.itemsPage = page;
    } catch (e: any) {
      if (seq === itemsSeqRef.current) setError(e?.message || "收藏条目加载失败");
    } finally {
      if (seq === itemsSeqRef.current) setIsLoading(false);
    }
  };

  // 排序切换：旧排序的已加载分页全部作废，回到第 1 页重新请求
  const handleSortChange = (nextSort: "time" | "vote") => {
    if (nextSort === sortBy) return;
    setSortBy(nextSort);
    setItems([]);
    allCollectionsStore.items = [];
    setItemsPage(1);
    allCollectionsStore.itemsPage = 1;
    setHasMoreItems(true);
    allCollectionsStore.hasMoreItems = true;
    allCollectionsStore.scrollPosition = 0;
    window.scrollTo(0, 0);
    fetchItems(1, nextSort);
  };

  useEffect(() => {
    if (activeTab === "items" && items.length === 0) {
      fetchItems(1);
    }
  }, [activeTab]);

  const lastElementRef = useCallback((node: HTMLElement | null) => {
    // 上一次请求失败时不能再挂 observer：哨兵元素持续可见会形成
    // 失败 -> 重挂 -> 再失败的无限请求风暴
    if (isLoading || error) return;
    if (observer.current) observer.current.disconnect();
    observer.current = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !isLoading && !error && hasMoreItems) {
        fetchItems(itemsPage + 1);
      }
    });
    if (node) observer.current.observe(node);
  }, [isLoading, error, hasMoreItems, itemsPage]);

  const fmtNum = (n: any) => {
    const num = Number(n) || 0;
    if (num >= 10000) return (num / 10000).toFixed(1).replace(/\.0$/, "") + " 万";
    return String(num);
  };

  return (
    <div>
      {error && (
        <div className="card" style={{ color: "#dc2626", fontSize: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span>{error}</span>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setError("");
              if (activeTab === "collections") {
                loadCollections();
              } else {
                fetchItems(items.length === 0 ? 1 : itemsPage + 1);
              }
            }}
          >
            点击重试
          </button>
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
        {activeTab === "items" && (
          <div className="tab-right">
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
        )}
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
          const cardBody = (
            <>
              {item.author_name && (
                <div className="card-author">
                  {item.author_avatar && <img src={item.author_avatar} alt="" referrerPolicy="no-referrer" />}
                  <span className="author-name">{item.author_name}</span>
                </div>
              )}
              <h3>{item.title || item.content_pk || "（内容编号缺失）"}</h3>
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
            </>
          );
          // content_pk 为空时不能拼出 /contents/null，降级成不可点击的普通卡片
          return item.content_pk ? (
            <Link 
              className="card" 
              key={`${item.id}-${index}`} 
              to={`/contents/${encodeURIComponent(item.content_pk)}`}
              ref={isLast ? lastElementRef : null}
            >
              {cardBody}
            </Link>
          ) : (
            <div className="card" key={`${item.id}-${index}`} ref={isLast ? lastElementRef : null}>
              {cardBody}
            </div>
          );
        })}

        {activeTab === "items" && isLoading && <p className="loading-state">加载中...</p>}
        {activeTab === "items" && !isLoading && items.length === 0 && <p className="empty-state">这里空空如也~</p>}
        {activeTab === "collections" && collections.length === 0 && <p className="empty-state">还没有追踪任何收藏夹</p>}
      </div>
    </div>
  );
}
