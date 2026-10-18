import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

type ZhihuStatus = {
  hasCookie: boolean;
  source: "db" | "env" | "none";
  updatedAt: string | null;
  ageHours: number | null;
  cookieCount: number;
  hasZC0: boolean;
  writeTokenRequired?: boolean;
  lastRun?: {
    status: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    message: string | null;
  } | null;
};


function fmtTime(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", { hour12: false });
}

export default function AuthPage() {
  const [status, setStatus] = useState<ZhihuStatus | null>(null);
  const [cookieInput, setCookieInput] = useState("");
  const [token, setToken] = useState(() => localStorage.getItem("cookie_write_token") || "");
  const [needToken, setNeedToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const load = () => {
    api<ZhihuStatus>("/api/auth/zhihu-status")
      .then(s => {
        setStatus(s);
        setNeedToken(!!s.writeTokenRequired);
      })
      .catch(() => setStatus(null));
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);


  const buildHeaders = () => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    return headers;
  };

  const save = async () => {
    const value = cookieInput.trim();
    if (!value) {
      setMsg({ type: "err", text: "先把 cookie 粘贴进来" });
      return;
    }

    setSaving(true);
    setMsg(null);
    try {
      const r = await api<{ ok: boolean; cookieCount: number; updatedAt: string }>("/api/auth/zhihu-cookie", {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({ cookieString: value })
      });
      if (token) localStorage.setItem("cookie_write_token", token);
      setMsg({ type: "ok", text: `已保存 ${r.cookieCount} 项 cookie，下次同步就会用它。` });
      setCookieInput("");
      load();
    } catch (e: any) {
      const m = String(e?.message || "");
      if (m.startsWith("401")) {
        setNeedToken(true);
        setMsg({ type: "err", text: "这个 Worker 配置了写入口令，填上 COOKIE_WRITE_TOKEN 再提交。" });
      } else {
        setMsg({ type: "err", text: m.slice(0, 200) || "保存失败" });
      }
    } finally {
      setSaving(false);
    }
  };

  const clearCookie = async () => {
    if (!window.confirm("确定清除已保存的知乎 cookie？（环境变量里的不受影响）")) return;
    try {
      await api("/api/auth/zhihu-cookie/clear", { method: "POST", headers: buildHeaders() });
      setMsg({ type: "ok", text: "已清除。" });
      load();
    } catch (e: any) {
      setMsg({ type: "err", text: String(e?.message || "清除失败").slice(0, 200) });
    }
  };

  const ok = !!status?.hasCookie && status?.hasZC0;
  const stale = typeof status?.ageHours === "number" && status.ageHours >= 24 * 20;
  const runFailed = !!status?.lastRun?.status &&
    ["FAILED", "ABORTED", "TIMED-OUT"].includes(status.lastRun.status);

  return (
    <div>
      <div className="stat-grid">
        <div className="stat-card">
          <div className="num" style={{ color: ok ? "#16a34a" : "#dc2626" }}>
            {status ? (ok ? "已登录" : "未登录") : "…"}
          </div>
          <div className="label">知乎登录态</div>
        </div>
        <div className="stat-card">
          <div className="num">{status?.cookieCount ?? 0}</div>
          <div className="label">cookie 项数</div>
        </div>
        <div className="stat-card">
          <div className="num" style={{ fontSize: 18 }}>
            {status?.source === "db" ? "网页/脚本保存" : status?.source === "env" ? "环境变量" : "无"}
          </div>
          <div className="label">来源</div>
        </div>
        <div className="stat-card">
          <div className="num" style={{ fontSize: 15 }}>
            {fmtTime(status?.updatedAt ?? null)}
          </div>
          <div className="label">
            最后更新{typeof status?.ageHours === "number" ? `（${status.ageHours} 小时前）` : ""}
          </div>
        </div>
      </div>

      {status?.lastRun && (
        <div className="card" style={{ fontSize: 14 }}>
          上次 Apify 同步：
          <strong style={{ marginLeft: 6, color: runFailed ? "#dc2626" : "#16a34a" }}>
            {status.lastRun.status || "未知"}
          </strong>
          {status.lastRun.finishedAt && (
            <span style={{ color: "var(--zhihu-meta)", marginLeft: 10, fontSize: 13 }}>
              {fmtTime(status.lastRun.finishedAt)}
            </span>
          )}
          {status.lastRun.message && (
            <span style={{ color: "var(--zhihu-meta)", marginLeft: 10, fontSize: 13 }}>
              {status.lastRun.message.slice(0, 160)}
            </span>
          )}
          {runFailed && (
            <div style={{ marginTop: 8, color: "#dc2626", fontSize: 13 }}>
              上一次 run 失败了。最常见的原因是 cookie 已失效，换一份新的再试；也可能是知乎风控或 Apify 配额。
            </div>
          )}
        </div>
      )}

      {stale && (
        <div className="card" style={{ color: "#b45309", fontSize: 14 }}>
          这份 cookie 已经快 20 天了，知乎登录态随时可能失效。建议现在换一份新的。
        </div>
      )}

      {status && status.writeTokenRequired === false && (
        <div className="card" style={{ fontSize: 13, color: "var(--zhihu-meta)", lineHeight: 1.8 }}>
          写接口当前<strong>未设口令</strong>：知道这个 Worker 域名的人都能覆盖你保存的 cookie。
          要收紧就在终端执行 <code>npx wrangler secret put COOKIE_WRITE_TOKEN</code>，
          之后本页会提示你填一次。
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>粘贴 cookie</h3>

        <div style={{ fontSize: 13, color: "var(--zhihu-meta)", lineHeight: 1.9, marginBottom: 14 }}>
          获取方式（30 秒）：
          <br />
          1. 浏览器登录 <code>zhihu.com</code>，按 <code>F12</code> 打开开发者工具
          <br />
          2. 切到 <code>Network</code>，刷新页面，点列表里任意一条 <code>zhihu.com</code> 的请求
          <br />
          3. 右侧 <code>Headers</code> → <code>Request Headers</code> → 找到 <code>cookie:</code>，
          复制冒号后面<strong>整行</strong>粘贴到下面
        </div>

        <textarea
          placeholder="z_c0=...; _xsrf=...; d_c0=...; （整行粘贴，不用手动删减）"
          value={cookieInput}
          onChange={e => setCookieInput(e.target.value)}
          rows={5}
          spellCheck={false}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: 12,
            borderRadius: 8,
            border: "1px solid var(--zhihu-border, #e5e7eb)",
            background: "transparent",
            color: "inherit",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 13,
            resize: "vertical"
          }}
        />

        {needToken && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: "var(--zhihu-meta)", marginBottom: 6 }}>
              写入口令（这个 Worker 配了 COOKIE_WRITE_TOKEN，填一次就会记住）
            </div>
            <input
              type="password"
              placeholder="COOKIE_WRITE_TOKEN"
              value={token}
              onChange={e => setToken(e.target.value)}
              style={{
                width: 320,
                maxWidth: "100%",
                padding: "9px 12px",
                borderRadius: 8,
                border: "1px solid var(--zhihu-border, #e5e7eb)",
                background: "transparent",
                color: "inherit",
                fontSize: 14
              }}
            />
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? "保存中…" : "保存 cookie"}
          </button>
          <button className="btn-ghost" onClick={clearCookie}>
            清除已保存
          </button>
          {msg && (
            <span style={{ fontSize: 13, color: msg.type === "ok" ? "#16a34a" : "#dc2626" }}>
              {msg.text}
            </span>
          )}
        </div>
      </div>

    </div>
  );
}
