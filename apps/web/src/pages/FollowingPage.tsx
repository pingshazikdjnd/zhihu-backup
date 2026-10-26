import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { followingStore, recommendStore } from "../lib/store.js";

const fmtNum = (n: any) => {
  const num = Number(n) || 0;
  if (num >= 10000) return (num / 10000).toFixed(1).replace(/\.0$/, "") + " 万";
  return String(num);
};

const fmtDate = (val: any) => {
  if (!val) return "";
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
};

const stripHtml = (html: string) =>
  html ? html.replace(/<[^>]+>/g, "").substring(0, 150) + "..." : "";

function RiskBadges({ item }: { item: any }) {
  if (!item) return null;
  const level = item.risk_level;
  const score = Number(item.risk_score) || 0;
  const tags: string[] = Array.isArray(item.risk_tags) ? item.risk_tags : [];

  return (
    <>
      {level === "high" && (
        <span
          className="detail-tag"
          style={{ background: "rgba(220,38,38,0.1)", color: "#dc2626", fontWeight: 600 }}
        >
          🔴 易和谐 {score}分
        </span>
      )}
      {level === "medium" && (
        <span
          className="detail-tag"
          style={{ background: "rgba(217,119,6,0.12)", color: "#b45309", fontWeight: 500 }}
        >
          🟠 敏感 {score}分
        </span>
      )}
      {tags.slice(0, 2).map((t, i) => (
        <span
          key={i}
          className="detail-tag"
          style={{ background: "rgba(100,116,139,0.1)", color: "#475569" }}
        >
          {t}
        </span>
      ))}
    </>
  );
}

export default function FollowingPage() {
  const { token: routeToken } = useParams();
  if (routeToken) return <FollowedUserDetail key={routeToken} urlToken={routeToken} />;
  return <FollowingHome />;
}

async function postUserModeWithAuth(urlToken: string, syncMode: "default" | "full") {
  let pwd = localStorage.getItem("cookie_write_token") || "";
  const doCall = (tokenStr: string) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (tokenStr.trim()) headers.authorization = `Bearer ${tokenStr.trim()}`;
    return api(`/api/following/users/${encodeURIComponent(urlToken)}/mode`, {
      method: "POST",
      headers,
      body: JSON.stringify({ syncMode })
    });
  };
  try {
    return await doCall(pwd);
  } catch (e: any) {
    if (String(e?.message || "").startsWith("401")) {
      const input = window.prompt("切换全量/精选备份模式需验证操作密码（验证后本浏览器自动记住）：", "");
      if (!input) throw new Error("已取消密码验证");
      const res = await doCall(input.trim());
      localStorage.setItem("cookie_write_token", input.trim());
      return res;
    }
    throw e;
  }
}

function FollowingHome() {
  const [activeTab, setActiveTab] = useState<"users" | "feed" | "risk">(followingStore.activeTab);
  const [users, setUsers] = useState<any[]>(followingStore.users);
  const [summary, setSummary] = useState<any>(followingStore.summary);
  const [userQ, setUserQ] = useState(followingStore.userQ);
  const [modeFilter, setModeFilter] = useState<"" | "full" | "backed">(followingStore.userModeFilter);
  const [feed, setFeed] = useState<any[]>(followingStore.feed);
  const [riskFeed, setRiskFeed] = useState<any[]>(followingStore.riskFeed);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [togglingToken, setTogglingToken] = useState<string | null>(null);
  const [aiResults, setAiResults] = useState<Record<string, any>>(recommendStore.aiCache);
  const [aiLoadingPk, setAiLoadingPk] = useState<string | null>(null);

  useEffect(() => {
    window.scrollTo(0, followingStore.scrollPosition);
    const handleScroll = () => {
      followingStore.scrollPosition = window.scrollY;
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const loadUsers = async (q = userQ, mode = modeFilter) => {
    setLoading(true);
    setError("");
    try {
      const qs = new URLSearchParams();
      if (q.trim()) qs.set("q", q.trim());
      if (mode) qs.set("mode", mode);
      const res = await api<{ users: any[]; summary: any }>(`/api/following/users?${qs.toString()}`);
      setUsers(res.users || []);
      setSummary(res.summary || null);
      followingStore.users = res.users || [];
      followingStore.summary = res.summary || null;
    } catch (e: any) {
      setError(e?.message || "加载关注列表失败");
    } finally {
      setLoading(false);
    }
  };

  const loadFeed = async (onlyRisk: boolean) => {
    setLoading(true);
    setError("");
    try {
      const res = await api<{ data: any[]; total: number }>(
        `/api/following/feed?page=1${onlyRisk ? "&only_risk=1" : ""}`
      );
      if (onlyRisk) {
        setRiskFeed(res.data || []);
        followingStore.riskFeed = res.data || [];
      } else {
        setFeed(res.data || []);
        followingStore.feed = res.data || [];
      }
    } catch (e: any) {
      setError(e?.message || "加载关注动态失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === "users" && users.length === 0) loadUsers();
    if (activeTab === "feed" && feed.length === 0) loadFeed(false);
    if (activeTab === "risk" && riskFeed.length === 0) loadFeed(true);
  }, [activeTab]);

  const handleToggleMode = async (u: any) => {
    const nextMode = u.sync_mode === "full" ? "default" : "full";
    const totalZhihu = (u.answer_count || 0) + (u.articles_count || 0);
    if (
      nextMode === "full" &&
      totalZhihu > 500 &&
      !window.confirm(
        `确定为「${u.name}」开启全量备份吗？\n\n该答主在知乎共有 ${u.answer_count} 篇回答 + ${u.articles_count} 篇文章（合计 ${totalZhihu} 篇），开启后后台计划任务将分批全量抓取。`
      )
    ) {
      return;
    }
    setTogglingToken(u.url_token);
    try {
      await postUserModeWithAuth(u.url_token, nextMode);
      await loadUsers(userQ, modeFilter);
      delete followingStore.userDetailCache[u.url_token];
    } catch (e: any) {
      if (e?.message !== "已取消密码验证") {
        alert(`切换失败: ${e?.message || e}`);
      }
    } finally {
      setTogglingToken(null);
    }
  };

  const handleAiAssess = async (e: React.MouseEvent, pk: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (aiResults[pk]) return;
    setAiLoadingPk(pk);
    try {
      const res = await api<any>(`/api/recommend/ai-assess`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pk })
      });
      if (res?.ai) {
        setAiResults(prev => {
          const next = { ...prev, [pk]: res.ai };
          recommendStore.aiCache = next;
          return next;
        });
      }
    } catch (err: any) {
      alert(`AI 评估失败: ${err?.message || err}`);
    } finally {
      setAiLoadingPk(null);
    }
  };

  return (
    <div>
      {error && <div className="card" style={{ color: "var(--zhihu-red)", fontSize: 14 }}>{error}</div>}

      <div className="card" style={{ marginBottom: 10, padding: "14px 18px" }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>我关注的人</h1>
        {summary && (
          <div style={{ marginTop: 8, fontSize: 13, color: "var(--zhihu-meta)", lineHeight: 1.8 }}>
            共关注 <strong>{summary.total_followed_users}</strong> 位答主 · 已开启全量备份{" "}
            <strong style={{ color: "var(--zhihu-blue)" }}>{summary.full_mode_users}</strong> 人 · 库内已收录他们{" "}
            <strong>{fmtNum(summary.total_backed_up_items)}</strong> 篇内容
            <br />
            📊 <strong>备份策略与容量预估</strong>：默认开启 <strong>「🛡️ 高危易和谐 + 深度精品自动抢救模式」</strong>（扫描关注答主的回答并只自动备份有被夹风险或高收藏比的精品，跳过普通水贴）；若将全部{" "}
            {summary.total_followed_users} 人都设为全量备份，则总计需抓取{" "}
            <strong>{fmtNum(summary.total_zhihu_all_items)}</strong> 篇。
          </div>
        )}
      </div>

      <div className="tab-bar">
        <button
          className={`tab ${activeTab === "users" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("users");
            followingStore.activeTab = "users";
          }}
        >
          👥 关注答主 ({summary?.total_followed_users ?? users.length})
        </button>
        <button
          className={`tab ${activeTab === "feed" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("feed");
            followingStore.activeTab = "feed";
          }}
        >
          🌊 关注动态流
        </button>
        <button
          className={`tab ${activeTab === "risk" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("risk");
            followingStore.activeTab = "risk";
          }}
        >
          ⚠️ 高危易和谐回答
        </button>

        {activeTab === "users" && (
          <div className="tab-right" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <select
              value={modeFilter}
              onChange={e => {
                const v = e.target.value as "" | "full" | "backed";
                setModeFilter(v);
                followingStore.userModeFilter = v;
                loadUsers(userQ, v);
              }}
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--zhihu-border)", fontSize: 13 }}
            >
              <option value="">全部答主</option>
              <option value="backed">库内已有回答</option>
              <option value="full">已开启全量备份</option>
            </select>
            <input
              className="search-input"
              type="search"
              placeholder="搜索关注答主昵称/简介..."
              value={userQ}
              onChange={e => {
                setUserQ(e.target.value);
                followingStore.userQ = e.target.value;
              }}
              onKeyDown={e => {
                if (e.key === "Enter") loadUsers(userQ, modeFilter);
              }}
            />
          </div>
        )}
      </div>

      {activeTab === "users" && (
        <div className="cards">
          {users.map(u => {
            const isFull = u.sync_mode === "full";
            const totalZhihu = (u.answer_count || 0) + (u.articles_count || 0);
            return (
              <div className="card" key={u.url_token} style={{ cursor: "default" }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <Link
                    to={`/following/${encodeURIComponent(u.url_token)}`}
                    style={{ display: "flex", alignItems: "center", gap: 12, textDecoration: "none", color: "inherit", flex: "1 1 240px" }}
                  >
                    {u.avatar_url && (
                      <img
                        src={u.avatar_url}
                        alt=""
                        referrerPolicy="no-referrer"
                        style={{ width: 44, height: 44, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
                      />
                    )}
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 16, color: "var(--zhihu-blue)" }}>
                        {u.name}
                      </div>
                      {u.headline && (
                        <div style={{ fontSize: 13, color: "var(--zhihu-meta)", marginTop: 2 }}>
                          {u.headline}
                        </div>
                      )}
                    </div>
                  </Link>

                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                    <button
                      type="button"
                      disabled={togglingToken === u.url_token}
                      onClick={() => handleToggleMode(u)}
                      style={{
                        padding: "6px 12px",
                        borderRadius: 6,
                        border: isFull ? "1px solid #16a34a" : "1px solid var(--zhihu-border, #d1d5db)",
                        background: isFull ? "rgba(22,163,74,0.1)" : "#fff",
                        color: isFull ? "#16a34a" : "var(--zhihu-text)",
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: "pointer"
                      }}
                    >
                      {togglingToken === u.url_token
                        ? "切换中…"
                        : isFull
                        ? `✅ 已开启全量备份（共 ${totalZhihu} 篇）· 点击切回精选`
                        : `开启全量备份（将抓取全部 ${totalZhihu} 篇）`}
                    </button>
                    <span style={{ fontSize: 11, color: "var(--zhihu-meta)" }}>
                      {isFull
                        ? `将备份该答主全部 ${u.answer_count} 回答 + ${u.articles_count} 文章`
                        : `默认仅自动抢救高危易和谐与高质回答（知乎共 ${u.answer_count} 回答 / ${u.articles_count} 文章）`}
                    </span>
                  </div>
                </div>

                <div className="card-footer" style={{ marginTop: 12 }}>
                  <Link
                    to={`/following/${encodeURIComponent(u.url_token)}`}
                    className="stat"
                    style={{ color: "var(--zhihu-blue)", background: "var(--zhihu-blue-bg)", borderRadius: 4, padding: "2px 10px", fontWeight: 500, textDecoration: "none" }}
                  >
                    已备份 {u.backed_up_count} 篇 →
                  </Link>
                  {u.upvoted_count > 0 && (
                    <span className="detail-tag" style={{ background: "var(--zhihu-blue-bg)", color: "var(--zhihu-blue)" }}>
                      我赞同过 {u.upvoted_count} 篇
                    </span>
                  )}
                  {u.faved_count > 0 && (
                    <span className="detail-tag" style={{ background: "rgba(46,125,50,0.08)", color: "#2e7d32" }}>
                      我收藏过 {u.faved_count} 篇
                    </span>
                  )}
                  <span className="footer-right">
                    关注者 {fmtNum(u.follower_count)}
                    {u.latest_content_time ? ` · 最近收录 ${fmtDate(u.latest_content_time)}` : ""}
                  </span>
                </div>
              </div>
            );
          })}
          {loading && <p className="loading-state">加载中...</p>}
          {!loading && users.length === 0 && (
            <p className="empty-state">暂无匹配的关注答主</p>
          )}
        </div>
      )}

      {(activeTab === "feed" || activeTab === "risk") && (
        <div className="cards">
          {(activeTab === "risk" ? riskFeed : feed).map(item => (
            <Link className="card" key={item.pk} to={`/contents/${encodeURIComponent(item.pk)}`}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                <div className="card-author" style={{ marginBottom: 0 }}>
                  {item.author_avatar && <img src={item.author_avatar} alt="" referrerPolicy="no-referrer" />}
                  <span className="author-name">{item.author_name}</span>
                  {item.author_headline && <span className="author-headline">{item.author_headline}</span>}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <RiskBadges item={item} />
                </div>
              </div>

              <h3 style={{ margin: "6px 0" }}>{item.question_title || item.title}</h3>
              {item.excerpt && <p className="card-excerpt">{stripHtml(item.excerpt)}</p>}

              {aiResults[item.pk] && (
                <div
                  onClick={e => { e.preventDefault(); e.stopPropagation(); }}
                  style={{
                    marginTop: 10,
                    padding: "10px 14px",
                    borderRadius: 8,
                    background: "rgba(0,102,255,0.05)",
                    border: "1px solid rgba(0,102,255,0.18)",
                    fontSize: 13,
                    lineHeight: 1.7,
                    whiteSpace: "pre-line"
                  }}
                >
                  <div style={{ fontWeight: 600, color: "var(--zhihu-blue)", marginBottom: 4 }}>
                    🤖 Workers AI 风险与价值鉴定
                  </div>
                  {aiResults[item.pk].analysis}
                </div>
              )}

              <div className="card-footer" style={{ marginTop: 10 }}>
                <span className="stat" style={{ color: "var(--zhihu-blue)", background: "var(--zhihu-blue-bg)", borderRadius: 4, padding: "2px 10px", fontWeight: 500 }}>
                  ▲ {fmtNum(item.voteup_count)}
                </span>
                {item.upvote_time && (
                  <span className="detail-tag" style={{ background: "var(--zhihu-blue-bg)", color: "var(--zhihu-blue)" }}>
                    我赞同过
                  </span>
                )}
                {Boolean(item.in_favorites) && (
                  <span className="detail-tag" style={{ background: "rgba(46,125,50,0.08)", color: "#2e7d32" }}>
                    已收藏
                  </span>
                )}
                <button
                  type="button"
                  onClick={e => handleAiAssess(e, item.pk)}
                  disabled={aiLoadingPk === item.pk}
                  style={{
                    padding: "2px 10px",
                    borderRadius: 4,
                    border: "1px solid var(--zhihu-blue)",
                    background: "#fff",
                    color: "var(--zhihu-blue)",
                    fontSize: 12,
                    cursor: "pointer"
                  }}
                >
                  {aiLoadingPk === item.pk ? "AI 鉴定中…" : aiResults[item.pk] ? "✅ 已鉴定" : "🛡️ AI 风险鉴定"}
                </button>
                <span className="footer-right">
                  {fmtDate(item.updated_time || item.created_time || item.last_seen_at)}
                </span>
              </div>
            </Link>
          ))}
          {loading && <p className="loading-state">加载中...</p>}
          {!loading && (activeTab === "risk" ? riskFeed : feed).length === 0 && (
            <p className="empty-state">暂无相关回答记录</p>
          )}
        </div>
      )}
    </div>
  );
}

function FollowedUserDetail({ urlToken }: { urlToken: string }) {
  const cached = followingStore.userDetailCache[urlToken];
  const [data, setData] = useState<any>(cached?.data || null);
  const [onlyRisk, setOnlyRisk] = useState(false);
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState(false);

  const loadDetail = async (riskOnly = onlyRisk) => {
    setLoading(true);
    try {
      const res = await api<any>(
        `/api/following/users/${encodeURIComponent(urlToken)}?page=1${riskOnly ? "&only_risk=1" : ""}`
      );
      setData(res);
      if (!riskOnly) {
        followingStore.userDetailCache[urlToken] = {
          data: res,
          scrollPosition: followingStore.userDetailCache[urlToken]?.scrollPosition || 0
        };
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDetail(onlyRisk);
  }, [urlToken, onlyRisk]);

  const toggleFullMode = async () => {
    if (!data?.user) return;
    const u = data.user;
    const nextMode = u.sync_mode === "full" ? "default" : "full";
    const totalZhihu = (u.answer_count || 0) + (u.articles_count || 0);
    if (
      nextMode === "full" &&
      totalZhihu > 500 &&
      !window.confirm(
        `确定为「${u.name}」开启全量备份吗？\n\n该答主在知乎共有 ${u.answer_count} 篇回答 + ${u.articles_count} 篇文章（合计 ${totalZhihu} 篇），开启后后台计划任务将分批全量抓取。`
      )
    ) {
      return;
    }
    setToggling(true);
    try {
      await postUserModeWithAuth(urlToken, nextMode);
      followingStore.users = [];
      followingStore.summary = null;
      await loadDetail(onlyRisk);
    } catch (e: any) {
      if (e?.message !== "已取消密码验证") {
        alert(`切换失败: ${e?.message || e}`);
      }
    } finally {
      setToggling(false);
    }
  };

  if (!data && loading) return <div className="loading-state">加载中...</div>;
  if (!data?.user) return <div className="empty-state">未找到该答主</div>;

  const u = data.user;
  const isFull = u.sync_mode === "full";
  const totalZhihu = (u.answer_count || 0) + (u.articles_count || 0);
  const backedTotal = data.backed_up_count ?? u.backed_up_count ?? data.total ?? 0;

  return (
    <div>
      <button className="back-fab" onClick={() => window.history.back()}>
        ← <span>返回</span>
      </button>

      <div className="card" style={{ marginBottom: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            {u.avatar_url && (
              <img
                src={u.avatar_url}
                alt=""
                referrerPolicy="no-referrer"
                style={{ width: 56, height: 56, borderRadius: "50%", objectFit: "cover" }}
              />
            )}
            <div>
              <h1 style={{ fontSize: 20, margin: 0 }}>{u.name}</h1>
              {u.headline && <p style={{ margin: "4px 0 0", color: "var(--zhihu-meta)", fontSize: 13 }}>{u.headline}</p>}
              <p style={{ margin: "6px 0 0", color: "var(--zhihu-meta)", fontSize: 12 }}>
                知乎总计：{u.answer_count || 0} 篇回答 + {u.articles_count || 0} 篇文章（共 {totalZhihu} 篇） · 当前已备份 {backedTotal} 篇
              </p>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
            <button
              type="button"
              className={isFull ? "btn-secondary" : "btn-primary"}
              disabled={toggling}
              onClick={toggleFullMode}
            >
              {toggling
                ? "保存中…"
                : isFull
                ? `✅ 已设全量备份（共 ${totalZhihu} 篇）· 点击切回精选`
                : `开启全量备份（将抓取全部 ${totalZhihu} 篇）`}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setOnlyRisk(v => !v)}
              style={{ fontSize: 12, padding: "5px 10px" }}
            >
              {onlyRisk ? "显示全部已备份回答" : "⚠️ 只看该答主高危易和谐回答"}
            </button>
          </div>
        </div>
      </div>

      <div className="cards">
        {(data.data || []).map((item: any) => (
          <Link className="card" key={item.pk} to={`/contents/${encodeURIComponent(item.pk)}`}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
              <h3 style={{ margin: 0, flex: "1 1 240px" }}>{item.question_title || item.title}</h3>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <RiskBadges item={item} />
              </div>
            </div>
            {item.excerpt && <p className="card-excerpt">{stripHtml(item.excerpt)}</p>}
            <div className="card-footer">
              <span className="stat" style={{ color: "var(--zhihu-blue)", background: "var(--zhihu-blue-bg)", borderRadius: 4, padding: "2px 10px", fontWeight: 500 }}>
                ▲ {fmtNum(item.voteup_count)}
              </span>
              {item.upvote_time && (
                <span className="detail-tag" style={{ background: "var(--zhihu-blue-bg)", color: "var(--zhihu-blue)" }}>
                  我赞同于 {fmtDate(item.upvote_time)}
                </span>
              )}
              {Boolean(item.in_favorites) && (
                <span className="detail-tag" style={{ background: "rgba(46,125,50,0.08)", color: "#2e7d32" }}>
                  收藏中
                </span>
              )}
              <span className="footer-right">
                {fmtDate(item.updated_time || item.created_time || item.last_seen_at)}
              </span>
            </div>
          </Link>
        ))}
        {!loading && (data.data || []).length === 0 && (
          <p className="empty-state">
            {onlyRisk ? "该答主暂无命中高危易和谐特征的已备份回答" : "暂未收录该答主的回答，下次自动同步时将按所选策略抓取"}
          </p>
        )}
      </div>
    </div>
  );
}
