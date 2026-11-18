import { useEffect, useState, useRef, useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { contentsStore } from "../lib/store.js";

const stripHtml = (html: string) => html ? html.replace(/<[^>]+>/g, '').substring(0, 150) + '...' : '';

export default function ContentsPage() {
  const [activeTab, setActiveTab] = useState<"answers" | "upvotes">(contentsStore.activeTab);
  const [sortBy, setSortBy] = useState<"time" | "vote">(contentsStore.sortBy);

  const [searchParams, setSearchParams] = useSearchParams();
  const urlQ = searchParams.get("q") ?? "";
  // 记录本页自己写进 URL 的关键词：只有外部（顶部搜索框/前进后退）带来的 ?q= 才回灌输入框，
  // 否则用户输入中的空格会被 trim 后的 URL 值反向吞掉
  const lastWrittenQRef = useRef<string | null>(null);

  // Data caching
  const [answersData, setAnswersData] = useState<any[]>(contentsStore.answersData);
  const [upvotesData, setUpvotesData] = useState<any[]>(contentsStore.upvotesData);
  
  const [answersPage, setAnswersPage] = useState(contentsStore.answersPage);
  const [upvotesPage, setUpvotesPage] = useState(contentsStore.upvotesPage);
  
  const [hasMoreAnswers, setHasMoreAnswers] = useState(contentsStore.hasMoreAnswers);
  const [hasMoreUpvotes, setHasMoreUpvotes] = useState(contentsStore.hasMoreUpvotes);
  
  // 列表与搜索各自独立的 loading：搜索请求结束不能把列表的“加载更多”状态提前清掉
  const [listLoading, setListLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [error, setError] = useState("");
  const observer = useRef<IntersectionObserver | null>(null);
  // answers/upvotes 各自独立序号；所有异步回包先校验序号与当前 tab，旧排序/旧分页不得追加进新列表
  const answersReqRef = useRef(0);
  const upvotesReqRef = useRef(0);
  const activeTabRef = useRef<"answers" | "upvotes">(activeTab);
  // 记录在途的列表页 key（tab:page:sort），防止 IntersectionObserver 在 React 重渲染前重复发起同一页
  const inFlightRef = useRef<string | null>(null);

  // 全文搜索（命中标题/问题标题/正文纯文本）
  const [keyword, setKeyword] = useState(urlQ);
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchError, setSearchError] = useState("");
  const [answersTotal, setAnswersTotal] = useState<number | null>(contentsStore.answersTotal);
  const searchSeqRef = useRef(0);

  useEffect(() => () => {
    answersReqRef.current++;
    upvotesReqRef.current++;
  }, []);

  // 顶部搜索框提交 / 浏览器前进后退导致 ?q= 变化时，同步到页内 keyword 触发搜索。
  // 本页自己回写的 URL 直接跳过，避免与输入框状态互相覆盖
  useEffect(() => {
    if (lastWrittenQRef.current === urlQ) return;
    lastWrittenQRef.current = urlQ;
    setKeyword(urlQ);
  }, [urlQ]);

  // 页内搜索框修改/清空时同步回写 URL（replace 不污染历史）。
  // 直接写在输入回调里而不是 effect 里：否则外部 ?q= 导航时，
  // 旧 keyword 的写回收尾 effect 会把刚导航来的新关键词又覆盖回去
  const applyKeyword = useCallback((value: string) => {
    setKeyword(value);
    const next = value.trim();
    if ((searchParams.get("q") ?? "") === next) return;
    const params = new URLSearchParams(searchParams);
    if (next) params.set("q", next);
    else params.delete("q");
    lastWrittenQRef.current = next;
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    const kw = keyword.trim();
    // 每次输入变化（含清空）都作废上一轮搜索，避免慢请求回包覆盖新关键字的结果
    const seq = ++searchSeqRef.current;
    setSearchError("");
    if (!kw) {
      setSearchResults(null);
      // 清空关键字会作废在途请求，它回包后不会再清搜索 loading，这里主动收尾
      setSearchLoading(false);
      return;
    }
    const timer = setTimeout(async () => {
      setSearchLoading(true);
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
      } finally {
        // 只结束自己这一轮搜索，绝不触碰列表 loading
        if (seq === searchSeqRef.current) setSearchLoading(false);
      }
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
    activeTabRef.current = activeTab;
    contentsStore.activeTab = activeTab;
  }, [activeTab]);

  useEffect(() => {
    contentsStore.sortBy = sortBy;
  }, [sortBy]);

  const requestKey = (tab: "answers" | "upvotes", page: number, sort: "time" | "vote") =>
    `${tab}:${page}:${sort}`;

  // 回包是否仍属于当前 tab 的这一轮请求：序号被更新的请求或切 tab 作废时返回 false
  const isCurrentRequest = (seq: number, ref: { current: number }, tab: "answers" | "upvotes") =>
    seq === ref.current && activeTabRef.current === tab;

  const fetchAnswers = async (page: number, sort = sortBy) => {
    const seq = ++answersReqRef.current;
    inFlightRef.current = requestKey("answers", page, sort);
    setListLoading(true);
    setError("");
    try {
      // 直接由服务端按 Worker 的 ZHIHU_USERNAME 精准过滤本人创作（回答 + 专栏文章），
      // 不再因未配置前端 VITE_ZHIHU_USERNAME 而把收藏夹/关注答主的他人回答混进来
      const envAuthor = (import.meta.env.VITE_ZHIHU_USERNAME as string | undefined) || "";
      const authorQuery = envAuthor ? `&author=${encodeURIComponent(envAuthor)}` : "&mine=1";
      const res = await api<{ data: any[]; total?: number }>(`/api/contents?page=${page}${authorQuery}&sort=${sort}`);
      if (!isCurrentRequest(seq, answersReqRef, "answers")) return;
      const myAnswers = res.data;

      if (typeof res.total === "number") {
        setAnswersTotal(res.total);
        contentsStore.answersTotal = res.total;
      }

      if (res.data.length < 50) {
        setHasMoreAnswers(false);
        contentsStore.hasMoreAnswers = false;
      } else {
        setHasMoreAnswers(true);
        contentsStore.hasMoreAnswers = true;
      }

      setAnswersData(prev => {
        if (!isCurrentRequest(seq, answersReqRef, "answers")) return prev;
        const next = page === 1 ? myAnswers : [...prev, ...myAnswers];
        contentsStore.answersData = next;
        return next;
      });

      setAnswersPage(page);
      contentsStore.answersPage = page;
    } catch (e: any) {
      if (!isCurrentRequest(seq, answersReqRef, "answers")) return;
      setError(e?.message || "内容列表加载失败");
    } finally {
      if (isCurrentRequest(seq, answersReqRef, "answers")) {
        inFlightRef.current = null;
        setListLoading(false);
      }
    }
  };

  const fetchUpvotes = async (page: number, sort = sortBy) => {
    const seq = ++upvotesReqRef.current;
    inFlightRef.current = requestKey("upvotes", page, sort);
    setListLoading(true);
    setError("");
    try {
      const res = await api<{ data: any[] }>(`/api/upvotes?page=${page}&sort=${sort}`);
      if (!isCurrentRequest(seq, upvotesReqRef, "upvotes")) return;

      if (res.data.length < 50) {
        setHasMoreUpvotes(false);
        contentsStore.hasMoreUpvotes = false;
      } else {
        setHasMoreUpvotes(true);
        contentsStore.hasMoreUpvotes = true;
      }

      setUpvotesData(prev => {
        if (!isCurrentRequest(seq, upvotesReqRef, "upvotes")) return prev;
        const next = page === 1 ? res.data : [...prev, ...res.data];
        contentsStore.upvotesData = next;
        return next;
      });

      setUpvotesPage(page);
      contentsStore.upvotesPage = page;
    } catch (e: any) {
      if (!isCurrentRequest(seq, upvotesReqRef, "upvotes")) return;
      setError(e?.message || "赞同列表加载失败");
    } finally {
      if (isCurrentRequest(seq, upvotesReqRef, "upvotes")) {
        inFlightRef.current = null;
        setListLoading(false);
      }
    }
  };

  // 切 tab 时作废旧 tab 在途请求，并复位列表 loading，避免旧请求的 finally 永远清不到新 tab
  const handleTabChange = (nextTab: "answers" | "upvotes") => {
    if (nextTab === activeTab) return;
    answersReqRef.current++;
    upvotesReqRef.current++;
    inFlightRef.current = null;
    setListLoading(false);
    setError("");
    activeTabRef.current = nextTab;
    setActiveTab(nextTab);
    contentsStore.activeTab = nextTab;
  };

  const handleSortChange = (nextSort: "time" | "vote") => {
    if (nextSort === sortBy) return;
    setSortBy(nextSort);
    contentsStore.sortBy = nextSort;
    contentsStore.scrollPosition = 0;
    window.scrollTo(0, 0);
    // 两个 tab 的旧排序缓存一起作废并复位，切回另一 tab 时它也会按新排序重新拉第一页
    answersReqRef.current++;
    upvotesReqRef.current++;
    inFlightRef.current = null;
    setAnswersData([]);
    setUpvotesData([]);
    setAnswersPage(1);
    setUpvotesPage(1);
    setHasMoreAnswers(true);
    setHasMoreUpvotes(true);
    contentsStore.answersData = [];
    contentsStore.upvotesData = [];
    contentsStore.answersPage = 1;
    contentsStore.upvotesPage = 1;
    contentsStore.hasMoreAnswers = true;
    contentsStore.hasMoreUpvotes = true;
    setListLoading(false);
    setError("");
    if (activeTab === "answers") {
      fetchAnswers(1, nextSort);
    } else {
      fetchUpvotes(1, nextSort);
    }
  };

  // Initial load（只在切 tab 时触发；搜索输入变化不会误触列表请求）
  useEffect(() => {
    if (activeTab === "answers" && answersData.length === 0) fetchAnswers(1);
    if (activeTab === "upvotes" && upvotesData.length === 0) fetchUpvotes(1);
  }, [activeTab]);

  // Load more trigger
  const lastElementRef = useCallback((node: HTMLAnchorElement | null) => {
    // 节点卸载/切 tab 时断开观察器，避免旧哨兵继续触发请求
    if (!node) {
      observer.current?.disconnect();
      observer.current = null;
      return;
    }
    // 上一次请求失败时不能再挂 observer：否则哨兵元素持续可见，
    // 失败 -> 重挂 -> 再失败，形成无限请求风暴
    if (listLoading || searchLoading || error || keyword.trim()) return;
    if (observer.current) observer.current.disconnect();
    observer.current = new IntersectionObserver(entries => {
      if (!entries[0]?.isIntersecting || listLoading || searchLoading || error || keyword.trim()) return;
      // 页码只在请求成功后由 fetchAnswers/fetchUpvotes 提交。
      // 之前在 setState updater 里 +1 并顺带 fetch：updater 同步执行而
      // 页码回滚只在成功时——一次网络失败就永久跳过那一页（50 条无感丢失），
      // StrictMode 下 updater 双调用还会同页抓两次
      if (activeTab === "answers" && hasMoreAnswers) {
        const nextPage = answersPage + 1;
        if (inFlightRef.current === requestKey("answers", nextPage, sortBy)) return;
        fetchAnswers(nextPage);
      } else if (activeTab === "upvotes" && hasMoreUpvotes) {
        const nextPage = upvotesPage + 1;
        if (inFlightRef.current === requestKey("upvotes", nextPage, sortBy)) return;
        fetchUpvotes(nextPage);
      }
    });
    if (node) observer.current.observe(node);
  }, [listLoading, searchLoading, error, keyword, hasMoreAnswers, hasMoreUpvotes, activeTab, answersPage, upvotesPage, sortBy]);

  const currentItems = searchResults !== null ? searchResults : (activeTab === "answers" ? answersData : upvotesData);
  const sortedItems = currentItems;
  const loadingVisible = searchResults !== null ? searchLoading : listLoading;

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
          <button className={`tab ${activeTab === "answers" ? "active" : ""}`} onClick={() => handleTabChange("answers")}>
            我回答的内容{answersTotal !== null && <span style={{ marginLeft: 6, fontSize: 13, color: "var(--zhihu-meta)", fontWeight: 400 }}>{answersTotal}</span>}
          </button>
          <button className={`tab ${activeTab === "upvotes" ? "active" : ""}`} onClick={() => handleTabChange("upvotes")}>我赞同的内容</button>
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
            onChange={e => applyKeyword(e.target.value)}
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
        {loadingVisible && <p className="loading-state">加载中...</p>}
        {!loadingVisible && sortedItems.length === 0 && !searchError && (
          <p className="empty-state">
            {searchResults !== null ? `没有找到匹配「${keyword}」的内容` : "这里空空如也~"}
          </p>
        )}
      </div>
    </div>
  );
}
