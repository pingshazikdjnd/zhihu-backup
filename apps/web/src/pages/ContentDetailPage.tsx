import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, fetchRootComments } from "../lib/api.js";
import { sanitizeHtml } from "../lib/sanitize.js";
import CommentTree from "../components/CommentTree.js";

const fmtNum = (n: any) => {
  const num = Number(n) || 0;
  if (num >= 10000) return (num / 10000).toFixed(1).replace(/\.0$/, "") + " 万";
  return String(num);
};

export default function ContentDetailPage() {
  const { pk = "" } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<any>(null);
  const [comments, setComments] = useState<any[]>([]);
  const [syncMsg, setSyncMsg] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // 评论单独维护错误/加载态：评论接口挂了不能把整篇正文一起判死
  const [commentError, setCommentError] = useState("");
  const [commentLoading, setCommentLoading] = useState(false);
  // 每次切换 pk 自增，旧请求回来时据此丢弃，避免串台
  const requestIdRef = useRef(0);

  // 云端 /sync-comments-live 已加 Bearer 鉴权（浏览器不该持有 API_SECRET），
  // 而且 Cloudflare 的出站 IP 抓知乎会被风控。抓取统一交给 Apify。
  // 这里不再发请求，避免必然 401 被误读成「Cookie 失效」。
  const syncCommentsLive = async () => {
    setSyncMsg("评论由 Apify 同步。需要立即刷新，请在 Apify 控制台运行 Actor。");
  };

  // 实时刷新统计数字已移除：云端 /sync-live 需要 Bearer 鉴权，
  // 且 CF 出站抓知乎不可用。统计由 Apify 同步时一并更新。

  const loadRootComments = useCallback(async (reqId: number) => {
    setCommentError("");
    setCommentLoading(true);
    try {
      const res = await fetchRootComments(pk, { limit: 20, offset: 0 });
      if (requestIdRef.current !== reqId) return;
      setComments(res.data || []);
    } catch (e: any) {
      if (requestIdRef.current !== reqId) return;
      setCommentError(e?.message || "评论加载失败");
    } finally {
      if (requestIdRef.current === reqId) setCommentLoading(false);
    }
  }, [pk]);

  useEffect(() => {
    if (!pk) return;
    const reqId = ++requestIdRef.current;
    setDetail(null);
    setComments([]);
    setSyncMsg("");
    setLoading(true);
    setError("");
    setCommentError("");

    // 正文与评论解耦：任一失败只影响自己那一块
    api(`/api/contents/${encodeURIComponent(pk)}`)
      .then(res => {
        if (requestIdRef.current === reqId) setDetail(res);
      })
      .catch(e => {
        if (requestIdRef.current === reqId) setError(e?.message || "加载失败");
      })
      .finally(() => {
        if (requestIdRef.current === reqId) setLoading(false);
      });

    loadRootComments(reqId);
  }, [pk, loadRootComments]);

  // 不再自动触发实时同步：
  // 1) 云端 /sync-live 现在要求 Bearer 鉴权，浏览器不该持有 API_SECRET；
  // 2) Cloudflare 的出站 IP 抓知乎基本会被风控，这条路本来就不通。
  // 抓取统一交给 Apify（右上角「同步」按钮触发），这里只做展示。
  // 需要手动刷新时用页面上的按钮。

  useEffect(() => {
    if (comments.length > 0 && window.location.hash) {
      const id = window.location.hash.slice(1);
      let attempts = 0;
      
      const tryScroll = () => {
        const el = document.getElementById(id);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.style.backgroundColor = "rgba(5, 109, 232, 0.08)";
          el.style.transition = "background-color 0.5s";
          setTimeout(() => { el.style.backgroundColor = "transparent"; }, 2000);
        } else if (attempts < 20) {
          attempts++;
          setTimeout(tryScroll, 100);
        }
      };
      
      setTimeout(tryScroll, 300);
    }
  }, [comments]);

  if (loading) return <div className="loading-state">加载中…</div>;
  if (error) {
    return (
      <div className="card" style={{ color: "#dc2626", fontSize: 14 }}>
        内容加载失败：{error}
      </div>
    );
  }
  if (!detail?.content) return <div className="empty-state">内容不存在，或已被删除。</div>;

  const c = detail.content;
  const editTime = (() => {
    if (!c.updated_time) return "";
    if (typeof c.updated_time === "string" && c.updated_time.includes("T")) {
      return new Date(c.updated_time).toLocaleString();
    }
    const num = Number(c.updated_time);
    if (Number.isNaN(num)) return "";
    return new Date(num * (num < 10000000000 ? 1000 : 1)).toLocaleString();
  })();

  return (
    <>
      <button className="back-fab" onClick={() => navigate(-1)}>
        ← <span>返回</span>
      </button>

      <div className="card">
        <h1 className="question-title">{c.title || c.question_title || c.pk}</h1>

        <div style={{ marginBottom: 12 }}>
          <span className="detail-tag blue">{c.source_type === "answer" ? "回答" : c.source_type === "article" ? "文章" : c.source_type}</span>
          {c.is_deleted === 1 && <span className="detail-tag red">已删除</span>}
          {c.is_collapsed === 1 && <span className="detail-tag orange">该回答被建议折叠</span>}
          {c.is_labeled === 1 && <span className="detail-tag orange">存在争议/特定标签</span>}
        </div>

        {c.author_name && (
          <div className="author-card">
            {c.author_avatar && <img src={c.author_avatar} alt="" referrerPolicy="no-referrer" />}
            <div className="author-info">
              <div className="author-name">{c.author_name}</div>
              {c.author_headline && <div className="author-headline">{c.author_headline}</div>}
            </div>
          </div>
        )}

        <div 
          className="content-body"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(c.content_html) }} 
        />
        {!c.content_html && c.content_md ? (
          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{c.content_md}</pre>
        ) : null}

        {editTime && <div className="edit-time">编辑于 {editTime}</div>}

        <div className="action-bar">
          <span className="vote-btn">▲ 赞同 <span className="stat-num">{fmtNum(c.voteup_count)}</span></span>
          <span className="stat">💬 <span className="stat-num">{fmtNum(c.comment_count)}</span> 条评论</span>
          <span className="stat">⭐ <span className="stat-num">{fmtNum(c.favorite_count)}</span> 收藏</span>
          {Number(c.visit_count) > 0 && <span className="stat">👁 <span className="stat-num">{fmtNum(c.visit_count)}</span> 浏览</span>}
        </div>
      </div>

      {detail.versions && detail.versions.length > 1 && (
        <div className="card">
          <h2 style={{ fontSize: 18, margin: "0 0 12px" }}>版本历史</h2>
          <ul className="version-list">
            {detail.versions.map((v: any) => (
              <li key={v.id}>
                {new Date(v.snapshot_at).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).replace(/\//g, "-")}
                {" · "}
                <span className="version-hash">hash: {String(v.version_hash).slice(0, 12)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <div className="comment-section-title">
          <span>评论区</span>
          <button className="btn-ghost" onClick={() => syncCommentsLive()}>
            ℹ️ 如何刷新
          </button>
          {syncMsg && <span style={{ fontSize: 13, color: "var(--zhihu-meta)", fontWeight: 400 }}>{syncMsg}</span>}
        </div>
        {commentError && (
          <div style={{ fontSize: 13, color: "#dc2626", marginBottom: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span>评论加载失败：{commentError}</span>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => loadRootComments(requestIdRef.current)}
            >
              重试加载评论
            </button>
          </div>
        )}
        {commentLoading && comments.length === 0 && (
          <p className="loading-state">评论加载中…</p>
        )}
        <CommentTree key={pk} comments={comments} contentPk={pk} />
      </div>
    </>
  );
}
