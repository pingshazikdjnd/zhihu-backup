import { useEffect, useState, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { contentsStore } from "../lib/store.js";

const stripHtml = (html: string) => html ? html.replace(/<[^>]+>/g, '').substring(0, 150) + '...' : '';

export default function ContentsPage() {
  const [activeTab, setActiveTab] = useState<"answers" | "upvotes">(contentsStore.activeTab);
  const [sortBy, setSortBy] = useState<"time" | "vote">(contentsStore.sortBy);
  
  // Data caching
  const [answersData, setAnswersData] = useState<any[]>(contentsStore.answersData);
  const [upvotesData, setUpvotesData] = useState<any[]>(contentsStore.upvotesData);
  
  const [answersPage, setAnswersPage] = useState(contentsStore.answersPage);
  const [upvotesPage, setUpvotesPage] = useState(contentsStore.upvotesPage);
  
  const [hasMoreAnswers, setHasMoreAnswers] = useState(contentsStore.hasMoreAnswers);
  const [hasMoreUpvotes, setHasMoreUpvotes] = useState(contentsStore.hasMoreUpvotes);
  
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const observer = useRef<IntersectionObserver | null>(null);

  // 全文搜索（命中标题/问题标题/正文纯文本）
  const [keyword, setKeyword] = useState("");
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchError, setSearchError] = useState("");
  const [answersTotal, setAnswersTotal] = useState<number | null>(null);
  const searchSeqRef = useRef(0);

  useEffect(() => {
    const kw = keyword.trim();
    // 每次输入变化（含清空）都作废上一轮搜索，避免慢请求回包覆盖新关键字的结果
    const seq = ++searchSeqRef.current;
    setSearchError("");
    if (!kw) {
      setSearchResults(null);
      // 清空关键字会作废在途请求，它回包后不会再清 loading，这里主动收尾
      setIsLoading(false);
      return;
    }
    const timer = setTimeout(async () => {
      setIsLoading(true);
      try {
        const res = await api<{ data: any[]; total?: number }>(`/api/contents?q=${encodeURIComponent(kw)}`);
        if (seq !== searchSeqRef.current) return;
        setSearchResults(res.data);
        setSearchTotal(res.total ?? res.data.length);
      } catch (e: any) {
        if (seq === searchSeqRef.current) {
          setSearchError(e?.message || "搜索请求失败");
          setSearchResults(null);
        }
      }
      if (seq === searchSeqRef.current) setIsLoading(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [keyword]);

  // Scroll position save and restore
  useEffect(() => {
    if (contentsStore.scrollPosition > 0) {
      setTimeout(() => window.scrollTo(0, contentsStore.scrollPosition), 0);
    }
    const handleScroll = () => {
      contentsStore.scrollPosition = window.scrollY;
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    contentsStore.activeTab = activeTab;
  }, [activeTab]);

  useEffect(() => {
    contentsStore.sortBy = sortBy;
  }, [sortBy]);

  const fetchAnswers = async (page: number, sort = sortBy) => {
    setIsLoading(true);
    setError("");
    try {
      // 直接由服务端按 Worker 的 ZHIHU_USERNAME 精准过滤本人创作（回答 + 专栏文章），
      // 不再因未配置前端 VITE_ZHIHU_USERNAME 而把收藏夹/关注答主的他人回答混进来
      const envAuthor = (import.meta.env.VITE_ZHIHU_USERNAME as string | undefined) || "";
      const authorQuery = envAuthor ? `&author=${encodeURIComponent(envAuthor)}` : "&mine=1";
      const res = await api<{ data: any[]; total?: number }>(`/api/contents?page=${page}${authorQuery}&sort=${sort}`);
      const myAnswers = res.data;

      if (typeof res.total === "number") setAnswersTotal(res.total);

      if (res.data.length < 50) {
        setHasMoreAnswers(false);
        contentsStore.hasMoreAnswers = false;
      } else {
        setHasMoreAnswers(true);
        contentsStore.hasMoreAnswers = true;
      }

      setAnswersData(prev => {
        const next = page === 1 ? myAnswers : [...prev, ...myAnswers];
        contentsStore.answersData = next;
        return next;
      });

      setAnswersPage(page);
      contentsStore.answersPage = page;
    } catch (e: any) {
      setError(e?.message || "内容列表加载失败");
    } finally {
      setIsLoading(false);
    }
  };

  const fetchUpvotes = async (page: number, sort = sortBy) => {
    setIsLoading(true);
    setError("");
    try {
      const res = await api<{ data: any[] }>(`/api/upvotes?page=${page}&sort=${sort}`);

      if (res.data.length < 50) {
        setHasMoreUpvotes(false);
        contentsStore.hasMoreUpvotes = false;
      } else {
        setHasMoreUpvotes(true);
        contentsStore.hasMoreUpvotes = true;
      }

      setUpvotesData(prev => {
        const next = page === 1 ? res.data : [...prev, ...res.data];
        contentsStore.upvotesData = next;
        return next;
      });

      setUpvotesPage(page);
      contentsStore.upvotesPage = page;
    } catch (e: any) {
      setError(e?.message || "赞同列表加载失败");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSortChange = (nextSort: "time" | "vote") => {
    if (nextSort === sortBy) return;
    setSortBy(nextSort);
    contentsStore.scrollPosition = 0;
    window.scrollTo(0, 0);
    if (activeTab === "answers") {
      fetchAnswers(1, nextSort);
    } else {
      fetchUpvotes(1, nextSort);
    }
  };

  // Initial load
  useEffect(() => {
    if (activeTab === "answers" && answersData.length === 0) fetchAnswers(1);
    if (activeTab === "upvotes" && upvotesData.length === 0) fetchUpvotes(1);
  }, [activeTab]);

  // Load more trigger
  const lastElementRef = useCallback((node: HTMLAnchorElement) => {
    // 上一次请求失败时不能再挂 observer：否则哨兵元素持续可见，
    // 失败 -> 重挂 -> 再失败，形成无限请求风暴
    if (isLoading || error) return;
    if (observer.current) observer.current.disconnect();
    observer.current = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !isLoading && !error) {
        // 页码只在请求成功后由 fetchAnswers/fetchUpvotes 提交。
        // 之前在 setState updater 里 +1 并顺带 fetch：updater 同步执行而
        // 页码回滚只在成功时——一次网络失败就永久跳过那一页（50 条无感丢失），
        // StrictMode 下 updater 双调用还会同页抓两次
        if (activeTab === "answers" && hasMoreAnswers) {
          fetchAnswers(answersPage + 1);
        } else if (activeTab === "upvotes" && hasMoreUpvotes) {
          fetchUpvotes(upvotesPage + 1);
        }
      }
    });
    if (node) observer.current.observe(node);
  }, [isLoading, error, hasMoreAnswers, hasMoreUpvotes, activeTab, answersPage, upvotesPage]);

  const currentItems = searchResults !== null ? searchResults : (activeTab === "answers" ? answersData : upvotesData);
  const sortedItems = currentItems;

  const parseDateStr = (val: any) => {
    if (!val) return "";
    if (typeof val === "string" && val.includes("T")) {
      const d = new Date(val);
      return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
    }
    const num = Number(val);
    if (Number.isNaN(num)) return "";
    return new Date(num * (num < 10000000000 ? 1000 : 1)).toLocaleDateString();
  };

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
              if (activeTab === "answers") {
                fetchAnswers(answersData.length === 0 ? 1 : answersPage + 1);
              } else {
                fetchUpvotes(upvotesData.length === 0 ? 1 : upvotesPage + 1);
              }
            }}
          >
            点击重试
          </button>
        </div>
      )}
      <div className="tab-bar" style={{ justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 24, height: "100%" }}>
          <button className={`tab ${activeTab === "answers" ? "active" : ""}`} onClick={() => setActiveTab("answers")}>
            我回答的内容{answersTotal !== null && <span style={{ marginLeft: 6, fontSize: 13, color: "var(--zhihu-meta)", fontWeight: 400 }}>{answersTotal}</span>}
          </button>
          <button className={`tab ${activeTab === "upvotes" ? "active" : ""}`} onClick={() => setActiveTab("upvotes")}>我赞同的内容</button>
        </div>
        <div className="tab-right" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {searchResults !== null && (
            <span style={{ fontSize: 13, color: "var(--zhihu-meta)" }}>命中 {searchTotal} 条</span>
          )}
          <button className={`sort-chip ${sortBy === "time" ? "active" : ""}`} onClick={() => handleSortChange("time")} aria-pressed={sortBy === "time"}>最新</button>
          <button className={`sort-chip ${sortBy === "vote" ? "active" : ""}`} onClick={() => handleSortChange("vote")} aria-pressed={sortBy === "vote"}>赞数最多</button>
          <input
            type="search"
            className="search-input"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            placeholder="全文搜索标题与正文…"
          />
        </div>
      </div>

      {searchError && (
        <div className="card" style={{ color: "#dc2626", fontSize: 14 }}>
          搜索失败：{searchError}
        </div>
      )}

      <div className="cards">
        {sortedItems.map((item, index) => {
          const isLast = index === sortedItems.length - 1 && searchResults === null;
          return (
            <Link 
              className="card" 
              key={`${item.pk}-${index}`} 
              to={`/contents/${encodeURIComponent(item.pk)}`}
              ref={isLast ? lastElementRef : null}
            >
              {item.author_name && (
                <div className="card-author">
                  {item.author_avatar && <img src={item.author_avatar} alt="" referrerPolicy="no-referrer" />}
                  <span className="author-name">{item.author_name}</span>
                  {item.author_headline && <span className="author-headline">{item.author_headline}</span>}
                  {item.is_deleted === 1 && <span className="detail-tag red">已删除</span>}
                </div>
              )}
              <h3>{item.title || item.question_title || item.pk}</h3>
              {item.excerpt && <p className="card-excerpt">{stripHtml(item.excerpt)}</p>}
              
              <div className="card-footer">
                <span className="stat" style={{ color: "var(--zhihu-blue)", background: "var(--zhihu-blue-bg)", borderRadius: 4, padding: "2px 10px", fontWeight: 500 }}>
                  ▲ 赞同 <span className="stat-num">{fmtNum(item.voteup_count)}</span>
                </span>
                <span className="stat">💬 <span className="stat-num">{fmtNum(item.comment_count)}</span> 条评论</span>
                <span className="stat">⭐ <span className="stat-num">{fmtNum(item.favorite_count)}</span></span>
                {Number(item.visit_count) > 0 && <span className="stat">👁 <span className="stat-num">{fmtNum(item.visit_count)}</span></span>}
                <span className="stat" style={{ color: "var(--zhihu-meta)" }}>
                  {item.source_type === "answer" ? "回答" : item.source_type === "article" ? "文章" : item.source_type}
                </span>
                <span className="footer-right">
                  {item.upvote_time ? "赞同于 " : (item.updated_time ? "编辑于 " : "")}
                  {item.upvote_time ? parseDateStr(item.upvote_time) : parseDateStr(item.updated_time || item.last_seen_at)}
                </span>
              </div>
            </Link>
          );
        })}
        {isLoading && <p className="loading-state">加载中...</p>}
        {!isLoading && sortedItems.length === 0 && !searchError && (
          <p className="empty-state">
            {searchResults !== null ? `没有找到匹配「${keyword}」的内容` : "这里空空如也~"}
          </p>
        )}
      </div>
    </div>
  );
}
