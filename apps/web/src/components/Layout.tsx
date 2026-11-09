import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useState, useCallback, useEffect, type FormEvent } from "react";

export default function Layout({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState("");
  const [searchKw, setSearchKw] = useState("");
  const navigate = useNavigate();
  const location = useLocation();

  // 顶部搜索框跟随内容页 URL：内容页内搜索回写 ?q= 时这里同步显示，
  // 浏览器前进/后退切换关键词时输入框也不会残留旧值
  useEffect(() => {
    if (location.pathname === "/contents") {
      setSearchKw(new URLSearchParams(location.search).get("q") || "");
    }
  }, [location.pathname, location.search]);

  const submitSearch = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const kw = searchKw.trim();
    navigate(kw ? `/contents?q=${encodeURIComponent(kw)}` : "/contents");
  };

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2600);
  }, []);

  const trigger = (path: string, label: string) => {
    // /api/sync/* 已加 Bearer 鉴权：浏览器不该持有 API_SECRET。
    // 抓取由 Cloudflare Cron 定时触发 Apify，也可去 Apify 控制台手动 Run。
    void path;
    notify(`${label}：已改为 Apify 定时同步，可去 Apify 控制台手动运行`);
  };

  return (
    <div className="layout">
      <header className="zhihu-header">
        <div className="zhihu-header-inner">
          <h1 className="zhihu-logo">
            知乎<span>备份</span>
          </h1>
          <nav className="zhihu-nav">
            <NavLink to="/" end className={({ isActive }) => isActive ? "active" : ""}>概览</NavLink>
            <NavLink to="/recommend" className={({ isActive }) => isActive ? "active" : ""}>推荐</NavLink>
            <NavLink to="/contents" className={({ isActive }) => isActive ? "active" : ""}>内容</NavLink>
            <NavLink to="/collections" className={({ isActive }) => isActive ? "active" : ""}>收藏夹</NavLink>
            <NavLink to="/questions" className={({ isActive }) => isActive ? "active" : ""}>问题</NavLink>
            <NavLink to="/following" className={({ isActive }) => isActive ? "active" : ""}>关注</NavLink>
            <NavLink to="/changes" className={({ isActive }) => isActive ? "active" : ""}>变更</NavLink>
            <NavLink to="/settings" className={({ isActive }) => isActive ? "active" : ""}>设置</NavLink>
          </nav>
          <form className="header-search" role="search" onSubmit={submitSearch}>
            <input
              type="search"
              className="header-search-input"
              value={searchKw}
              onChange={e => setSearchKw(e.target.value)}
              placeholder="搜索知乎内容"
              aria-label="全站搜索"
            />
            <button type="submit" className="header-search-btn" aria-label="搜索">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
            </button>
          </form>
          <div className="header-actions">
            <div className="sync-dropdown">
              <button className="btn-secondary">⚡ 快速同步 ▾</button>
              <div className="sync-dropdown-content">
                <button onClick={() => trigger("/api/sync/fast?target=all", "🚀 全部快速同步")}>全部</button>
                <button onClick={() => trigger("/api/sync/fast?target=answers", "🚀 我的回答快速同步")}>我的回答</button>
                <button onClick={() => trigger("/api/sync/fast?target=upvotes", "🚀 赞同内容快速同步")}>赞同内容</button>
                <button onClick={() => trigger("/api/sync/fast?target=collections", "🚀 收藏夹快速同步")}>收藏夹</button>
              </div>
            </div>
            <div className="sync-dropdown">
              <button className="btn-primary">🔄 全量扫描 ▾</button>
              <div className="sync-dropdown-content">
                <button onClick={() => trigger("/api/sync/full?target=all", "📦 全部全量扫描")}>全部</button>
                <button onClick={() => trigger("/api/sync/full?target=answers", "📦 我的回答全量扫描")}>我的回答</button>
                <button onClick={() => trigger("/api/sync/full?target=upvotes", "📦 赞同内容全量扫描")}>赞同内容</button>
                <button onClick={() => trigger("/api/sync/full?target=collections", "📦 收藏夹全量扫描")}>收藏夹</button>
              </div>
            </div>
          </div>
        </div>
      </header>
      <main className="zhihu-main">
        <div className="zhihu-content-wrapper">
          {children}
        </div>
      </main>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
