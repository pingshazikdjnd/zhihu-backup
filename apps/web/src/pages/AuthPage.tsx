import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

type CommentSyncMode = "full" | "hot" | "none";

type SyncConfig = {
  commentsMyAnswers: CommentSyncMode;
  commentsCollections: CommentSyncMode;
  commentsUpvotes: CommentSyncMode;
  commentsFollowing: CommentSyncMode;
  followingSensitivity: "strict" | "standard" | "relaxed";
  preferredAiModel: string;
  updatedAt?: string | null;
};

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
  syncConfig?: SyncConfig;
  upvotesCursor?: string | null;
};

const DEFAULT_CFG: SyncConfig = {
  commentsMyAnswers: "full",
  commentsCollections: "hot",
  commentsUpvotes: "hot",
  commentsFollowing: "hot",
  followingSensitivity: "standard",
  preferredAiModel: "@cf/qwen/qwen3-30b-a3b-fp8"
};

function fmtTime(iso: string | null | undefined) {
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
  const [cfg, setCfg] = useState<SyncConfig>(DEFAULT_CFG);
  const [cfgInitialized, setCfgInitialized] = useState(false);
  const [savingCfg, setSavingCfg] = useState(false);
  const [cfgMsg, setCfgMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

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

  const load = (syncForm = false) => {
    api<ZhihuStatus>("/api/auth/zhihu-status")
      .then(s => {
        setStatus(s);
        setNeedToken(!!s.writeTokenRequired);
        if (s.syncConfig && (!cfgInitialized || syncForm)) {
          setCfg({ ...DEFAULT_CFG, ...s.syncConfig });
          setCfgInitialized(true);
        }
      })
      .catch(() => setStatus(null));
  };

  useEffect(() => {
    load(true);
    const t = setInterval(() => load(false), 8000);
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
    setMsg({ type: "ok", text: "已在本浏览器记住操作密码，保存设置或更新 Cookie 时将自动验证。" });
  };

  const saveConfig = async () => {
    if (needToken && !token.trim()) {
      setCfgMsg({ type: "err", text: "请先在下方【操作密码验证】框中输入密码（如 8367274466）" });
      return;
    }
    setSavingCfg(true);
    setCfgMsg(null);
    try {
      const res = await api<{ ok: boolean; syncConfig: SyncConfig }>("/api/auth/settings", {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify(cfg)
      });
      if (token.trim()) localStorage.setItem("cookie_write_token", token.trim());
      if (res.syncConfig) setCfg(res.syncConfig);
      setCfgMsg({ type: "ok", text: "同步与评论策略已保存生效！下次自动或手动同步将按新策略执行。" });
      load(false);
    } catch (e: any) {
      setCfgMsg({ type: "err", text: extractErrText(e, "保存设置失败") });
    } finally {
      setSavingCfg(false);
    }
  };

  const save = async () => {
    const value = cookieInput.trim();
    if (!value) {
      setMsg({ type: "err", text: "先把 cookie 粘贴进来" });
      return;
    }
    if (needToken && !token.trim()) {
      setMsg({ type: "err", text: "请先在操作密码框中输入密码" });
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
      load(false);
    } catch (e: any) {
      const m = String(e?.message || "");
      if (m.startsWith("401")) {
        setNeedToken(true);
        setMsg({ type: "err", text: "操作密码错误或未填写，请核对操作密码后再提交。" });
      } else {
        setMsg({ type: "err", text: extractErrText(e, "保存失败") });
      }
    } finally {
      setSaving(false);
    }
  };

  const clearCookie = async () => {
    if (needToken && !token.trim()) {
      setMsg({ type: "err", text: "清除 Cookie 需要先输入操作密码" });
      return;
    }
    if (!window.confirm("确定清除已保存的知乎 cookie？（环境变量里的不受影响）")) return;
    try {
      await api("/api/auth/zhihu-cookie/clear", { method: "POST", headers: buildHeaders() });
      if (token.trim()) localStorage.setItem("cookie_write_token", token.trim());
      setMsg({ type: "ok", text: "已清除。" });
      load(false);
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
      load(false);
    } catch (e: any) {
      setPwdMsg({ type: "err", text: extractErrText(e, "修改密码失败") });
    } finally {
      setSavingPwd(false);
    }
  };

  const ok = !!status?.hasCookie && status?.hasZC0;
  const stale = typeof status?.ageHours === "number" && status.ageHours >= 24 * 20;
  const runFailed = !!status?.lastRun?.status &&
    ["FAILED", "ABORTED", "TIMED-OUT"].includes(status.lastRun.status);

  const selectStyle: React.CSSProperties = {
    padding: "8px 12px",
    borderRadius: 6,
    border: "1px solid var(--zhihu-border, #d1d5db)",
    background: "#fff",
    fontSize: 13,
    minWidth: 240
  };

  return (
    <div>
      {/* 顶部系统状态概览 */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="num" style={{ color: ok ? "#16a34a" : "#dc2626" }}>
            {status ? (ok ? "已登录" : "未登录") : "…"}
          </div>
          <div className="label">知乎登录态</div>
        </div>
        <div className="stat-card">
          <div className="num">{status?.cookieCount ?? 0}</div>
          <div className="label">Cookie 项数</div>
        </div>
        <div className="stat-card">
          <div className="num" style={{ fontSize: 18 }}>
            {needToken ? "🔒 已加锁" : "🔓 未设锁"}
          </div>
          <div className="label">设置与凭据密码保护</div>
        </div>
        <div className="stat-card">
          <div className="num" style={{ fontSize: 15 }}>
            {fmtTime(status?.updatedAt ?? null)}
          </div>
          <div className="label">
            Cookie 更新{typeof status?.ageHours === "number" ? `（${status.ageHours} 小时前）` : ""}
          </div>
        </div>
      </div>

      {/* 全局操作密码验证栏（所有设置修改与 Cookie 保存共用） */}
      <div className="card" style={{ borderLeft: "4px solid var(--zhihu-blue)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              🔑 管理员操作密码验证
            </div>
            <div style={{ fontSize: 12, color: "var(--zhihu-meta)", marginTop: 4 }}>
              修改同步策略、切换全量备份或更新知乎 Cookie 均受此密码保护。输入一次点「记住密码」后本浏览器自动保存。
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <input
              type={showToken ? "text" : "password"}
              placeholder="输入操作密码..."
              value={token}
              onChange={e => setToken(e.target.value)}
              style={{
                width: 200,
                padding: "8px 12px",
                borderRadius: 6,
                border: "1px solid var(--zhihu-border, #d1d5db)",
                background: "#fff",
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
              记住密码
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setShowPwdPanel(v => !v)}
              style={{ padding: "7px 12px", fontSize: 13, color: "var(--zhihu-blue)", borderColor: "var(--zhihu-blue)" }}
            >
              {showPwdPanel ? "收起改密" : "⚙️ 修改密码"}
            </button>
          </div>
        </div>

        {showPwdPanel && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px dashed var(--zhihu-border-light, #e2e8f0)" }}>
            <div style={{ fontSize: 13, color: "var(--zhihu-meta)", lineHeight: 1.7, marginBottom: 10 }}>
              • <strong>作用范围</strong>：锁定设置修改、全量开关、Cookie 更新与清除操作；日常浏览内容无需密码。
              <br />
              • <strong>忘记密码重置方法</strong>：在 Cloudflare Worker（<code>gemini-zhihu-api</code>）→ <code>Settings → Variables and Secrets</code> 重置 <code>COOKIE_WRITE_TOKEN</code>。
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              {needToken && (
                <input
                  type={showToken ? "text" : "password"}
                  placeholder="当前密码"
                  value={currentPwdInput}
                  onChange={e => setCurrentPwdInput(e.target.value)}
                  style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid var(--zhihu-border)", fontSize: 13 }}
                />
              )}
              <input
                type={showToken ? "text" : "password"}
                placeholder="新密码（至少 4 位）"
                value={newPwdInput}
                onChange={e => setNewPwdInput(e.target.value)}
                style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid var(--zhihu-border)", fontSize: 13 }}
              />
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
        )}
      </div>

      {/* 模块一：评论抓取与智能同步策略设置 */}
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>💬 评论抓取与同步策略设置</h3>
          {cfg.updatedAt && (
            <span style={{ fontSize: 12, color: "var(--zhihu-meta)" }}>
              上次保存：{fmtTime(cfg.updatedAt)}
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, color: "var(--zhihu-meta)", lineHeight: 1.7, marginBottom: 16 }}>
          可按不同板块独立控制评论抓取深度。<strong>「抓取前 20 条高赞热评 + 回复」</strong>既能保留神评、答主补充与打脸反转现场，又不会因为万评水贴触发知乎风控或占满免费 D1 每日 10 万行写入额度；<strong>「全量抓取全部评论」</strong>则会翻遍所有评论分页。
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>1. 「我的回答」评论区抓取策略</div>
              <div style={{ fontSize: 12, color: "var(--zhihu-meta)" }}>你自己的回答（共 562 篇）下的读者评论与你的回复</div>
            </div>
            <select
              style={selectStyle}
              value={cfg.commentsMyAnswers}
              onChange={e => setCfg({ ...cfg, commentsMyAnswers: e.target.value as CommentSyncMode })}
            >
              <option value="full">全量抓取全部评论 + 楼中楼回复（默认推荐）</option>
              <option value="hot">仅抓取前 20 条高赞热评 + 回复</option>
              <option value="none">不抓取评论</option>
            </select>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>2. 「我的收藏夹」回答/文章评论策略</div>
              <div style={{ fontSize: 12, color: "var(--zhihu-meta)" }}>你收藏的 1,099 篇内容下的评论区抓取范围</div>
            </div>
            <select
              style={selectStyle}
              value={cfg.commentsCollections}
              onChange={e => setCfg({ ...cfg, commentsCollections: e.target.value as CommentSyncMode })}
            >
              <option value="hot">抓取前 20 条高赞/置顶热评 + 回复（推荐）</option>
              <option value="full">全量抓取全部评论（消耗较多 D1 每日写入配额）</option>
              <option value="none">不抓取评论</option>
            </select>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>3. 「我赞同的内容」评论策略</div>
              <div style={{ fontSize: 12, color: "var(--zhihu-meta)" }}>你点赞的回答/文章下的评论区抓取范围</div>
            </div>
            <select
              style={selectStyle}
              value={cfg.commentsUpvotes}
              onChange={e => setCfg({ ...cfg, commentsUpvotes: e.target.value as CommentSyncMode })}
            >
              <option value="hot">抓取前 20 条高赞/置顶热评 + 回复（推荐）</option>
              <option value="full">全量抓取全部评论（不建议，赞同基数大易超每日限额）</option>
              <option value="none">不抓取评论</option>
            </select>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>4. 「关注的人」回答评论策略</div>
              <div style={{ fontSize: 12, color: "var(--zhihu-meta)" }}>自动抢救或全量备份关注答主回答时的评论抓取范围</div>
            </div>
            <select
              style={selectStyle}
              value={cfg.commentsFollowing}
              onChange={e => setCfg({ ...cfg, commentsFollowing: e.target.value as CommentSyncMode })}
            >
              <option value="hot">抓取前 20 条高赞/置顶热评 + 回复（推荐）</option>
              <option value="full">全量抓取全部评论</option>
              <option value="none">不抓取评论</option>
            </select>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>5. 「关注的人」高危易和谐自动抢救灵敏度</div>
              <div style={{ fontSize: 12, color: "var(--zhihu-meta)" }}>未开启单人全量备份时，按风险与质量分数自动筛选入库的门槛</div>
            </div>
            <select
              style={selectStyle}
              value={cfg.followingSensitivity}
              onChange={e => setCfg({ ...cfg, followingSensitivity: e.target.value as any })}
            >
              <option value="standard">标准模式（风险≥25分 或 质量≥38分 自动抢救，推荐）</option>
              <option value="relaxed">宽松模式（风险≥18分 或 质量≥24分，多收录优质回答）</option>
              <option value="strict">严格模式（风险≥40分 或 质量≥50分，只存极高危与神贴）</option>
            </select>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 18, flexWrap: "wrap" }}>
          <button className="btn-primary" onClick={saveConfig} disabled={savingCfg}>
            {savingCfg ? "保存中…" : "💾 保存同步与评论策略"}
          </button>
          {cfgMsg && (
            <span style={{ fontSize: 13, color: cfgMsg.type === "ok" ? "#16a34a" : "#dc2626" }}>
              {cfgMsg.text}
            </span>
          )}
        </div>
      </div>

      {/* 模块二：AI 模型与高级扩展设置（预留未来功能扩展口） */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>🤖 AI 引擎与系统扩展设置</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>Cloudflare Workers AI 首选鉴定模型</div>
              <div style={{ fontSize: 12, color: "var(--zhihu-meta)" }}>用于「推荐页」与「关注页」的单篇回答和谐风险与核心看点深度评估（每天 10,000 Neurons 免费额度）</div>
            </div>
            <select
              style={selectStyle}
              value={cfg.preferredAiModel}
              onChange={e => setCfg({ ...cfg, preferredAiModel: e.target.value })}
            >
              <option value="@cf/qwen/qwen3-30b-a3b-fp8">通义千问 Qwen3-30B-A3B-FP8（300亿MoE·中文最佳且最省额度）</option>
              <option value="@cf/deepseek-ai/deepseek-v4.1-flash-1017">DeepSeek-V4.1-Flash（深度求索·观点提炼犀利）</option>
              <option value="@cf/zai-org/glm-5.3-flash">智谱 GLM-5.3-Flash（中文语境自然）</option>
              <option value="@cf/meta/llama-3.3-70b-instruct-fp8-fast">Meta Llama-3.3-70B-FP8-Fast（700亿超大参数）</option>
            </select>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, paddingTop: 10, borderTop: "1px dashed var(--zhihu-border-light, #e2e8f0)" }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>赞同历史断点续传游标状态</div>
              <div style={{ fontSize: 12, color: "var(--zhihu-meta)" }}>
                {status?.upvotesCursor
                  ? `当前断点位于：${status.upvotesCursor}`
                  : "当前无未完成断点（已全量追平或从头扫描）"}
              </div>
            </div>
            <button className="btn-secondary" onClick={saveConfig} disabled={savingCfg}>
              {savingCfg ? "保存中…" : "保存 AI 与扩展设置"}
            </button>
          </div>
        </div>
      </div>

      {/* 模块三：知乎登录凭据维护（原登录页） */}
      {status?.lastRun && (
        <div className="card" style={{ fontSize: 14 }}>
          上次云端 Apify 同步状态：
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
        </div>
      )}

      {stale && (
        <div className="card" style={{ color: "#b45309", fontSize: 14 }}>
          这份 cookie 已经快 20 天了，知乎登录态随时可能失效。建议现在换一份新的。
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>🍪 知乎登录凭据（粘贴并更新 Cookie）</h3>

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

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? "保存中…" : "保存 Cookie"}
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
