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

function extractErrText(e: any, fallback: string): string {
  const m = String(e?.message || "");
  let text = m.slice(0, 200) || fallback;
  const jsonStart = m.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(m.slice(jsonStart));
      if (parsed?.error) text = String(parsed.error);
    } catch { /* ignore */ }
  }
  return text;
}

export default function AuthPage() {
  const [status, setStatus] = useState<ZhihuStatus | null>(null);
  const [cookieInput, setCookieInput] = useState("");
  const [token, setToken] = useState(() => localStorage.getItem("cookie_write_token") || "");
  const [showToken, setShowToken] = useState(false);
  const [needToken, setNeedToken] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // 设置/修改密码面板状态
  const [showPwdPanel, setShowPwdPanel] = useState(false);
  const [currentPwdInput, setCurrentPwdInput] = useState("");
  const [newPwdInput, setNewPwdInput] = useState("");
  const [savingPwd, setSavingPwd] = useState(false);
  const [pwdMsg, setPwdMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

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
    if (token.trim()) headers.authorization = `Bearer ${token.trim()}`;
    return headers;
  };

  const rememberToken = () => {
    const t = token.trim();
    if (!t) {
      setMsg({ type: "err", text: "请先在密码框中输入操作密码" });
      return;
    }
    localStorage.setItem("cookie_write_token", t);
    setMsg({ type: "ok", text: "已在本浏览器记住操作密码，后续保存/清除 Cookie 将自动携带。" });
  };

  const save = async () => {
    const value = cookieInput.trim();
    if (!value) {
      setMsg({ type: "err", text: "先把 cookie 粘贴进来" });
      return;
    }
    if (needToken && !token.trim()) {
      setMsg({ type: "err", text: "请先在下方输入凭据页操作密码" });
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
      if (token.trim()) localStorage.setItem("cookie_write_token", token.trim());
      setMsg({ type: "ok", text: `已保存 ${r.cookieCount} 项 cookie，下次同步就会用它。` });
      setCookieInput("");
      load();
    } catch (e: any) {
      const m = String(e?.message || "");
      if (m.startsWith("401")) {
        setNeedToken(true);
        setMsg({ type: "err", text: "操作密码错误或未填写，请核对下方操作密码后再提交。" });
      } else {
        setMsg({ type: "err", text: extractErrText(e, "保存失败") });
      }
    } finally {
      setSaving(false);
    }
  };

  const clearCookie = async () => {
    if (needToken && !token.trim()) {
      setMsg({ type: "err", text: "清除 Cookie 需要先在下方输入操作密码" });
      return;
    }
    if (!window.confirm("确定清除已保存的知乎 cookie？（环境变量里的不受影响）")) return;
    try {
      await api("/api/auth/zhihu-cookie/clear", { method: "POST", headers: buildHeaders() });
      if (token.trim()) localStorage.setItem("cookie_write_token", token.trim());
      setMsg({ type: "ok", text: "已清除。" });
      load();
    } catch (e: any) {
      setMsg({ type: "err", text: extractErrText(e, "清除失败") });
    }
  };

  const saveNewPassword = async () => {
    const nextPwd = newPwdInput.trim();
    const curPwd = currentPwdInput.trim() || token.trim();
    if (needToken && !curPwd) {
      setPwdMsg({ type: "err", text: "请填写当前密码" });
      return;
    }
    if (nextPwd.length < 4) {
      setPwdMsg({ type: "err", text: "新密码长度至少 4 位" });
      return;
    }

    setSavingPwd(true);
    setPwdMsg(null);
    try {
      await api("/api/auth/write-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentToken: curPwd,
          newToken: nextPwd
        })
      });
      setToken(nextPwd);
      localStorage.setItem("cookie_write_token", nextPwd);
      setCurrentPwdInput("");
      setNewPwdInput("");
      setNeedToken(true);
      setPwdMsg({ type: "ok", text: "新密码已保存生效，并已自动在本浏览器记住！" });
      load();
    } catch (e: any) {
      setPwdMsg({ type: "err", text: extractErrText(e, "修改密码失败（若当日 D1 写入配额已满，请于次日 08:00 后再改，或在 Cloudflare Worker 后台修改 COOKIE_WRITE_TOKEN）") });
    } finally {
      setSavingPwd(false);
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
              上一次云端 run 未完成（若为 12h 超时 ABORTED 或月度额度用尽，本地计划任务仍在每天 08:05 / 20:05 自动继续同步）。
            </div>
          )}
        </div>
      )}

      {stale && (
        <div className="card" style={{ color: "#b45309", fontSize: 14 }}>
          这份 cookie 已经快 20 天了，知乎登录态随时可能失效。建议现在换一份新的。
        </div>
      )}

      <div className="card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>粘贴并更新知乎 Cookie</h3>
          <span
            className="detail-tag"
            style={{
              background: needToken ? "rgba(22,163,74,0.1)" : "rgba(217,119,6,0.12)",
              color: needToken ? "#16a34a" : "#b45309",
              padding: "4px 10px",
              fontSize: 12
            }}
          >
            {needToken ? "🔒 已开启操作密码保护" : "🔓 当前未设操作密码"}
          </span>
        </div>

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

        <div style={{ marginTop: 14, padding: "12px 14px", borderRadius: 8, background: "var(--zhihu-bg, #f8fafc)", border: "1px solid var(--zhihu-border-light, #eef2f6)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
            凭据操作密码（口令验证）
          </div>
          <div style={{ fontSize: 12, color: "var(--zhihu-meta)", marginBottom: 10, lineHeight: 1.6 }}>
            保存或清除知乎 Cookie 时需验证此密码，防止他人知道网址后误改或清空你的登录态。验证通过或点击「记住密码」后，当前浏览器会自动保存，无需每次重填。
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <input
              type={showToken ? "text" : "password"}
              placeholder="输入凭据页操作密码..."
              value={token}
              onChange={e => setToken(e.target.value)}
              style={{
                width: 260,
                maxWidth: "100%",
                padding: "8px 12px",
                borderRadius: 6,
                border: "1px solid var(--zhihu-border, #d1d5db)",
                background: "#fff",
                color: "inherit",
                fontSize: 14
              }}
            />
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setShowToken(v => !v)}
              style={{ padding: "7px 12px", fontSize: 13 }}
            >
              {showToken ? "隐藏" : "显示"}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={rememberToken}
              style={{ padding: "7px 12px", fontSize: 13 }}
            >
              在本机记住密码
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setShowPwdPanel(v => !v)}
              style={{ padding: "7px 12px", fontSize: 13, color: "var(--zhihu-blue)", borderColor: "var(--zhihu-blue)" }}
            >
              {showPwdPanel ? "收起设置密码" : "⚙️ 设置 / 修改密码"}
            </button>
          </div>
        </div>

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

      {showPwdPanel && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>设置 / 修改凭据页密码</h3>
          <div style={{ fontSize: 13, color: "var(--zhihu-meta)", lineHeight: 1.8, marginBottom: 12 }}>
            • <strong>作用范围</strong>：仅锁住本页的「保存 Cookie」「清除 Cookie」与「修改密码」操作；平时浏览回答、收藏、赞同、按问题整理无需密码。
            <br />
            • <strong>修改方式</strong>：若已设置过密码，请先填「当前密码」再填「新密码」（不少于 4 位）；修改后立即存入云端 D1 数据库。
            <br />
            • <strong>忘记密码怎么办</strong>：可在 Cloudflare 网页端进入 Worker（<code>gemini-zhihu-api</code>）→ <code>Settings</code> → <code>Variables and Secrets</code> 查看或重置 <code>COOKIE_WRITE_TOKEN</code>，并在 D1 数据库 <code>app_settings</code> 表中删除 <code>cookie_write_token</code> 行。
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 380 }}>
            {needToken && (
              <div>
                <div style={{ fontSize: 12, color: "var(--zhihu-meta)", marginBottom: 4 }}>当前密码</div>
                <input
                  type={showToken ? "text" : "password"}
                  placeholder="输入当前正在使用的密码"
                  value={currentPwdInput}
                  onChange={e => setCurrentPwdInput(e.target.value)}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "8px 12px",
                    borderRadius: 6,
                    border: "1px solid var(--zhihu-border, #d1d5db)",
                    fontSize: 14
                  }}
                />
              </div>
            )}
            <div>
              <div style={{ fontSize: 12, color: "var(--zhihu-meta)", marginBottom: 4 }}>新密码（至少 4 位）</div>
              <input
                type={showToken ? "text" : "password"}
                placeholder="输入要设置的新密码"
                value={newPwdInput}
                onChange={e => setNewPwdInput(e.target.value)}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "8px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--zhihu-border, #d1d5db)",
                  fontSize: 14
                }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
              <button className="btn-primary" onClick={saveNewPassword} disabled={savingPwd}>
                {savingPwd ? "提交中…" : "保存新密码"}
              </button>
              {pwdMsg && (
                <span style={{ fontSize: 13, color: pwdMsg.type === "ok" ? "#16a34a" : "#dc2626" }}>
                  {pwdMsg.text}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
