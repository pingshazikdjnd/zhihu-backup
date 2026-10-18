import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";

export default function ChangesPage() {
  const [items, setItems] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<"all" | "core" | "comments">("all");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setIsLoading(true);
    setError("");
    let url = "/api/changes?limit=300";
    if (activeTab === "core") url += "&exclude_comments=true";
    if (activeTab === "comments") url += "&only_comments=true";

    api<{ data: any[] }>(url)
      .then(res => {
        if (alive) setItems(res.data);
      })
      .catch(e => {
        if (alive) setError(e?.message || "加载失败");
      })
      .finally(() => {
        if (alive) setIsLoading(false);
      });

    return () => { alive = false; };
  }, [activeTab]);

  return (
    <div>
      {error && (
        <div className="card" style={{ color: "#dc2626", fontSize: 14 }}>
          变更列表加载失败：{error}
        </div>
      )}
      <div className="tab-bar">
        <button className={`tab ${activeTab === "all" ? "active" : ""}`} onClick={() => setActiveTab("all")}>全部变更</button>
        <button className={`tab ${activeTab === "core" ? "active" : ""}`} onClick={() => setActiveTab("core")}>核心变更（去评论）</button>
        <button className={`tab ${activeTab === "comments" ? "active" : ""}`} onClick={() => setActiveTab("comments")}>评论变更</button>
      </div>

      {isLoading ? <div className="loading-state">加载中...</div> : (
        <ul className="timeline">
          {items.map(item => {
            const isComment = item.event_type.startsWith("comment.");
            const content = (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className="event-pill">{item.event_type}</span>
                  <span className="event-time" style={{ marginLeft: "auto" }}>
                    {new Date(item.created_at).toLocaleString('zh-CN', {
                      year: 'numeric', month: '2-digit', day: '2-digit',
                      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
                    })}
                  </span>
                </div>
                <div style={{ marginTop: 6, color: "var(--zhihu-text-2)", lineHeight: 1.6 }}>{item.summary}</div>
              </>
            );

            return (
              <li key={item.id} className="card" style={{ padding: "12px 16px", display: "block" }}>
                {item.content_pk ? (
                  <Link 
                    to={`/contents/${encodeURIComponent(item.content_pk)}${isComment ? `#comment-${item.entity_pk}` : ''}`} 
                    style={{ display: "block" }}
                  >
                    {content}
                  </Link>
                ) : (
                  <div>{content}</div>
                )}
              </li>
            );
          })}
          {items.length === 0 && <p className="empty-state">这里空空如也~</p>}
        </ul>
      )}
    </div>
  );
}
