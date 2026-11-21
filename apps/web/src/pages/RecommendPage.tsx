import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { recommendStore } from "../lib/store.js";

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
  html ? html.replace(/<[^>]+>/g, "").substring(0, 160) + "..." : "";

function safeSetWriteToken(token: string) {
  try {
    localStorage.setItem("cookie_write_token", token);
  } catch {
    // 禁用存储/隐私模式不阻断当前请求
  }
}

export default function RecommendPage() {
  const navigate = useNavigate();
  const [channel, setChannel] = useState<"mix" | "risk" | "authors" | "classic">(recommendStore.channel);
  const [items, setItems] = useState<any[]>(recommendStore.items);
  const [stats, setStats] = useState<any>(recommendStore.stats);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [aiResults, setAiResults] = useState<Record<string, any>>(recommendStore.aiCache);
  const [aiLoadingPks, setAiLoadingPks] = useState<Record<string, boolean>>({});
  const aiLoadingSetRef = useRef<Set<string>>(new Set());
  const [similarMap, setSimilarMap] = useState<Record<string, any[]>>(recommendStore.similarCache);
  const [similarLoadingPk, setSimilarLoadingPk] = useState<string | null>(null);
  const [similarError, setSimilarError] = useState<Record<string, string>>({});
  const reqIdRef = useRef(0);
  // 每个 pk 独立序号：并行查找不同条目时，旧响应/旧 finally 不得覆盖新结果或清掉别人的 loading
  const similarSeqRef = useRef<Record<string, number>>({});

  useEffect(() => {
    window.scrollTo(0, recommendStore.scrollPosition);
    const handleScroll = () => {
      recommendStore.scrollPosition = window.scrollY;
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const fetchRecommend = async (ch = channel, newSeed = Date.now()) => {
    const myReqId = ++reqIdRef.current;
    setLoading(true);
    setError("");
    try {
      const res = await api<{ data: any[]; stats: any; seed: number }>(
        `/api/recommend?channel=${ch}&seed=${newSeed}&limit=20`
      );
      if (myReqId !== reqIdRef.current) return;
      setItems(res.data || []);
      setStats(res.stats || null);
      recommendStore.channel = ch;
      recommendStore.seed = newSeed;
      recommendStore.items = res.data || [];
      recommendStore.stats = res.stats || null;
    } catch (e: any) {
      if (myReqId !== reqIdRef.current) return;
      setError(e?.message || "加载推荐流失败");
    } finally {
      if (myReqId === reqIdRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (items.length === 0) {
      fetchRecommend(channel, recommendStore.seed);
    }
  }, []);

  const handleChannelChange = (ch: "mix" | "risk" | "authors" | "classic") => {
    setChannel(ch);
    recommendStore.scrollPosition = 0;
    window.scrollTo(0, 0);
    fetchRecommend(ch, Date.now());
  };

  const handleAiAssess = async (e: React.MouseEvent, pk: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (aiResults[pk] || aiLoadingSetRef.current.has(pk)) return;
    aiLoadingSetRef.current.add(pk);
    setAiLoadingPks(prev => ({ ...prev, [pk]: true }));
    const callAssess = (tokenStr?: string) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (tokenStr && tokenStr.trim()) headers.authorization = `Bearer ${tokenStr.trim()}`;
      return api<any>(`/api/recommend/ai-assess`, {
        method: "POST",
        headers,
        body: JSON.stringify({ pk })
      });
    };
    try {
      let res: any;
      try {
        res = await callAssess();
      } catch (err: any) {
        const msg = String(err?.message || "");
        const needAuth = msg.startsWith("401") || (msg.startsWith("403") && !/Forbidden origin/i.test(msg));
        if (!needAuth) throw err;
        const input = window.prompt("AI 风险鉴定需验证操作密码（验证后本浏览器自动记住）：", "");
        const trimmed = input?.trim() || "";
        if (!trimmed) return;
        res = await callAssess(trimmed);
        safeSetWriteToken(trimmed);
      }
      if (res?.ai) {
        setAiResults(prev => {
          const next = { ...prev, [pk]: res.ai };
          recommendStore.aiCache = next;
          return next;
        });
      }
    } catch (err: any) {
      alert(`AI 风险鉴定失败: ${err?.message || err}`);
    } finally {
      aiLoadingSetRef.current.delete(pk);
      setAiLoadingPks(prev => {
        if (!prev[pk]) return prev;
        const next = { ...prev };
        delete next[pk];
        return next;
      });
    }
  };

  const handleFindSimilar = async (e: React.MouseEvent, pk: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (similarMap[pk]) {
      setSimilarMap(prev => {
        const copy = { ...prev };
        delete copy[pk];
        return copy;
      });
      return;
    }
    const seq = (similarSeqRef.current[pk] || 0) + 1;
    similarSeqRef.current[pk] = seq;
    setSimilarLoadingPk(pk);
    setSimilarError(prev => {
      if (!prev[pk]) return prev;
      const next = { ...prev };
      delete next[pk];
      return next;
    });
    try {
      const res = await api<{ data: any[] }>(`/api/recommend/similar/${encodeURIComponent(pk)}`);
      if (similarSeqRef.current[pk] !== seq) return;
      setSimilarMap(prev => {
        const next = { ...prev, [pk]: res.data || [] };
        recommendStore.similarCache = next;
        return next;
      });
    } catch (err: any) {
      if (similarSeqRef.current[pk] !== seq) return;
      setSimilarError(prev => ({ ...prev, [pk]: err?.message || "查找相似回答失败" }));
    } finally {
      // 只结束自己这个 pk 的 loading；并行查找其它条目时不能被旧请求提前清掉
      if (similarSeqRef.current[pk] === seq) {
        setSimilarLoadingPk(prev => (prev === pk ? null : prev));
      }
    }
  };

  return (
    <div>
      {error && <div className="card" style={{ color: "var(--zhihu-red)", fontSize: 14 }}>{error}</div>}

      <div className="card" style={{ marginBottom: 10, padding: "14px 18px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <div>
            <h1 style={{ fontSize: 18, margin: 0 }}>个性化推荐与防和谐预警</h1>
            <p style={{ margin: "6px 0 0", color: "var(--zhihu-meta)", fontSize: 13 }}>
              基于你的赞同/收藏偏好与关注答主做规则打分，可手动点击「AI 鉴定」调用 Cloudflare Workers AI 做风险鉴定
              {stats ? ` · 候选池中发现 ${stats.high_risk_count} 篇高危易和谐、${stats.medium_risk_count} 篇中度敏感回答` : ""}
            </p>
          </div>
          <button
            type="button"
            className="btn-primary"
            disabled={loading}
            onClick={() => fetchRecommend(channel, Date.now())}
          >
            {loading ? "刷新中…" : "🔄 换一批"}
          </button>
        </div>
      </div>

      <div className="tab-bar">
        <button
          className={`tab ${channel === "mix" ? "active" : ""}`}
          onClick={() => handleChannelChange("mix")}
        >
          ✨ 猜你想看
        </button>
        <button
          className={`tab ${channel === "risk" ? "active" : ""}`}
          onClick={() => handleChannelChange("risk")}
        >
          ⚠️ 高危易和谐榜 {stats?.high_risk_count ? `(${stats.high_risk_count})` : ""}
        </button>
        <button
          className={`tab ${channel === "authors" ? "active" : ""}`}
          onClick={() => handleChannelChange("authors")}
        >
          🔥 偏爱与关注答主
        </button>
        <button
          className={`tab ${channel === "classic" ? "active" : ""}`}
          onClick={() => handleChannelChange("classic")}
        >
          💎 绝版与深度神贴
        </button>
      </div>

      <div className="cards">
        {items.map(item => {
          const tags: string[] = Array.isArray(item.risk_tags) ? item.risk_tags : [];
          return (
            <Link className="card" key={item.pk} to={`/contents/${encodeURIComponent(item.pk)}`}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                <span
                  className="detail-tag"
                  style={{
                    background: item.risk_level === "high" ? "rgba(220,38,38,0.1)" : "var(--zhihu-blue-bg)",
                    color: item.risk_level === "high" ? "#dc2626" : "var(--zhihu-blue)",
                    fontWeight: 600
                  }}
                >
                  {item.recommend_reason}
                </span>

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {item.risk_score >= 28 && (
                    <span
                      className="detail-tag"
                      style={{
                        background: item.risk_level === "high" ? "rgba(220,38,38,0.1)" : "rgba(217,119,6,0.12)",
                        color: item.risk_level === "high" ? "#dc2626" : "#b45309",
                        fontWeight: 600
                      }}
                    >
                      和谐风险 {item.risk_score}分
                    </span>
                  )}
                  {tags.slice(0, 2).map((t, idx) => (
                    <span
                      key={idx}
                      className="detail-tag"
                      style={{ background: "rgba(100,116,139,0.1)", color: "#475569" }}
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </div>

              <h3 style={{ marginBottom: 8 }}>{item.question_title || item.title}</h3>

              {item.author_name && (
                <div className="card-author">
                  {item.author_avatar && <img src={item.author_avatar} alt="" referrerPolicy="no-referrer" />}
                  <span className="author-name">{item.author_name}</span>
                  {item.author_headline && <span className="author-headline">{item.author_headline}</span>}
                </div>
              )}

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
                    🤖 Cloudflare Workers AI 风险与核心价值鉴定（模型：{aiResults[item.pk].model}）
                  </div>
                  {aiResults[item.pk].analysis}
                </div>
              )}

              {similarMap[item.pk] && (
                <div
                  onClick={e => { e.preventDefault(); e.stopPropagation(); }}
                  style={{
                    marginTop: 10,
                    padding: "10px 14px",
                    borderRadius: 8,
                    background: "#f8fafc",
                    border: "1px solid var(--zhihu-border-light, #e2e8f0)",
                    fontSize: 13
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>🔍 库内关联 / 相似回答：</div>
                  {similarMap[item.pk].length === 0 ? (
                    <div style={{ color: "var(--zhihu-meta)" }}>未找到其他相似回答</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {similarMap[item.pk].map((s: any) => {
                        const targetTo = `/contents/${encodeURIComponent(s.pk)}`;
                        return (
                          <div
                            key={s.pk}
                            role="link"
                            tabIndex={0}
                            onClick={e => {
                              e.preventDefault();
                              e.stopPropagation();
                              navigate(targetTo);
                            }}
                            onKeyDown={e => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                e.stopPropagation();
                                navigate(targetTo);
                              }
                            }}
                            style={{ color: "var(--zhihu-blue)", cursor: "pointer", display: "flex", justifyContent: "space-between", gap: 8 }}
                          >
                            <span>
                              [{s.relation_type}] {s.question_title || s.title} — {s.author_name || "匿名"}
                            </span>
                            <span style={{ color: "var(--zhihu-meta)", flexShrink: 0 }}>▲ {fmtNum(s.voteup_count)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {similarError[item.pk] && (
                <div
                  onClick={e => { e.preventDefault(); e.stopPropagation(); }}
                  style={{
                    marginTop: 10,
                    padding: "10px 14px",
                    borderRadius: 8,
                    background: "rgba(220,38,38,0.06)",
                    border: "1px solid rgba(220,38,38,0.2)",
                    color: "#dc2626",
                    fontSize: 13
                  }}
                >
                  找相似失败：{similarError[item.pk]}
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
                  disabled={Boolean(aiLoadingPks[item.pk])}
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
                  {aiLoadingPks[item.pk] ? "AI 鉴定中…" : aiResults[item.pk] ? "✅ 已鉴定" : "🛡️ AI 风险鉴定"}
                </button>
                <button
                  type="button"
                  onClick={e => handleFindSimilar(e, item.pk)}
                  disabled={similarLoadingPk === item.pk}
                  style={{
                    padding: "2px 10px",
                    borderRadius: 4,
                    border: "1px solid var(--zhihu-border, #cbd5e1)",
                    background: "#fff",
                    color: "var(--zhihu-text)",
                    fontSize: 12,
                    cursor: "pointer"
                  }}
                >
                  {similarLoadingPk === item.pk ? "查找中…" : similarMap[item.pk] ? "收起相似" : "🔍 找相似"}
                </button>
                <span className="footer-right">
                  {fmtDate(item.upvote_time || item.updated_time || item.last_seen_at)}
                </span>
              </div>
            </Link>
          );
        })}
        {loading && <p className="loading-state">正在智能召回推荐内容...</p>}
      </div>
    </div>
  );
}
