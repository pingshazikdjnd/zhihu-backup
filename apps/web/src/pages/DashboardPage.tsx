import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

export default function DashboardPage() {
  const [changes, setChanges] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    Promise.all([
      api<{ data: any[] }>("/api/changes?limit=20&exclude_comments=true").then(res => {
        if (alive) setChanges(res.data);
      }),
      api("/api/stats").then(res => {
        if (alive) setStats(res);
      })
    ]).catch(e => {
      if (alive) setError(e?.message || "加载失败");
    });
    return () => { alive = false; };
  }, []);

  return (
    <div>
      {error && (
        <div className="card" style={{ color: "#dc2626", fontSize: 14 }}>
          数据加载失败：{error}
          <div style={{ color: "var(--zhihu-meta)", fontSize: 12, marginTop: 6 }}>
            常见原因是 Worker 未部署、D1 未初始化，或 CORS 里没放行当前域名。
          </div>
        </div>
      )}
      {stats && (
        <div className="stat-grid">
          <div className="stat-card">
            <div className="num">{stats.total_contents}</div>
            <div className="label">总收录内容</div>
          </div>
          <div className="stat-card">
            <div className="num">{stats.total_comments}</div>
            <div className="label">总评论数</div>
          </div>
          <div className="stat-card">
            <div className="num">{stats.total_collections}</div>
            <div className="label">追踪收藏夹</div>
          </div>
          <div className="stat-card">
            <div className="num">{stats.total_collection_items}</div>
            <div className="label">收藏条目</div>
          </div>
          <div className="stat-card">
            <div className="num">{stats.total_upvotes}</div>
            <div className="label">赞同记录</div>
          </div>
        </div>
      )}

      <div className="card">
        <h2 style={{ fontSize: 18, margin: "0 0 12px" }}>核心变更记录 <span style={{ fontSize: 13, color: "var(--zhihu-meta)", fontWeight: 400 }}>（不含评论）</span></h2>
        <ul className="timeline">
          {changes.map(item => (
            <li key={item.id}>
              <span className="event-pill">{item.event_type}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.summary}</span>
              <span className="event-time">{new Date(item.created_at).toLocaleString('zh-CN', { hour12: false })}</span>
            </li>
          ))}
          {changes.length === 0 && <p className="empty-state">暂无变更记录</p>}
        </ul>
      </div>
    </div>
  );
}
