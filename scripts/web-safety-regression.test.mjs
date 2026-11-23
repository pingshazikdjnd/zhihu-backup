/**
 * Web 请求竞态 / 凭据边界 / Pages 安全头回归测试（纯静态 + vm 隔离 + worker 单测）
 *
 * 不启动 vite / worker / 浏览器，不 import 任何会执行副作用的页面组件；
 * api.ts 中的纯辅助函数通过源码提取后在 vm 里执行，页面只做源码约束断言。
 * _worker.js 无顶层副作用，用假的 ASSETS/API binding 直接调用 fetch 验证响应头。
 * 这些测试不能证明真实浏览器 UI 已通过，只覆盖可静态/纯逻辑验证的部分。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

/** 从 TS 源码中提取函数体（函数体本身必须是纯 JS，不含类型注解） */
function extractFunctionBody(src, name) {
  const header = new RegExp(`function\\s+${name}\\s*\\(([^)]*)\\)`).exec(src);
  assert.ok(header, `源码中缺少函数 ${name}`);
  const params = header[1]
    .split(",")
    .map(part => part.trim().split(":")[0].replace(/\?$/, "").trim())
    .filter(Boolean);
  const braceStart = src.indexOf("{", header.index + header[0].length);
  assert.ok(braceStart >= 0, `函数 ${name} 缺少函数体`);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end >= 0, `函数 ${name} 函数体未闭合`);
  return { params, body: src.slice(braceStart + 1, end) };
}

function loadFunctions(src, names, sandbox, prelude = "") {
  const declarations = names.map(name => {
    const { params, body } = extractFunctionBody(src, name);
    return `function ${name}(${params.join(", ")}) {${body}}`;
  });
  const context = vm.createContext(sandbox);
  vm.runInContext(
    [prelude, ...declarations, `globalThis.__fns = { ${names.join(", ")} };`].filter(Boolean).join("\n"),
    context
  );
  return sandbox.__fns;
}

const apiSrc = read("apps/web/src/lib/api.ts");
const aiAssessSrc = read("apps/web/src/lib/ai-assess.ts");
const contentsSrc = read("apps/web/src/pages/ContentsPage.tsx");
const questionsSrc = read("apps/web/src/pages/QuestionsPage.tsx");
const followingSrc = read("apps/web/src/pages/FollowingPage.tsx");
const recommendSrc = read("apps/web/src/pages/RecommendPage.tsx");
const collectionSrc = read("apps/web/src/pages/CollectionDetailPage.tsx");
const workerSrc = read("apps/web/public/_worker.js");
const indexHtml = read("apps/web/index.html");

// ---------------------------------------------------------------------------
// api.ts：同源口令边界 + URL 解析
// ---------------------------------------------------------------------------
test("api.ts：自动口令只对同源目标生效，跨源永不自动外发", () => {
  assert.match(
    apiSrc,
    /!headers\.has\("authorization"\)[\s\S]{0,220}isSameOriginRequest\(path, API_BASE, requestOrigin\)/,
    "自动附带 Authorization 必须同时满足调用方未传凭据且 isSameOriginRequest 为真"
  );
  assert.match(apiSrc, /const token = resolveWriteToken\(\);/, "同源分支内才读取 localStorage 口令");
  assert.doesNotMatch(apiSrc, /headers\.delete\("authorization"\)/i, "不得删除调用方显式传入的凭据");

  const fns = loadFunctions(apiSrc, ["joinApiBase", "resolveRequestUrl", "isSameOriginRequest"], { URL });
  const origin = "https://pages.example";
  assert.equal(fns.isSameOriginRequest("/api/contents?page=1", "", origin), true);
  assert.equal(fns.isSameOriginRequest("/api/contents", origin, origin), true);
  assert.equal(fns.isSameOriginRequest("/api/contents", "https://api.example.com", origin), false);
  assert.equal(fns.isSameOriginRequest("/api/contents", "https://api.example.com/", origin), false);
  assert.equal(fns.isSameOriginRequest("//api.example.com/x", "", origin), false);
  assert.equal(fns.isSameOriginRequest("/api/contents", "", "null"), false, "不可解析 origin 时不得发口令");
  assert.equal(fns.isSameOriginRequest("/api/contents", "https://[", origin), false);
});

test("api.ts：new URL 合并保留相对路径、末尾斜杠与查询参数", () => {
  const fns = loadFunctions(apiSrc, ["joinApiBase", "resolveRequestUrl"], { URL });
  const origin = "https://pages.example";
  assert.equal(fns.resolveRequestUrl("/api/contents?page=1&sort=time", "", origin), `${origin}/api/contents?page=1&sort=time`);
  assert.equal(fns.resolveRequestUrl("/api/x/", "https://api.example.com/", origin), "https://api.example.com/api/x/");
  assert.equal(fns.resolveRequestUrl("/api/x?q=a%20b", "https://api.example.com/base", origin), "https://api.example.com/base/api/x?q=a%20b");
  assert.equal(fns.resolveRequestUrl("api/items?page=1", "https://api.example.com/v1/", origin), "https://api.example.com/v1/api/items?page=1");
  assert.equal(fns.joinApiBase("/", "/api/images/a.png"), "/api/images/a.png");
  assert.equal(fns.resolveRequestUrl("/api/x", "", undefined), "/api/x", "无 window 时保留历史相对拼接");
});

function makeAbortHarness() {
  const timers = [];
  const cleared = [];
  const fakeAbortSignal = function () {};
  const sandbox = {
    URL,
    AbortController,
    AbortSignal: fakeAbortSignal,
    setTimeout: (fn, ms) => {
      const id = timers.length + 1;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimeout: id => {
      cleared.push(id);
    }
  };
  const fns = loadFunctions(
    apiSrc,
    ["createTimeoutAbort", "createRequestAbort"],
    sandbox,
    "const REQUEST_TIMEOUT_MS = 30000;\nconst ABORT_SIGNAL_STATICS = AbortSignal;"
  );
  return { fns, timers, cleared };
}

test("api.ts：30 秒超时降级会 clearTimeout，超时能中止请求", () => {
  const h = makeAbortHarness();
  const abort = h.fns.createRequestAbort(undefined);
  assert.equal(h.timers.length, 1, "无 AbortSignal.timeout 时应设置降级定时器");
  assert.equal(h.timers[0].ms, 30000);
  assert.equal(abort.signal.aborted, false);
  h.timers[0].fn();
  assert.equal(abort.signal.aborted, true, "30 秒后必须中止请求");
  abort.cleanup();
  assert.deepEqual(h.cleared, [h.timers[0].id], "请求结束必须清理定时器");
});

test("api.ts：options.signal 与超时信号都会生效，cleanup 移除监听器", () => {
  const h = makeAbortHarness();
  const external = new AbortController();
  const abort = h.fns.createRequestAbort(external.signal);
  assert.equal(abort.signal.aborted, false);
  external.abort();
  assert.equal(abort.signal.aborted, true, "调用方 signal 必须能中止组合信号");
  abort.cleanup();
  assert.deepEqual(h.cleared, [h.timers[0].id]);

  const h2 = makeAbortHarness();
  const external2 = new AbortController();
  const abort2 = h2.fns.createRequestAbort(external2.signal);
  abort2.cleanup();
  external2.abort();
  assert.equal(abort2.signal.aborted, false, "cleanup 后必须移除监听器，旧 signal 不再影响请求");
});

test("api.ts：优先使用 AbortSignal.any 组合两个 signal", () => {
  const anyCalls = [];
  let timeoutMs = 0;
  const fakeTimeout = { aborted: false };
  const fakeCombined = { aborted: false };
  const fakeAbortSignal = function () {};
  fakeAbortSignal.timeout = ms => {
    timeoutMs = ms;
    return fakeTimeout;
  };
  fakeAbortSignal.any = signals => {
    anyCalls.push(signals);
    return fakeCombined;
  };
  const fns = loadFunctions(
    apiSrc,
    ["createTimeoutAbort", "createRequestAbort"],
    { URL, AbortSignal: fakeAbortSignal },
    "const REQUEST_TIMEOUT_MS = 30000;\nconst ABORT_SIGNAL_STATICS = AbortSignal;"
  );
  const external = { aborted: false };
  const result = fns.createRequestAbort(external);
  assert.equal(timeoutMs, 30000);
  assert.equal(anyCalls.length, 1);
  assert.equal(anyCalls[0][0], external);
  assert.equal(anyCalls[0][1], fakeTimeout);
  assert.equal(result.signal, fakeCombined);
  result.cleanup();
});

test("api.ts：fetch 使用统一 URL 解析与组合 signal，并在 finally 清理", () => {
  assert.match(apiSrc, /fetch\(resolveRequestUrl\(path, API_BASE, requestOrigin\)/);
  assert.match(apiSrc, /signal: abort\.signal/);
  assert.match(apiSrc, /finally \{[\s\S]{0,160}abort\.cleanup\(\)/);
  assert.doesNotMatch(apiSrc, /options\?\.signal \?\? timeoutSignal\(\)/, "不得再用只取其一的旧逻辑");
});

// ---------------------------------------------------------------------------
// ContentsPage：双列表竞态 / 排序缓存 / 搜索与列表 loading 隔离
// ---------------------------------------------------------------------------
test("ContentsPage：answers/upvotes 独立序号且校验当前 tab", () => {
  assert.match(contentsSrc, /const answersReqRef = useRef\(0\)/);
  assert.match(contentsSrc, /const upvotesReqRef = useRef\(0\)/);
  assert.match(contentsSrc, /const activeTabRef = useRef</);
  assert.match(contentsSrc, /const seq = \+\+answersReqRef\.current/);
  assert.match(contentsSrc, /const seq = \+\+upvotesReqRef\.current/);
  assert.match(
    contentsSrc,
    /seq === ref\.current && activeTabRef\.current === tab/,
    "旧请求必须同时校验序号与当前 tab"
  );
  assert.match(contentsSrc, /answersReqRef\.current\+\+[\s\S]{0,80}upvotesReqRef\.current\+\+/, "切 tab / 换排序要作废两个列表的旧请求");
});

test("ContentsPage：排序切换同时失效两个 tab 的缓存并复位页码", () => {
  assert.match(contentsSrc, /contentsStore\.answersData = \[\]/);
  assert.match(contentsSrc, /contentsStore\.upvotesData = \[\]/);
  assert.match(contentsSrc, /contentsStore\.answersPage = 1/);
  assert.match(contentsSrc, /contentsStore\.upvotesPage = 1/);
  assert.match(contentsSrc, /setAnswersData\(\[\]\)[\s\S]{0,120}setUpvotesData\(\[\]\)/);
  assert.match(contentsSrc, /fetchAnswers\(1, nextSort\)[\s\S]{0,80}else \{[\s\S]{0,40}fetchUpvotes\(1, nextSort\)/);
});

test("ContentsPage：搜索与列表 loading 拆分，搜索输入不触发列表请求", () => {
  assert.match(contentsSrc, /const \[listLoading, setListLoading\] = useState\(false\)/);
  assert.match(contentsSrc, /const \[searchLoading, setSearchLoading\] = useState\(false\)/);
  assert.match(contentsSrc, /setSearchLoading\(true\)/);
  assert.match(contentsSrc, /if \(seq === searchSeqRef\.current\) setSearchLoading\(false\)/);
  assert.doesNotMatch(contentsSrc, /setIsLoading/);
  assert.match(contentsSrc, /\}, 300\);/, "搜索防抖语义保持不变");
  assert.match(
    contentsSrc,
    /if \(activeTab === "answers" && answersData\.length === 0\) fetchAnswers\(1\)[\s\S]{0,160}\}, \[activeTab\]\);/,
    "列表首载只依赖 activeTab，不能被 keyword 误触"
  );
});

test("ContentsPage：IntersectionObserver 用 inFlight 防同页重复请求，卸载断开", () => {
  assert.match(contentsSrc, /const inFlightRef = useRef<string \| null>\(null\)/);
  assert.match(contentsSrc, /const requestKey = \(tab: "answers" \| "upvotes", page: number, sort: "time" \| "vote"\)/);
  assert.match(contentsSrc, /inFlightRef\.current === requestKey\("answers", nextPage, sortBy\)/);
  assert.match(contentsSrc, /inFlightRef\.current === requestKey\("upvotes", nextPage, sortBy\)/);
  assert.match(contentsSrc, /if \(!node\) \{[\s\S]{0,120}observer\.current\?\.disconnect\(\)/);
});

// ---------------------------------------------------------------------------
// QuestionsPage：列表序号 / 卸载守卫
// ---------------------------------------------------------------------------
test("QuestionsPage：列表回包写 rows/page/total/store 前校验请求序号与卸载状态", () => {
  assert.match(questionsSrc, /const reqIdRef = useRef\(0\)/);
  assert.match(questionsSrc, /const aliveRef = useRef\(true\)/);
  assert.match(questionsSrc, /const seq = \+\+reqIdRef\.current/);
  assert.match(questionsSrc, /if \(!aliveRef\.current \|\| seq !== reqIdRef\.current\) return/);
  assert.match(questionsSrc, /aliveRef\.current = false;[\s\S]{0,80}reqIdRef\.current\+\+/, "卸载时必须作废在途请求");
  assert.match(questionsSrc, /questionsStore\.list = next/);
  assert.match(questionsSrc, /questionsStore\.page = p/);
  assert.match(questionsSrc, /questionsStore\.total = res\.total/);
  assert.match(questionsSrc, /if \(aliveRef\.current && seq === reqIdRef\.current\) setIsLoading\(false\)/);
  // 详情页已有的 alive 保护不能被删除
  assert.match(questionsSrc, /let alive = true;[\s\S]{0,600}if \(!alive\) return/);
});

// ---------------------------------------------------------------------------
// FollowingPage：详情加载错误/重试/竞态
// ---------------------------------------------------------------------------
test("FollowingPage：loadDetail 有 catch/loadError/重试，网络失败不再显示未找到", () => {
  assert.match(followingSrc, /const \[loadError, setLoadError\] = useState\(""\)/);
  assert.match(followingSrc, /const seq = \+\+seqRef\.current/);
  assert.match(followingSrc, /const requestToken = urlToken/);
  assert.match(followingSrc, /requestToken !== urlTokenRef\.current/);
  assert.match(followingSrc, /setLoadError\(e\?\.message \|\| "加载答主详情失败"\)/);
  assert.match(
    followingSrc,
    /if \(!res\?\.user\) \{[\s\S]{0,200}setLoadError\("未找到该答主"\)/,
    "只有接口明确无 user 才提示未找到"
  );
  assert.match(followingSrc, /if \(seq === seqRef\.current && requestToken === urlTokenRef\.current\) setLoading\(false\)/);
  assert.match(followingSrc, /onClick=\{\(\) => loadDetail\(onlyRisk\)\}/, "错误态需要重试按钮");
  assert.match(followingSrc, /finally \{[\s\S]{0,80}setLoading\(false\)/, "详情请求必须有 finally 收尾");
});

test("FollowingPage：onlyRisk 旧响应不覆盖，刷新失败由 loadDetail 自己展示", () => {
  const start = followingSrc.indexOf("const loadDetail = async");
  const end = followingSrc.indexOf("useEffect(() => {\n    loadDetail(onlyRisk);");
  assert.ok(start >= 0 && end > start, "未找到 loadDetail 代码块");
  const block = followingSrc.slice(start, end);
  assert.match(block, /seq !== seqRef\.current \|\| requestToken !== urlTokenRef\.current/);
  assert.match(block, /setLoadError/);
  assert.ok(!/\bthrow\b/.test(block), "loadDetail 必须自行吞掉刷新错误，避免 toggleFullMode 重复弹窗");
  assert.match(followingSrc, /await loadDetail\(onlyRisk\)/);
  assert.doesNotMatch(followingSrc, /alert\(`切换失败: \$\{e\?\.message \|\| e\}`\)[\s\S]{0,40}loadDetail/);
});

// ---------------------------------------------------------------------------
// RecommendPage：找相似错误与并行 loading
// ---------------------------------------------------------------------------
test("RecommendPage：handleFindSimilar 有 catch/独立错误态/每 pk 序号", () => {
  assert.match(recommendSrc, /const \[similarError, setSimilarError\] = useState<Record<string, string>>\(\{\}\)/);
  assert.match(recommendSrc, /const similarSeqRef = useRef<Record<string, number>>\(\{\}\)/);
  assert.match(recommendSrc, /const seq = \(similarSeqRef\.current\[pk\] \|\| 0\) \+ 1/);
  assert.match(recommendSrc, /catch \(err: any\) \{[\s\S]{0,200}setSimilarError/);
  assert.match(recommendSrc, /similarSeqRef\.current\[pk\] !== seq/);
  assert.match(recommendSrc, /prev === pk \? null : prev/, "finally 只能清当前 pk 的 loading");
  assert.match(recommendSrc, /recommendStore\.similarCache = next/, "保留原有相似结果缓存行为");
  assert.match(recommendSrc, /similarError\[item\.pk\]/, "错误需要在页内可见");
});

// ---------------------------------------------------------------------------
// CollectionDetailPage：id 切换 / alive / store 闭包
// ---------------------------------------------------------------------------
test("CollectionDetailPage：id 变化按 key 重建，请求带 alive 且只写闭包 id", () => {
  assert.match(collectionSrc, /<CollectionDetail key=\{id\} id=\{id\} \/>/);
  assert.match(collectionSrc, /function CollectionDetail\(\{ id \}: \{ id: string \}\)/);
  assert.match(collectionSrc, /let alive = true/);
  assert.match(collectionSrc, /if \(!alive\) return/g);
  assert.match(collectionSrc, /\}, \[id, retryKey\]\);/);
  assert.doesNotMatch(collectionSrc, /\[id, detail, retryKey\]/, "effect 不能再依赖 detail，否则 B 无法加载");
  assert.match(collectionSrc, /collectionsStore\[id\] = \{ data, scrollPosition: 0, visibleCount: 50 \}/);
  assert.match(collectionSrc, /setDetail\(null\)/, "切换收藏夹时必须先清掉旧 detail");
});

// ---------------------------------------------------------------------------
// _worker.js：仅 HTML 安全头 + ingest 404
// ---------------------------------------------------------------------------
const workerModule = await import(pathToFileURL(path.join(ROOT, "apps/web/public/_worker.js")).href);
const worker = workerModule.default;

function htmlResponse(body = "<html><body>ok</body></html>") {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function makeEnv(assetFetch, apiFetch) {
  const calls = { assets: 0, api: 0 };
  const env = {
    ASSETS: {
      fetch: async request => {
        calls.assets++;
        return assetFetch(request);
      }
    },
    API: {
      fetch: async request => {
        calls.api++;
        return apiFetch(request);
      }
    }
  };
  return { env, calls };
}

test("_worker.js：HTML 响应附加 CSP 与安全头，且兼容 Vite/本地图片", async () => {
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(indexHtml), "index.html 不得有 inline script，否则 script-src 'self' 会白屏");
  const { env } = makeEnv(async () => htmlResponse(), async () => new Response("{}"));
  const res = await worker.fetch(new Request("https://pages.example/"), env);
  const csp = res.headers.get("content-security-policy") || "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /img-src 'self' data: https:/);
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  assert.match(csp, /connect-src 'self' https:/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.match(res.headers.get("referrer-policy") || "", /strict-origin/);
  assert.equal(await res.text(), "<html><body>ok</body></html>");
});

test("_worker.js：二进制响应原样透传，不强制 CSP 也不做字符串转换", async () => {
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
  const { env } = makeEnv(
    async () => new Response(bytes, { headers: { "content-type": "image/png" } }),
    async () => new Response("{}")
  );
  const res = await worker.fetch(new Request("https://pages.example/logo.png"), env);
  assert.equal(res.headers.get("content-security-policy"), null);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
});

test("_worker.js：API JSON 不追加 CSP，仍正常转发 /api/*", async () => {
  const { env, calls } = makeEnv(
    async () => {
      throw new Error("assets must not be called for /api/*");
    },
    async () => new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } })
  );
  const res = await worker.fetch(new Request("https://pages.example/api/contents"), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get("content-security-policy"), null);
  assert.equal(calls.api, 1);
  assert.equal(calls.assets, 0);
});

test("_worker.js：/ingest/* 仅对携带非空 Bearer 的请求转发到 Service Binding，其余返回 404", async () => {
  const { env, calls } = makeEnv(
    async () => htmlResponse(),
    async request => {
      assert.equal(request.headers.get("authorization"), "Bearer secret-123");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  );

  // 1) 无 Authorization 头：直接 404 且不转发 Service Binding
  const noAuthRes = await worker.fetch(
    new Request("https://pages.example/ingest/sync-state", { method: "GET" }),
    env
  );
  assert.equal(noAuthRes.status, 404);
  assert.equal(calls.api, 0);
  assert.equal(calls.assets, 0);

  // 2) 空 Bearer：同样返回 404
  const emptyBearerRes = await worker.fetch(
    new Request("https://pages.example/ingest/abc", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer   " },
      body: "{}"
    }),
    env
  );
  assert.equal(emptyBearerRes.status, 404);
  assert.equal(calls.api, 0);

  // 3) 携带有效 Bearer 头：透传至 env.API 并返回 200
  const okRes = await worker.fetch(
    new Request("https://pages.example/ingest/sync-state", {
      method: "GET",
      headers: { authorization: "Bearer secret-123" }
    }),
    env
  );
  assert.equal(okRes.status, 200);
  assert.deepEqual(await okRes.json(), { ok: true });
  assert.equal(calls.api, 1);
  assert.equal(calls.assets, 0);

  // 4) env.API 缺失时 fail-closed 返回 404
  const noBindingRes = await worker.fetch(
    new Request("https://pages.example/ingest/sync-state", {
      headers: { authorization: "Bearer secret-123" }
    }),
    { ASSETS: env.ASSETS }
  );
  assert.equal(noBindingRes.status, 404);
});

test("_worker.js：SPA fallback 返回 index.html 并补安全头，非 HTML 404 不强制 CSP", async () => {
  const { env, calls } = makeEnv(
    async request => {
      const pathname = request instanceof URL ? request.pathname : new URL(request.url).pathname;
      if (pathname === "/index.html") return htmlResponse("<html>spa</html>");
      return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    },
    async () => new Response("{}")
  );
  const res = await worker.fetch(
    new Request("https://pages.example/contents/123", { headers: { accept: "text/html,application/xhtml+xml" } }),
    env
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "<html>spa</html>");
  assert.match(res.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(calls.assets, 2);

  const { env: env2 } = makeEnv(
    async () => new Response("missing", { status: 404, headers: { "content-type": "application/json" } }),
    async () => new Response("{}")
  );
  const res2 = await worker.fetch(
    new Request("https://pages.example/missing", { headers: { accept: "application/json" } }),
    env2
  );
  assert.equal(res2.status, 404);
  assert.equal(res2.headers.get("content-security-policy"), null);
});

test("_worker.js：源码只允许 HTML 分支设置 CSP，/ingest/* 校验 Bearer", () => {
  assert.match(workerSrc, /contentType\.toLowerCase\(\)\.includes\("text\/html"\)/);
  assert.match(workerSrc, /new Response\(res\.body, \{/);
  assert.match(workerSrc, /headers\.set\("content-security-policy", HTML_CSP\)/);
  assert.doesNotMatch(workerSrc, /text\(\)|textContent|String\(res\.body\)/, "不得把二进制 body 转成字符串");
  assert.match(workerSrc, /url\.pathname\.startsWith\("\/ingest\/"\)[\s\S]{0,220}status: 404/);
  assert.match(workerSrc, /if \(!\/\^Bearer\\s\+\\S\+\/i\.test\(auth\) \|\| !env\.API\)/);
  assert.match(workerSrc, /return env\.API\.fetch\(request\);/);
});

test("前端边界与安全增强：ErrorBoundary 路由复位、sanitize 防御大小写与 //、存储/标签页/查询原子更新", () => {
  const appSrc = read("apps/web/src/App.tsx");
  const sanitizeSrc = read("apps/web/src/lib/sanitize.ts");
  const collectionsSrc = read("apps/web/src/pages/CollectionsPage.tsx");
  const authSrc = read("apps/web/src/pages/AuthPage.tsx");
  const storeSrc = read("apps/web/src/lib/store.ts");

  assert.match(appSrc, /<ErrorBoundary key=\{location\.pathname\}>/);
  assert.match(sanitizeSrc, /\/\^\(https\?:\)\?\\\/\\\/\/i\.test\(href\)/);
  assert.match(sanitizeSrc, /node\.getAttribute\("target"\) === "_blank"/);

  assert.match(storeSrc, /answersTotal:\s*null as number \| null/);
  assert.match(contentsSrc, /contentsStore\.answersTotal = res\.total/);
  assert.match(contentsSrc, /contentsStore\.answersData = nextAnswers;\s*contentsStore\.answersPage = page;/);
  assert.match(contentsSrc, /contentsStore\.upvotesData = nextUpvotes;\s*contentsStore\.upvotesPage = page;/);
  assert.match(contentsSrc, /useEffect\(\(\) => \(\) => \{\s*answersReqRef\.current\+\+;\s*upvotesReqRef\.current\+\+;\s*\}, \[\]\)/);

  assert.match(collectionsSrc, /itemsSeqRef\.current\+\+;/);
  assert.match(collectionsSrc, /if \(!aliveRef\.current \|\| seq !== itemsSeqRef\.current\) return;/);
  assert.match(collectionsSrc, /allCollectionsStore\.items = nextItems;\s*allCollectionsStore\.itemsPage = page;/);
  assert.match(collectionsSrc, /setError\(""\); setActiveTab\("collections"\)/);
  assert.match(collectionsSrc, /setError\(""\); setActiveTab\("items"\)/);

  assert.match(authSrc, /function safeGetStorage\(/);
  assert.match(authSrc, /function safeSetStorage\(/);
  assert.match(authSrc, /\(!cfgInitRef\.current \|\| syncForm\) && !cfgDirtyRef\.current/);
  assert.match(authSrc, /resetTimerRef\.current/);

  assert.match(questionsSrc, /questionsStore\.list = nextRows;/);
  assert.match(questionsSrc, /setActiveQ\(committedQ\);\s*questionsStore\.page = p;\s*questionsStore\.q = committedQ;/);
  assert.doesNotMatch(questionsSrc, /const handleSearch[\s\S]{0,160}questionsStore\.q = trimmed;/);
});

test("前端 P2-1 / P2-6 / P1-1 / P2-5 回归：跨源不外泄口令、同页去重、筛选切 Tab 重拉与空格/双击防护", async () => {
  const commentTreeSrc = read("apps/web/src/components/CommentTree.tsx");

  // 1) FollowingPage & RecommendPage & ai-assess.ts：首次请求不主动读 localStorage 传 Authorization，
  //    交由 api() 同源策略控制；仅 401/403 弹窗输入非空/非纯空格口令重试后，才传入 Authorization 并 safeSetWriteToken（保留 try/catch 保护）
  for (const [label, src] of [["FollowingPage", followingSrc], ["RecommendPage", recommendSrc]]) {
    assert.doesNotMatch(src, /safeGetWriteToken/, `${label} 首次请求不得自行读取 localStorage 口令`);
    const directLsCalls = src.match(/\blocalStorage\.(getItem|setItem)/g) || [];
    assert.equal(directLsCalls.length, 0, `${label} 不得直接调用 localStorage，应复用 ai-assess.ts 的 safeSetWriteToken`);
    assert.match(src, /from ["']\.\.\/lib\/ai-assess\.js["']/, `${label} 必须复用共享 ai-assess.ts 模块`);
    assert.match(src, /await assessContentRisk\(/, `${label} handleAiAssess 必须调用共享 assessContentRisk`);
  }
  assert.doesNotMatch(aiAssessSrc, /safeGetWriteToken/, "ai-assess.ts 首次请求不得自行读取 localStorage 口令");
  assert.match(aiAssessSrc, /export function safeSetWriteToken\(/, "ai-assess.ts 必须导出 safeSetWriteToken");
  const aiLsCalls = aiAssessSrc.match(/\blocalStorage\.(getItem|setItem)/g) || [];
  assert.equal(aiLsCalls.length, 1, "ai-assess.ts 只允许在 safeSetWriteToken 中调用 localStorage.setItem");
  assert.match(aiAssessSrc, /if \(tokenStr && tokenStr\.trim\(\)\) headers\.authorization = `Bearer \$\{tokenStr\.trim\(\)\}`/);
  assert.match(aiAssessSrc, /window\.prompt\("AI 风险鉴定需验证操作密码/);
  assert.match(aiAssessSrc, /if \(aiResults\[pk\] \|\| aiLoadingSetRef\.current\.has\(pk\)\) return;/, "assessContentRisk 必须拦截正在加载中的双击");
  assert.match(aiAssessSrc, /const trimmed = input\?\.trim\(\) \|\| "";\s*if \(!trimmed\)/, "ai-assess.ts prompt 必须拦截纯空格输入");
  assert.match(aiAssessSrc, /await callAssess\(\);/, "assessContentRisk 首次请求必须无参调用 callAssess()");
  assert.match(followingSrc, /await doCall\(\);/, "postUserModeWithAuth 首次请求必须无参调用 doCall()");

  // 1b) 行为验证 [P1-1]：跨源 VITE_API_BASE + 预置 localStorage.cookie_write_token 时，
  //     postUserModeWithAuth 首次请求不携带 Authorization；prompt 纯空格取消不发请求；输入口令重试才携带
  const { createRequire } = await import("node:module");
  const webRequire = createRequire(path.join(ROOT, "apps", "web", "package.json"));
  const tsMod = await import(pathToFileURL(webRequire.resolve("typescript")).href);
  const ts = tsMod.default ?? tsMod;
  const transpile = src =>
    ts.transpileModule(src, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX
      }
    }).outputText;

  const apiJs = transpile(apiSrc);
  const aiAssessJs = transpile(aiAssessSrc)
    .replace(/^\s*import\s+[^;]+;\s*$/gm, "")
    .replace(/\bexport\s+/g, "");
  const followingJs = transpile(followingSrc);

  const localStore = new Map([["cookie_write_token", "local-secret-token"]]);
  const fetchCalls = [];
  let promptQueue = [];
  const lsMock = {
    getItem: k => localStore.get(k) ?? null,
    setItem: (k, v) => { localStore.set(k, String(v)); }
  };
  const sharedSandbox = {
    URL,
    Headers,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    Response,
    window: {
      location: { origin: "https://pages.example" },
      localStorage: lsMock,
      prompt: () => promptQueue.shift() ?? null
    },
    localStorage: lsMock,
    fetch: async (url, init) => {
      const headersObj = Object.fromEntries(new Headers(init?.headers).entries());
      fetchCalls.push({ url: String(url), headers: headersObj });
      if (!headersObj.authorization) {
        return { ok: false, status: 401, text: async () => "Unauthorized" };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
  };
  const syncDecls = [
    ...["joinApiBase", "resolveRequestUrl", "isSameOriginRequest", "createTimeoutAbort", "createRequestAbort", "resolveWriteToken"].map(name => {
      const { params, body } = extractFunctionBody(apiJs, name);
      return `function ${name}(${params.join(", ")}) {${body}}`;
    }),
    (() => {
      const { params, body } = extractFunctionBody(aiAssessJs, "safeSetWriteToken");
      return `function safeSetWriteToken(${params.join(", ")}) {${body}}`;
    })(),
    (() => {
      const { params, body } = extractFunctionBody(apiJs, "api");
      return `async function api(${params.join(", ")}) {${body}}`;
    })(),
    (() => {
      const { params, body } = extractFunctionBody(followingJs, "postUserModeWithAuth");
      return `async function postUserModeWithAuth(${params.join(", ")}) {${body}}`;
    })()
  ];
  const modeCtx = vm.createContext(sharedSandbox);
  vm.runInContext(
    [
      `const API_BASE = "https://third-party-api.example";`,
      `const REQUEST_TIMEOUT_MS = 30000;`,
      `const ABORT_SIGNAL_STATICS = AbortSignal;`,
      ...syncDecls,
      `globalThis.__postUserModeWithAuth = postUserModeWithAuth;`
    ].join("\n"),
    modeCtx
  );

  // 纯空格 prompt：首次跨源请求无 authorization，收到 401 后纯空格输入被拦截且不覆盖 localStorage
  promptQueue = ["   "];
  await assert.rejects(
    () => modeCtx.__postUserModeWithAuth("alice", "full"),
    /已取消密码验证/
  );
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].headers.authorization, undefined, "跨源首次请求绝不可外发本地 cookie_write_token");
  assert.equal(localStore.get("cookie_write_token"), "local-secret-token");

  // 输入有效口令重试：首次仍无 authorization，第二次携带输入口令并保存 trimmed
  fetchCalls.length = 0;
  promptQueue = ["  new-token-123  "];
  const modeRes = await modeCtx.__postUserModeWithAuth("alice", "full");
  assert.deepEqual(Array.from([modeRes.ok]), [true]);
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].headers.authorization, undefined);
  assert.equal(fetchCalls[1].headers.authorization, "Bearer new-token-123");
  assert.equal(localStore.get("cookie_write_token"), "new-token-123");

  // 1c) 行为验证 [P1-1][P2-6]：共享 assessContentRisk 跨源首次请求不外泄口令，
  //     401 后 prompt 输入才带 Bearer 重试；双击正在加载中的 pk 直接忽略
  localStore.set("cookie_write_token", "local-secret-token");
  fetchCalls.length = 0;
  promptQueue = ["  rec-secret  "];
  let aiLoadingPksVal = {};
  const aiLoadingSet = new Set();
  let aiResultsVal = {};
  const alertMsgs = [];
  let apiHandler = async (p, opts) => {
    const headersObj = Object.fromEntries(new Headers(opts?.headers).entries());
    fetchCalls.push({ url: p, headers: headersObj });
    if (!headersObj.authorization) throw new Error("401 Unauthorized");
    return { ai: { model: "m", analysis: "ok" } };
  };
  const recCtx = vm.createContext({
    api: (p, opts) => apiHandler(p, opts),
    window: { prompt: () => promptQueue.shift() ?? null },
    localStorage: lsMock,
    alert: msg => { alertMsgs.push(String(msg)); },
    recommendStore: { aiCache: {} }
  });
  vm.runInContext(
    `${aiAssessJs}\nglobalThis.__assessContentRisk = assessContentRisk;`,
    recCtx
  );
  const callSharedAssess = (pk, errorPrefix = "AI 风险鉴定失败") =>
    recCtx.__assessContentRisk({
      pk,
      aiResults: aiResultsVal,
      aiLoadingSetRef: { current: aiLoadingSet },
      setAiLoadingPks: fn => { aiLoadingPksVal = typeof fn === "function" ? fn(aiLoadingPksVal) : fn; },
      setAiResults: fn => { aiResultsVal = typeof fn === "function" ? fn(aiResultsVal) : fn; },
      errorPrefix
    });
  // 模拟加载中双击：aiLoadingSet 已含 answer:1 时必须直接返回
  aiLoadingSet.add("answer:1");
  await callSharedAssess("answer:1");
  assert.equal(fetchCalls.length, 0, "加载中重复点击不得发起请求");
  aiLoadingSet.delete("answer:1");
  await callSharedAssess("answer:1");
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].headers.authorization, undefined, "assessContentRisk 首次请求不得带本地口令");
  assert.equal(fetchCalls[1].headers.authorization, "Bearer rec-secret");
  assert.equal(localStore.get("cookie_write_token"), "rec-secret");
  assert.equal(alertMsgs.length, 0);

  // 1d) 并发点击 A、B：重复点 A 被拦截，B 结束后 A 仍保持锁定直到 A 完成
  fetchCalls.length = 0;
  aiResultsVal = {};
  aiLoadingPksVal = {};
  aiLoadingSet.clear();
  const deferredByPk = new Map();
  apiHandler = (p, opts) => {
    const body = JSON.parse(opts.body);
    fetchCalls.push({ url: p, pk: body.pk });
    return new Promise(resolve => { deferredByPk.set(body.pk, resolve); });
  };
  const pA = callSharedAssess("answer:A");
  const pB = callSharedAssess("answer:B");
  assert.equal(fetchCalls.length, 2);
  assert.equal(aiLoadingSet.has("answer:A"), true);
  assert.equal(aiLoadingSet.has("answer:B"), true);
  assert.equal(aiLoadingPksVal["answer:A"], true);
  assert.equal(aiLoadingPksVal["answer:B"], true);
  await callSharedAssess("answer:A");
  assert.equal(fetchCalls.length, 2, "A 加载中再次点击 A 必须被拦截");
  deferredByPk.get("answer:B")({ ai: { model: "m", analysis: "B ok" } });
  await pB;
  assert.equal(aiLoadingSet.has("answer:B"), false);
  assert.equal(aiLoadingPksVal["answer:B"], undefined);
  assert.equal(aiLoadingSet.has("answer:A"), true, "B 结束后不得清除 A 的锁定状态");
  assert.equal(aiLoadingPksVal["answer:A"], true);
  deferredByPk.get("answer:A")({ ai: { model: "m", analysis: "A ok" } });
  await pA;
  assert.equal(aiLoadingSet.size, 0);
  assert.equal(Object.keys(aiLoadingPksVal).length, 0);

  // 1e) 行为验证：RecommendPage 与 FollowingPage 各自 handleAiAssess 包装函数均调用 preventDefault/stopPropagation，
  //     并把全部 state/ref 与各自 errorPrefix 透传给 assessContentRisk
  for (const [label, pageSrc, expectedErrPrefix] of [
    ["RecommendPage", recommendSrc, "AI 风险鉴定失败"],
    ["FollowingPage", followingSrc, "AI 评估失败"]
  ]) {
    const pageJs = transpile(pageSrc);
    const assessIdx = pageJs.indexOf("const handleAiAssess = async (e, pk) => {");
    assert.ok(assessIdx >= 0, `${label} transpiled 源码缺少 handleAiAssess`);
    const openIdx = pageJs.indexOf("{", assessIdx);
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < pageJs.length; i++) {
      if (pageJs[i] === "{") depth++;
      else if (pageJs[i] === "}") {
        depth--;
        if (depth === 0) {
          closeIdx = i;
          break;
        }
      }
    }
    assert.ok(closeIdx > openIdx, `${label} handleAiAssess 花括号未闭合`);
    const body = pageJs.slice(openIdx + 1, closeIdx);
    const sentinelResults = { existing: true };
    const sentinelLoadingRef = { current: new Set() };
    const sentinelSetLoading = () => {};
    const sentinelSetResults = () => {};
    let capturedArgs = null;
    const pageCtx = vm.createContext({
      aiResults: sentinelResults,
      aiLoadingSetRef: sentinelLoadingRef,
      setAiLoadingPks: sentinelSetLoading,
      setAiResults: sentinelSetResults,
      assessContentRisk: async arg => {
        capturedArgs = arg;
      }
    });
    vm.runInContext(
      `async function handleAiAssess(e, pk) {${body}}\nglobalThis.__handleAiAssess = handleAiAssess;`,
      pageCtx
    );
    let prevented = 0;
    let stopped = 0;
    await pageCtx.__handleAiAssess(
      { preventDefault() { prevented++; }, stopPropagation() { stopped++; } },
      "answer:42"
    );
    assert.equal(prevented, 1, `${label} handleAiAssess 必须调用 preventDefault`);
    assert.equal(stopped, 1, `${label} handleAiAssess 必须调用 stopPropagation`);
    assert.ok(capturedArgs, `${label} handleAiAssess 必须调用 assessContentRisk`);
    assert.equal(capturedArgs.pk, "answer:42");
    assert.equal(capturedArgs.aiResults, sentinelResults);
    assert.equal(capturedArgs.aiLoadingSetRef, sentinelLoadingRef);
    assert.equal(capturedArgs.setAiLoadingPks, sentinelSetLoading);
    assert.equal(capturedArgs.setAiResults, sentinelSetResults);
    assert.equal(capturedArgs.errorPrefix, expectedErrPrefix);
  }

  // 2) FollowingPage 切回已缓存 Tab 时递增 listReqRef 并清零 loading/error，且按筛选条件变更重拉
  assert.match(
    followingSrc,
    /const lastLoadedUsersKeyRef = useRef<string \| null>\(/
  );
  assert.match(
    followingSrc,
    /lastLoadedUsersKeyRef\.current = `\$\{q\}\\0\$\{mode\}`;/
  );
  assert.match(
    followingSrc,
    /if \(users\.length === 0 \|\| lastLoadedUsersKeyRef\.current !== `\$\{userQ\}\\0\$\{modeFilter\}`\)/
  );
  assert.match(
    followingSrc,
    /\/\/ 切回已缓存 Tab 时作废前 Tab 在途请求并清空残留 loading\/error\s*listReqRef\.current\+\+;\s*setLoading\(false\);\s*setError\(""\);/
  );

  // 3) CommentTree RootCommentList 同 pk 翻页序号作废与同页+跨页 id 去重
  assert.match(commentTreeSrc, /const loadMoreSeqRef = useRef\(0\);/);
  assert.match(commentTreeSrc, /loadMoreSeqRef\.current\+\+;\s*setRootComments\(initialComments\);/);
  assert.match(commentTreeSrc, /const reqSeq = \+\+loadMoreSeqRef\.current;/);
  assert.match(commentTreeSrc, /reqPk !== resolvedPkRef\.current \|\| reqSeq !== loadMoreSeqRef\.current/);
  const dedupMatch = commentTreeSrc.match(
    /setRootComments\(prev => \{([\s\S]*?)\}\);/
  );
  assert.ok(dedupMatch, "CommentTree 必须包含 setRootComments 去重更新");
  assert.match(dedupMatch[1], /seen\.add\(item\.id\)/, "同页内接受的元素也必须立即写入 seen");
  const dedupReducer = vm.runInNewContext(
    `(function(prev, newItems) { let next; const setRootComments = fn => { next = fn(prev); }; ${dedupMatch[0]} return next; })`
  );
  const deduped = dedupReducer(
    [{ id: "c1" }],
    [{ id: "c1" }, { id: "c2" }, { id: "c2" }, { id: "c3" }]
  );
  assert.deepEqual(Array.from(deduped, x => x.id), ["c1", "c2", "c3"], "同页与跨页重复 id 均只保留一条");

  // 4) [防删归档] CommentTree 为已删除根评论、预览回复、展开子评论渲染「已删除」徽标
  assert.match(commentTreeSrc, /comment\.is_deleted === 1[\s\S]{0,200}已删除/);
  assert.match(commentTreeSrc, /\{reply\.isDeleted\s*&&\s*<span[^>]*>已删除<\/span>\}/);
  assert.match(commentTreeSrc, /child\.isDeleted[\s\S]{0,200}已删除/);
});
