import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";

function safeGetStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 无痕模式或禁用存储时忽略持久化失败 */
  }
}

type CommentSyncMode = "full" | "hot" | "none";
// 图片备份质量：original=原图，high=图床 1440w 官方尺寸，compressed=图床 720w 官方尺寸
type ImageQuality = "original" | "high" | "compressed";

type ExternalProviderType = "turso" | "cloudflare_d1" | "supabase" | "s3_r2" | "webhook";
type ExternalSyncScope = "contents" | "comments" | "collections" | "upvotes";
// offload=直接分流扩容（不占主库空间）｜overflow=主库满额自动溢出｜mirror=双写灾备
type ExternalStorageRole = "offload" | "overflow" | "mirror";

const DEFAULT_OVERFLOW_THRESHOLD_ROWS = 1_500_000;

type ClientExternalStorageTarget = {
  id: string;
  name: string;
  provider: ExternalProviderType;
  enabled: boolean;
  syncScopes: ExternalSyncScope[];
  storageRole: ExternalStorageRole;
  overflowThresholdRows: number;
  endpointUrl: string;
  databaseId?: string;
  hasToken: boolean;
  maskedToken: string;
  createdAt: string;
  updatedAt: string;
  lastTestAt?: string | null;
  lastTestOk?: boolean | null;
  lastTestMsg?: string | null;
};

type SyncConfig = {
  commentsMyAnswers: CommentSyncMode;
  commentsCollections: CommentSyncMode;
  commentsUpvotes: CommentSyncMode;
  commentsFollowing: CommentSyncMode;
  followingSensitivity: "strict" | "standard" | "relaxed";
  preferredAiModel: string;
  // 正文图片备份质量（Worker 端 processContentImages 读取）
  imageQuality: ImageQuality;
  // Workers AI 额度耗尽/不可用时的替补引擎（OpenAI 兼容，反代 DeepSeek）
  fallbackAiBaseUrl?: string;
  fallbackAiModel?: string;
  // 只读标记：后端只返回「有没有配 Key」，明文 Key 永不下发
  hasFallbackAiKey?: boolean;
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
  // db=网页设的独立密码，env=COOKIE_WRITE_TOKEN，api_secret=暂用 API_SECRET 兜底，none=纯本地空环境
  tokenSource?: "db" | "env" | "api_secret" | "none";
  lastRun?: {
    status: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    message: string | null;
  } | null;
  syncConfig?: SyncConfig;
  upvotesCursor?: string | null;
  externalTargetsCount?: number;
};

const DEFAULT_CFG: SyncConfig = {
  commentsMyAnswers: "full",
  commentsCollections: "full",
  commentsUpvotes: "hot",
  commentsFollowing: "hot",
  followingSensitivity: "standard",
  preferredAiModel: "@cf/qwen/qwen3-30b-a3b-fp8",
  imageQuality: "original",
  fallbackAiBaseUrl: "",
  fallbackAiModel: "deepseek-v4.1-flash",
  hasFallbackAiKey: false
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
  // 用 ref 而不是 state 做闸门：8 秒轮询的闭包永远读不到最新的 state
  const cfgInitRef = useRef(false);
  const cfgDirtyRef = useRef(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [savingCfg, setSavingCfg] = useState(false);
  const [cfgMsg, setCfgMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  // 替补引擎 Key 只写不读：明文绝不进 state 之外的地方，保存后立即清空输入框
  const [fallbackKeyInput, setFallbackKeyInput] = useState("");
  const [clearFallbackKey, setClearFallbackKey] = useState(false);

  const [cookieInput, setCookieInput] = useState("");
  const [token, setToken] = useState(
    () => safeGetStorage("cookie_write_token") || safeGetStorage("zhihu_write_token") || ""
  );
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

  // 外部存储与多云扩展状态
  const [targets, setTargets] = useState<ClientExternalStorageTarget[]>([]);
  const [loadingTargets, setLoadingTargets] = useState(false);
  const [showTargetForm, setShowTargetForm] = useState(false);
  const [editingTargetId, setEditingTargetId] = useState<string | null>(null);
  const [targetName, setTargetName] = useState("");
  const [targetProvider, setTargetProvider] = useState<ExternalProviderType>("turso");
  const [targetEndpoint, setTargetEndpoint] = useState("");
  const [targetDatabaseId, setTargetDatabaseId] = useState("");
  const [targetAuthToken, setTargetAuthToken] = useState("");
  const [targetSyncScopes, setTargetSyncScopes] = useState<ExternalSyncScope[]>(["contents", "comments"]);
  const [targetStorageRole, setTargetStorageRole] = useState<ExternalStorageRole>("offload");
  const [targetOverflowThreshold, setTargetOverflowThreshold] = useState(String(DEFAULT_OVERFLOW_THRESHOLD_ROWS));
  const [targetEnabled, setTargetEnabled] = useState(true);
  const [savingTarget, setSavingTarget] = useState(false);
  const [testingTarget, setTestingTarget] = useState(false);
  const [targetActionMsg, setTargetActionMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [testingTargetId, setTestingTargetId] = useState<string | null>(null);

  const loadTargets = () => {
    setLoadingTargets(true);
    api<{ targets: ClientExternalStorageTarget[] }>("/api/auth/external-targets")
      .then(res => {
        setTargets(res.targets || []);
      })
      .catch(() => {})
      .finally(() => setLoadingTargets(false));
  };

  const load = (syncForm = false) => {
    loadTargets();
    api<ZhihuStatus>("/api/auth/zhihu-status")
      .then(s => {
        setStatus(s);
        setNeedToken(!!s.writeTokenRequired);
        // 只有首次初始化或用户主动保存且当前没有未保存修改时才回写表单；
        // 若用户在首轮响应到达前已开始编辑（cfgDirtyRef=true），同样绝不覆盖用户输入
        if (s.syncConfig && ((!cfgInitRef.current || syncForm) && !cfgDirtyRef.current)) {
          setCfg({ ...DEFAULT_CFG, ...s.syncConfig });
          cfgInitRef.current = true;
        }
      })
      .catch(() => setStatus(null));
  };

  // 所有修改同步策略的入口都走这里，保证「有未保存修改」标记不遗漏
  const updateCfg = (patch: Partial<SyncConfig>) => {
    cfgDirtyRef.current = true;
    setCfg(prev => ({ ...prev, ...patch }));
  };

  useEffect(() => {
    load(true);
    const t = setInterval(() => load(false), 8000);
    return () => {
      clearInterval(t);
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
    };
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
    safeSetStorage("cookie_write_token", t);
    setMsg({ type: "ok", text: "已在本浏览器记住操作密码，保存设置或更新 Cookie 时将自动验证。" });
  };

  const saveConfig = async () => {
    if (needToken && !token.trim()) {
      setCfgMsg({ type: "err", text: "请先在下方【操作密码验证】框中输入你设置的操作密码" });
      return;
    }
    setSavingCfg(true);
    setCfgMsg(null);
    try {
      // 替补引擎 Key：勾选清除 → "__CLEAR__"；输入了新 Key → 覆盖；留空 → 保留原值（服务端不返回明文）
      const keyPatch = clearFallbackKey
        ? { fallbackAiApiKey: "__CLEAR__" }
        : fallbackKeyInput.trim()
        ? { fallbackAiApiKey: fallbackKeyInput.trim() }
        : {};
      const res = await api<{ ok: boolean; syncConfig: SyncConfig }>("/api/auth/settings", {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({ ...cfg, ...keyPatch })
      });
      if (token.trim()) safeSetStorage("cookie_write_token", token.trim());
      if (res.syncConfig) setCfg(res.syncConfig);
      setFallbackKeyInput("");
      setClearFallbackKey(false);
      cfgDirtyRef.current = false;
      setCfgMsg({ type: "ok", text: "设置已保存生效！下次自动或手动同步将按新策略执行。" });
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
      if (token.trim()) safeSetStorage("cookie_write_token", token.trim());
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
      if (token.trim()) safeSetStorage("cookie_write_token", token.trim());
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
      safeSetStorage("cookie_write_token", nextPwd);
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

  const clearResetTimer = () => {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  };

  const resetTargetForm = () => {
    clearResetTimer();
    setShowTargetForm(false);
    setEditingTargetId(null);
    setTargetName("");
    setTargetProvider("turso");
    setTargetEndpoint("");
    setTargetDatabaseId("");
    setTargetAuthToken("");
    setTargetSyncScopes(["contents", "comments"]);
    setTargetStorageRole("offload");
    setTargetOverflowThreshold(String(DEFAULT_OVERFLOW_THRESHOLD_ROWS));
    setTargetEnabled(true);
    setTargetActionMsg(null);
  };

  const openAddTargetForm = () => {
    resetTargetForm();
    setShowTargetForm(true);
  };

  const openEditTargetForm = (t: ClientExternalStorageTarget) => {
    clearResetTimer();
    setEditingTargetId(t.id);
    setTargetName(t.name);
    setTargetProvider(t.provider);
    setTargetEndpoint(t.endpointUrl);
    setTargetDatabaseId(t.databaseId || "");
    setTargetAuthToken(""); // 密码留空表示不修改
    setTargetSyncScopes(t.syncScopes || ["contents", "comments"]);
    setTargetStorageRole(t.storageRole || "offload");
    setTargetOverflowThreshold(String(t.overflowThresholdRows || DEFAULT_OVERFLOW_THRESHOLD_ROWS));
    setTargetEnabled(t.enabled);
    setTargetActionMsg(null);
    setShowTargetForm(true);
  };

  const toggleTargetScope = (scope: ExternalSyncScope) => {
    setTargetSyncScopes(prev => {
      if (prev.includes(scope)) {
        if (prev.length === 1) return prev; // 至少选一个
        return prev.filter(s => s !== scope);
      } else {
        return [...prev, scope];
      }
    });
  };

  const saveTarget = async () => {
    const name = targetName.trim();
    if (!name) {
      setTargetActionMsg({ type: "err", text: "请输入存储源名称" });
      return;
    }
    let endpoint = targetEndpoint.trim();
    if (targetProvider === "cloudflare_d1" && !endpoint) {
      endpoint = "https://api.cloudflare.com";
    }
    if (!endpoint) {
      setTargetActionMsg({ type: "err", text: "请输入连接地址" });
      return;
    }
    if (needToken && !token.trim()) {
      setTargetActionMsg({ type: "err", text: "请在上方操作密码框中输入密码" });
      return;
    }

    const overflowThresholdRows = Math.trunc(Number(targetOverflowThreshold));
    if (
      targetStorageRole === "overflow" &&
      (!Number.isFinite(overflowThresholdRows) || overflowThresholdRows <= 0)
    ) {
      setTargetActionMsg({ type: "err", text: "请填写有效的主库溢出水位线（评论行数）" });
      return;
    }

    setSavingTarget(true);
    setTargetActionMsg(null);
    try {
      const res = await api<{ ok: boolean; targets: ClientExternalStorageTarget[] }>("/api/auth/external-targets", {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({
          id: editingTargetId || undefined,
          name,
          provider: targetProvider,
          endpointUrl: endpoint,
          databaseId: targetDatabaseId.trim() || undefined,
          authToken: targetAuthToken.trim() || undefined,
          syncScopes: targetSyncScopes,
          storageRole: targetStorageRole,
          overflowThresholdRows:
            Number.isFinite(overflowThresholdRows) && overflowThresholdRows > 0
              ? overflowThresholdRows
              : DEFAULT_OVERFLOW_THRESHOLD_ROWS,
          enabled: targetEnabled
        })
      });
      if (token.trim()) safeSetStorage("cookie_write_token", token.trim());
      setTargets(res.targets || []);
      setTargetActionMsg({ type: "ok", text: "外部存储源保存成功！" });
      clearResetTimer();
      resetTimerRef.current = setTimeout(() => {
        resetTimerRef.current = null;
        resetTargetForm();
      }, 1000);
      load(false);
    } catch (e: any) {
      setTargetActionMsg({ type: "err", text: extractErrText(e, "保存外部存储源失败") });
    } finally {
      setSavingTarget(false);
    }
  };

  const testConnection = async (targetId?: string) => {
    if (needToken && !token.trim()) {
      setTargetActionMsg({ type: "err", text: "测试连接需要先输入操作密码" });
      return;
    }
    if (targetId) {
      setTestingTargetId(targetId);
    } else {
      setTestingTarget(true);
      setTargetActionMsg(null);
    }

    try {
      let reqBody: any;
      if (targetId) {
        reqBody = { id: targetId };
      } else {
        let endpoint = targetEndpoint.trim();
        if (targetProvider === "cloudflare_d1" && !endpoint) {
          endpoint = "https://api.cloudflare.com";
        }
        if (!endpoint) {
          setTargetActionMsg({ type: "err", text: "请输入连接地址后再测试" });
          return;
        }
        reqBody = {
          // 编辑已有目标时带上 id：密码框留空（不重填 authToken）时后端才能回退到已保存的 token
          id: editingTargetId || undefined,
          provider: targetProvider,
          endpointUrl: endpoint,
          databaseId: targetDatabaseId.trim() || undefined,
          authToken: targetAuthToken.trim() || undefined
        };
      }

      const res = await api<{ ok: boolean; latencyMs: number; message: string; target?: ClientExternalStorageTarget }>(
        "/api/auth/external-targets/test",
        {
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify(reqBody)
        }
      );

      if (token.trim()) safeSetStorage("cookie_write_token", token.trim());

      const msgText = `${res.ok ? "🟢 连接成功" : "🔴 连接失败"} (${res.latencyMs}ms): ${res.message}`;
      if (targetId) {
        loadTargets();
        alert(msgText);
      } else {
        setTargetActionMsg({ type: res.ok ? "ok" : "err", text: msgText });
      }
    } catch (e: any) {
      const errText = extractErrText(e, "测试连接失败");
      if (targetId) {
        alert("测试连接失败: " + errText);
      } else {
        setTargetActionMsg({ type: "err", text: errText });
      }
    } finally {
      if (targetId) {
        setTestingTargetId(null);
      } else {
        setTestingTarget(false);
      }
    }
  };

  const toggleTargetEnabled = async (t: ClientExternalStorageTarget) => {
    if (needToken && !token.trim()) {
      alert("操作需要先输入操作密码");
      return;
    }
    try {
      const res = await api<{ ok: boolean; targets: ClientExternalStorageTarget[] }>("/api/auth/external-targets", {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({
          id: t.id,
          name: t.name,
          provider: t.provider,
          endpointUrl: t.endpointUrl,
          databaseId: t.databaseId,
          syncScopes: t.syncScopes,
          enabled: !t.enabled
        })
      });
      if (token.trim()) safeSetStorage("cookie_write_token", token.trim());
      setTargets(res.targets || []);
      load(false);
    } catch (e: any) {
      alert("切换失败: " + extractErrText(e, "未知错误"));
    }
  };

  const deleteTarget = async (t: ClientExternalStorageTarget) => {
    if (needToken && !token.trim()) {
      alert("删除外部存储源需要先输入操作密码");
      return;
    }
    if (!window.confirm(`确定删除外部存储源【${t.name}】吗？删除后将停止向其镜像分流。`)) return;
    try {
      const res = await api<{ ok: boolean; targets: ClientExternalStorageTarget[] }>("/api/auth/external-targets/delete", {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({ id: t.id })
      });
      if (token.trim()) safeSetStorage("cookie_write_token", token.trim());
      setTargets(res.targets || []);
      if (editingTargetId === t.id) resetTargetForm();
      load(false);
    } catch (e: any) {
      alert("删除失败: " + extractErrText(e, "未知错误"));
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

  // 替补引擎配置区的输入框/标签样式（与外部存储表单保持一致）
  const fallbackInputStyle: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 12px",
    borderRadius: 6,
    border: "1px solid var(--zhihu-border, #d1d5db)",
    background: "#fff",
    fontSize: 13
  };
  const fallbackLabelStyle: React.CSSProperties = {
    display: "block",
    fontSize: 12,
    fontWeight: 600,
    marginBottom: 4
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

        {status?.tokenSource === "api_secret" && (
          <div
            style={{
              marginTop: 12,
              padding: "10px 12px",
              borderRadius: 6,
              background: "rgba(180, 83, 9, 0.08)",
              border: "1px solid rgba(180, 83, 9, 0.35)",
              color: "#b45309",
              fontSize: 12.5,
              lineHeight: 1.8
            }}
          >
            当前尚未单独设置网页操作密码，默认使用 Worker 的 API_SECRET 作为初始操作密码（如需设置独立密码，请在「修改密码」的当前密码框输入 API_SECRET）。
          </div>
        )}

        {showPwdPanel && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px dashed var(--zhihu-border-light, #e2e8f0)" }}>
            <div style={{ fontSize: 13, color: "var(--zhihu-meta)", lineHeight: 1.7, marginBottom: 10 }}>
              • <strong>作用范围</strong>：锁定设置修改、全量开关、Cookie 更新与清除操作；日常浏览内容无需密码。
              <br />
              • <strong>忘记密码重置方法</strong>：在 Cloudflare Worker（<code>gemini-zhihu-api</code>）→ <code>Settings → Variables and Secrets</code> 重置 <code>COOKIE_WRITE_TOKEN</code>。若已配置 Worker 环境变量 <code>COOKIE_WRITE_TOKEN</code>，也可直接在上方「当前密码」框输入该环境变量值作为恢复主钥重置密码。
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
              onChange={e => updateCfg({ commentsMyAnswers: e.target.value as CommentSyncMode })}
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
              onChange={e => updateCfg({ commentsCollections: e.target.value as CommentSyncMode })}
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
              onChange={e => updateCfg({ commentsUpvotes: e.target.value as CommentSyncMode })}
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
              onChange={e => updateCfg({ commentsFollowing: e.target.value as CommentSyncMode })}
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
              onChange={e => updateCfg({ followingSensitivity: e.target.value as any })}
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

      {/* 模块：图片备份质量设置 */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>🖼️ 图片备份质量</h3>
        <div style={{ fontSize: 13, color: "var(--zhihu-meta)", lineHeight: 1.7, marginBottom: 16 }}>
          正文配图在入库时会自动下载进 R2 备份。<strong>「高质量 / 省空间」</strong>会优先抓取知乎图床官方的
          <code> _1440w </code>/<code> _720w </code>尺寸版本（即知乎自己生成的压缩图），显著节省 R2 空间；
          图床没有对应尺寸版本时会自动回退原图，不会漏备份。该设置<strong>只影响之后新下载的图片</strong>，
          已备份的图片按内容哈希命中，不会重复下载替换。
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>图片备份质量</div>
            <div style={{ fontSize: 12, color: "var(--zhihu-meta)" }}>
              默认原图，备份完整度最高；空间紧张时可选省空间
            </div>
          </div>
          <select
            style={selectStyle}
            value={cfg.imageQuality}
            onChange={e => updateCfg({ imageQuality: e.target.value as ImageQuality })}
          >
            <option value="original">原图（不压缩，最大备份完整度，默认）</option>
            <option value="high">高质量（图床 1440w，视觉接近无损）</option>
            <option value="compressed">省空间（图床 720w，体积明显更小，轻微画质损失）</option>
          </select>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 18, flexWrap: "wrap" }}>
          <button className="btn-primary" onClick={saveConfig} disabled={savingCfg}>
            {savingCfg ? "保存中…" : "💾 保存图片备份质量"}
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
              onChange={e => updateCfg({ preferredAiModel: e.target.value })}
            >
              <option value="@cf/qwen/qwen3-30b-a3b-fp8">通义千问 Qwen3-30B-A3B-FP8（300亿MoE·中文最佳且最省额度）</option>
              <option value="@cf/deepseek-ai/deepseek-v4.1-flash-1017">DeepSeek-V4.1-Flash（深度求索·观点提炼犀利）</option>
              <option value="@cf/zai-org/glm-5.3-flash">智谱 GLM-5.3-Flash（中文语境自然）</option>
              <option value="@cf/meta/llama-3.3-70b-instruct-fp8-fast">Meta Llama-3.3-70B-FP8-Fast（700亿超大参数）</option>
            </select>
          </div>

          {/* Workers AI 额度耗尽替补引擎：每日 Neurons 用尽 / 模型报错时自动无缝改走反代 DeepSeek */}
          <div style={{ paddingTop: 10, borderTop: "1px dashed var(--zhihu-border-light, #e2e8f0)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Workers AI 额度耗尽替补引擎（反代 DeepSeek / OpenAI 兼容接口）</div>
                <div style={{ fontSize: 12, color: "var(--zhihu-meta)", lineHeight: 1.6, maxWidth: 760 }}>
                  每日免费 Neurons 用尽（budget-exhausted）或 Workers AI 模型报错时，自动无缝改走这里配置的反代接口完成风险鉴定与关注答主复核，全部留空则读取环境变量 FALLBACK_AI_BASE_URL / FALLBACK_AI_API_KEY / FALLBACK_AI_MODEL，最后回退默认 http://127.0.0.1:8788/v1
                </div>
              </div>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  padding: "2px 8px",
                  borderRadius: 12,
                  background: cfg.hasFallbackAiKey ? "#dcfce7" : "#f1f5f9",
                  color: cfg.hasFallbackAiKey ? "#15803d" : "#64748b",
                  border: `1px solid ${cfg.hasFallbackAiKey ? "#bbf7d0" : "#e2e8f0"}`,
                  whiteSpace: "nowrap"
                }}
              >
                {cfg.hasFallbackAiKey ? "🔑 已保存 Key（脱敏）" : "未配置 Key"}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginTop: 10 }}>
              <div>
                <label style={fallbackLabelStyle}>Base URL</label>
                <input
                  type="text"
                  placeholder="例如 http://127.0.0.1:8788/v1 或公网反代地址"
                  value={cfg.fallbackAiBaseUrl || ""}
                  onChange={e => updateCfg({ fallbackAiBaseUrl: e.target.value })}
                  style={fallbackInputStyle}
                />
              </div>
              <div>
                <label style={fallbackLabelStyle}>模型名称</label>
                <input
                  type="text"
                  placeholder="deepseek-v4.1-flash"
                  value={cfg.fallbackAiModel || ""}
                  onChange={e => updateCfg({ fallbackAiModel: e.target.value })}
                  style={fallbackInputStyle}
                />
              </div>
              <div>
                <label style={fallbackLabelStyle}>API Key</label>
                <input
                  type="password"
                  placeholder={cfg.hasFallbackAiKey ? "已保存密钥，留空则保持不变" : "本地免 Key 可留空"}
                  value={fallbackKeyInput}
                  onChange={e => setFallbackKeyInput(e.target.value)}
                  disabled={clearFallbackKey}
                  style={{ ...fallbackInputStyle, opacity: clearFallbackKey ? 0.5 : 1 }}
                />
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginTop: 6, color: "var(--zhihu-meta)" }}>
                  <input
                    type="checkbox"
                    checked={clearFallbackKey}
                    onChange={e => setClearFallbackKey(e.target.checked)}
                  />
                  保存时清除已保存的 Key
                </label>
              </div>
            </div>
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

      {/* 模块：外部数据库与多云存储扩展（突破单号免费额度） */}
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h3 style={{ margin: "0 0 6px 0", display: "flex", alignItems: "center", gap: 8 }}>
              <span>🗄️ 外部数据库与多云存储扩展</span>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  padding: "2px 8px",
                  borderRadius: 12,
                  background: "#dcfce7",
                  color: "#15803d",
                  border: "1px solid #bbf7d0"
                }}
              >
                分流扩容 · 透明回读
              </span>
            </h3>
            <div style={{ fontSize: 13, color: "var(--zhihu-meta)", lineHeight: 1.6, maxWidth: 760 }}>
              可挂载其他平台的免费数据库（Turso 9GB SQLite、跨账号 Cloudflare D1/R2、S3 对象存储等），把评论、楼中楼或正文<strong>真正分流</strong>到外部库：主 D1 的 5GB 与主 R2 的 10GB 不再是天花板，网页浏览时自动透明回源读取，完全无感。
            </div>
          </div>
          <button
            type="button"
            className="btn-primary"
            onClick={openAddTargetForm}
            style={{ padding: "7px 14px", fontSize: 13 }}
          >
            ➕ 添加外部存储源
          </button>
        </div>

        {/* 顶部主库状态指示条 */}
        <div
          style={{
            marginTop: 14,
            padding: "10px 14px",
            borderRadius: 8,
            background: "rgba(22, 163, 74, 0.05)",
            border: "1px solid rgba(22, 163, 74, 0.2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 10,
            fontSize: 13
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>🟢</span>
            <span>
              <strong>主存储状态：</strong>Cloudflare D1 (5GB) + R2 (10GB) 已绑定并正常运行
            </span>
          </div>
          <div style={{ color: "var(--zhihu-meta)", fontSize: 12 }}>
            已启用 {targets.filter(t => t.enabled).length} / {targets.length} 个外部存储节点
          </div>
        </div>

        {/* 表单面板（添加/编辑） */}
        {showTargetForm && (
          <div
            style={{
              marginTop: 16,
              padding: 16,
              borderRadius: 8,
              background: "#f8fafc",
              border: "1px solid #e2e8f0"
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>{editingTargetId ? "✏️ 编辑外部存储源" : "➕ 添加外部数据库 / 存储源"}</span>
              <button
                type="button"
                className="btn-ghost"
                onClick={resetTargetForm}
                style={{ padding: "3px 8px", fontSize: 12 }}
              >
                ✕ 取消
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                  存储源类型 (Provider)
                </label>
                <select
                  style={{ ...selectStyle, width: "100%", minWidth: "auto", boxSizing: "border-box" }}
                  value={targetProvider}
                  onChange={e => {
                    const p = e.target.value as ExternalProviderType;
                    setTargetProvider(p);
                    if (p === "cloudflare_d1" && !targetEndpoint) {
                      setTargetEndpoint("https://api.cloudflare.com");
                    }
                  }}
                >
                  <option value="turso">Turso / LibSQL（SQLite 兼容云数据库 · 免费 9GB，推荐）</option>
                  <option value="cloudflare_d1">Cloudflare D1 REST API（跨账号第二套 CF D1 数据库）</option>
                  <option value="supabase">Supabase / PostgreSQL（REST API 模式）</option>
                  <option value="s3_r2">S3 兼容对象存储（外部 R2 / Backblaze B2 / MinIO / 阿里云 OSS）</option>
                  <option value="webhook">自定义 Webhook / 自建同步镜像节点（HTTP Ingest 转发）</option>
                </select>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                  存储源名称 (Name)
                </label>
                <input
                  type="text"
                  placeholder="例如：备用 Turso 评论库 / 跨账号备份 D1"
                  value={targetName}
                  onChange={e => setTargetName(e.target.value)}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "8px 12px",
                    borderRadius: 6,
                    border: "1px solid var(--zhihu-border, #d1d5db)",
                    fontSize: 13
                  }}
                />
              </div>

              <div style={{ gridColumn: "1 / -1" }}>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                  连接地址 (Endpoint URL)
                </label>
                <input
                  type="text"
                  placeholder={
                    targetProvider === "turso"
                      ? "https://your-db-org.turso.io"
                      : targetProvider === "cloudflare_d1"
                      ? "https://api.cloudflare.com（默认即可）"
                      : targetProvider === "supabase"
                      ? "https://your-project.supabase.co"
                      : targetProvider === "s3_r2"
                      ? "https://<account_id>.r2.cloudflarestorage.com 或 S3 Endpoint"
                      : "https://your-nas.example.com/api/webhook"
                  }
                  value={targetEndpoint}
                  onChange={e => setTargetEndpoint(e.target.value)}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "8px 12px",
                    borderRadius: 6,
                    border: "1px solid var(--zhihu-border, #d1d5db)",
                    fontSize: 13,
                    fontFamily: "ui-monospace, monospace"
                  }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                  {targetProvider === "cloudflare_d1"
                    ? "数据库标识 (AccountId/DatabaseId)"
                    : targetProvider === "s3_r2"
                    ? "Bucket 名称 (Bucket Name)"
                    : "数据库标识 / 前缀 (可选)"}
                </label>
                <input
                  type="text"
                  placeholder={
                    targetProvider === "cloudflare_d1"
                      ? "例如：4a9b.../d1-database-uuid"
                      : targetProvider === "s3_r2"
                      ? "例如：my-zhihu-backup"
                      : "可选，库名或前缀"
                  }
                  value={targetDatabaseId}
                  onChange={e => setTargetDatabaseId(e.target.value)}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "8px 12px",
                    borderRadius: 6,
                    border: "1px solid var(--zhihu-border, #d1d5db)",
                    fontSize: 13
                  }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                  访问凭据 / Token (Auth Token / Secret)
                </label>
                <input
                  type="password"
                  placeholder={editingTargetId ? "已保存密钥，留空则保持不变" : "Database Auth Token / CF API Token / Bearer Secret"}
                  value={targetAuthToken}
                  onChange={e => setTargetAuthToken(e.target.value)}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "8px 12px",
                    borderRadius: 6,
                    border: "1px solid var(--zhihu-border, #d1d5db)",
                    fontSize: 13
                  }}
                />
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                工作模式 (storageRole) — 决定这个外部库是「真扩容」还是「只备份」
              </label>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {[
                  {
                    role: "offload" as const,
                    title: "🚀 直接分流扩容（推荐）",
                    desc: "勾选的数据直接存入外部库，不再写入主 D1 / 主 R2，网页读取时自动透明回源拉取，真实节省主库空间与写入配额"
                  },
                  {
                    role: "overflow" as const,
                    title: "📈 主库满额自动溢出",
                    desc: "主 D1 评论行数达到设定水位后，新数据自动切入该外部库接力存储；未达水位前不启用"
                  },
                  {
                    role: "mirror" as const,
                    title: "🛡️ 双写灾备镜像",
                    desc: "主库与外部库同时写入，只做异地防丢备份，不节省主库空间"
                  }
                ].map(item => (
                  <label
                    key={item.role}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      padding: "8px 10px",
                      borderRadius: 6,
                      border: targetStorageRole === item.role ? "1px solid #16a34a" : "1px solid #e2e8f0",
                      background: targetStorageRole === item.role ? "rgba(22, 163, 74, 0.06)" : "#ffffff",
                      cursor: "pointer"
                    }}
                  >
                    <input
                      type="radio"
                      name="storageRole"
                      checked={targetStorageRole === item.role}
                      onChange={() => setTargetStorageRole(item.role)}
                      style={{ marginTop: 3 }}
                    />
                    <span>
                      <span style={{ display: "block", fontSize: 13, fontWeight: 600 }}>{item.title}</span>
                      <span style={{ display: "block", fontSize: 12, color: "var(--zhihu-meta)", marginTop: 2 }}>
                        {item.desc}
                      </span>
                    </span>
                  </label>
                ))}
              </div>

              {targetStorageRole === "overflow" && (
                <div style={{ marginTop: 10 }}>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                    主库溢出水位线（评论行数）
                  </label>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={targetOverflowThreshold}
                    onChange={e => setTargetOverflowThreshold(e.target.value)}
                    style={{
                      width: 220,
                      boxSizing: "border-box",
                      padding: "8px 12px",
                      borderRadius: 6,
                      border: "1px solid var(--zhihu-border, #d1d5db)",
                      fontSize: 13
                    }}
                  />
                  <div style={{ fontSize: 12, color: "var(--zhihu-meta)", marginTop: 4 }}>
                    默认 1,500,000 条 ≈ 约 3.5GB D1 水位；想验证行为可改小，例如 100。
                  </div>
                </div>
              )}
            </div>

            <div style={{ marginTop: 14 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                同步分流范围 (Sync Scopes)
              </label>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                {[
                  { scope: "contents" as const, label: "回答与文章正文 (contents)" },
                  { scope: "comments" as const, label: "评论与楼中楼 (comments)" },
                  { scope: "collections" as const, label: "收藏夹快照 (collections)" },
                  { scope: "upvotes" as const, label: "赞同记录 (upvotes)" }
                ].map(item => (
                  <label key={item.scope} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={targetSyncScopes.includes(item.scope)}
                      onChange={() => toggleTargetScope(item.scope)}
                    />
                    <span>{item.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={targetEnabled}
                  onChange={e => setTargetEnabled(e.target.checked)}
                />
                <span style={{ fontWeight: 500 }}>立即启用此备份节点</span>
              </label>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn-primary"
                onClick={saveTarget}
                disabled={savingTarget || testingTarget}
                style={{ padding: "7px 16px", fontSize: 13 }}
              >
                {savingTarget ? "保存中…" : "💾 保存外部存储源"}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => testConnection()}
                disabled={savingTarget || testingTarget}
                style={{ padding: "7px 14px", fontSize: 13 }}
              >
                {testingTarget ? "测试中…" : "🔌 先测试连接"}
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={resetTargetForm}
                disabled={savingTarget || testingTarget}
                style={{ padding: "7px 12px", fontSize: 13 }}
              >
                取消
              </button>
              {targetActionMsg && (
                <span style={{ fontSize: 13, color: targetActionMsg.type === "ok" ? "#16a34a" : "#dc2626" }}>
                  {targetActionMsg.text}
                </span>
              )}
            </div>
          </div>
        )}

        {/* 外部存储源列表 */}
        <div style={{ marginTop: 16 }}>
          {loadingTargets && targets.length === 0 ? (
            <div style={{ textAlign: "center", padding: 20, color: "var(--zhihu-meta)", fontSize: 13 }}>
              加载外部存储列表中…
            </div>
          ) : targets.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "28px 16px",
                border: "1px dashed #cbd5e1",
                borderRadius: 8,
                color: "var(--zhihu-meta)",
                fontSize: 13
              }}
            >
              尚未添加任何外部存储目标。点击右上角「➕ 添加外部存储源」，即可挂载免费的 Turso 9GB 或第二套 D1/R2，把评论 / 正文直接分流出去，帮主库突破 5GB 上限。
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {targets.map(t => {
                const isTesting = testingTargetId === t.id;
                const providerNames: Record<ExternalProviderType, { name: string; icon: string }> = {
                  turso: { name: "Turso (LibSQL)", icon: "⚡" },
                  cloudflare_d1: { name: "跨账号 Cloudflare D1", icon: "☁️" },
                  supabase: { name: "Supabase Postgres", icon: "🐘" },
                  s3_r2: { name: "S3 / 外部 R2", icon: "📦" },
                  webhook: { name: "自定义 Webhook", icon: "🔗" }
                };
                const pInfo = providerNames[t.provider] || { name: t.provider, icon: "🗄️" };
                const roleInfo =
                  t.storageRole === "overflow"
                    ? {
                        label: `📈 满额溢出待命 (阈值 ${(t.overflowThresholdRows || DEFAULT_OVERFLOW_THRESHOLD_ROWS).toLocaleString("zh-CN")} 行)`,
                        bg: "#fef3c7",
                        color: "#92400e",
                        border: "#fde68a"
                      }
                    : t.storageRole === "mirror"
                    ? { label: "🛡️ 双写镜像", bg: "#dbeafe", color: "#1e40af", border: "#bfdbfe" }
                    : { label: "🚀 分流扩容中", bg: "#ede9fe", color: "#6d28d9", border: "#ddd6fe" };

                return (
                  <div
                    key={t.id}
                    style={{
                      border: "1px solid #e2e8f0",
                      borderRadius: 8,
                      padding: "14px 16px",
                      background: t.enabled ? "#ffffff" : "#f8fafc",
                      display: "flex",
                      flexDirection: "column",
                      gap: 10
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 18 }}>{pInfo.icon}</span>
                        <strong style={{ fontSize: 15 }}>{t.name}</strong>
                        <span style={{ fontSize: 12, color: "var(--zhihu-meta)" }}>（{pInfo.name}）</span>
                        <span
                          style={{
                            fontSize: 11,
                            padding: "1px 6px",
                            borderRadius: 10,
                            background: t.enabled ? "#dcfce7" : "#fee2e2",
                            color: t.enabled ? "#15803d" : "#b91c1c",
                            fontWeight: 500
                          }}
                        >
                          {t.enabled ? "运行中" : "已暂停"}
                        </span>
                        <span
                          style={{
                            fontSize: 11,
                            padding: "1px 6px",
                            borderRadius: 10,
                            background: roleInfo.bg,
                            color: roleInfo.color,
                            border: `1px solid ${roleInfo.border}`,
                            fontWeight: 500
                          }}
                        >
                          {roleInfo.label}
                        </span>
                      </div>

                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => testConnection(t.id)}
                          disabled={isTesting}
                          style={{ padding: "4px 10px", fontSize: 12 }}
                        >
                          {isTesting ? "测试中…" : "🔌 测试连接"}
                        </button>
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => toggleTargetEnabled(t)}
                          style={{ padding: "4px 10px", fontSize: 12 }}
                        >
                          {t.enabled ? "⏸️ 暂停" : "▶️ 启用"}
                        </button>
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => openEditTargetForm(t)}
                          style={{ padding: "4px 10px", fontSize: 12 }}
                        >
                          ✏️ 编辑
                        </button>
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => deleteTarget(t)}
                          style={{ padding: "4px 10px", fontSize: 12, color: "#dc2626" }}
                        >
                          🗑️ 删除
                        </button>
                      </div>
                    </div>

                    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 20px", fontSize: 12, color: "var(--zhihu-meta)" }}>
                      <div>
                        <strong>地址：</strong>
                        <code style={{ fontSize: 11, background: "#f1f5f9", padding: "2px 6px", borderRadius: 4 }}>
                          {t.endpointUrl}
                        </code>
                      </div>
                      {t.databaseId && (
                        <div>
                          <strong>标识：</strong>
                          <code style={{ fontSize: 11, background: "#f1f5f9", padding: "2px 6px", borderRadius: 4 }}>
                            {t.databaseId}
                          </code>
                        </div>
                      )}
                      <div>
                        <strong>密钥：</strong>
                        <span>{t.hasToken ? (t.maskedToken || "已配置密钥") : "无密钥"}</span>
                      </div>
                      <div>
                        <strong>分流范围：</strong>
                        <span>
                          {t.syncScopes
                            .map(s => {
                              if (s === "contents") return "回答/文章";
                              if (s === "comments") return "评论与楼中楼";
                              if (s === "collections") return "收藏夹";
                              if (s === "upvotes") return "赞同记录";
                              return s;
                            })
                            .join("、")}
                        </span>
                      </div>
                    </div>

                    {/* 测试结果行 */}
                    <div style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6, paddingTop: 6, borderTop: "1px dashed #f1f5f9" }}>
                      <strong>连通状态：</strong>
                      {t.lastTestAt ? (
                        <span style={{ color: t.lastTestOk ? "#16a34a" : "#dc2626" }}>
                          {t.lastTestOk ? "🟢" : "🔴"} {t.lastTestMsg || (t.lastTestOk ? "探测正常" : "探测失败")}
                          <span style={{ color: "var(--zhihu-meta)", marginLeft: 6 }}>
                            ({fmtTime(t.lastTestAt)})
                          </span>
                        </span>
                      ) : (
                        <span style={{ color: "var(--zhihu-meta)" }}>⚪ 尚未进行连通性测试</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
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
