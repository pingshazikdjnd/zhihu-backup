import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import Database from "better-sqlite3";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// typescript 是各 app 的 devDependency，根目录没有提升链接，按 workspace 包解析
const tsRequire = createRequire(path.join(repoRoot, "apps", "apify-crawler", "package.json"));
const tsModule = await import(pathToFileURL(tsRequire.resolve("typescript")).href);
const ts = tsModule.default ?? tsModule;
const workerSrc = path.join(repoRoot, "apps", "worker", "src");
const sharedSchemasPath = path.join(repoRoot, "packages", "shared", "src", "schemas.ts");
const sharedIndexPath = path.join(repoRoot, "packages", "shared", "src", "index.ts");
const crawlerMainPath = path.join(repoRoot, "apps", "apify-crawler", "src", "main.ts");

const moduleUrlCache = new Map();

function toDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

function resolveRelativeTs(spec, fromFile) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidate = base.endsWith(".js") ? `${base.slice(0, -3)}.ts` : base;
  return existsSync(candidate) ? candidate : null;
}

const zodRequire = createRequire(path.join(repoRoot, "packages", "shared", "package.json"));
let zodUrl;
function resolveZod() {
  if (zodUrl) return zodUrl;
  const pkgPath = zodRequire.resolve("zod/package.json");
  const esmPath = path.join(path.dirname(pkgPath), "index.js");
  zodUrl = pathToFileURL(existsSync(esmPath) ? esmPath : zodRequire.resolve("zod")).href;
  return zodUrl;
}

/**
 * 用生产 TS 源码（transpileModule）生成 data: URL；
 * 相对依赖递归生成 URL，bare import 只允许显式注入的本地 mock 或 zod。
 */
async function moduleUrlFor(file, overrides = new Map()) {
  const abs = path.resolve(file);
  if (moduleUrlCache.has(abs)) return moduleUrlCache.get(abs);

  const promise = (async () => {
    const source = readFileSync(abs, "utf8");
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        esModuleInterop: true,
        isolatedModules: true
      },
      fileName: abs
    }).outputText;

    const specRe = /(\bfrom\s*)(["'])([^"'\n]+)\2/g;
    const specs = new Set([...transpiled.matchAll(specRe)].map(match => match[3]));
    const replacements = new Map();

    for (const spec of specs) {
      if (spec.startsWith(".")) {
        const target = resolveRelativeTs(spec, abs);
        if (!target) throw new Error(`cannot resolve ${spec} from ${abs}`);
        replacements.set(spec, await moduleUrlFor(target, overrides));
      } else if (overrides.has(spec)) {
        replacements.set(spec, overrides.get(spec));
      } else if (spec === "zod") {
        replacements.set(spec, resolveZod());
      } else if (spec.startsWith("node:")) {
        replacements.set(spec, spec);
      } else {
        throw new Error(`unexpected bare import "${spec}" in ${abs}`);
      }
    }

    const rewritten = transpiled.replace(
      specRe,
      (_match, prefix, quote, spec) => `${prefix}${quote}${replacements.get(spec)}${quote}`
    );
    return toDataUrl(rewritten);
  })();

  moduleUrlCache.set(abs, promise);
  return promise;
}

async function loadTs(file, overrides = new Map()) {
  return await import(await moduleUrlFor(file, overrides));
}

// ---------- 内存 D1（better-sqlite3，本地内存库，无网络/凭据） ----------

class MemoryD1Statement {
  constructor(owner, sql, params = []) {
    this.owner = owner;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new MemoryD1Statement(this.owner, this.sql, params);
  }

  async first() {
    return this.owner.sqlite.prepare(this.sql).get(...this.params) ?? null;
  }

  async all() {
    return { results: this.owner.sqlite.prepare(this.sql).all(...this.params) };
  }

  async run() {
    this.owner.record(this.sql, this.params);
    return this.execute();
  }

  execute() {
    return this.owner.sqlite.prepare(this.sql).run(...this.params);
  }
}

class MemoryD1 {
  constructor(sqlite) {
    this.sqlite = sqlite;
    this.writes = [];
    // 每个 batch 的语句清单：原子性回归用例据此刻画「几条语句同批提交」
    this.batches = [];
  }

  prepare(sql) {
    return new MemoryD1Statement(this, sql);
  }

  record(sql, params) {
    this.writes.push({ sql: sql.replace(/\s+/g, " ").trim(), params: [...params] });
  }

  batch(statements) {
    this.batches.push(statements.map(statement => ({
      sql: statement.sql.replace(/\s+/g, " ").trim(),
      params: [...statement.params]
    })));
    const runAll = this.sqlite.transaction(() => statements.map(statement => {
      this.record(statement.sql, statement.params);
      const info = statement.execute();
      return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
    }));
    return Promise.resolve(runAll());
  }
}

// 按顺序加载 migrations 目录全部 0000~0006+（node:fs 同步只读，绝不访问 .wrangler）
const migrationsDir = path.join(repoRoot, "apps", "worker", "migrations");
const migrationSql = readdirSync(migrationsDir)
  .filter(name => /^\d{4}_.*\.sql$/.test(name))
  .sort()
  .map(name => readFileSync(path.join(migrationsDir, name), "utf8"));

function createMemoryDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const sql of migrationSql) sqlite.exec(sql);
  return { sqlite, d1: new MemoryD1(sqlite) };
}

// 路由模块在加载时只注册 handler，用最小 Hono mock 阻断真实框架依赖。
// __call 让单测可以直接驱动某个 handler（auth.ts 经由 services/apify.ts 也会复用此 mock）。
// 注意：services/comments.ts 需要 import routes/auth.ts 的分流执行器，因此必须在加载
// comments 之前准备好 hono mock（否则会解析到真实框架依赖）。
const honoMockUrl = toDataUrl(`
class Hono {
  constructor() { this.handlers = new Map(); this.headerStore = new Map(); }
  use() { return this }
  get(path, handler) { this.handlers.set("GET " + path, handler); return this }
  post(path, handler) { this.handlers.set("POST " + path, handler); return this }
  route() { return this }
  async __call(method, path, { body, headers, url, executionCtx, params } = {}, env = {}) {
    const handler = this.handlers.get(method + " " + path);
    if (!handler) throw new Error("no handler for " + method + " " + path);
    let status = 200;
    let payload;
    this.headerStore.clear();
    const lower = {};
    for (const [k, v] of Object.entries(headers || {})) lower[String(k).toLowerCase()] = v;
    const c = {
      env,
      ...(executionCtx ? { executionCtx } : {}),
      req: {
        url: url || ("http://127.0.0.1/api/auth" + path),
        header: name => lower[String(name).toLowerCase()],
        param: name => (params || {})[name],
        query: name => new URL(url || ("http://127.0.0.1/api/auth" + path)).searchParams.get(name) ?? undefined,
        json: async () => body
      },
      header: (name, value) => { this.headerStore.set(String(name).toLowerCase(), value); },
      json: (obj, code = 200) => { status = code; payload = obj; return { status, body: obj }; }
    };
    await handler(c);
    return { status, body: payload, headers: Object.fromEntries(this.headerStore) };
  }
}
export { Hono };
export default Hono;
`);

const workerModules = await (async () => {
  const honoOverrides = new Map([["hono", honoMockUrl]]);
  const db = await loadTs(path.join(workerSrc, "db.ts"));
  const hash = await loadTs(path.join(workerSrc, "utils", "hash.ts"));
  const changes = await loadTs(path.join(workerSrc, "services", "changes.ts"));
  const comments = await loadTs(path.join(workerSrc, "services", "comments.ts"), honoOverrides);
  const imageTasks = await loadTs(path.join(workerSrc, "services", "image-tasks.ts"), honoOverrides);
  const auth = await loadTs(path.join(workerSrc, "routes", "auth.ts"), honoOverrides);
  const statsRoute = await loadTs(path.join(workerSrc, "routes", "stats.ts"), honoOverrides);
  const collections = await loadTs(path.join(workerSrc, "services", "collections.ts"));
  const sharedIndexUrl = await moduleUrlFor(sharedIndexPath);
  const contents = await loadTs(
    path.join(workerSrc, "services", "contents.ts"),
    new Map([["shared", sharedIndexUrl]])
  );
  const schemas = await loadTs(sharedSchemasPath);
  return { db, hash, changes, comments, imageTasks, auth, statsRoute, collections, contents, schemas };
})();

const { db: dbModule, hash: hashModule, changes: changesModule, comments: commentsModule, imageTasks: imageTasksModule, collections: collectionsModule, contents: contentsModule, statsRoute: statsRouteModule } = workerModules;

const CONTENT_PK = "answer:1";
const NOW_ISO = "2024-01-01T00:00:00.000Z";

function seedContent(sqlite, pk = CONTENT_PK) {
  sqlite.prepare(`
    INSERT INTO contents (pk, source_type, source_id, content_hash, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, 'h', ?, ?)
  `).run(pk, "answer", pk.split(":")[1], NOW_ISO, NOW_ISO);
}

function makeComment(overrides = {}) {
  return {
    id: "c1",
    parentId: null,
    author: "Author",
    authorAvatar: "",
    beReplied: null,
    content: "hello",
    img: "",
    imageUrl: "",
    time: "",
    location: "",
    likes: 1,
    isAuthor: false,
    isTop: false,
    isFeatured: false,
    ...overrides
  };
}

async function hashFor(content, img, likes) {
  return hashModule.sha256(hashModule.normalizeForHash(`${content}|${img}|${likes}`));
}

function seedComment(sqlite, { id, content, img = "", likes, hash, timeText = null, location = null }) {
  sqlite.prepare(`
    INSERT INTO comments (
      id, content_pk, author_name, content_md, img_url, time_text, location, likes,
      comment_hash, first_seen_at, last_seen_at, is_deleted
    ) VALUES (?, ?, 'Author', ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(id, CONTENT_PK, content, img, timeText, location, likes, hash, NOW_ISO, NOW_ISO);
}

function runWithDb(d1, fn) {
  return dbModule.dbContext.run(d1, fn);
}

/** 迁移前写在 D1 comments 里的旧扁平子评论行（parent_comment_id 指向根） */
function insertLegacyChild(sqlite, { id, rootId = "r1", content, likes = 1, isDeleted = 0 }) {
  sqlite.prepare(`
    INSERT INTO comments (
      id, content_pk, parent_comment_id, author_name, content_md, img_url,
      time_text, location, likes, comment_hash, first_seen_at, last_seen_at, is_deleted
    ) VALUES (?, ?, ?, 'Legacy', ?, '', '', '', ?, 'legacy-hash', ?, ?, ?)
  `).run(id, CONTENT_PK, rootId, content, likes, NOW_ISO, NOW_ISO, isDeleted);
}

/** 带读写计数的内存 R2，store 用 Map<string,string> */
function makeTrackedBucket(initialEntries = []) {
  const store = new Map(initialEntries);
  const stats = { gets: 0, puts: 0, deletes: 0 };
  const bucket = {
    async get(key) {
      stats.gets++;
      const value = store.get(key);
      return value === undefined ? null : { async text() { return value; } };
    },
    async put(key, value) {
      stats.puts++;
      store.set(key, String(value));
    },
    async delete(key) {
      stats.deletes++;
      store.delete(key);
    }
  };
  return { bucket, store, stats };
}

/** replaceCommentsByRoot 的完整根评论 payload */
function rootPayload({ children = [], childCount = children.length, isChildrenComplete = true, partial = false, allRootIds = ["r1"] } = {}) {
  return {
    contentPk: CONTENT_PK,
    partial,
    allRootIds,
    roots: [{
      id: "r1",
      author: "RootUser",
      authorAvatar: "",
      content: "root body",
      img: "",
      time: NOW_ISO,
      location: "",
      likes: 10,
      isAuthor: false,
      isTop: false,
      isFeatured: false,
      childCount,
      isChildrenComplete,
      children
    }]
  };
}

function childComment(id, content = `reply ${id}`) {
  return { id, parentId: "r1", author: "A", content, likes: 1, isAuthor: false };
}

// ---------- 评论写入 ----------

test("重复发送 NULL 时间/位置的评论产生 0 条 UPDATE", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  const hash = await hashFor("hello", "", 1);
  seedComment(sqlite, { id: "c1", content: "hello", likes: 1, hash, timeText: null, location: null });

  const input = {
    contentPk: CONTENT_PK,
    comments: [makeComment({ time: "", location: "" })],
    partial: false
  };

  const first = await runWithDb(d1, () => commentsModule.replaceComments(input));
  assert.deepEqual(first, { added: 0, updated: 0, deleted: 0 });
  assert.equal(d1.writes.length, 0, "首次重复同步不应写库");

  const second = await runWithDb(d1, () => commentsModule.replaceComments(input));
  assert.deepEqual(second, { added: 0, updated: 0, deleted: 0 });
  assert.equal(
    d1.writes.filter(write => /^UPDATE comments/i.test(write.sql)).length,
    0,
    "NULL 与空串相同，不应反复 UPDATE"
  );
  assert.equal(d1.writes.length, 0);
});

test("点赞显式变化只写 2 条语句（主评论+事件，不再写 comment_versions），事件不含正文", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  const oldHash = await hashFor("hello", "", 1);
  seedComment(sqlite, { id: "c1", content: "hello", likes: 1, hash: oldHash });

  const result = await runWithDb(d1, () => commentsModule.replaceComments({
    contentPk: CONTENT_PK,
    comments: [makeComment({ likes: 2 })],
    partial: false
  }));

  assert.deepEqual(result, { added: 0, updated: 1, deleted: 0 });
  assert.equal(d1.writes.length, 2, `期望 2 条语句，实际 ${d1.writes.map(w => w.sql).join(" | ")}`);
  assert.equal(d1.writes.filter(write => /^UPDATE comments/i.test(write.sql)).length, 1);
  assert.equal(d1.writes.filter(write => /^INSERT INTO comment_versions/i.test(write.sql)).length, 0);
  assert.equal(d1.writes.filter(write => /^INSERT INTO change_events/i.test(write.sql)).length, 1);

  const row = sqlite.prepare(`SELECT payload_json FROM change_events ORDER BY id DESC LIMIT 1`).get();
  assert.deepEqual(JSON.parse(row.payload_json), { commentId: "c1", contentPk: CONTENT_PK });
  assert.equal(row.payload_json.includes("hello"), false, "事件 payload 不应复制评论正文");
  assert.equal(sqlite.prepare(`SELECT likes FROM comments WHERE id = 'c1'`).get().likes, 2);
});

test("两层评论 replaceCommentsByRoot：子评论落 R2、带预览，完全重复同步 0 次 R2 读写与 0 条 D1 写", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);

  const r2Store = new Map();
  let r2Gets = 0;
  let r2Puts = 0;
  const bucket = {
    async get(key) {
      r2Gets++;
      const val = r2Store.get(key);
      return val === undefined ? null : { async text() { return val; } };
    },
    async put(key, value) {
      r2Puts++;
      r2Store.set(key, String(value));
    }
  };

  const payload = {
    contentPk: CONTENT_PK,
    partial: true,
    roots: [{
      id: "r1",
      author: "RootUser",
      authorAvatar: "",
      content: "root body",
      img: "",
      time: "2026-10-18T00:00:00.000Z",
      location: "上海",
      likes: 10,
      isAuthor: false,
      isTop: false,
      isFeatured: false,
      childCount: 2,
      isChildrenComplete: false,
      children: [
        { id: "ch1", parentId: "r1", author: "A", content: "reply 1", likes: 3, isAuthor: true },
        { id: "ch2", parentId: "r1", author: "B", beReplied: "A", content: "reply 2", likes: 1 }
      ]
    }]
  };

  const first = await commentsModule.replaceCommentsByRoot(payload, { DB: d1, BUCKET: bucket });
  assert.deepEqual(first, { added: 1, updated: 0, deleted: 0, r2Puts: 1, threadUpserts: 1 });
  assert.equal(d1.writes.filter(w => /comment_versions/i.test(w.sql)).length, 0);

  const roots = await commentsModule.listRootComments(d1, CONTENT_PK, { limit: 20, offset: 0 });
  assert.equal(roots.length, 1);
  assert.equal(roots[0].child_count, 2);
  assert.equal(roots[0].preview_replies.length, 2);

  d1.writes.length = 0;
  r2Gets = 0;
  r2Puts = 0;

  const second = await commentsModule.replaceCommentsByRoot(payload, { DB: d1, BUCKET: bucket });
  assert.deepEqual(second, { added: 0, updated: 0, deleted: 0, r2Puts: 0, threadUpserts: 0 });
  assert.equal(d1.writes.length, 0, "重复同步不得产生任何 D1 写入");
  assert.equal(r2Gets, 0, "重复同步不得产生任何 R2 读取");
  assert.equal(r2Puts, 0, "重复同步不得产生任何 R2 写入");
});

test("R2 旧楼中楼读取失败时绝不 PUT 覆盖，恢复后正确合并旧数据与新数据", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);

  const key = "childcomments/r1.json";
  const storedChildren = [
    { id: "old1", parentId: "r1", author: "Old", content: "old reply", likes: 5, isAuthor: false }
  ];
  const originalPayload = JSON.stringify({ children: storedChildren, complete: false, updatedAt: NOW_ISO });

  const r2Store = new Map([[key, originalPayload]]);
  let failGet = true;
  let r2Puts = 0;
  const bucket = {
    async get(k) {
      if (failGet) throw new Error("r2 read boom");
      const val = r2Store.get(k);
      return val === undefined ? null : { async text() { return val; } };
    },
    async put(k, value) {
      r2Puts++;
      r2Store.set(k, String(value));
    }
  };

  const payload = {
    contentPk: CONTENT_PK,
    partial: true,
    roots: [{
      id: "r1",
      author: "RootUser",
      authorAvatar: "",
      content: "root body",
      img: "",
      time: NOW_ISO,
      location: "",
      likes: 10,
      isAuthor: false,
      isTop: false,
      isFeatured: false,
      childCount: 2,
      isChildrenComplete: false,
      children: [{ id: "ch1", parentId: "r1", author: "A", content: "reply 1", likes: 3, isAuthor: false }]
    }]
  };

  const first = await quietly(() => commentsModule.replaceCommentsByRoot(payload, { DB: d1, BUCKET: bucket }));
  assert.equal(first.r2Puts, 0, "读取失败时不得写 R2");
  assert.equal(r2Puts, 0, "读取失败时绝不能 PUT 覆盖既有楼中楼");
  assert.equal(r2Store.get(key), originalPayload, "R2 原对象必须保持原样");

  // 线程被标记为不完整，确保下一轮不会误命中快路径
  const thread = sqlite.prepare(`SELECT is_complete, incoming_hash FROM comment_threads WHERE root_id = 'r1'`).get();
  assert.equal(thread.is_complete, 0);
  assert.equal(thread.incoming_hash, "");

  // R2 恢复可读：同输入重试应合并旧对象 + 新子评论，而不是丢掉旧数据
  failGet = false;
  r2Puts = 0;
  const second = await quietly(() => commentsModule.replaceCommentsByRoot(payload, { DB: d1, BUCKET: bucket }));
  assert.equal(second.r2Puts, 1);
  assert.equal(r2Puts, 1);

  const stored = JSON.parse(r2Store.get(key));
  assert.deepEqual(stored.children.map(child => child.id), ["old1", "ch1"]);
  assert.equal(stored.children.find(child => child.id === "old1").content, "old reply");
  assert.equal(stored.children.find(child => child.id === "ch1").content, "reply 1");
});

test("全量评论清零：roots 为空时 contents.comment_count 归零并删除残余线程索引与 R2 子评论", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  sqlite.prepare(`UPDATE contents SET comment_count = 3 WHERE pk = ?`).run(CONTENT_PK);

  const r2Store = new Map();
  let r2Deletes = 0;
  const bucket = {
    async get(key) {
      const val = r2Store.get(key);
      return val === undefined ? null : { async text() { return val; } };
    },
    async put(key, value) {
      r2Store.set(key, String(value));
    },
    async delete(key) {
      r2Deletes++;
      r2Store.delete(key);
    }
  };

  // 先写入一条带楼中楼的根评论，建立 comment_threads 索引与预览
  await runWithDb(d1, () => commentsModule.replaceCommentsByRoot({
    contentPk: CONTENT_PK,
    partial: false,
    allRootIds: ["r1"],
    roots: [{
      id: "r1",
      author: "RootUser",
      authorAvatar: "",
      content: "root body",
      img: "",
      time: NOW_ISO,
      location: "",
      likes: 10,
      isAuthor: false,
      isTop: false,
      isFeatured: false,
      childCount: 1,
      isChildrenComplete: true,
      children: [{ id: "ch1", parentId: "r1", author: "A", content: "reply", likes: 1, isAuthor: false }]
    }]
  }, { DB: d1, BUCKET: bucket }));

  const threadBefore = sqlite.prepare(`SELECT child_count FROM comment_threads WHERE root_id = 'r1'`).get();
  assert.equal(threadBefore.child_count, 1);

  // 原站评论被整体删光：非 partial 且本次 0 条根评论
  await runWithDb(d1, () => commentsModule.replaceCommentsByRoot({
    contentPk: CONTENT_PK,
    partial: false,
    allRootIds: [],
    roots: []
  }, { DB: d1, BUCKET: bucket }));

  assert.equal(
    sqlite.prepare(`SELECT comment_count FROM contents WHERE pk = ?`).get(CONTENT_PK).comment_count,
    0,
    "全量对账后 contents.comment_count 必须归零以驱动爬虫增量检测"
  );
  assert.ok(
    sqlite.prepare(`SELECT archived_comment_count FROM contents WHERE pk = ?`).get(CONTENT_PK).archived_comment_count >= 1,
    "全量清零后 contents.archived_comment_count 必须保留已归档总数"
  );
  // 评论防删归档：全量清零只将根评论标为 is_deleted = 1，绝不删除 comment_threads 索引或 R2 楼中楼对象。
  assert.ok(
    sqlite.prepare(`SELECT * FROM comment_threads WHERE root_id = 'r1'`).get(),
    "全量清零后 comment_threads 线程索引必须保留"
  );
  assert.equal(r2Deletes, 0, "全量清零不得删除旧 R2 子评论对象");
  assert.equal(r2Store.has("childcomments/r1.json"), true, "旧 R2 子评论对象必须保留");
  assert.equal(sqlite.prepare(`SELECT is_deleted FROM comments WHERE id = 'r1'`).get().is_deleted, 1);
  const archivedRoots = await runWithDb(d1, () => commentsModule.listRootComments(d1, CONTENT_PK, {}, bucket));
  assert.equal(archivedRoots.length, 1);
  assert.equal(archivedRoots[0].id, "r1");
  assert.equal(archivedRoots[0].is_deleted, 1);
});

test("单根楼中楼删光：R2 与 comment_threads 同步清空，不再显示旧预览", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);

  const key = "childcomments/r1.json";
  const r2Store = new Map();
  const bucket = {
    async get(k) {
      const val = r2Store.get(k);
      return val === undefined ? null : { async text() { return val; } };
    },
    async put(k, value) {
      r2Store.set(k, String(value));
    }
  };

  const rootPayload = (children, childCount, isChildrenComplete) => ({
    contentPk: CONTENT_PK,
    partial: false,
    allRootIds: ["r1"],
    roots: [{
      id: "r1",
      author: "RootUser",
      authorAvatar: "",
      content: "root body",
      img: "",
      time: NOW_ISO,
      location: "",
      likes: 10,
      isAuthor: false,
      isTop: false,
      isFeatured: false,
      childCount,
      isChildrenComplete,
      children
    }]
  });

  await runWithDb(d1, () => commentsModule.replaceCommentsByRoot(
    rootPayload([{ id: "ch1", parentId: "r1", author: "A", content: "reply", likes: 1, isAuthor: false }], 1, true),
    { DB: d1, BUCKET: bucket }
  ));
  assert.equal(JSON.parse(r2Store.get(key)).children.length, 1);

  // 原站楼中楼被删光：抓全 + childCount = 0 -> 防删归档保留旧回复并打上 isDeleted: true 标记
  await runWithDb(d1, () => commentsModule.replaceCommentsByRoot(
    rootPayload([], 0, true),
    { DB: d1, BUCKET: bucket }
  ));

  const stored = JSON.parse(r2Store.get(key));
  assert.equal(stored.children.length, 1);
  assert.equal(stored.children[0].id, "ch1");
  assert.equal(stored.children[0].isDeleted, true);
  assert.equal(stored.complete, true);
  const thread = sqlite.prepare(`SELECT child_count, is_complete, preview_json FROM comment_threads WHERE root_id = 'r1'`).get();
  assert.equal(thread.is_complete, 1);
  const preview = JSON.parse(thread.preview_json);
  assert.equal(preview.length, 1);
  assert.equal(preview[0].id, "ch1");
  assert.equal(preview[0].isDeleted, true);
});

test("complete-empty：旧扁平 D1 子评论 + 无线程索引时防删归档迁移至 R2 并标记已删除", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  insertLegacyChild(sqlite, { id: "legacy-child", content: "legacy reply" });
  const { bucket, store, stats } = makeTrackedBucket();

  const result = await runWithDb(d1, () => commentsModule.replaceCommentsByRoot(
    rootPayload({ children: [], childCount: 0, isChildrenComplete: true }),
    { DB: d1, BUCKET: bucket }
  ));

  assert.equal(result.r2Puts, 1, "旧 D1 子评论必须防删归档到 R2 并建立完整快照");
  assert.equal(stats.puts, 1);
  const stored = JSON.parse(store.get("childcomments/r1.json"));
  assert.equal(stored.complete, true);
  assert.equal(stored.children.length, 1);
  assert.equal(stored.children[0].id, "legacy-child");
  assert.equal(stored.children[0].isDeleted, true);

  const thread = sqlite.prepare(`SELECT child_count, is_complete, preview_json FROM comment_threads WHERE root_id = 'r1'`).get();
  assert.equal(thread.is_complete, 1);

  const children = await runWithDb(d1, () => commentsModule.getChildComments(bucket, "r1", d1));
  assert.equal(children.length, 1);
  assert.equal(children[0].id, "legacy-child");
  assert.equal(children[0].isDeleted, true);
  assert.equal(
    sqlite.prepare(`SELECT COUNT(*) AS n FROM comments WHERE id = 'legacy-child'`).get().n,
    1,
    "防删归档不得删除 D1 旧子评论行"
  );
});

test("complete-empty：R2 有旧子评论但线程计数被人为置 0 时仍清除旧对象与索引", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  const { bucket, store, stats } = makeTrackedBucket();

  // 先正常同步一条子评论，再把线程计数人为改成 0（模拟旧迁移/人工修复留下的不一致）
  await runWithDb(d1, () => commentsModule.replaceCommentsByRoot(
    rootPayload({ children: [childComment("ch1")], childCount: 1, isChildrenComplete: true }),
    { DB: d1, BUCKET: bucket }
  ));
  sqlite.prepare(`UPDATE comment_threads SET child_count = 0 WHERE root_id = 'r1'`).run();
  const putsBefore = stats.puts;

  const result = await quietly(() => runWithDb(d1, () => commentsModule.replaceCommentsByRoot(
    rootPayload({ children: [], childCount: 0, isChildrenComplete: true }),
    { DB: d1, BUCKET: bucket }
  )));

  assert.equal(result.r2Puts, 1, "不能因为 child_count 已经是 0 就跳过防删归档标记");
  assert.equal(stats.puts, putsBefore + 1);
  const stored = JSON.parse(store.get("childcomments/r1.json"));
  assert.equal(stored.children.length, 1);
  assert.equal(stored.children[0].id, "ch1");
  assert.equal(stored.children[0].isDeleted, true);
  assert.equal(stored.complete, true);
  const thread = sqlite.prepare(`SELECT child_count, is_complete FROM comment_threads WHERE root_id = 'r1'`).get();
  assert.equal(thread.is_complete, 1);
});

test("complete-empty：第二遍同输入命中快路径，0 次 R2 PUT / 0 条线程写入", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  const { bucket, stats } = makeTrackedBucket();

  await runWithDb(d1, () => commentsModule.replaceCommentsByRoot(
    rootPayload({ children: [], childCount: 0, isChildrenComplete: true }),
    { DB: d1, BUCKET: bucket }
  ));

  const statsAfterFirst = { ...stats };
  d1.writes.length = 0;
  const second = await quietly(() => runWithDb(d1, () => commentsModule.replaceCommentsByRoot(
    rootPayload({ children: [], childCount: 0, isChildrenComplete: true }),
    { DB: d1, BUCKET: bucket }
  )));

  assert.equal(second.r2Puts, 0, "重复 complete-empty 不得再次 PUT R2");
  assert.equal(second.threadUpserts, 0, "重复 complete-empty 不得写 comment_threads");
  assert.equal(stats.puts, statsAfterFirst.puts);
  assert.equal(stats.gets, statsAfterFirst.gets, "快路径不得读取 R2");
  assert.equal(d1.writes.length, 0, "快路径不得产生任何 D1 写入");
});

test("partial 合并：R2 missing 时把旧扁平 D1 子评论与新子评论合并，且保持 incomplete 计数语义", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  insertLegacyChild(sqlite, { id: "legacy-child", content: "legacy reply", likes: 7 });
  const { bucket, store } = makeTrackedBucket();

  const payload = rootPayload({
    children: [childComment("new-child", "new reply")],
    childCount: 1,
    isChildrenComplete: false,
    partial: true,
    allRootIds: undefined
  });
  const first = await runWithDb(d1, () => commentsModule.replaceCommentsByRoot(payload, { DB: d1, BUCKET: bucket }));
  assert.equal(first.r2Puts, 1);

  const stored = JSON.parse(store.get("childcomments/r1.json"));
  assert.deepEqual(stored.children.map(child => child.id), ["legacy-child", "new-child"]);
  assert.equal(stored.complete, false, "partial 结果必须保持 incomplete");
  const thread = sqlite.prepare(`SELECT child_count, is_complete FROM comment_threads WHERE root_id = 'r1'`).get();
  assert.equal(thread.child_count, 1, "child_count 只能来自原站计数/本次抓取数，不能把 D1 旧行数冒充全量");
  assert.equal(thread.is_complete, 0);

  const children = await runWithDb(d1, () => commentsModule.getChildComments(bucket, "r1", d1));
  assert.deepEqual(children.map(child => child.id).sort(), ["legacy-child", "new-child"]);
  assert.equal(
    sqlite.prepare(`SELECT COUNT(*) AS n FROM comments WHERE id = 'legacy-child'`).get().n,
    1,
    "合并不得删除 D1 旧子评论"
  );

  // 同输入重复 partial 按设计可直接命中快路径跳过写入
  const second = await quietly(() => runWithDb(d1, () => commentsModule.replaceCommentsByRoot(payload, { DB: d1, BUCKET: bucket })));
  assert.equal(second.r2Puts, 0);
  assert.equal(second.threadUpserts, 0);
});

test("partial 合并：R2 读取失败时即使 D1 有旧子评论也绝不 PUT 覆盖", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  insertLegacyChild(sqlite, { id: "legacy-child", content: "legacy reply" });
  const key = "childcomments/r1.json";
  const original = JSON.stringify({ children: [childComment("r2-old")], complete: false });
  const r2Store = new Map([[key, original]]);
  let r2Puts = 0;
  const bucket = {
    async get() {
      throw new Error("r2 read boom");
    },
    async put(k, value) {
      r2Puts++;
      r2Store.set(k, String(value));
    }
  };

  const result = await quietly(() => runWithDb(d1, () => commentsModule.replaceCommentsByRoot(
    rootPayload({
      children: [childComment("new-child")],
      childCount: 1,
      isChildrenComplete: false,
      partial: true,
      allRootIds: undefined
    }),
    { DB: d1, BUCKET: bucket }
  )));

  assert.equal(result.r2Puts, 0, "R2 读失败时不得写 R2");
  assert.equal(r2Puts, 0, "不得用 D1 旧数据 + 新数据覆盖不可读的 R2 对象");
  assert.equal(r2Store.get(key), original, "R2 原对象必须保持原样");
  const thread = sqlite.prepare(`SELECT is_complete, incoming_hash FROM comment_threads WHERE root_id = 'r1'`).get();
  assert.equal(thread.is_complete, 0);
  assert.equal(thread.incoming_hash, "", "失败后必须清空 incoming_hash 以便下轮重试");
  assert.equal(
    sqlite.prepare(`SELECT COUNT(*) AS n FROM comments WHERE id = 'legacy-child'`).get().n,
    1
  );
});

test("R2 楼中楼 complete=true 且 children 为空时返回 []，不回退 D1 历史子评论", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  sqlite.prepare(`
    INSERT INTO comments (
      id, content_pk, parent_comment_id, author_name, content_md, img_url,
      time_text, location, likes, comment_hash, first_seen_at, last_seen_at, is_deleted
    ) VALUES ('legacy-child', ?, 'r1', 'Old', 'legacy reply', '', '', '', 1, 'h', ?, ?, 0)
  `).run(CONTENT_PK, NOW_ISO, NOW_ISO);

  workerModules.auth.invalidateExternalTargetsCache();
  const bucket = {
    async get(key) {
      if (key !== "childcomments/r1.json") return null;
      return { async text() { return JSON.stringify({ children: [], complete: true }); } };
    }
  };

  const children = await runWithDb(d1, () => commentsModule.getChildComments(bucket, "r1", d1));
  assert.deepEqual(children, [], "complete 快照为空时必须以 R2 为准，不得回退 D1 旧子评论");
  assert.equal(
    sqlite.prepare(`SELECT COUNT(*) AS n FROM comments WHERE id = 'legacy-child'`).get().n,
    1,
    "读取路径不得删除任何 D1 历史子评论"
  );
});

test("R2 楼中楼读取失败时 getChildComments 仍回退 D1 历史子评论", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  sqlite.prepare(`
    INSERT INTO comments (
      id, content_pk, parent_comment_id, author_name, content_md, img_url,
      time_text, location, likes, comment_hash, first_seen_at, last_seen_at, is_deleted
    ) VALUES ('legacy-child', ?, 'r1', 'Old', 'legacy reply', '', '', '', 1, 'h', ?, ?, 0)
  `).run(CONTENT_PK, NOW_ISO, NOW_ISO);

  workerModules.auth.invalidateExternalTargetsCache();
  const bucket = {
    async get() {
      throw new Error("r2 read boom");
    }
  };

  const children = await quietly(() =>
    runWithDb(d1, () => commentsModule.getChildComments(bucket, "r1", d1))
  );
  assert.deepEqual(children.map(child => child.id), ["legacy-child"]);
  assert.equal(children[0].content, "legacy reply");
});

test("完整载荷的评论数 0 如实落库，弱载荷（无正文）仍保护旧值", async () => {
  const { sqlite, d1 } = createMemoryDb();

  await runWithDb(d1, () => contentsModule.upsertContent(contentInput({ commentCount: 3 })));
  assert.equal(sqlite.prepare(`SELECT comment_count FROM contents WHERE pk = ?`).get(CONTENT_PK).comment_count, 3);

  // 弱数据源（无正文）的 0 视为未提供，保留旧值
  await runWithDb(d1, () => contentsModule.upsertContent(
    contentInput({ commentCount: 0, contentMd: "", contentHtml: "" })
  ));
  assert.equal(sqlite.prepare(`SELECT comment_count FROM contents WHERE pk = ?`).get(CONTENT_PK).comment_count, 3);

  // 完整载荷（带正文）的 0 是真实观测：必须落库，否则原站删光后计数永远停在 3
  const result = await runWithDb(d1, () => contentsModule.upsertContent(contentInput({ commentCount: 0 })));
  assert.equal(result.changed, false);
  assert.equal(sqlite.prepare(`SELECT comment_count FROM contents WHERE pk = ?`).get(CONTENT_PK).comment_count, 0);
});

function contentInput(overrides = {}) {
  return {
    sourceType: "answer",
    sourceId: "1",
    title: "T",
    sourceUrl: "https://www.zhihu.com/answer/1",
    author: { name: "Ann", urlToken: "ann", avatarUrl: "", headline: "" },
    question: { id: "456", title: "Q" },
    contentHtml: "",
    contentMd: "body text",
    excerpt: "",
    voteupCount: 5,
    commentCount: 0,
    favoriteCount: 3,
    visitCount: 7,
    isCollapsed: true,
    isLabeled: true,
    labelInfo: "",
    createdTime: NOW_ISO,
    updatedTime: NOW_ISO,
    ...overrides
  };
}

test("弱数据源未传 isCollapsed/isLabeled 时保留原值，不产生伪变更版本与事件", async () => {
  const { sqlite, d1 } = createMemoryDb();

  await runWithDb(d1, () => contentsModule.upsertContent(contentInput()));
  const inserted = sqlite.prepare(`SELECT is_collapsed, is_labeled FROM contents WHERE pk = ?`).get(CONTENT_PK);
  assert.equal(inserted.is_collapsed, 1);
  assert.equal(inserted.is_labeled, 1);
  const versionsBefore = sqlite.prepare(`SELECT COUNT(*) AS n FROM content_versions WHERE content_pk = ?`).get(CONTENT_PK).n;

  d1.writes.length = 0;

  const result = await runWithDb(d1, () =>
    contentsModule.upsertContent(contentInput({ isCollapsed: undefined, isLabeled: undefined }))
  );

  assert.equal(result.changed, false);
  const updated = sqlite.prepare(`SELECT is_collapsed, is_labeled FROM contents WHERE pk = ?`).get(CONTENT_PK);
  assert.equal(updated.is_collapsed, 1, "未传 isCollapsed 不得把既有折叠状态冲成 0");
  assert.equal(updated.is_labeled, 1, "未传 isLabeled 不得把既有黄标状态冲成 0");
  assert.equal(
    d1.writes.filter(write => /^UPDATE contents/i.test(write.sql)).length,
    0,
    `未传字段不应产生伪 bodyChanges UPDATE：${d1.writes.map(w => w.sql).join(" | ")}`
  );
  assert.equal(d1.writes.filter(write => /INSERT INTO change_events/i.test(write.sql)).length, 0);
  assert.equal(
    sqlite.prepare(`SELECT COUNT(*) AS n FROM content_versions WHERE content_pk = ?`).get(CONTENT_PK).n,
    versionsBefore,
    "未传字段不应追加快照版本"
  );
});

test("新建正文：contents、版本快照与 content.created 事件在同一个 batch 原子提交", async () => {
  const { sqlite, d1 } = createMemoryDb();
  const result = await runWithDb(d1, () => contentsModule.upsertContent(contentInput()));

  assert.equal(result.created, true);
  assert.equal(d1.batches.length, 1, `新建正文必须只提交 1 个 batch，实际 ${d1.batches.length} 个`);
  const sqls = d1.batches[0].map(item => item.sql);
  assert.equal(sqls.length, 3, `期望 3 条语句同批，实际：${sqls.join(" | ")}`);
  assert.match(sqls[0], /^INSERT INTO contents/i);
  assert.match(sqls[1], /^INSERT INTO content_versions/i);
  assert.match(sqls[2], /^INSERT INTO change_events/i);
  assert.equal(
    sqlite.prepare(`SELECT COUNT(*) AS n FROM content_versions WHERE content_pk = ?`).get(CONTENT_PK).n,
    1
  );
  assert.equal(
    sqlite.prepare(`SELECT event_type FROM change_events`).get().event_type,
    "content.created"
  );
});

test("无正文新建：只提交 contents + content.created 两条语句，仍为单 batch", async () => {
  const { sqlite, d1 } = createMemoryDb();
  await runWithDb(d1, () =>
    contentsModule.upsertContent(contentInput({ contentHtml: "", contentMd: "" }))
  );

  assert.equal(d1.batches.length, 1);
  assert.equal(d1.batches[0].length, 2, `期望 2 条语句同批，实际：${d1.batches[0].map(s => s.sql).join(" | ")}`);
  assert.match(d1.batches[0][0].sql, /^INSERT INTO contents/i);
  assert.match(d1.batches[0][1].sql, /^INSERT INTO change_events/i);
  assert.equal(
    sqlite.prepare(`SELECT COUNT(*) AS n FROM content_versions WHERE content_pk = ?`).get(CONTENT_PK).n,
    0
  );
});

test("正文更新：content.updated 事件与正文、版本快照同批提交，无 batch 外事件写入", async () => {
  const { sqlite, d1 } = createMemoryDb();
  await runWithDb(d1, () => contentsModule.upsertContent(contentInput()));
  d1.writes.length = 0;
  d1.batches.length = 0;

  const result = await runWithDb(d1, () =>
    contentsModule.upsertContent(contentInput({ contentMd: "body changed", voteupCount: 6 }))
  );

  assert.equal(result.changed, true);
  assert.equal(d1.batches.length, 1, "更新必须只提交 1 个 batch");
  const sqls = d1.batches[0].map(item => item.sql);
  assert.equal(sqls.length, 3, `期望 UPDATE + 版本 + 事件同批，实际：${sqls.join(" | ")}`);
  assert.match(sqls[0], /^UPDATE contents/i);
  assert.match(sqls[1], /^INSERT INTO content_versions/i);
  assert.match(sqls[2], /^INSERT INTO change_events/i);
  assert.equal(d1.writes.length, 3, "所有写入都必须来自批次，不得在 batch 外单独 emitChange");
  assert.equal(
    sqlite.prepare(`SELECT COUNT(*) AS n FROM change_events WHERE event_type = 'content.updated'`).get().n,
    1
  );
});

test("HttpUrl：拒绝路径段恰为 undefined/null 的占位 URL，nullable 等普通单词照常通过", () => {
  const { schemas } = workerModules;
  const base = { sourceType: "answer", sourceId: "1" };

  assert.doesNotThrow(() => schemas.IngestContentSchema.parse({
    ...base,
    sourceUrl: "https://www.zhihu.com/question/123/answer/456"
  }));
  assert.doesNotThrow(() => schemas.IngestContentSchema.parse({
    ...base,
    sourceUrl: "https://www.zhihu.com/answer/nullable"
  }));
  assert.throws(() => schemas.IngestContentSchema.parse({
    ...base,
    sourceUrl: "https://www.zhihu.com/question/undefined/answer/1"
  }), "路径段 undefined 必须拒绝");
  assert.throws(() => schemas.IngestContentSchema.parse({
    ...base,
    sourceUrl: "https://www.zhihu.com/question/null/answer/1"
  }), "路径段 null 必须拒绝");
});

test("更新载荷带 undefined/null 占位 URL 时保留库里已有的正确 source_url", async () => {
  const { sqlite, d1 } = createMemoryDb();
  await runWithDb(d1, () => contentsModule.upsertContent(contentInput()));
  const original = sqlite.prepare(`SELECT source_url FROM contents WHERE pk = ?`).get(CONTENT_PK).source_url;
  assert.equal(original, "https://www.zhihu.com/answer/1");

  await runWithDb(d1, () => contentsModule.upsertContent(contentInput({
    sourceUrl: "https://www.zhihu.com/question/undefined/answer/1",
    voteupCount: 6
  })));
  assert.equal(
    sqlite.prepare(`SELECT source_url FROM contents WHERE pk = ?`).get(CONTENT_PK).source_url,
    original,
    "undefined 占位 URL 不得覆盖已有正确 URL"
  );

  await runWithDb(d1, () => contentsModule.upsertContent(contentInput({
    sourceUrl: "https://www.zhihu.com/question/null/answer/1",
    voteupCount: 7
  })));
  assert.equal(
    sqlite.prepare(`SELECT source_url FROM contents WHERE pk = ?`).get(CONTENT_PK).source_url,
    original,
    "null 占位 URL 不得覆盖已有正确 URL"
  );
});

function seedImageTask(sqlite, { imageUrl, objectKey, status, attempts, updatedAt }) {
  const info = sqlite.prepare(`
    INSERT INTO image_tasks (content_pk, image_url, object_key, status, attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(CONTENT_PK, imageUrl, objectKey, status, attempts, updatedAt, updatedAt);
  return Number(info.lastInsertRowid);
}

const HOUR_MS = 60 * 60 * 1000;

test("图片任务：failed 冷却 6 小时后才重排，attempts 归零并刷新签名 URL，其他状态不动", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  const old = new Date(Date.now() - 7 * HOUR_MS).toISOString();
  const recent = new Date(Date.now() - 1 * HOUR_MS).toISOString();
  const keys = {
    old: `images/${"a".repeat(64)}.jpg`,
    recent: `images/${"b".repeat(64)}.jpg`,
    done: `images/${"c".repeat(64)}.jpg`,
    pending: `images/${"d".repeat(64)}.jpg`,
    processing: `images/${"e".repeat(64)}.jpg`
  };
  seedImageTask(sqlite, { imageUrl: "https://picx.zhimg.com/old.jpg?sign=1", objectKey: keys.old, status: "failed", attempts: 3, updatedAt: old });
  seedImageTask(sqlite, { imageUrl: "https://picx.zhimg.com/recent.jpg?sign=1", objectKey: keys.recent, status: "failed", attempts: 3, updatedAt: recent });
  seedImageTask(sqlite, { imageUrl: "https://picx.zhimg.com/done.jpg?sign=1", objectKey: keys.done, status: "done", attempts: 1, updatedAt: old });
  seedImageTask(sqlite, { imageUrl: "https://picx.zhimg.com/pending.jpg?sign=1", objectKey: keys.pending, status: "pending", attempts: 0, updatedAt: old });
  seedImageTask(sqlite, { imageUrl: "https://picx.zhimg.com/proc.jpg?sign=1", objectKey: keys.processing, status: "processing", attempts: 1, updatedAt: recent });

  const tasks = Object.entries(keys).map(([name, objectKey]) => ({
    objectKey,
    imageUrl: `https://picx.zhimg.com/${name}.jpg?sign=2`
  }));
  const inserted = await runWithDb(d1, () => imageTasksModule.enqueueImageTasks(CONTENT_PK, tasks));
  assert.equal(inserted, 0);

  const getRow = objectKey =>
    sqlite.prepare(`SELECT status, attempts, image_url FROM image_tasks WHERE object_key = ?`).get(objectKey);

  const oldRow = getRow(keys.old);
  assert.equal(oldRow.status, "pending", "冷却期满的 failed 行必须重排");
  assert.equal(oldRow.attempts, 0, "重排必须重置 attempts");
  assert.equal(oldRow.image_url, "https://picx.zhimg.com/old.jpg?sign=2", "重排必须刷新为本次签名 URL");

  const recentRow = getRow(keys.recent);
  assert.equal(recentRow.status, "failed", "冷却期内的 failed 行不得重排");
  assert.equal(recentRow.attempts, 3);
  assert.equal(recentRow.image_url, "https://picx.zhimg.com/recent.jpg?sign=1");

  assert.deepEqual(
    { status: getRow(keys.done).status, attempts: getRow(keys.done).attempts, image_url: getRow(keys.done).image_url },
    { status: "done", attempts: 1, image_url: "https://picx.zhimg.com/done.jpg?sign=1" }
  );
  assert.deepEqual(
    { status: getRow(keys.pending).status, attempts: getRow(keys.pending).attempts, image_url: getRow(keys.pending).image_url },
    { status: "pending", attempts: 0, image_url: "https://picx.zhimg.com/pending.jpg?sign=1" }
  );
  assert.deepEqual(
    { status: getRow(keys.processing).status, attempts: getRow(keys.processing).attempts, image_url: getRow(keys.processing).image_url },
    { status: "processing", attempts: 1, image_url: "https://picx.zhimg.com/proc.jpg?sign=1" }
  );
});

test("图片任务重排按数据库当前 status='failed' 做 CAS，过期预读不会复活 done 行", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  const key = `images/${"f".repeat(64)}.jpg`;
  const old = new Date(Date.now() - 7 * HOUR_MS).toISOString();
  const storedUrl = "https://picx.zhimg.com/done.jpg?sign=old";
  seedImageTask(sqlite, { imageUrl: storedUrl, objectKey: key, status: "done", attempts: 1, updatedAt: old });

  // 模拟「SELECT 之后、UPDATE 之前」该行被其他消费者改成 done：预读结果仍声称 failed
  const staleD1 = {
    prepare(sql) {
      if (/^SELECT object_key, status, attempts FROM image_tasks/i.test(sql.trim())) {
        const stale = {
          bind: () => stale,
          all: async () => ({ results: [{ object_key: key, status: "failed", attempts: 3 }] })
        };
        return stale;
      }
      return d1.prepare(sql);
    },
    batch: statements => d1.batch(statements)
  };

  const inserted = await runWithDb(staleD1, () => imageTasksModule.enqueueImageTasks(
    CONTENT_PK,
    [{ objectKey: key, imageUrl: "https://picx.zhimg.com/done.jpg?sign=new" }]
  ));
  assert.equal(inserted, 0);

  const row = sqlite.prepare(
    `SELECT status, attempts, image_url FROM image_tasks WHERE object_key = ?`
  ).get(key);
  assert.equal(row.status, "done", "CAS 必须挡住已经变成 done 的行");
  assert.equal(row.attempts, 1);
  assert.equal(row.image_url, storedUrl);
  assert.ok(
    d1.batches.some(batch => batch.some(statement =>
      /AND status = 'failed' AND updated_at </i.test(statement.sql)
    )),
    "重排队 SQL 必须带 status='failed' 与冷却阈值的 CAS 条件"
  );
});

test("图片任务领取：候选条件 UPDATE 合并为单个 batch，按各自 meta.changes 只取成功者", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  const stale = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const fresh = new Date().toISOString();
  const imageUrl = "https://not-zhihu.example/image.jpg";
  const ids = [
    seedImageTask(sqlite, { imageUrl, objectKey: `images/${"1".repeat(64)}.jpg`, status: "pending", attempts: 0, updatedAt: stale }),
    seedImageTask(sqlite, { imageUrl, objectKey: `images/${"2".repeat(64)}.jpg`, status: "pending", attempts: 0, updatedAt: stale }),
    seedImageTask(sqlite, { imageUrl, objectKey: `images/${"3".repeat(64)}.jpg`, status: "processing", attempts: 1, updatedAt: stale }),
    seedImageTask(sqlite, { imageUrl, objectKey: `images/${"4".repeat(64)}.jpg`, status: "processing", attempts: 1, updatedAt: fresh })
  ];

  let batchCalls = 0;
  const batchSizes = [];
  const countingD1 = {
    prepare: sql => d1.prepare(sql),
    batch: statements => {
      batchCalls++;
      batchSizes.push(statements.length);
      if (batchCalls === 1) {
        // 模拟并发消费者在 batch 提交前抢先领走第 2 条候选
        sqlite.prepare(`
          UPDATE image_tasks
          SET status = 'processing', attempts = attempts + 1, updated_at = ?
          WHERE id = ?
        `).run(new Date(Date.now() - 5 * 60 * 1000).toISOString(), ids[1]);
      }
      return d1.batch(statements);
    }
  };

  const bucket = {
    async get() { return null; },
    async head() { return null; },
    async put() {},
    async delete() {}
  };

  const result = await runWithDb(countingD1, () =>
    imageTasksModule.processImageBatch(bucket, 10)
  );

  assert.equal(batchCalls, 2, "领取与状态落库各发 1 个 D1 batch（共 2 个）");
  assert.equal(batchSizes[0], 3, "候选只能包含 2 条 pending + 1 条超时 processing");
  assert.equal(batchSizes[1], 2, "已领取任务的最终状态更新必须合并为单个 batch");
  assert.equal(result.claimed, 2, "被并发抢走的任务必须按各自 meta.changes 剔除");
});

test("评论事件即使调用方传入完整评论对象也只保留引用字段", async () => {
  const { sqlite, d1 } = createMemoryDb();
  await runWithDb(d1, async () => {
    const statement = changesModule.buildChangeStatement({
      eventType: "comment.updated",
      entityType: "comment",
      entityPk: "c9",
      contentPk: CONTENT_PK,
      summary: "s",
      payload: makeComment({ id: "c9", content: "SECRET COMMENT BODY" })
    });
    await dbModule.db.batch([statement]);
  });

  const row = sqlite.prepare(`SELECT payload_json FROM change_events`).get();
  assert.deepEqual(JSON.parse(row.payload_json), { commentId: "c9", contentPk: CONTENT_PK });
  assert.equal(row.payload_json.includes("SECRET COMMENT BODY"), false);
});

// ---------- 收藏夹快照 ----------

function seedCollection(sqlite, items, snapshotCount) {
  sqlite.prepare(`
    INSERT INTO collections (id, title, owner_token, first_seen_at, last_seen_at, updated_time)
    VALUES ('col1', 'Fav', 'owner', ?, ?, ?)
  `).run(NOW_ISO, NOW_ISO, NOW_ISO);

  const insertItem = sqlite.prepare(`
    INSERT INTO collection_items (
      collection_id, content_pk, source_type, source_id, title, author_name, source_url,
      first_seen_at, last_seen_at, is_removed
    ) VALUES ('col1', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of items) {
    insertItem.run(
      `${item.sourceType}:${item.sourceId}`,
      item.sourceType,
      item.sourceId,
      item.title,
      item.authorName,
      item.sourceUrl,
      NOW_ISO,
      NOW_ISO,
      item.isRemoved ?? 0
    );
  }

  if (snapshotCount !== undefined) {
    sqlite.prepare(`
      INSERT INTO collection_snapshots (collection_id, snapshot_at, item_count, added_count, removed_count)
      VALUES ('col1', ?, ?, 0, 0)
    `).run(NOW_ISO, snapshotCount);
  }
}

function collectionInput(items, { incremental = false, title = "Fav", updatedTime = NOW_ISO } = {}) {
  return {
    collection: { id: "col1", title, ownerToken: "owner", updatedTime },
    incremental,
    items
  };
}

const itemA = {
  sourceType: "answer",
  sourceId: "a",
  title: "A",
  authorName: "Ann",
  sourceUrl: "https://example.com/a"
};
const itemB = {
  sourceType: "answer",
  sourceId: "b",
  title: "B",
  authorName: "Bob",
  sourceUrl: "https://example.com/b"
};
const itemC = {
  sourceType: "answer",
  sourceId: "c",
  title: "C",
  authorName: "Cat",
  sourceUrl: "https://example.com/c"
};

test("条目、标题、owner、updatedTime 完全重复的收藏夹快照 0 写", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedCollection(sqlite, [itemA, itemB], 2);

  const result = await runWithDb(d1, () => collectionsModule.upsertCollectionSnapshot(collectionInput([itemA, itemB])));

  assert.deepEqual(result, { added: 0, removed: 0, count: 2, unchanged: true });
  assert.equal(d1.writes.length, 0, `不应产生 collections UPDATE 或 snapshot INSERT：${d1.writes.map(w => w.sql).join(" | ")}`);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM collection_snapshots WHERE collection_id = 'col1'`).get().n, 1);
});

test("输入 updatedTime 为空时历史 updated_time 不得阻止零写入", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedCollection(sqlite, [itemA, itemB], 2);
  const storedUpdatedTime = sqlite.prepare(`SELECT updated_time FROM collections WHERE id = 'col1'`).get().updated_time;

  const result = await runWithDb(d1, () =>
    collectionsModule.upsertCollectionSnapshot(collectionInput([itemA, itemB], { updatedTime: "" }))
  );

  assert.deepEqual(result, { added: 0, removed: 0, count: 2, unchanged: true });
  assert.equal(d1.writes.length, 0);
  assert.equal(
    sqlite.prepare(`SELECT updated_time FROM collections WHERE id = 'col1'`).get().updated_time,
    storedUpdatedTime
  );
});

test("存在与本次输入无关的历史已移除条目时仍可零写入", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedCollection(sqlite, [itemA, itemB, { ...itemC, isRemoved: 1 }], 2);

  const result = await runWithDb(d1, () => collectionsModule.upsertCollectionSnapshot(collectionInput([itemA, itemB])));

  assert.deepEqual(result, { added: 0, removed: 0, count: 2, unchanged: true });
  assert.equal(d1.writes.length, 0, `历史已移除行不应触发写入：${d1.writes.map(w => w.sql).join(" | ")}`);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM collection_snapshots WHERE collection_id = 'col1'`).get().n, 1);
});

test("全量快照遗漏有效条目时不得因存在历史已移除行而零写入", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedCollection(sqlite, [itemA, itemB, { ...itemC, isRemoved: 1 }], 2);

  const result = await runWithDb(d1, () => collectionsModule.upsertCollectionSnapshot(collectionInput([itemA])));

  assert.equal(result.removed, 1);
  assert.notEqual(result.unchanged, true);
  assert.ok(d1.writes.length > 0);
  assert.equal(sqlite.prepare(`SELECT is_removed FROM collection_items WHERE source_id = 'b'`).get().is_removed, 1);
  assert.equal(sqlite.prepare(`SELECT is_removed FROM collection_items WHERE source_id = 'c'`).get().is_removed, 1);
  assert.equal(
    sqlite.prepare(`SELECT COUNT(*) AS n FROM change_events WHERE event_type = 'collection.item_removed'`).get().n,
    1
  );
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM collection_snapshots WHERE collection_id = 'col1'`).get().n, 2);
});

test("收藏夹有效条目删除时仍按全量快照对账", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedCollection(sqlite, [itemA, itemB], 2);

  const result = await runWithDb(d1, () => collectionsModule.upsertCollectionSnapshot(collectionInput([itemA])));

  assert.equal(result.added, 0);
  assert.equal(result.removed, 1);
  assert.equal(result.count, 1);
  assert.notEqual(result.unchanged, true);
  assert.equal(sqlite.prepare(`SELECT is_removed FROM collection_items WHERE source_id = 'b'`).get().is_removed, 1);
  assert.equal(
    sqlite.prepare(`SELECT COUNT(*) AS n FROM change_events WHERE event_type = 'collection.item_removed'`).get().n,
    1
  );
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM collection_snapshots WHERE collection_id = 'col1'`).get().n, 2);
});

test("incremental 分片即使条目数相同，字段变化也不能跳过修复", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedCollection(sqlite, [itemA, itemB], 2);

  const changedA = { ...itemA, title: "A changed" };
  const result = await runWithDb(d1, () =>
    collectionsModule.upsertCollectionSnapshot(collectionInput([changedA, itemB], { incremental: true }))
  );

  assert.equal(result.added, 0);
  assert.equal(result.removed, 0);
  assert.equal(result.count, 2);
  assert.equal(sqlite.prepare(`SELECT title FROM collection_items WHERE source_id = 'a'`).get().title, "A changed");
  assert.equal(sqlite.prepare(`SELECT is_removed FROM collection_items WHERE source_id = 'b'`).get().is_removed, 0);
  assert.ok(d1.writes.some(write => /^UPDATE collection_items/i.test(write.sql)));
});

test("之前移除后重新出现的条目照常复活并记事件", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedCollection(sqlite, [itemA, { ...itemB, isRemoved: 1 }], 2);

  const result = await runWithDb(d1, () => collectionsModule.upsertCollectionSnapshot(collectionInput([itemA, itemB])));

  assert.equal(result.removed, 0);
  assert.equal(sqlite.prepare(`SELECT is_removed FROM collection_items WHERE source_id = 'b'`).get().is_removed, 0);
  const event = sqlite.prepare(`
    SELECT summary FROM change_events WHERE event_type = 'collection.item_added' ORDER BY id DESC LIMIT 1
  `).get();
  assert.ok(event && event.summary.includes("重新加入"));
});

// ---------- 爬虫两条评论链路的图片归一化 ----------

let sentRequests = [];
const standardImage = "https://picx.zhimg.com/v2-standard.jpg";
const fallbackImage = "https://picx.zhimg.com/v2-fallback.jpg";
const commentFixtures = [
  {
    id: "9001",
    content: `<a href="${standardImage}" target="_blank">查看图片</a><p>hi</p>`,
    created_time: 1700000000,
    vote_count: 3,
    author: { member: { name: "Bob", avatar_url: "" } },
    address_text: "",
    image_url: standardImage,
    child_comment_count: 0
  },
  {
    id: "9002",
    content: "<p>text only</p>",
    created_time: 1700000001,
    vote_count: 1,
    author: { member: { name: "Eve", avatar_url: "" } },
    address_text: "",
    imageUrl: fallbackImage,
    child_comment_count: 0
  }
];
const answerFixture = {
  id: 123,
  type: "answer",
  question: { id: 456, title: "Question" },
  content: "<p>answer body</p>",
  excerpt: "excerpt",
  author: { name: "Ann", url_token: "ann", avatar_url: "", headline: "" },
  comment_count: 2,
  voteup_count: 10,
  favorite_count: 1,
  visit_count: 5,
  created_time: 1700000000,
  updated_time: 1700000000
};

function okJson(json) {
  return { ok: () => true, status: () => 200, json: async () => json, text: async () => "" };
}

globalThis.__crawlerContext = {
  addCookies: async () => {},
  addInitScript: async () => {},
  request: {
    get: async url => {
      const target = String(url);
      if (target.includes("/followees")) {
        return okJson({
          data: [{
            url_token: "ann",
            name: "Ann",
            id: "1",
            avatar_url: "",
            headline: "",
            answer_count: 1,
            articles_count: 0,
            follower_count: 0
          }],
          paging: { is_end: true }
        });
      }
      // 回答详情真实统计：members/answers 列表不返回顶层 voteup_count/visit_count，
      // crawler 会在入库前逐篇请求 /api/v4/answers/{id} 补真实赞同数与真实浏览量
      if (target.includes("/api/v4/answers/123?")) {
        return okJson({ id: 123, voteup_count: 10, visit_count: 5, comment_count: 2 });
      }
      if (target.includes("/answers?")) return okJson({ data: [answerFixture], paging: { is_end: true } });
      if (target.includes("/root_comments")) return okJson({ data: commentFixtures, paging: { is_end: true } });
      // 回答评论已改走 comment_v5：/api/v4/comment_v5/answers/{id}/root_comment?order_by=ts|score
      // 与 /root_comments 一样返回根评论夹具 + is_end，保证主链路与 syncHotCommentsForContent 输出一致
      if (target.includes("/root_comment?") || target.includes("/root_comment&")) {
        return okJson({ data: commentFixtures, paging: { is_end: true } });
      }
      if (target.includes("/child_comments")) return okJson({ data: [], paging: { is_end: true } });
      throw new Error(`unexpected crawler URL: ${target}`);
    }
  }
};
globalThis.__crawlerInput = {
  runType: "following-list",
  isFast: true,
  apiUrl: "https://worker.invalid/",
  zhihuUsername: "ann",
  cookieString: "z_c0=test"
};
globalThis.fetch = async (url, init) => {
  const pathname = new URL(String(url)).pathname;
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  sentRequests.push({ path: pathname, body });
  if (pathname === "/ingest/content") {
    return okJson({ created: true, changed: false, prevCommentCount: 0, pk: CONTENT_PK });
  }
  return okJson({ added: 0, updated: 0, deleted: 0 });
};

const actorMockUrl = toDataUrl(`
const noop = () => {};
export const Actor = {
  init: async () => {},
  getInput: async () => globalThis.__crawlerInput,
  exit: async () => {},
  fail: async message => { throw new Error(String(message)); },
  on: noop,
  off: noop
};
export const log = { error: noop, warning: noop, info: noop, debug: noop };
`);
const playwrightMockUrl = toDataUrl(`
export const chromium = {
  launch: async () => ({
    newContext: async () => globalThis.__crawlerContext,
    close: async () => {}
  })
};
`);

async function quietly(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = saved.log;
    console.warn = saved.warn;
    console.error = saved.error;
  }
}

const crawlerModule = await quietly(() => loadTs(crawlerMainPath, new Map([
  ["apify", actorMockUrl],
  ["playwright", playwrightMockUrl]
])));

test("主回答链路与 syncHotCommentsForContent 输出一致的图片归一化", async () => {
  const before = sentRequests.length;

  await quietly(() => crawlerModule.runScraper());
  await quietly(() => crawlerModule.syncHotCommentsForContent(globalThis.__crawlerContext, "answer", "123", "hot"));

  const payloads = sentRequests
    .slice(before)
    .filter(request => request.path === "/ingest/comments-by-root");
  assert.equal(payloads.length, 2, "两条链路各应提交一次按根分组评论 payload");

  const [mainPayload, hotPayload] = payloads;
  assert.deepEqual(mainPayload.body.roots, hotPayload.body.roots, "两条链路必须产出相同根评论分组对象");

  const imageComment = mainPayload.body.roots.find(comment => comment.id === "9001");
  assert.equal(imageComment.img, standardImage);
  assert.equal(imageComment.imageUrl, standardImage);
  assert.equal(imageComment.content, "<p>hi</p>");
  assert.equal(imageComment.content.includes(standardImage), false, "图片 URL 不得写进正文");

  const fallbackComment = mainPayload.body.roots.find(comment => comment.id === "9002");
  assert.equal(fallbackComment.img, fallbackImage);
  assert.equal(fallbackComment.imageUrl, fallbackImage);
  assert.equal(fallbackComment.content, "<p>text only</p>");

  const parsed = workerModules.schemas.IngestCommentsByRootSchema.parse(mainPayload.body);
  assert.equal(parsed.roots[0].imageUrl, standardImage);
  assert.equal(parsed.roots[1].imageUrl, fallbackImage);
});

// ---------- 分布式同步锁（app_settings.sync_lock CAS 租约） ----------

test("分布式同步锁：CAS 互斥、非持有者无法释放、持有者续租与释放", async () => {
  const { sqlite, d1 } = createMemoryDb();
  const sync = await loadTs(
    path.join(workerSrc, "routes", "sync.ts"),
    new Map([["hono", honoMockUrl]])
  );

  const first = await runWithDb(d1, () => sync.acquireSyncLock("owner-a", "manual"));
  assert.equal(first.ok, true);
  assert.equal(first.ownerId, "owner-a");

  // 租约未过期：第二个任务（cron / 本地同步）抢锁必须失败并拿到当前持有者
  const blocked = await runWithDb(d1, () => sync.acquireSyncLock("owner-b", "cron"));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.holder.ownerId, "owner-a");

  // 非持有者：既不能续租也不能释放，锁必须原样保留
  assert.equal(await runWithDb(d1, () => sync.renewSyncLock("owner-b")), false);
  assert.equal(await runWithDb(d1, () => sync.releaseSyncLock("owner-b")), false);
  assert.ok(sqlite.prepare(`SELECT value FROM app_settings WHERE key = 'sync_lock'`).get());

  // 持有者续租：expiresAt 按 leaseMs 重算，ownerId 不变
  const renewTime = Date.now();
  assert.equal(await runWithDb(d1, () => sync.renewSyncLock("owner-a", 5_000)), true);
  const renewed = JSON.parse(sqlite.prepare(`SELECT value FROM app_settings WHERE key = 'sync_lock'`).get().value);
  assert.equal(renewed.ownerId, "owner-a");
  assert.ok(Date.parse(renewed.expiresAt) >= renewTime);
  assert.ok(Date.parse(renewed.expiresAt) <= Date.now() + 5_000 + 1_000);

  // 默认租约（15 分钟）续租应把过期时间进一步顺延
  assert.equal(await runWithDb(d1, () => sync.renewSyncLock("owner-a")), true);
  const extended = JSON.parse(sqlite.prepare(`SELECT value FROM app_settings WHERE key = 'sync_lock'`).get().value);
  assert.ok(Date.parse(extended.expiresAt) > Date.parse(renewed.expiresAt));
  assert.ok(Date.parse(extended.expiresAt) >= Date.now() + sync.SYNC_LOCK_LEASE_MS - 5_000);

  // 模拟爬虫崩溃：租约过期后其他任务可自动抢到锁（无需人工清锁）
  sqlite.prepare(`UPDATE app_settings SET value = ? WHERE key = 'sync_lock'`).run(
    JSON.stringify({
      ownerId: "owner-a",
      source: "manual",
      acquiredAt: NOW_ISO,
      expiresAt: "2000-01-01T00:00:00.000Z"
    })
  );
  const takeover = await runWithDb(d1, () => sync.acquireSyncLock("owner-b", "local"));
  assert.equal(takeover.ok, true);
  assert.equal(takeover.ownerId, "owner-b");

  // 新持有者能释放；旧持有者的释放请求不得误删新锁
  assert.equal(await runWithDb(d1, () => sync.releaseSyncLock("owner-a")), false);
  assert.equal(await runWithDb(d1, () => sync.releaseSyncLock("owner-b")), true);
  assert.equal(sqlite.prepare(`SELECT value FROM app_settings WHERE key = 'sync_lock'`).get(), undefined);

  // 不传 ownerId 时自动生成（本地脚本场景），且生成的 id 可正常续租/释放
  const auto = await runWithDb(d1, () => sync.acquireSyncLock());
  assert.equal(auto.ok, true);
  assert.match(auto.ownerId, /^sync-\d+-[a-z0-9]+$/);
  assert.equal(await runWithDb(d1, () => sync.renewSyncLock(auto.ownerId)), true);
  assert.equal(await runWithDb(d1, () => sync.releaseSyncLock(auto.ownerId)), true);

  // 旧版 Worker 在 sync_lock 里存的是裸 ISO 时间戳（不是合法 JSON）。
  // json_extract/json_set 遇到非法 JSON 会抛 "malformed JSON"，必须靠 json_valid 短路接管，
  // 否则 acquire 永远 fail-closed、renew/release 也永远删不掉这行，同步被永久锁死。
  sqlite.prepare(`DELETE FROM app_settings WHERE key = 'sync_lock'`).run();
  sqlite
    .prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('sync_lock', ?, ?)`)
    .run("2026-10-28T00:00:00.000Z", "2026-10-28T00:00:00.000Z");
  const legacyTakeover = await runWithDb(d1, () => sync.acquireSyncLock("owner-legacy", "manual"));
  assert.equal(legacyTakeover.ok, true, "非 JSON 的旧版锁必须能被直接接管，而不是抛 malformed JSON 永久锁死");
  assert.equal(legacyTakeover.ownerId, "owner-legacy");
  const legacyValue = JSON.parse(
    sqlite.prepare(`SELECT value FROM app_settings WHERE key = 'sync_lock'`).get().value
  );
  assert.equal(legacyValue.ownerId, "owner-legacy", "接管后必须升级为合法 JSON 租约");
  assert.equal(
    await runWithDb(d1, () => sync.renewSyncLock("owner-other")),
    false,
    "非持有者不能续租升级后的合法 JSON 锁"
  );
  assert.equal(await runWithDb(d1, () => sync.releaseSyncLock("owner-legacy")), true);

  // 遗留的畸形锁即使没有 ownerId 也必须能被清除（否则旧行永远删不掉）
  sqlite
    .prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('sync_lock', ?, ?)`)
    .run("2026-10-28T00:00:00.000Z", "2026-10-28T00:00:00.000Z");
  assert.equal(await runWithDb(d1, () => sync.releaseSyncLock("any-owner")), true);
  assert.equal(sqlite.prepare(`SELECT value FROM app_settings WHERE key = 'sync_lock'`).get(), undefined);
});
// ---------- 外部存储目标（Turso / D1 / Supabase / S3 / Webhook） ----------

test("外部存储目标：保存脱敏、编辑保留 token、isolate 缓存命中 0 读放大、删除即时生效", async () => {
  const auth = await loadTs(
    path.join(workerSrc, "routes", "auth.ts"),
    new Map([["hono", honoMockUrl]])
  );
  const { sqlite, d1 } = createMemoryDb();

  let d1Selects = 0;
  let r2Gets = 0;
  const countingD1 = {
    prepare(sql) {
      if (/^\s*SELECT\b/i.test(sql)) d1Selects++;
      return d1.prepare(sql);
    },
    batch: statements => d1.batch(statements)
  };
  const r2Store = new Map();
  const bucket = {
    async get(key) {
      r2Gets++;
      const value = r2Store.get(key);
      return value === undefined ? null : { async text() { return value; } };
    },
    async put(key, value) {
      r2Store.set(key, String(value));
    }
  };
  const env = { API_SECRET: "unit-secret", BUCKET: bucket };
  const authHeaders = { authorization: "Bearer unit-secret" };
  const call = (method, path, init) =>
    runWithDb(countingD1, () => auth.authRoutes.__call(method, path, init, env));

  auth.invalidateExternalTargetsCache();

  // 1) 冷启动：D1 为空 → 回退一次 R2
  assert.deepEqual(await runWithDb(countingD1, () => auth.getExternalTargetsRaw(bucket)), []);
  assert.equal(d1Selects, 1);
  assert.equal(r2Gets, 1);

  // 2) 60 秒内存缓存命中：重复读取 0 次 D1 / 0 次 R2
  assert.deepEqual(await runWithDb(countingD1, () => auth.getExternalTargetsRaw(bucket)), []);
  assert.equal(d1Selects, 1, "缓存期内不得重复查 D1");
  assert.equal(r2Gets, 1, "缓存期内不得重复查 R2");

  // 3) 保存目标：响应必须脱敏，且缓存立即刷新（不产生新的 D1 读）
  const saveRes = await call("POST", "/external-targets", {
    headers: authHeaders,
    body: {
      name: "备用 Turso",
      provider: "turso",
      endpointUrl: "https://demo.turso.io",
      authToken: "secret-turso-token-1234",
      syncScopes: ["contents"],
      enabled: true
    }
  });
  assert.equal(saveRes.status, 200);
  assert.equal(saveRes.body.target.hasToken, true);
  assert.equal(saveRes.body.target.maskedToken, "••••••••1234");
  assert.equal(JSON.stringify(saveRes.body).includes("secret-turso-token-1234"), false, "响应不得泄漏 token 明文");
  const savedId = saveRes.body.target.id;

  const afterSave = await runWithDb(countingD1, () => auth.getExternalTargetsRaw(bucket));
  assert.equal(afterSave.length, 1);
  assert.equal(afterSave[0].authToken, "secret-turso-token-1234", "服务端内部仍需保留 token 用于转发");
  assert.equal(d1Selects, 2, "保存锁内重读 1 次 D1 后，读取应直接命中内存缓存（不再多查 D1）");

  // 4) GET 列表同样只返回脱敏字段
  const listRes = await call("GET", "/external-targets");
  assert.equal(listRes.status, 200);
  assert.equal(JSON.stringify(listRes.body).includes("secret-turso-token-1234"), false);
  assert.equal(listRes.body.targets[0].maskedToken, "••••••••1234");

  // 5) 编辑已有目标且密码框留空：必须保留原 token
  const editRes = await call("POST", "/external-targets", {
    headers: authHeaders,
    body: {
      id: savedId,
      name: "改名 Turso",
      provider: "turso",
      endpointUrl: "https://demo.turso.io",
      syncScopes: ["contents"],
      enabled: true
    }
  });
  assert.equal(editRes.status, 200);
  const afterEdit = await runWithDb(countingD1, () => auth.getExternalTargetsRaw(bucket));
  assert.equal(afterEdit[0].name, "改名 Turso");
  assert.equal(afterEdit[0].authToken, "secret-turso-token-1234", "编辑时留空 token 不得清空旧值");
  assert.equal(JSON.stringify(editRes.body).includes("secret-turso-token-1234"), false);

  // 6) SSRF：云元数据地址即使来自本地也必须拦截
  const ssrfRes = await call("POST", "/external-targets", {
    headers: authHeaders,
    body: {
      name: "bad",
      provider: "webhook",
      endpointUrl: "http://169.254.169.254/latest/meta-data",
      syncScopes: ["contents"]
    }
  });
  assert.equal(ssrfRes.status, 400);

  // 6b) URL 内嵌账号密码会通过 endpointUrl 原样回显给前端，必须拒绝
  const credentialRes = await call("POST", "/external-targets", {
    headers: authHeaders,
    body: {
      name: "embedded credentials",
      provider: "turso",
      endpointUrl: "https://user:pass@demo.turso.io",
      syncScopes: ["contents"]
    }
  });
  assert.equal(credentialRes.status, 400);

  // 7) 未鉴权写请求必须 401
  const denied = await call("POST", "/external-targets/delete", { body: { id: savedId } });
  assert.equal(denied.status, 401);

  // 8) 删除：锁内失效缓存重读一次 D1 并写回最新状态，随后读取命中缓存不再查 D1
  // 上面的 401 分支会查一次写口令（app_settings SELECT），从这里重新计数
  d1Selects = 0;
  const delRes = await call("POST", "/external-targets/delete", {
    headers: authHeaders,
    body: { id: savedId }
  });
  assert.equal(delRes.status, 200);
  assert.deepEqual(delRes.body.targets, []);
  const selectsAfterDelete = d1Selects;
  assert.equal(selectsAfterDelete, 1, "delete 锁内失效缓存后应精确重读 1 次 D1");
  assert.deepEqual(await runWithDb(countingD1, () => auth.getExternalTargetsRaw(bucket)), []);
  assert.equal(d1Selects, selectsAfterDelete, "删除刷新缓存后读取应直接命中缓存，不再产生 D1 SELECT");
  assert.equal(
    JSON.parse(sqlite.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(auth.EXTERNAL_TARGETS_KEY).value).length,
    0
  );
  assert.deepEqual(JSON.parse(r2Store.get(auth.R2_EXTERNAL_TARGETS_KEY)), []);
});

// ---------- 外部扩容库：offload 真分流 + 透明联邦回读 ----------

/** JS 值 → Turso v2 pipeline 单元格（真实 Turso 的 integer 也是字符串） */
function tursoCell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { type: "integer", value: String(value) }
      : { type: "float", value };
  }
  if (typeof value === "bigint") return { type: "integer", value: String(value) };
  return { type: "text", value: String(value) };
}

test("外部数据库 offload 真扩容模式：评论写入外部库时主 D1/R2 零写入，且 listRootComments 与 getChildComments 透明从外部库读回", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);

  const auth = workerModules.auth;
  auth.invalidateExternalTargetsCache();
  auth.invalidateMainCommentCountCache();
  auth.resetRemoteSchemaCache();

  // 真实内存 SQLite 充当远程 Turso：Worker 发过去的每条 SQL 都在这里真实执行
  const remoteSqlite = new Database(":memory:");

  const targetConfig = {
    id: "ext-turso-offload",
    name: "Turso 扩容库",
    provider: "turso",
    enabled: true,
    syncScopes: ["comments"],
    storageRole: "offload",
    overflowThresholdRows: 1500000,
    endpointUrl: "https://ext-turso.example.com",
    authToken: "turso-unit-token",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO
  };

  // 主 R2 只放外部目标配置：childcomments/* 必须保持为空（证明主 R2 没被写）
  const r2Store = new Map([[auth.R2_EXTERNAL_TARGETS_KEY, JSON.stringify([targetConfig])]]);
  let mainR2Puts = 0;
  const bucket = {
    async get(key) {
      const value = r2Store.get(key);
      return value === undefined ? null : { async text() { return value; } };
    },
    async put(key, value) {
      mainR2Puts++;
      r2Store.set(key, String(value));
    },
    async head() {
      return null;
    },
    async delete(key) {
      r2Store.delete(key);
    }
  };

  const remoteCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target !== "https://ext-turso.example.com/v2/pipeline") {
      throw new Error(`unexpected fetch in offload test: ${target}`);
    }
    assert.equal(String(init.method || "").toUpperCase(), "POST");
    assert.equal(init.headers?.Authorization, "Bearer turso-unit-token");
    const body = JSON.parse(String(init.body));
    const results = [];
    for (const request of body.requests) {
      if (request.type === "close") {
        results.push({ type: "ok", response: { type: "close" } });
        continue;
      }
      const sql = request.stmt.sql;
      // 参数必须按 Turso v2 协议编码：integer 是字符串、null 是 {type:"null"}
      const args = (request.stmt.args || []).map(arg => {
        if (!arg || arg.type === "null") return null;
        if (arg.type === "integer" || arg.type === "float") return Number(arg.value);
        return String(arg.value);
      });
      remoteCalls.push({ sql: sql.replace(/\s+/g, " ").trim(), args });
      const statement = remoteSqlite.prepare(sql);
      if (statement.reader) {
        const cols = statement.columns().map(column => ({ name: column.name }));
        const rows = statement.all(...args).map(row => cols.map(column => tursoCell(row[column.name])));
        results.push({
          type: "ok",
          response: {
            type: "execute",
            result: { cols, rows, affected_row_count: 0, last_insert_rowid: null }
          }
        });
      } else {
        const info = statement.run(...args);
        results.push({
          type: "ok",
          response: {
            type: "execute",
            result: { cols: [], rows: [], affected_row_count: info.changes, last_insert_rowid: null }
          }
        });
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ results }),
      text: async () => ""
    };
  };

  try {
    const payload = {
      contentPk: CONTENT_PK,
      partial: true,
      roots: [{
        id: "r1",
        author: "RootUser",
        authorAvatar: "",
        content: "root body",
        img: "",
        time: NOW_ISO,
        location: "上海",
        likes: 10,
        isAuthor: false,
        isTop: false,
        isFeatured: false,
        childCount: 2,
        isChildrenComplete: true,
        children: [
          { id: "ch1", parentId: "r1", author: "A", content: "reply 1", likes: 3, isAuthor: true },
          { id: "ch2", parentId: "r1", author: "B", beReplied: "A", content: "reply 2", likes: 1 }
        ]
      }]
    };

    const result = await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot(payload, { DB: d1, BUCKET: bucket })
    );

    assert.equal(result.added, 0, "added 表示主 D1 写入行数，offload 模式必须是 0（爬虫写入预算才不会误耗）");
    assert.equal(result.updated, 0);
    assert.equal(result.deleted, 0);
    assert.equal(result.offloadedCounts.added, 1, "真正写进外部库的条数在 offloadedCounts 里");
    assert.equal(result.r2Puts, 0, "offload 模式不得写主 R2");
    assert.equal(result.threadUpserts, 0, "offload 模式的线程索引写外部库，不能计入主 D1 写预算");
    assert.equal(result.offloadedTo, "Turso 扩容库", "必须明确告知调用方数据已分流到外部库");

    // 主 D1：0 行写入（comments / comment_threads / change_events 全空）
    assert.equal(d1.writes.length, 0, `主 D1 不得有任何写入：${d1.writes.map(w => w.sql).join(" | ")}`);
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM comments`).get().n, 0);
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM comment_threads`).get().n, 0);
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM change_events`).get().n, 0);

    // 主 R2：0 次 PUT，childcomments/* 不存在
    assert.equal(mainR2Puts, 0, "offload 模式不得写主 R2");
    assert.equal(r2Store.has("childcomments/r1.json"), false);

    // 外部库：数据真的落在内存 SQLite 里
    assert.equal(remoteSqlite.prepare(`SELECT COUNT(*) AS n FROM comments`).get().n, 1);
    assert.equal(remoteSqlite.prepare(`SELECT COUNT(*) AS n FROM comment_threads`).get().n, 1);
    const blob = remoteSqlite.prepare(
      `SELECT payload_json, complete FROM child_comment_blobs WHERE root_id = 'r1'`
    ).get();
    assert.ok(blob, "楼中楼 JSON 必须写进外部库 child_comment_blobs");
    assert.equal(blob.complete, 1);
    assert.deepEqual(JSON.parse(blob.payload_json).children.map(child => child.id), ["ch1", "ch2"]);
    assert.ok(remoteCalls.length > 0);

    // 读接口透明回源：主 D1 / 主 R2 都空空如也，页面依然能拿到评论
    const roots = await runWithDb(d1, () =>
      commentsModule.listRootComments(d1, CONTENT_PK, { limit: 20, offset: 0 }, bucket)
    );
    assert.equal(roots.length, 1, "listRootComments 必须透明从外部库读出根评论");
    assert.equal(roots[0].id, "r1");
    assert.equal(roots[0].child_count, 2);
    assert.equal(roots[0].preview_replies.length, 2, "必须从外部库 comment_threads.preview_json 还原 2 条预览");
    assert.equal(roots[0].preview_replies[0].content, "reply 1");
    assert.equal(roots[0].preview_replies[1].content, "reply 2");

    const children = await runWithDb(d1, () => commentsModule.getChildComments(bucket, "r1", d1));
    assert.deepEqual(
      children.map(child => child.id),
      ["ch1", "ch2"],
      "getChildComments 必须透明从外部库读出完整楼中楼"
    );
    assert.equal(children[0].content, "reply 1");
    assert.equal(children[1].beReplied, "A");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------- R2 边缘缓存 ----------

test("R2 边缘缓存：命中 0 次 R2 读取，楼中楼写入/清空后 purge 立即失效，children 响应带 CDN 缓存头", async () => {
  const r2Cache = await loadTs(path.join(workerSrc, "utils", "r2-cache.ts"));

  // 内存版 caches.default：与 Workers Cache API 相同的 match/put/delete 形状
  const edgeStore = new Map();
  const cacheApi = {
    async match(url) {
      const hit = edgeStore.get(String(url));
      return hit === undefined ? undefined : new Response(hit.body);
    },
    async put(url, response) {
      edgeStore.set(String(url), {
        body: await response.text(),
        cacheControl: response.headers.get("cache-control")
      });
    },
    async delete(url) {
      edgeStore.delete(String(url));
    }
  };
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: cacheApi };

  // 上一个用例可能把 external_storage_targets 缓存在 isolate 里；
  // 本用例的 bucket 没有外部目标配置，必须清掉缓存再回源，避免误打外部库
  workerModules.auth.invalidateExternalTargetsCache();
  workerModules.auth.invalidateMainCommentCountCache();
  workerModules.auth.resetRemoteSchemaCache();

  try {
    // 1) 首次读取回源 R2，并写入边缘缓存
    const htmlKey = "html/answer:edge/hash1";
    const cacheUrl = `https://r2-edge-cache.internal/${encodeURIComponent(htmlKey)}`;
    const r2Store = new Map([[htmlKey, "<p>edge cached</p>"]]);
    function makeBucket() {
      const stats = { gets: 0 };
      const bucket = {
        async get(key) {
          stats.gets++;
          const value = r2Store.get(key);
          return value === undefined ? null : { async text() { return value; } };
        },
        async put(key, value) {
          r2Store.set(key, String(value));
        },
        async delete(key) {
          r2Store.delete(key);
        }
      };
      return { bucket, stats };
    }

    const first = makeBucket();
    const text1 = await r2Cache.getR2TextWithEdgeCache(first.bucket, htmlKey, { immutable: true });
    assert.equal(text1, "<p>edge cached</p>");
    assert.equal(first.stats.gets, 1, "首次读取必须回源 R2");
    assert.equal(edgeStore.get(cacheUrl).cacheControl, "public, max-age=31536000, immutable");

    // 2) 同一 bucket 再读：进程内 Map 命中，0 次 R2
    const text2 = await r2Cache.getR2TextWithEdgeCache(first.bucket, htmlKey, { immutable: true });
    assert.equal(text2, "<p>edge cached</p>");
    assert.equal(first.stats.gets, 1, "内存缓存命中不得再读 R2");

    // 3) 换一个 bucket 实例（模拟另一个 isolate）：caches.default 命中，仍是 0 次 R2
    const second = makeBucket();
    const text3 = await r2Cache.getR2TextWithEdgeCache(second.bucket, htmlKey, { immutable: true });
    assert.equal(text3, "<p>edge cached</p>");
    assert.equal(second.stats.gets, 0, "CDN 边缘缓存命中必须 0 次 R2 Class B 调用");

    // 4) purge 后两层缓存同时失效，下一次读取重新回源
    await r2Cache.purgeR2EdgeCache(htmlKey);
    assert.equal(edgeStore.has(cacheUrl), false, "purge 必须删除 caches.default 条目");
    const text4 = await r2Cache.getR2TextWithEdgeCache(second.bucket, htmlKey, { immutable: true });
    assert.equal(text4, "<p>edge cached</p>");
    assert.equal(second.stats.gets, 1, "purge 后必须重新回源 R2");

    // 5) 可变内容按 ttlSeconds 生成 Cache-Control
    const legacyKey = "html/answer:edge";
    r2Store.set(legacyKey, "<p>legacy</p>");
    await r2Cache.getR2TextWithEdgeCache(second.bucket, legacyKey, { ttlSeconds: 3600 });
    assert.equal(
      edgeStore.get(`https://r2-edge-cache.internal/${encodeURIComponent(legacyKey)}`).cacheControl,
      "public, max-age=3600"
    );

    // 6) 楼中楼读路径命中边缘缓存；replaceCommentsByRoot 更新后自动 purge，读到新数据
    const { sqlite, d1 } = createMemoryDb();
    seedContent(sqlite);
    const commentBucket = makeBucket();
    const threadKey = "childcomments/r1.json";
    const threadUrl = `https://r2-edge-cache.internal/v2/${encodeURIComponent(threadKey)}`;
    await r2Cache.purgeR2EdgeCache(threadKey);

    const payload = (children) => ({
      contentPk: CONTENT_PK,
      partial: false,
      roots: [{
        id: "r1",
        author: "RootUser",
        authorAvatar: "",
        content: "root body",
        img: "",
        time: NOW_ISO,
        location: "上海",
        likes: 10,
        isAuthor: false,
        isTop: false,
        isFeatured: false,
        childCount: children.length,
        isChildrenComplete: true,
        children
      }]
    });
    const child = (id, content) => ({ id, parentId: "r1", author: "A", content, likes: 1 });

    const firstWrite = await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot(payload([child("ch1", "reply 1")]), { DB: d1, BUCKET: commentBucket.bucket })
    );
    assert.equal(firstWrite.r2Puts, 1);
    assert.equal(edgeStore.has(threadUrl), false, "写入后边缘缓存必须已被 purge");

    const readBefore = commentBucket.stats.gets;
    const read1 = await runWithDb(d1, () => commentsModule.getChildComments(commentBucket.bucket, "r1", d1));
    assert.deepEqual(read1.map(item => item.id), ["ch1"]);
    assert.equal(commentBucket.stats.gets - readBefore, 1);
    assert.equal(edgeStore.has(threadUrl), true, "读取后应写入边缘缓存");

    const readAgainBefore = commentBucket.stats.gets;
    const read2 = await runWithDb(d1, () => commentsModule.getChildComments(commentBucket.bucket, "r1", d1));
    assert.deepEqual(read2.map(item => item.id), ["ch1"]);
    assert.equal(commentBucket.stats.gets - readAgainBefore, 0, "楼中楼二次展开必须命中缓存，0 次 R2 读取");

    // 更新楼中楼：R2 PUT 后必须立刻 purge，读路径不能拿到旧缓存
    const secondWrite = await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot(
        payload([child("ch1", "reply 1"), child("ch2", "reply 2")]),
        { DB: d1, BUCKET: commentBucket.bucket }
      )
    );
    assert.equal(secondWrite.r2Puts, 1);
    assert.equal(edgeStore.has(threadUrl), false, "更新后边缘缓存必须被 purge");

    const read3Before = commentBucket.stats.gets;
    const read3 = await runWithDb(d1, () => commentsModule.getChildComments(commentBucket.bucket, "r1", d1));
    assert.deepEqual(read3.map(item => item.id), ["ch1", "ch2"], "purge 后必须读到最新楼中楼");
    assert.equal(commentBucket.stats.gets - read3Before, 1, "更新后必须重新回源 R2，而不是返回旧缓存");

    // 7) 全量清零时防删归档保留 R2 楼中楼对象，读路径仍可查看已归档回复
    const emptyWrite = await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot(
        { contentPk: CONTENT_PK, partial: false, roots: [], allRootIds: [] },
        { DB: d1, BUCKET: commentBucket.bucket }
      )
    );
    assert.equal(emptyWrite.r2Puts, 0);
    const readAfterClear = await runWithDb(d1, () =>
      commentsModule.getChildComments(commentBucket.bucket, "r1", d1)
    );
    assert.deepEqual(readAfterClear.map(item => item.id), ["ch1", "ch2"], "防删归档模式下全量清零仍保留已归档楼中楼");

    // 8) GET /api/contents/:pk 正文走边缘缓存；children 路由带短时 CDN 缓存头
    const contentsRoutePath = path.join(workerSrc, "routes", "contents.ts");
    const sharedIndexUrl = await moduleUrlFor(sharedIndexPath);
    const contentsRoutes = await loadTs(
      contentsRoutePath,
      new Map([["hono", honoMockUrl], ["shared", sharedIndexUrl]])
    );

    const htmlStore = makeBucket();
    const hash = "h";
    r2Store.set(`html/${CONTENT_PK}/${hash}`, "<p>full body</p>");
    const env = { BUCKET: htmlStore.bucket, DB: d1 };

    const res1 = await runWithDb(d1, () =>
      contentsRoutes.contentRoutes.__call("GET", "/:pk", { params: { pk: CONTENT_PK } }, env)
    );
    assert.equal(res1.body.content.content_html, "<p>full body</p>");
    assert.equal(htmlStore.stats.gets, 1);

    const res2 = await runWithDb(d1, () =>
      contentsRoutes.contentRoutes.__call("GET", "/:pk", { params: { pk: CONTENT_PK } }, env)
    );
    assert.equal(res2.body.content.content_html, "<p>full body</p>");
    assert.equal(htmlStore.stats.gets, 1, "详情页二次打开必须命中边缘缓存，0 次 R2 读取");

    const childrenRes = await runWithDb(d1, () =>
      contentsRoutes.contentRoutes.__call(
        "GET",
        "/:pk/comments/:rootId/children",
        { params: { pk: CONTENT_PK, rootId: "r1" } },
        env
      )
    );
    assert.equal(childrenRes.headers["cache-control"], "public, max-age=30, stale-while-revalidate=300");
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("processImageBatch：catch 异常分支受 MAX_IMAGE_TASK_ATTEMPTS 上限约束，第 3 次标 failed 不无限重试", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  const key = `images/${"9".repeat(64)}.jpg`;
  const id = seedImageTask(sqlite, {
    imageUrl: "https://picx.zhimg.com/throw-err.jpg",
    objectKey: key,
    status: "pending",
    attempts: 2,
    updatedAt: NOW_ISO
  });

  const throwingBucket = {
    async head() { throw new Error("simulated R2 head outage"); },
    async get() { return null; },
    async put() {},
    async delete() {}
  };

  const result = await runWithDb(d1, () =>
    imageTasksModule.processImageBatch(throwingBucket, 5)
  );
  assert.equal(result.claimed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.retry, 0);

  const row = sqlite.prepare(`SELECT status, last_error FROM image_tasks WHERE id = ?`).get(id);
  assert.equal(row.status, "failed");
  assert.match(row.last_error || "", /simulated R2 head outage/);
});

test("offload：getChildComments 优先外部库、empty complete 不复活旧回复，且 upsertContent 保留 prevCommentCount", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  sqlite.prepare(`UPDATE contents SET comment_count = 15, title = 'Old Title' WHERE pk = ?`).run(CONTENT_PK);

  const auth = workerModules.auth;
  auth.invalidateExternalTargetsCache();
  auth.invalidateMainCommentCountCache();
  auth.resetRemoteSchemaCache();

  const remoteSqlite = new Database(":memory:");
  const targetConfig = {
    id: "ext-turso-offload-consistency",
    name: "Turso 扩容库",
    provider: "turso",
    enabled: true,
    syncScopes: ["comments"],
    storageRole: "offload",
    overflowThresholdRows: 1500000,
    endpointUrl: "https://ext-turso-check.example.com",
    authToken: "turso-unit-token",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO
  };

  // 主 R2 放一个启用 offload 前残留的旧快照；主 D1 也残留旧扁平子行
  const r2Store = new Map([
    [auth.R2_EXTERNAL_TARGETS_KEY, JSON.stringify([targetConfig])],
    ["childcomments/r1.json", JSON.stringify({ children: [{ id: "stale_r2", content: "stale r2" }], complete: true })]
  ]);
  sqlite.prepare(`
    INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, first_seen_at, last_seen_at, is_deleted)
    VALUES ('stale_d1_child', ?, 'r1', 'Old', 'stale d1', 0, 'h', ?, ?, 0)
  `).run(CONTENT_PK, NOW_ISO, NOW_ISO);

  const bucket = {
    async get(key) {
      const value = r2Store.get(key);
      return value === undefined ? null : { async text() { return value; } };
    },
    async put(key, value) { r2Store.set(key, String(value)); },
    async head() { return null; },
    async delete(key) { r2Store.delete(key); }
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target !== "https://ext-turso-check.example.com/v2/pipeline") {
      throw new Error(`unexpected fetch: ${target}`);
    }
    const body = JSON.parse(String(init.body));
    const results = [];
    for (const request of body.requests) {
      if (request.type === "close") {
        results.push({ type: "ok", response: { type: "close" } });
        continue;
      }
      const sql = request.stmt.sql;
      const args = (request.stmt.args || []).map(arg => {
        if (!arg || arg.type === "null") return null;
        if (arg.type === "integer" || arg.type === "float") return Number(arg.value);
        return String(arg.value);
      });
      const statement = remoteSqlite.prepare(sql);
      if (statement.reader) {
        const cols = statement.columns().map(column => ({ name: column.name }));
        const rows = statement.all(...args).map(row => cols.map(column => tursoCell(row[column.name])));
        results.push({ type: "ok", response: { type: "execute", result: { cols, rows, affected_row_count: 0, last_insert_rowid: null } } });
      } else {
        const info = statement.run(...args);
        results.push({ type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: info.changes, last_insert_rowid: null } } });
      }
    }
    return { ok: true, status: 200, json: async () => ({ results }), text: async () => "" };
  };

  try {
    // 1) 先写入有子评论的数据，再模拟在原站把楼中楼删光（complete=true, children=[]）
    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        roots: [{
          id: "r1",
          author: "RootUser",
          authorAvatar: "",
          content: "root body",
          img: "",
          time: NOW_ISO,
          location: "上海",
          likes: 10,
          isAuthor: false,
          isTop: false,
          isFeatured: false,
          childCount: 1,
          isChildrenComplete: true,
          children: [{ id: "ch1", parentId: "r1", author: "A", content: "reply 1", likes: 1 }]
        }]
      }, { DB: d1, BUCKET: bucket })
    );

    // 人为在外部库残留一条旧扁平子行，然后提交完整空快照
    remoteSqlite.prepare(`
      INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, first_seen_at, last_seen_at, is_deleted)
      VALUES ('stale_remote_child', ?, 'r1', 'Old', 'stale remote', 0, 'h', ?, ?, 0)
    `).run(CONTENT_PK, NOW_ISO, NOW_ISO);

    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        roots: [{
          id: "r1",
          author: "RootUser",
          authorAvatar: "",
          content: "root body",
          img: "",
          time: NOW_ISO,
          location: "上海",
          likes: 10,
          isAuthor: false,
          isTop: false,
          isFeatured: false,
          childCount: 0,
          isChildrenComplete: true,
          children: []
        }]
      }, { DB: d1, BUCKET: bucket })
    );

    const children = await runWithDb(d1, () => commentsModule.getChildComments(bucket, "r1", d1));
    assert.deepEqual(children.map(c => c.id), ["ch1"], "外部库防删归档必须保留 ch1，不得被主 R2 旧快照或旧扁平行污染");
    assert.equal(children[0].isDeleted, true);

    // 2) 主 D1 0 行评论时，upsertContent 通过外部库感知已有评论，保持 prevCommentCount = 15
    const existingRow = sqlite.prepare(`SELECT * FROM contents WHERE pk = ?`).get(CONTENT_PK);
    const up = await runWithDb(d1, () =>
      contentsModule.upsertContent({
        sourceType: "answer",
        sourceId: existingRow.source_id,
        title: existingRow.title,
        sourceUrl: existingRow.source_url,
        contentHtml: "",
        contentMd: existingRow.content_md,
        excerpt: existingRow.excerpt,
        voteupCount: existingRow.voteup_count,
        commentCount: 15,
        favoriteCount: existingRow.favorite_count,
        visitCount: existingRow.visit_count
      }, bucket)
    );
    assert.equal(up.prevCommentCount, 15, "评论已 offload 时 prevCommentCount 不得误退回 0");
  } finally {
    globalThis.fetch = originalFetch;
    auth.invalidateExternalTargetsCache();
  }
});

test("upsertContent：历史空串元数据与 null 比较不产生伪写入，真实修复元数据走单条轻量 UPDATE 且二次 0 写", async () => {
  const { sqlite, d1 } = createMemoryDb();
  const initialHash = "legacy-empty-meta-hash";
  sqlite.prepare(`
    INSERT INTO contents (
      pk, source_type, source_id, source_url, title,
      author_name, author_url_token, author_avatar, author_headline,
      question_id, question_title, content_html, content_md, excerpt,
      voteup_count, comment_count, favorite_count, visit_count,
      is_collapsed, is_labeled, label_info,
      created_time, updated_time, content_hash, first_seen_at, last_seen_at, is_deleted
    ) VALUES (?, 'answer', '1', 'https://www.zhihu.com/answer/1', 'Existing Title',
              'OldAuthor', '', '', '', '', '', '', 'existing md', 'existing excerpt',
              5, 0, 1, 2, 0, 0, '', ?, ?, ?, ?, ?, 0)
  `).run(CONTENT_PK, NOW_ISO, NOW_ISO, initialHash, NOW_ISO, NOW_ISO);

  d1.writes.length = 0;

  // 1) 传入默认/空字段，不得把数据库里的 "" 与 null 判为不同而触发伪写入
  const noopRes = await runWithDb(d1, () =>
    contentsModule.upsertContent({
      sourceType: "answer",
      sourceId: "1",
      title: "Existing Title",
      sourceUrl: "https://www.zhihu.com/answer/1",
      author: { name: "OldAuthor", urlToken: null, avatarUrl: "", headline: "" },
      question: { id: "", title: "" },
      contentHtml: "",
      contentMd: "",
      excerpt: "existing excerpt",
      voteupCount: 5,
      commentCount: 0,
      favoriteCount: 1,
      visitCount: 2,
      labelInfo: "",
      createdTime: NOW_ISO,
      updatedTime: NOW_ISO
    })
  );
  assert.equal(noopRes.changed, false);
  assert.equal(d1.writes.length, 0, "空串与 null 等价，弱载荷同步不得触发任何 UPDATE");

  // 2) 传入修复后的作者名/question/sourceUrl（title 与正文不变）：走 1 次轻量 UPDATE 且 changed=false
  const repairedRes = await runWithDb(d1, () =>
    contentsModule.upsertContent({
      sourceType: "answer",
      sourceId: "1",
      title: "Existing Title",
      sourceUrl: "https://www.zhihu.com/question/999/answer/1",
      author: { name: "FixedAuthor", urlToken: "fixed-token", avatarUrl: "", headline: "" },
      question: { id: "999", title: "Fixed Question Title" },
      contentHtml: "",
      contentMd: "",
      excerpt: "existing excerpt",
      voteupCount: 5,
      commentCount: 0,
      favoriteCount: 1,
      visitCount: 2,
      labelInfo: "",
      createdTime: NOW_ISO,
      updatedTime: NOW_ISO
    })
  );
  assert.equal(repairedRes.changed, false);
  assert.equal(d1.writes.length, 1, "修复元数据应执行 1 次轻量 UPDATE");

  const updatedRow = sqlite.prepare(
    `SELECT author_name, author_url_token, source_url, question_id, question_title FROM contents WHERE pk = ?`
  ).get(CONTENT_PK);
  assert.equal(updatedRow.author_name, "FixedAuthor");
  assert.equal(updatedRow.author_url_token, "fixed-token");
  assert.equal(updatedRow.source_url, "https://www.zhihu.com/question/999/answer/1");
  assert.equal(updatedRow.question_id, "999");
  assert.equal(updatedRow.question_title, "Fixed Question Title");

  // 3) 再次同输入 0 写
  d1.writes.length = 0;
  const thirdRes = await runWithDb(d1, () =>
    contentsModule.upsertContent({
      sourceType: "answer",
      sourceId: "1",
      title: "Existing Title",
      sourceUrl: "https://www.zhihu.com/question/999/answer/1",
      author: { name: "FixedAuthor", urlToken: "fixed-token", avatarUrl: "", headline: "" },
      question: { id: "999", title: "Fixed Question Title" },
      contentHtml: "",
      contentMd: "",
      excerpt: "existing excerpt",
      voteupCount: 5,
      commentCount: 0,
      favoriteCount: 1,
      visitCount: 2,
      labelInfo: "",
      createdTime: NOW_ISO,
      updatedTime: NOW_ISO
    })
  );
  assert.equal(thirdRes.changed, false);
  assert.equal(d1.writes.length, 0, "修复后同输入再次写入必须 0 写");

  // 4) 弱载荷带回退链接/匿名作者/占位问题标题时，不得降级覆盖既有规范元数据且应 0 写
  d1.writes.length = 0;
  const downgradeRes = await runWithDb(d1, () =>
    contentsModule.upsertContent({
      sourceType: "answer",
      sourceId: "1",
      title: "未知问题",
      sourceUrl: "https://www.zhihu.com/answer/1",
      author: { name: "匿名", urlToken: null, avatarUrl: "", headline: "" },
      question: { id: "999", title: "未知问题" },
      contentHtml: "",
      contentMd: "",
      excerpt: "existing excerpt",
      voteupCount: 5,
      commentCount: 0,
      favoriteCount: 1,
      visitCount: 2,
      labelInfo: "",
      createdTime: NOW_ISO,
      updatedTime: NOW_ISO
    })
  );
  assert.equal(downgradeRes.changed, false);
  assert.equal(d1.writes.length, 0, "回退/占位元数据不得降级覆盖或触发伪 UPDATE");
  const preservedRow = sqlite.prepare(
    `SELECT author_name, source_url, question_title FROM contents WHERE pk = ?`
  ).get(CONTENT_PK);
  assert.equal(preservedRow.author_name, "FixedAuthor");
  assert.equal(preservedRow.source_url, "https://www.zhihu.com/question/999/answer/1");
  assert.equal(preservedRow.question_title, "Fixed Question Title");
});

test("saveExternalTargetsRaw：D1 与 R2 全失败时不残留错误内存缓存", async () => {
  const { d1 } = createMemoryDb();
  const auth = workerModules.auth;
  auth.invalidateExternalTargetsCache();

  const failingD1 = {
    prepare() {
      return {
        bind() { return this; },
        async run() { throw new Error("D1 write outage"); },
        async first() { return null; },
        async all() { return { results: [] }; }
      };
    },
    async batch() { throw new Error("D1 write outage"); }
  };
  const failingBucket = {
    async put() { throw new Error("R2 write outage"); },
    async get() { return null; }
  };

  await assert.rejects(
    () =>
      runWithDb(failingD1, () =>
        auth.saveExternalTargetsRaw(failingBucket, [{
          id: "ext-fail",
          name: "Bad",
          provider: "turso",
          enabled: true,
          syncScopes: ["comments"],
          storageRole: "offload",
          overflowThresholdRows: 1500000,
          endpointUrl: "https://fail.example.com",
          authToken: "tok",
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO
        }])
      ),
    /D1 write outage/
  );

  // D1 为空但缓存必须已失效，不得返回刚才失败写入的 ext-fail
  const after = await runWithDb(d1, () => auth.getExternalTargetsRaw(null));
  assert.deepEqual(after, []);
  auth.invalidateExternalTargetsCache();
});

test("offload：listRootComments 混合分页跨页去重、getChildComments 不完整空快照与 partial=false 不完整楼中楼合并旧扁平行", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);

  const auth = workerModules.auth;
  auth.invalidateExternalTargetsCache();
  auth.invalidateMainCommentCountCache();
  auth.resetRemoteSchemaCache();

  const remoteSqlite = new Database(":memory:");
  const targetConfig = {
    id: "ext-turso-hybrid-pagination",
    name: "Turso 混合分页测试库",
    provider: "turso",
    enabled: true,
    syncScopes: ["comments"],
    storageRole: "offload",
    overflowThresholdRows: 1500000,
    endpointUrl: "https://ext-turso-hybrid.example.com",
    authToken: "turso-hybrid-token",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO
  };

  const r2Store = new Map([[auth.R2_EXTERNAL_TARGETS_KEY, JSON.stringify([targetConfig])]]);
  const bucket = {
    async get(key) {
      const value = r2Store.get(key);
      return value === undefined ? null : { async text() { return value; } };
    },
    async put(key, value) { r2Store.set(key, String(value)); },
    async head() { return null; },
    async delete(key) { r2Store.delete(key); }
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target !== "https://ext-turso-hybrid.example.com/v2/pipeline") {
      throw new Error(`unexpected fetch: ${target}`);
    }
    const body = JSON.parse(String(init.body));
    const results = [];
    for (const request of body.requests) {
      if (request.type === "close") {
        results.push({ type: "ok", response: { type: "close" } });
        continue;
      }
      const sql = request.stmt.sql;
      const args = (request.stmt.args || []).map(arg => {
        if (!arg || arg.type === "null") return null;
        if (arg.type === "integer" || arg.type === "float") return Number(arg.value);
        return String(arg.value);
      });
      const statement = remoteSqlite.prepare(sql);
      if (statement.reader) {
        const cols = statement.columns().map(column => ({ name: column.name }));
        const rows = statement.all(...args).map(row => cols.map(column => tursoCell(row[column.name])));
        results.push({ type: "ok", response: { type: "execute", result: { cols, rows, affected_row_count: 0, last_insert_rowid: null } } });
      } else {
        const info = statement.run(...args);
        results.push({ type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: info.changes, last_insert_rowid: null } } });
      }
    }
    return { ok: true, status: 200, json: async () => ({ results }), text: async () => "" };
  };

  try {
    // 1) 主 D1 有 3 条旧根评论 (A:100, B:50, Z:10)
    const insertMainRoot = sqlite.prepare(`
      INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, first_seen_at, last_seen_at, is_deleted)
      VALUES (?, ?, NULL, 'User', 'text', ?, 'h', ?, ?, 0)
    `);
    insertMainRoot.run("root_A", CONTENT_PK, 100, NOW_ISO, NOW_ISO);
    insertMainRoot.run("root_B", CONTENT_PK, 50, NOW_ISO, NOW_ISO);
    insertMainRoot.run("root_Z", CONTENT_PK, 10, NOW_ISO, NOW_ISO);

    // 2) 外部库写入 3 条根评论 (root_B 重叠:50, root_C:30, root_D:5)，且 root_C 带 1 条不完整子评论；
    // 先插入一条外部库旧扁平子行给 root_C，验证 partial=false + isChildrenComplete=false 也能合并保留它
    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        roots: [{
          id: "root_B",
          author: "UserB",
          authorAvatar: "",
          content: "B",
          img: "",
          time: NOW_ISO,
          location: "上海",
          likes: 50,
          isAuthor: false,
          isTop: false,
          isFeatured: false,
          childCount: 0,
          isChildrenComplete: true,
          children: []
        }]
      }, { DB: d1, BUCKET: bucket })
    );

    remoteSqlite.prepare(`
      INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, first_seen_at, last_seen_at, is_deleted)
      VALUES ('legacy_child_1', ?, 'root_C', 'Legacy', 'legacy reply', 1, 'h1', ?, ?, 0)
    `).run(CONTENT_PK, NOW_ISO, NOW_ISO);

    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        roots: [
          {
            id: "root_B",
            author: "UserB",
            authorAvatar: "",
            content: "B",
            img: "",
            time: NOW_ISO,
            location: "上海",
            likes: 50,
            isAuthor: false,
            isTop: false,
            isFeatured: false,
            childCount: 0,
            isChildrenComplete: true,
            children: []
          },
          {
            id: "root_C",
            author: "UserC",
            authorAvatar: "",
            content: "C",
            img: "",
            time: NOW_ISO,
            location: "上海",
            likes: 30,
            isAuthor: false,
            isTop: false,
            isFeatured: false,
            childCount: 2,
            isChildrenComplete: false,
            children: [{ id: "new_child_2", parentId: "root_C", author: "New", content: "new reply", likes: 2 }]
          },
          {
            id: "root_D",
            author: "UserD",
            authorAvatar: "",
            content: "D",
            img: "",
            time: NOW_ISO,
            location: "上海",
            likes: 5,
            isAuthor: false,
            isTop: false,
            isFeatured: false,
            childCount: 0,
            isChildrenComplete: true,
            children: []
          }
        ]
      }, { DB: d1, BUCKET: bucket })
    );

    // 验证 partial=false + isChildrenComplete=false 合并保留了外部库旧扁平子评论
    const mergedChildren = await runWithDb(d1, () => commentsModule.getChildComments(bucket, "root_C", d1));
    assert.deepEqual(
      mergedChildren.map(c => c.id),
      ["legacy_child_1", "new_child_2"],
      "partial=false 时若单根 isChildrenComplete=false 也必须合并外部库旧扁平子评论"
    );

    // 验证 getChildComments 在外部库 blob 为不完整空快照 (complete=0, children=[]) 时回查外部扁平子评论行
    remoteSqlite.prepare(`
      INSERT OR REPLACE INTO child_comment_blobs (root_id, content_pk, payload_json, complete, updated_at)
      VALUES ('root_C', ?, ?, 0, ?)
    `).run(CONTENT_PK, JSON.stringify({ children: [], complete: false, updatedAt: NOW_ISO }), NOW_ISO);
    const recoveredChildren = await runWithDb(d1, () => commentsModule.getChildComments(bucket, "root_C", d1));
    assert.deepEqual(
      recoveredChildren.map(c => c.id),
      ["legacy_child_1"],
      "不完整空 blob 不得屏蔽外部库既有扁平子评论"
    );

    // 验证 listRootComments 混合分页（limit=2: page1=[A,B], page2=[Z,C], page3=[D]）不重复不跳过
    const p1 = await runWithDb(d1, () => commentsModule.listRootComments(d1, CONTENT_PK, { limit: 2, offset: 0 }, bucket));
    const p2 = await runWithDb(d1, () => commentsModule.listRootComments(d1, CONTENT_PK, { limit: 2, offset: 2 }, bucket));
    const p3 = await runWithDb(d1, () => commentsModule.listRootComments(d1, CONTENT_PK, { limit: 2, offset: 4 }, bucket));
    assert.deepEqual(p1.map(r => r.id), ["root_A", "root_B"]);
    assert.deepEqual(p2.map(r => r.id), ["root_Z", "root_C"]);
    assert.deepEqual(p3.map(r => r.id), ["root_D"]);
  } finally {
    globalThis.fetch = originalFetch;
    auth.invalidateExternalTargetsCache();
  }
});

test("main comments：partial=false + isChildrenComplete=false 保留旧扁平 D1 子评论，且外部库失败时降级回写主库", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  const auth = workerModules.auth;
  auth.invalidateExternalTargetsCache();
  auth.invalidateMainCommentCountCache();

  // 插入迁移前旧扁平 D1 子评论
  sqlite.prepare(`
    INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, first_seen_at, last_seen_at, is_deleted)
    VALUES ('legacy_d1_child', ?, 'r_incomplete', 'OldUser', 'old flat reply', 1, 'h', ?, ?, 0)
  `).run(CONTENT_PK, NOW_ISO, NOW_ISO);

  // 配置一个启用 offload 但端点不可达的外部库，触发降级回写主 D1/R2
  const r2Store = new Map([
    [auth.R2_EXTERNAL_TARGETS_KEY, JSON.stringify([{
      id: "ext-down",
      name: "Down Turso",
      provider: "turso",
      enabled: true,
      syncScopes: ["comments"],
      storageRole: "offload",
      overflowThresholdRows: 1500000,
      endpointUrl: "https://down-turso.example.com",
      authToken: "tok",
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO
    }])]
  ]);
  const bucket = {
    async get(key) {
      const value = r2Store.get(key);
      return value === undefined ? null : { async text() { return value; } };
    },
    async put(key, value) { r2Store.set(key, String(value)); },
    async delete(key) { r2Store.delete(key); }
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network outage"); };
  try {
    const res = await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        allRootIds: ["r_incomplete"],
        roots: [{
          id: "r_incomplete",
          author: "Root",
          authorAvatar: "",
          content: "root",
          img: "",
          time: NOW_ISO,
          location: "",
          likes: 5,
          isAuthor: false,
          isTop: false,
          isFeatured: false,
          childCount: 2,
          isChildrenComplete: false,
          children: [{ id: "preview_child", parentId: "r_incomplete", author: "Preview", content: "new preview", likes: 2 }]
        }]
      }, { DB: d1, BUCKET: bucket })
    );
    assert.equal(res.added, 1, "外部库写入失败时必须降级写入主 D1/R2 而不抛 500");
    const stored = JSON.parse(r2Store.get("childcomments/r_incomplete.json"));
    assert.deepEqual(
      stored.children.map(c => c.id),
      ["legacy_d1_child", "preview_child"],
      "partial=false 时单根 isChildrenComplete=false 必须合并保留旧扁平 D1 子评论"
    );
  } finally {
    globalThis.fetch = originalFetch;
    auth.invalidateExternalTargetsCache();
  }
});

test("collections：incremental 快照保留真实 item_count、支持无变更 0 写，且 getCollectionDetail 不覆盖 ci.author_name", async () => {
  const { sqlite, d1 } = createMemoryDb();
  const baseCollection = { id: "col_inc", title: "测试收藏", ownerToken: "me", updatedTime: NOW_ISO };
  const twoItems = [
    { sourceType: "answer", sourceId: "1", title: "Q1", authorName: "Author1", sourceUrl: "https://www.zhihu.com/question/10/answer/1" },
    { sourceType: "article", sourceId: "2", title: "A2", authorName: "Author2", sourceUrl: "https://zhuanlan.zhihu.com/p/2" }
  ];

  // 先全量写入 2 条，contents 表中故意不放 article:2（模拟内容尚未抓全）
  await runWithDb(d1, () =>
    collectionsModule.upsertCollectionSnapshot({ collection: baseCollection, incremental: false, items: twoItems })
  );

  // 1) incremental 只传第 1 条且无新增删除：item_count 仍保持 2 且 0 写快路径生效
  d1.writes.length = 0;
  const incSame = await runWithDb(d1, () =>
    collectionsModule.upsertCollectionSnapshot({ collection: baseCollection, incremental: true, items: [twoItems[0]] })
  );
  assert.equal(incSame.unchanged, true);
  assert.equal(d1.writes.length, 0, "incremental 分片完全无变化时应命中 0 写快路径");

  // 2) incremental 新增第 3 条：快照 item_count 应为总有效数 3（而非本次传入数 2）
  const newItem = { sourceType: "answer", sourceId: "3", title: "Q3", authorName: "Author3", sourceUrl: "https://www.zhihu.com/question/30/answer/3" };
  const incAdd = await runWithDb(d1, () =>
    collectionsModule.upsertCollectionSnapshot({ collection: baseCollection, incremental: true, items: [twoItems[0], newItem] })
  );
  assert.equal(incAdd.added, 1);
  assert.equal(incAdd.count, 3);
  const latestSnap = sqlite.prepare(`SELECT item_count FROM collection_snapshots WHERE collection_id = 'col_inc' ORDER BY id DESC LIMIT 1`).get();
  assert.equal(latestSnap.item_count, 3, "incremental 快照记录的 item_count 必须反映全量有效条目数");

  // 3) getCollectionDetail 在 contents 无对应行时不得用 null 覆盖 ci.author_name
  const detail = await runWithDb(d1, () => collectionsModule.getCollectionDetail("col_inc"));
  const articleRow = detail.items.find(i => i.source_id === "2");
  assert.equal(articleRow.author_name, "Author2");
});

test("contents / following / auth / schema：1970 时间戳过滤、last_synced_at 保留、空 [] 不复活及 null 载荷校验", async () => {
  const { sqlite, d1 } = createMemoryDb();
  const auth = workerModules.auth;
  const followingModule = await loadTs(path.join(workerSrc, "services", "following.ts"));
  auth.invalidateExternalTargetsCache();

  // 1) IngestContentSchema 接受 author/question/time/boolean 为 null
  const parsedNulls = workerModules.schemas.IngestContentSchema.parse({
    sourceType: "answer",
    sourceId: "88",
    sourceUrl: "https://www.zhihu.com/answer/88",
    title: null,
    author: { name: null, urlToken: null, avatarUrl: null, headline: null },
    question: null,
    isCollapsed: null,
    isLabeled: null,
    createdTime: null,
    updatedTime: null
  });
  assert.equal(parsedNulls.author.name, "");
  assert.equal(parsedNulls.isCollapsed, undefined);

  const parsedNullAuthor = workerModules.schemas.IngestContentSchema.parse({
    sourceType: "answer",
    sourceId: "88",
    sourceUrl: "https://www.zhihu.com/answer/88",
    title: null,
    author: null
  });
  assert.deepEqual(parsedNullAuthor.author, { name: "", urlToken: null, avatarUrl: "", headline: "" });

  // 2) upsertContent 首次 INSERT 不写入 1970-01-01 哨兵，后续真实时间与摘要可通过轻量 UPDATE 修复
  await runWithDb(d1, () =>
    contentsModule.upsertContent({
      sourceType: "answer",
      sourceId: "88",
      title: "Title",
      sourceUrl: "https://www.zhihu.com/answer/88",
      contentHtml: "",
      contentMd: "",
      excerpt: "",
      voteupCount: 1,
      commentCount: 0,
      createdTime: "1970-01-01T00:00:00.000Z",
      updatedTime: "1970-01-01T00:00:00.000Z"
    })
  );
  const inserted = sqlite.prepare(`SELECT created_time, updated_time FROM contents WHERE pk = 'answer:88'`).get();
  assert.equal(inserted.created_time, null);
  assert.equal(inserted.updated_time, null);

  await runWithDb(d1, () =>
    contentsModule.upsertContent({
      sourceType: "answer",
      sourceId: "88",
      title: "Title",
      sourceUrl: "https://www.zhihu.com/answer/88",
      contentHtml: "",
      contentMd: "",
      excerpt: "Real excerpt",
      voteupCount: 1,
      commentCount: 0,
      createdTime: NOW_ISO,
      updatedTime: NOW_ISO
    })
  );
  const repaired = sqlite.prepare(`SELECT excerpt, created_time, updated_time FROM contents WHERE pk = 'answer:88'`).get();
  assert.equal(repaired.excerpt, "Real excerpt");
  assert.equal(repaired.created_time, NOW_ISO);
  assert.equal(repaired.updated_time, NOW_ISO);

  // 2b) 未改动正文/标题时，另一通道发来的不同摘要与更早时间戳不得触发无效 UPDATE 或回退
  let updateContentsCount = 0;
  const countingD1 = {
    prepare(sql) {
      if (/^\s*UPDATE\s+contents\b/i.test(sql)) {
        updateContentsCount++;
      }
      return d1.prepare(sql);
    },
    batch: d1.batch.bind(d1)
  };
  await runWithDb(countingD1, () =>
    contentsModule.upsertContent({
      sourceType: "answer",
      sourceId: "88",
      title: "Title",
      sourceUrl: "https://www.zhihu.com/answer/88",
      contentHtml: "",
      contentMd: "",
      excerpt: "Different channel excerpt",
      voteupCount: 1,
      commentCount: 0,
      createdTime: "2020-01-01T00:00:00.000Z",
      updatedTime: "2020-01-01T00:00:00.000Z"
    })
  );
  assert.equal(updateContentsCount, 0);
  const afterStaleSync = sqlite.prepare(`SELECT excerpt, created_time, updated_time FROM contents WHERE pk = 'answer:88'`).get();
  assert.equal(afterStaleSync.excerpt, "Real excerpt");
  assert.equal(afterStaleSync.created_time, NOW_ISO);
  assert.equal(afterStaleSync.updated_time, NOW_ISO);

  // 更晚的 updatedTime 允许向前推进，同时 created_time 保持锁定
  const LATER_ISO = "2099-01-01T00:00:00.000Z";
  await runWithDb(d1, () =>
    contentsModule.upsertContent({
      sourceType: "answer",
      sourceId: "88",
      title: "Title",
      sourceUrl: "https://www.zhihu.com/answer/88",
      contentHtml: "",
      contentMd: "",
      excerpt: "Real excerpt",
      voteupCount: 1,
      commentCount: 0,
      createdTime: LATER_ISO,
      updatedTime: LATER_ISO
    })
  );
  const afterLaterUpdate = sqlite.prepare(`SELECT created_time, updated_time FROM contents WHERE pk = 'answer:88'`).get();
  assert.equal(afterLaterUpdate.created_time, NOW_ISO);
  assert.equal(afterLaterUpdate.updated_time, LATER_ISO);

  // 3) getExternalTargetsRaw：D1 明确存 "[]" 时不得从 R2 复活已删目标
  sqlite.prepare(
    `INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, '[]', ?)`
  ).run("external_storage_targets", NOW_ISO);
  const staleR2Bucket = {
    async get(key) {
      if (key === auth.R2_EXTERNAL_TARGETS_KEY) {
        return { async text() { return JSON.stringify([{ id: "ghost", name: "Ghost", provider: "webhook", enabled: true, endpointUrl: "https://example.com" }]); } };
      }
      return null;
    }
  };
  const targetsAfterClear = await runWithDb(d1, () => auth.getExternalTargetsRaw(staleR2Bucket));
  assert.deepEqual(targetsAfterClear, []);
  auth.invalidateExternalTargetsCache();

  // 4) following：setFollowedUserSyncMode 后不得因 D1 last_seen_at 更晚而丢掉 last_synced_at
  const followBucket = (() => {
    const store = new Map();
    return {
      async get(key) {
        const val = store.get(key);
        return val === undefined ? null : { async text() { return val; } };
      },
      async put(key, value) { store.set(key, String(value)); }
    };
  })();
  await runWithDb(d1, () =>
    followingModule.upsertFollowedUsersSnapshot(followBucket, [{ urlToken: "u1", name: "User 1", answerCount: 10, articlesCount: 1 }], true)
  );
  await runWithDb(d1, () =>
    followingModule.updateFollowedUserProgress(followBucket, "u1", { resumeOffset: 20, historyDone: true, lastCheckedAnswerId: "a1" })
  );
  const beforeSwitch = await runWithDb(d1, () => followingModule.getFollowedUsersMap(followBucket));
  const savedSyncedAt = beforeSwitch.u1.last_synced_at;
  assert.ok(savedSyncedAt);
  await runWithDb(d1, () => followingModule.setFollowedUserSyncMode(followBucket, "u1", "full"));
  const afterSwitch = await runWithDb(d1, () => followingModule.getFollowedUsersMap(followBucket));
  assert.equal(afterSwitch.u1.last_synced_at, savedSyncedAt);
  assert.equal(afterSwitch.u1.sync_mode, "full");
});

test("[P0-2][P1-8] crawler runScraper 与 syncHotCommentsForContent：子评论闭评不标记完整 + 首页 ts 空页回退 score", async () => {
  const prevGet = globalThis.__crawlerContext.request.get;
  const prevFetch = globalThis.fetch;
  const prevInput = globalThis.__crawlerInput;
  const recorded = [];

  const rootCommentOrders = [];
  try {
    globalThis.__crawlerInput = {
      ...prevInput,
      runType: "answers",
      syncConfig: { commentsMyAnswers: "full" }
    };
    globalThis.__crawlerContext.request.get = async url => {
      const target = String(url);
      if (target.includes("/answers?")) {
        return okJson({ data: [answerFixture], paging: { is_end: true } });
      }
      if (target.includes("/api/v4/answers/123?")) {
        return okJson({ id: 123, voteup_count: 10, visit_count: 5, comment_count: 2 });
      }
      if (target.includes("/root_comment?") && target.includes("order_by=ts")) {
        rootCommentOrders.push("ts");
        // 模拟 order_by=ts 首页假空页（is_end=false）
        return okJson({ data: [], paging: { is_end: false } });
      }
      if (target.includes("/root_comment?") && target.includes("order_by=score")) {
        rootCommentOrders.push("score");
        return okJson({
          data: [
            {
              id: "r-closed-1",
              author: { name: "Ann", avatar_url: "" },
              content: "<p>root</p>",
              created_time: 1700000000,
              vote_count: 1,
              child_comment_count: 5,
              child_comments: [
                { id: "c-inline-1", author: { name: "B", avatar_url: "" }, content: "<p>inline</p>", created_time: 1700000001, vote_count: 0 }
              ]
            }
          ],
          paging: { is_end: true }
        });
      }
      if (target.includes("/comments/r-closed-1/child_comments")) {
        return {
          ok: () => false,
          status: () => 403,
          json: async () => ({ error: { code: 106, message: "评论已关闭" } }),
          text: async () => JSON.stringify({ error: { code: 106, message: "评论已关闭" } })
        };
      }
      throw new Error(`unexpected URL in P0-2/P1-8 test: ${target}`);
    };
    globalThis.fetch = async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      recorded.push({ pathname, body });
      if (pathname === "/ingest/content") {
        return okJson({ created: true, changed: false, prevCommentCount: 0, pk: CONTENT_PK });
      }
      return okJson({ added: 0, updated: 0, deleted: 0 });
    };

    rootCommentOrders.length = 0;
    await quietly(() => crawlerModule.runScraper());
    assert.deepEqual(rootCommentOrders, ["ts", "score"], "runScraper 必须先请求 order_by=ts 再回退 order_by=score");

    rootCommentOrders.length = 0;
    await quietly(() => crawlerModule.syncHotCommentsForContent(globalThis.__crawlerContext, "answer", "123", "full"));
    assert.deepEqual(rootCommentOrders, ["ts", "score"], "syncHotCommentsForContent 必须先请求 order_by=ts 再回退 order_by=score");

    const commentReqs = recorded.filter(r => r.pathname === "/ingest/comments-by-root");
    assert.equal(commentReqs.length, 2, "两条链路均应通过 order_by=score 回退提交评论");
    for (const req of commentReqs) {
      assert.equal(req.body.roots.length, 1);
      assert.equal(req.body.roots[0].id, "r-closed-1");
      assert.equal(
        req.body.roots[0].isChildrenComplete,
        false,
        "子评论遇已关闭评论必须发送 isChildrenComplete=false，防止覆盖 R2 历史楼中楼"
      );
    }
  } finally {
    globalThis.__crawlerContext.request.get = prevGet;
    globalThis.fetch = prevFetch;
    globalThis.__crawlerInput = prevInput;
  }
});

// ---------- P1-1 / P1-4 / P1-5 / P1-9 / P2-1 / P2-2 / P2-5 / P2-7 Worker 隔离回归测试 ----------

test("[P1-1] 楼中楼写路径跳过跨 isolate 旧缓存，读路径缩短为 30 秒 TTL", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  workerModules.auth.invalidateExternalTargetsCache();

  const edgeStore = new Map();
  const cacheApi = {
    async match(url) {
      const hit = edgeStore.get(String(url));
      return hit === undefined ? undefined : new Response(hit.body);
    },
    async put(url, response) {
      edgeStore.set(String(url), {
        body: await response.text(),
        cacheControl: response.headers.get("cache-control")
      });
    },
    async delete(url) {
      edgeStore.delete(String(url));
    }
  };
  const originalCaches = globalThis.caches;
  globalThis.caches = { default: cacheApi };

  const r2Store = new Map();
  const bucket = {
    async get(key) {
      const val = r2Store.get(key);
      return val === undefined ? null : { async text() { return val; } };
    },
    async put(key, val) { r2Store.set(key, String(val)); },
    async delete(key) { r2Store.delete(key); }
  };

  try {
    const threadKey = "childcomments/r-p11.json";
    const threadCacheUrl = `https://r2-edge-cache.internal/v2/${encodeURIComponent(threadKey)}`;

    // 1) 初始写入 1 条不完整子评论，并由读路径预热 30 秒边缘缓存 + 进程内缓存
    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        allRootIds: ["r-p11"],
        roots: [{
          id: "r-p11",
          author: "Root",
          authorAvatar: "",
          content: "root",
          img: "",
          time: NOW_ISO,
          location: "",
          likes: 1,
          isAuthor: false,
          isTop: false,
          isFeatured: false,
          childCount: 1,
          isChildrenComplete: false,
          children: [{ id: "ch1", parentId: "r-p11", author: "A", content: "first", likes: 1 }]
        }]
      }, { DB: d1, BUCKET: bucket })
    );

    const read1 = await runWithDb(d1, () => commentsModule.getChildComments(bucket, "r-p11", d1));
    assert.deepEqual(read1.map(c => c.id), ["ch1"]);
    assert.equal(edgeStore.get(threadCacheUrl).cacheControl, "public, max-age=30");

    // 2) 模拟另一 isolate 直接把 R2 更新为含 ch2 的新对象，但当前 isolate 的内存/边缘缓存仍是旧 [ch1]
    r2Store.set(threadKey, JSON.stringify({
      children: [
        { id: "ch1", parentId: "r-p11", author: "A", content: "first", likes: 1 },
        { id: "ch2", parentId: "r-p11", author: "B", content: "from-other-isolate", likes: 2 }
      ],
      complete: false
    }));

    // partial 合并写路径必须 bypassCache 直读最新 R2，绝不能拿旧缓存把 ch2 覆盖丢掉
    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        allRootIds: ["r-p11"],
        roots: [{
          id: "r-p11",
          author: "Root",
          authorAvatar: "",
          content: "root",
          img: "",
          time: NOW_ISO,
          location: "",
          likes: 1,
          isAuthor: false,
          isTop: false,
          isFeatured: false,
          childCount: 3,
          isChildrenComplete: false,
          children: [{ id: "ch3", parentId: "r-p11", author: "C", content: "third", likes: 3 }]
        }]
      }, { DB: d1, BUCKET: bucket })
    );

    const merged = JSON.parse(r2Store.get(threadKey));
    assert.deepEqual(
      merged.children.map(c => c.id),
      ["ch1", "ch2", "ch3"],
      "写路径必须绕过旧缓存直读 R2，保留另一 isolate 刚写入的 ch2"
    );

    // 3) 空线程校验同样绕过旧缓存：边缘缓存残留非空旧数据时，只要 R2 已是 complete-empty 就不重复 PUT
    const emptyKey = "childcomments/r-p11-empty.json";
    const emptyUrl = `https://r2-edge-cache.internal/v2/${encodeURIComponent(emptyKey)}`;
    r2Store.set(emptyKey, JSON.stringify({ children: [], complete: true }));
    edgeStore.set(emptyUrl, {
      body: JSON.stringify({ children: [{ id: "stale", content: "old" }], complete: false }),
      cacheControl: "public, max-age=30"
    });
    const emptyRes = await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        allRootIds: ["r-p11-empty"],
        roots: [{
          id: "r-p11-empty",
          author: "Root2",
          authorAvatar: "",
          content: "root2",
          img: "",
          time: NOW_ISO,
          location: "",
          likes: 1,
          isAuthor: false,
          isTop: false,
          isFeatured: false,
          childCount: 0,
          isChildrenComplete: true,
          children: []
        }]
      }, { DB: d1, BUCKET: bucket })
    );
    assert.equal(emptyRes.r2Puts, 0, "空线程校验直读 R2 确认已是 complete-empty 时不应重复 PUT");
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("[P1-4] 评论全量清零：60 根主库单次批量 delete 且跳过高频 edge purge；外部 cloudflare_d1 单条 content_pk 删除", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  workerModules.auth.invalidateExternalTargetsCache();
  workerModules.auth.resetRemoteSchemaCache();

  // 1) 主库 60 个楼中楼清零
  const r2Store = new Map();
  const deleteCalls = [];
  let r2Gets = 0;
  const bucket = {
    async get(key) {
      r2Gets++;
      const val = r2Store.get(key);
      return val === undefined ? null : { async text() { return val; } };
    },
    async put(key, val) { r2Store.set(key, String(val)); },
    async delete(keyOrKeys) {
      deleteCalls.push(keyOrKeys);
      if (Array.isArray(keyOrKeys)) {
        for (const k of keyOrKeys) r2Store.delete(k);
      } else {
        r2Store.delete(keyOrKeys);
      }
    }
  };

  const edgeStore = new Map();
  let edgeDeleteCalls = 0;
  const cacheApi = {
    async match(url) {
      const hit = edgeStore.get(String(url));
      return hit === undefined ? undefined : new Response(hit);
    },
    async put(url, response) { edgeStore.set(String(url), await response.text()); },
    async delete(url) { edgeDeleteCalls++; edgeStore.delete(String(url)); }
  };
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: cacheApi };

  try {
    const roots60 = [];
    for (let i = 1; i <= 60; i++) {
      const rootId = `r60-${i}`;
      roots60.push({
        id: rootId,
        author: `U${i}`,
        authorAvatar: "",
        content: `body-${i}`,
        img: "",
        time: NOW_ISO,
        location: "",
        likes: i,
        isAuthor: false,
        isTop: false,
        isFeatured: false,
        childCount: 1,
        isChildrenComplete: true,
        children: [{ id: `${rootId}-c1`, parentId: rootId, author: "C", content: "reply", likes: 0 }]
      });
    }
    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        allRootIds: roots60.map(r => r.id),
        roots: roots60
      }, { DB: d1, BUCKET: bucket })
    );
    assert.equal(r2Store.size, 60);

    // 预热第 1 条的进程内与边缘缓存，验证清零后至少进程内缓存被驱逐
    await runWithDb(d1, () => commentsModule.getChildComments(bucket, "r60-1", d1));
    assert.equal(edgeStore.size, 1);

    edgeDeleteCalls = 0;
    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        allRootIds: [],
        roots: []
      }, { DB: d1, BUCKET: bucket })
    );

    assert.equal(deleteCalls.length, 0, "防删归档全量清零不得调用 bucket.delete");
    assert.equal(r2Store.size, 60, "60 个 R2 对象必须全部保留");
    assert.equal(edgeDeleteCalls, 0, "未删改 R2 时不应无效调用 caches.default.delete");
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM comment_threads WHERE content_pk = ?`).get(CONTENT_PK).n, 60);
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM comments WHERE content_pk = ? AND parent_comment_id IS NULL AND is_deleted = 0`).get(CONTENT_PK).n, 0);
    assert.equal(sqlite.prepare(`SELECT comment_count FROM contents WHERE pk = ?`).get(CONTENT_PK).comment_count, 0);

    // 关闭 caches.default 后仍可读取已归档楼中楼
    delete globalThis.caches;
    const afterClear = await runWithDb(d1, () => commentsModule.getChildComments(bucket, "r60-1", d1));
    assert.ok(afterClear.length > 0, "全量清零后仍应可读取已归档子评论");

    // 2) 外部 cloudflare_d1 扩容路径：60 个线程全量清零只发单条 DELETE FROM child_comment_blobs WHERE content_pk = ?
    const remoteSqlite = new Database(":memory:");
    const d1Config = {
      id: "ext-cf-d1-clear",
      name: "CF D1 扩容",
      provider: "cloudflare_d1",
      enabled: true,
      syncScopes: ["comments"],
      storageRole: "offload",
      overflowThresholdRows: 1500000,
      endpointUrl: "https://api.cloudflare.com",
      databaseId: "acc123/db456",
      authToken: "cf-tok",
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO
    };
    const extBucketStore = new Map([[workerModules.auth.R2_EXTERNAL_TARGETS_KEY, JSON.stringify([d1Config])]]);
    const extBucket = {
      async get(key) {
        const val = extBucketStore.get(key);
        return val === undefined ? null : { async text() { return val; } };
      },
      async put(key, val) { extBucketStore.set(key, String(val)); },
      async delete(key) { extBucketStore.delete(key); }
    };

    const executedRemoteSqls = [];
    globalThis.fetch = async (url, init = {}) => {
      assert.equal(
        String(url),
        "https://api.cloudflare.com/client/v4/accounts/acc123/d1/database/db456/query"
      );
      const body = JSON.parse(String(init.body));
      const sql = body.sql;
      const params = body.params || [];
      executedRemoteSqls.push(sql.replace(/\s+/g, " ").trim());
      const stmt = remoteSqlite.prepare(sql);
      if (stmt.reader) {
        const rows = stmt.all(...params);
        return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: rows, meta: { changes: 0 } }] }), text: async () => "" };
      }
      const info = stmt.run(...params);
      return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: [], meta: { changes: info.changes } }] }), text: async () => "" };
    };

    workerModules.auth.invalidateExternalTargetsCache();
    workerModules.auth.resetRemoteSchemaCache();
    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        allRootIds: roots60.map(r => r.id),
        roots: roots60
      }, { DB: d1, BUCKET: extBucket })
    );
    assert.equal(remoteSqlite.prepare(`SELECT COUNT(*) AS n FROM child_comment_blobs WHERE content_pk = ?`).get(CONTENT_PK).n, 60);

    executedRemoteSqls.length = 0;
    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        allRootIds: [],
        roots: []
      }, { DB: d1, BUCKET: extBucket })
    );

    const blobDeletes = executedRemoteSqls.filter(s => /DELETE FROM child_comment_blobs/i.test(s));
    assert.equal(blobDeletes.length, 0, "防删归档模式下 cloudflare_d1 全量清零不得删除 child_comment_blobs");
    assert.equal(remoteSqlite.prepare(`SELECT COUNT(*) AS n FROM child_comment_blobs WHERE content_pk = ?`).get(CONTENT_PK).n, 60);
    assert.equal(remoteSqlite.prepare(`SELECT COUNT(*) AS n FROM comment_threads WHERE content_pk = ?`).get(CONTENT_PK).n, 60);
    assert.equal(sqlite.prepare(`SELECT comment_count FROM contents WHERE pk = ?`).get(CONTENT_PK).comment_count, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
    workerModules.auth.invalidateExternalTargetsCache();
    workerModules.auth.resetRemoteSchemaCache();
  }
});

test("[P1-5] localizeImage 全局并发槽位 <= 4 且异常归还；processImageBatch 默认批量落库子请求 < 50", async () => {
  const imagesModule = await loadTs(
    path.join(workerSrc, "services", "images.ts"),
    new Map([["hono", honoMockUrl]])
  );
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);

  assert.ok(
    imageTasksModule.IMAGE_TASK_BATCH_DEFAULT_LIMIT >= 6 &&
      imageTasksModule.IMAGE_TASK_BATCH_DEFAULT_LIMIT <= 8,
    `IMAGE_TASK_BATCH_DEFAULT_LIMIT 应在 6..8 之间，实际=${imageTasksModule.IMAGE_TASK_BATCH_DEFAULT_LIMIT}`
  );
  assert.equal(imageTasksModule.IMAGE_TASK_BATCH_MAX_LIMIT, 100);

  const originalFetch = globalThis.fetch;
  try {
    // 1) 10 路并发调用 localizeImage：峰值并发 <= IMAGE_FETCH_CONCURRENCY (4)，且抛错不泄漏槽位
    let inFlight = 0;
    let maxInFlight = 0;
    const r2 = new Map();
    const slotBucket = {
      async head() { return null; },
      async get() { return null; },
      async put(k, body) { r2.set(k, body); },
      async delete() {}
    };

    globalThis.fetch = async (url) => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      try {
        await new Promise(resolve => setTimeout(resolve, 15));
        if (String(url).includes("fail-slot")) {
          throw new Error("boom");
        }
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/jpeg", "content-length": "3" }
        });
      } finally {
        inFlight--;
      }
    };

    const urls = Array.from({ length: 10 }, (_, idx) =>
      idx < 2 ? `https://picx.zhimg.com/fail-slot-${idx}.jpg` : `https://picx.zhimg.com/ok-slot-${idx}.jpg`
    );
    const results = await Promise.all(
      urls.map(url => imagesModule.localizeImage(url, slotBucket, "original"))
    );
    assert.ok(
      maxInFlight <= imagesModule.IMAGE_FETCH_CONCURRENCY,
      `并发峰值(${maxInFlight})不得超过 IMAGE_FETCH_CONCURRENCY(${imagesModule.IMAGE_FETCH_CONCURRENCY})`
    );
    assert.ok(maxInFlight >= 2, "应允许受限并发下载");
    assert.equal(results.slice(0, 2).every(v => v === null), true);
    assert.equal(results.slice(2).every(v => typeof v === "string" && v.startsWith("/api/images/")), true);

    // 2) processImageBatch 默认批大小：10 条待处理任务下只领取默认批大小、总操作 < 50、单次 db.batch 落库
    for (let i = 0; i < 10; i++) {
      seedImageTask(sqlite, {
        imageUrl: `https://picx.zhimg.com/batch-item-${i}.jpg`,
        objectKey: `images/${String(i).padStart(64, "a")}.jpg`,
        status: "pending",
        attempts: 0,
        updatedAt: NOW_ISO
      });
    }

    let selectOps = 0;
    let nonBatchRunOps = 0;
    let batchOps = 0;
    let bucketOps = 0;
    let fetchOps = 0;

    const countedD1 = {
      prepare(sql) {
        const stmt = d1.prepare(sql);
        return {
          bind(...params) {
            const bound = stmt.bind(...params);
            return {
              first: () => { selectOps++; return bound.first(); },
              all: () => { selectOps++; return bound.all(); },
              run: () => { nonBatchRunOps++; return bound.run(); },
              execute: () => bound.execute(),
              sql: bound.sql,
              params: bound.params
            };
          },
          first: () => { selectOps++; return stmt.first(); },
          all: () => { selectOps++; return stmt.all(); },
          run: () => { nonBatchRunOps++; return stmt.run(); },
          execute: () => stmt.execute(),
          sql: stmt.sql,
          params: stmt.params
        };
      },
      batch(stmts) {
        batchOps++;
        return d1.batch(stmts);
      }
    };

    const countedBucket = {
      async head() { bucketOps++; return null; },
      async get() { bucketOps++; return null; },
      async put() { bucketOps++; },
      async delete() { bucketOps++; }
    };

    globalThis.fetch = async () => {
      fetchOps++;
      return new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: { "content-type": "image/jpeg", "content-length": "3" }
      });
    };

    const batchRes = await runWithDb(countedD1, () =>
      imageTasksModule.processImageBatch(countedBucket)
    );
    const totalOps = selectOps + nonBatchRunOps + batchOps + bucketOps + fetchOps;
    assert.equal(batchRes.claimed, imageTasksModule.IMAGE_TASK_BATCH_DEFAULT_LIMIT);
    assert.equal(batchRes.done, imageTasksModule.IMAGE_TASK_BATCH_DEFAULT_LIMIT);
    assert.equal(
      batchOps,
      1 + Math.ceil(imageTasksModule.IMAGE_TASK_BATCH_DEFAULT_LIMIT / 4),
      "领取走 1 次 db.batch，随后按并发分组（<=4）每组完成后立刻各提交 1 次 db.batch"
    );
    assert.equal(nonBatchRunOps, 0, "状态更新不得逐条调用 db.prepare().run()");
    assert.ok(totalOps < 50, `默认批总子请求/操作次数必须 < 50，实际=${totalOps}`);
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM image_tasks WHERE status = 'done'`).get().n, imageTasksModule.IMAGE_TASK_BATCH_DEFAULT_LIMIT);
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM image_tasks WHERE status = 'pending'`).get().n, 10 - imageTasksModule.IMAGE_TASK_BATCH_DEFAULT_LIMIT);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("[P1-9] 作者头像图床子域轮换与 query 变更不触发 D1 UPDATE；空值补齐或换图触发更新", async () => {
  const { sqlite, d1 } = createMemoryDb();
  workerModules.auth.invalidateExternalTargetsCache();
  workerModules.auth.resetRemoteSchemaCache();

  // 0) 共享归一化函数纯逻辑验证
  assert.equal(
    hashModule.isAvatarUrlChanged(
      "https://pic1.zhimg.com/v2-abc_l.jpg?source=1940ef5c",
      "https://picx.zhimg.com/v2-abc_l.jpg?source=other"
    ),
    false
  );
  assert.equal(
    hashModule.isAvatarUrlChanged(null, "https://pic1.zhimg.com/v2-abc_l.jpg"),
    true
  );
  assert.equal(
    hashModule.isAvatarUrlChanged(
      "https://pic1.zhimg.com/v2-abc_l.jpg",
      "https://pica.zhimg.com/v2-def_l.jpg"
    ),
    true
  );

  // 1) contents.ts (upsertContent)
  const pk = "answer:p19";
  await runWithDb(d1, () =>
    contentsModule.upsertContent({
      sourceType: "answer",
      sourceId: "p19",
      title: "P1-9 Title",
      sourceUrl: "https://www.zhihu.com/question/1/answer/p19",
      author: { name: "Bob", urlToken: "bob", avatarUrl: "https://pic1.zhimg.com/v2-c1_l.jpg?source=a" },
      contentHtml: "<p>same body</p>",
      contentMd: "",
      excerpt: "same body",
      voteupCount: 1,
      commentCount: 0,
      createdTime: NOW_ISO,
      updatedTime: NOW_ISO
    })
  );
  d1.writes.length = 0;
  await runWithDb(d1, () =>
    contentsModule.upsertContent({
      sourceType: "answer",
      sourceId: "p19",
      title: "P1-9 Title",
      sourceUrl: "https://www.zhihu.com/question/1/answer/p19",
      author: { name: "Bob", urlToken: "bob", avatarUrl: "https://picx.zhimg.com/v2-c1_l.jpg?source=b" },
      contentHtml: "<p>same body</p>",
      contentMd: "",
      excerpt: "same body",
      voteupCount: 1,
      commentCount: 0,
      createdTime: NOW_ISO,
      updatedTime: NOW_ISO
    })
  );
  assert.equal(d1.writes.length, 0, "upsertContent 头像仅子域/query 轮换不得写入 D1");

  await runWithDb(d1, () =>
    contentsModule.upsertContent({
      sourceType: "answer",
      sourceId: "p19",
      title: "P1-9 Title",
      sourceUrl: "https://www.zhihu.com/question/1/answer/p19",
      author: { name: "Bob", urlToken: "bob", avatarUrl: "https://pica.zhimg.com/v2-c2_l.jpg?source=b" },
      contentHtml: "<p>same body</p>",
      contentMd: "",
      excerpt: "same body",
      voteupCount: 1,
      commentCount: 0,
      createdTime: NOW_ISO,
      updatedTime: NOW_ISO
    })
  );
  assert.equal(d1.writes.length, 1, "upsertContent 头像路径实质变化应触发轻量 UPDATE");
  assert.equal(sqlite.prepare(`SELECT author_avatar FROM contents WHERE pk = ?`).get(pk).author_avatar, "https://pica.zhimg.com/v2-c2_l.jpg?source=b");

  // 2) comments.ts (replaceComments)
  await runWithDb(d1, () =>
    commentsModule.replaceComments({
      contentPk: pk,
      partial: false,
      comments: [makeComment({ id: "c-p19", authorAvatar: "https://pic1.zhimg.com/v2-cm1.jpg?t=1" })]
    })
  );
  d1.writes.length = 0;
  await runWithDb(d1, () =>
    commentsModule.replaceComments({
      contentPk: pk,
      partial: false,
      comments: [makeComment({ id: "c-p19", authorAvatar: "https://picx.zhimg.com/v2-cm1.jpg?t=2" })]
    })
  );
  assert.equal(d1.writes.length, 0, "replaceComments 头像仅子域/query 轮换不得 UPDATE");
  await runWithDb(d1, () =>
    commentsModule.replaceComments({
      contentPk: pk,
      partial: false,
      comments: [makeComment({ id: "c-p19", authorAvatar: "https://pic2.zhimg.com/v2-cm2.jpg?t=2" })]
    })
  );
  assert.equal(d1.writes.length, 1, "replaceComments 头像路径变化应触发 UPDATE");

  // 3) comments.ts (replaceCommentsByRoot main)
  const r2Bucket = makeTrackedBucket().bucket;
  const makeRootP19 = (id, avatar) => ({
    id,
    author: "Root",
    authorAvatar: avatar,
    content: "root body",
    img: "",
    time: NOW_ISO,
    location: "上海",
    likes: 5,
    isAuthor: false,
    isTop: false,
    isFeatured: false,
    childCount: 0,
    isChildrenComplete: true,
    children: []
  });
  await runWithDb(d1, () =>
    commentsModule.replaceCommentsByRoot({
      contentPk: pk,
      partial: false,
      allRootIds: ["r-p19"],
      roots: [makeRootP19("r-p19", "https://pic1.zhimg.com/v2-rt1.jpg?x=1")]
    }, { DB: d1, BUCKET: r2Bucket })
  );
  d1.writes.length = 0;
  await runWithDb(d1, () =>
    commentsModule.replaceCommentsByRoot({
      contentPk: pk,
      partial: false,
      allRootIds: ["r-p19"],
      roots: [makeRootP19("r-p19", "https://pica.zhimg.com/v2-rt1.jpg?x=2")]
    }, { DB: d1, BUCKET: r2Bucket })
  );
  assert.equal(d1.writes.length, 0, "replaceCommentsByRoot 主库头像子域/query 轮换不得 UPDATE");

  // 4) comments.ts (replaceCommentsByRoot offload)
  const remoteSqlite = new Database(":memory:");
  const offloadTarget = {
    id: "ext-p19",
    name: "Turso P19",
    provider: "turso",
    enabled: true,
    syncScopes: ["comments"],
    storageRole: "offload",
    overflowThresholdRows: 1500000,
    endpointUrl: "https://ext-p19.example.com",
    authToken: "tok",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO
  };
  const offloadBucket = {
    async get(key) {
      if (key === workerModules.auth.R2_EXTERNAL_TARGETS_KEY) {
        return { async text() { return JSON.stringify([offloadTarget]); } };
      }
      return null;
    },
    async put() {},
    async delete() {}
  };
  let remoteWriteSqls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body));
    const results = [];
    for (const req of body.requests) {
      if (req.type === "close") {
        results.push({ type: "ok", response: { type: "close" } });
        continue;
      }
      const sql = req.stmt.sql;
      const args = (req.stmt.args || []).map(a => (!a || a.type === "null") ? null : (a.type === "integer" || a.type === "float") ? Number(a.value) : String(a.value));
      const st = remoteSqlite.prepare(sql);
      if (st.reader) {
        const cols = st.columns().map(c => ({ name: c.name }));
        const rows = st.all(...args).map(r => cols.map(c => tursoCell(r[c.name])));
        results.push({ type: "ok", response: { type: "execute", result: { cols, rows, affected_row_count: 0, last_insert_rowid: null } } });
      } else {
        if (!/^\s*CREATE\b/i.test(sql)) remoteWriteSqls.push(sql.replace(/\s+/g, " ").trim());
        const info = st.run(...args);
        results.push({ type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: info.changes, last_insert_rowid: null } } });
      }
    }
    return { ok: true, status: 200, json: async () => ({ results }), text: async () => "" };
  };

  try {
    workerModules.auth.invalidateExternalTargetsCache();
    workerModules.auth.resetRemoteSchemaCache();
    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: pk,
        partial: false,
        allRootIds: ["r-off-p19"],
        roots: [makeRootP19("r-off-p19", "https://pic1.zhimg.com/v2-off1.jpg?s=1")]
      }, { DB: d1, BUCKET: offloadBucket })
    );
    remoteWriteSqls = [];
    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: pk,
        partial: false,
        allRootIds: ["r-off-p19"],
        roots: [makeRootP19("r-off-p19", "https://picx.zhimg.com/v2-off1.jpg?s=2")]
      }, { DB: d1, BUCKET: offloadBucket })
    );
    assert.equal(remoteWriteSqls.length, 0, "replaceCommentsByRootOffloaded 头像子域/query 轮换不得写入外部库");

    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: pk,
        partial: false,
        allRootIds: ["r-off-p19"],
        roots: [makeRootP19("r-off-p19", "https://pic2.zhimg.com/v2-off2.jpg?s=2")]
      }, { DB: d1, BUCKET: offloadBucket })
    );
    assert.equal(remoteWriteSqls.length, 1, "replaceCommentsByRootOffloaded 头像实质变化应触发 1 次外部 UPDATE");
  } finally {
    globalThis.fetch = originalFetch;
    workerModules.auth.invalidateExternalTargetsCache();
    workerModules.auth.resetRemoteSchemaCache();
  }
});

test("[P2-1] POST /ai-assess 拆分 403 Forbidden origin 与 401 needToken:true", async () => {
  const { d1 } = createMemoryDb();
  const recommend = await loadTs(
    path.join(workerSrc, "routes", "recommend.ts"),
    new Map([["hono", honoMockUrl]])
  );
  const env = {
    API_SECRET: "assess-secret",
    ALLOWED_ORIGIN: "https://zhihu-backup.pages.dev"
  };

  // 1) 非法 Origin 即使带正确 Bearer 也返回 403 Forbidden origin
  const badOrigin = await runWithDb(d1, () =>
    recommend.recommendRoutes.__call("POST", "/ai-assess", {
      headers: { origin: "https://evil.example.com", authorization: "Bearer assess-secret" },
      body: { pk: "answer:1" }
    }, env)
  );
  assert.equal(badOrigin.status, 403);
  assert.deepEqual(badOrigin.body, { error: "Forbidden origin" });

  // 2) 合法 Origin 缺 Bearer -> 401 { error: "Unauthorized", needToken: true }
  const missingToken = await runWithDb(d1, () =>
    recommend.recommendRoutes.__call("POST", "/ai-assess", {
      headers: { origin: "https://zhihu-backup.pages.dev" },
      body: { pk: "answer:1" }
    }, env)
  );
  assert.equal(missingToken.status, 401);
  assert.deepEqual(missingToken.body, { error: "Unauthorized", needToken: true });

  // 3) 合法 Origin 错 Bearer -> 401 { error: "Unauthorized", needToken: true }
  const wrongToken = await runWithDb(d1, () =>
    recommend.recommendRoutes.__call("POST", "/ai-assess", {
      headers: { origin: "https://zhihu-backup.pages.dev", authorization: "Bearer wrong" },
      body: { pk: "answer:1" }
    }, env)
  );
  assert.equal(wrongToken.status, 401);
  assert.deepEqual(wrongToken.body, { error: "Unauthorized", needToken: true });

  // 4) 无 Origin 缺 Bearer -> 401 { error: "Unauthorized", needToken: true }
  const noOrigin = await runWithDb(d1, () =>
    recommend.recommendRoutes.__call("POST", "/ai-assess", {
      body: { pk: "answer:1" }
    }, env)
  );
  assert.equal(noOrigin.status, 401);
  assert.deepEqual(noOrigin.body, { error: "Unauthorized", needToken: true });

  // 5) 合法 Origin + 合法 Bearer 通过鉴权进入业务校验 (400 pk is required)
  const passedAuth = await runWithDb(d1, () =>
    recommend.recommendRoutes.__call("POST", "/ai-assess", {
      headers: { origin: "https://zhihu-backup.pages.dev", authorization: "Bearer assess-secret" },
      body: { pk: "" }
    }, env)
  );
  assert.equal(passedAuth.status, 400);
  assert.deepEqual(passedAuth.body, { error: "pk is required" });

  // 6) 无任何口令的空环境：无 Origin 仍返回 401 needToken:true，非法 Origin 返回 403
  const emptyEnv = { ALLOWED_ORIGIN: "https://zhihu-backup.pages.dev" };
  const emptyNoOrigin = await runWithDb(d1, () =>
    recommend.recommendRoutes.__call("POST", "/ai-assess", { body: { pk: "answer:1" } }, emptyEnv)
  );
  assert.equal(emptyNoOrigin.status, 401);
  assert.deepEqual(emptyNoOrigin.body, { error: "Unauthorized", needToken: true });
});

test("[P2-2] 外部存储 SSRF 防护：拦截 ::ffff: IPv4-mapped IPv6 与所有外部 fetch 强制 redirect: manual", async () => {
  const auth = workerModules.auth;
  const sharedIndexUrl = await moduleUrlFor(sharedIndexPath);
  const ingest = await loadTs(
    path.join(workerSrc, "routes", "ingest.ts"),
    new Map([["hono", honoMockUrl], ["shared", sharedIndexUrl]])
  );
  const { d1 } = createMemoryDb();
  auth.invalidateExternalTargetsCache();

  // 1) isPrivateOrLoopbackHost 拦截 ::ffff: IPv4-mapped IPv6，不误伤正常域名
  assert.equal(auth.isPrivateOrLoopbackHost("::ffff:127.0.0.1"), true);
  assert.equal(auth.isPrivateOrLoopbackHost("[::ffff:7f00:1]"), true);
  assert.equal(auth.isPrivateOrLoopbackHost("::ffff:10.0.0.1"), true);
  assert.equal(auth.isPrivateOrLoopbackHost("::ffff:a9fe:a9fe"), true);
  assert.equal(auth.isPrivateOrLoopbackHost("demo.turso.io"), false);
  assert.equal(auth.isPrivateOrLoopbackHost("fc-demo.turso.io"), false);

  const r2Store = new Map();
  const bucket = {
    async get(key) {
      const val = r2Store.get(key);
      return val === undefined ? null : { async text() { return val; } };
    },
    async put(key, val) { r2Store.set(key, String(val)); }
  };
  const env = { API_SECRET: "ssrf-secret", BUCKET: bucket };
  const headers = { authorization: "Bearer ssrf-secret" };

  // 2) 非本地请求保存/测试 ::ffff:127.0.0.1 与 ::ffff:169.254.169.254 必须 400
  for (const badUrl of ["http://[::ffff:127.0.0.1]/hook", "http://[::ffff:169.254.169.254]/latest"]) {
    const saveBad = await runWithDb(d1, () =>
      auth.authRoutes.__call("POST", "/external-targets", {
        url: "https://zhihu-backup.pages.dev/api/auth/external-targets",
        headers,
        body: { name: "bad", provider: "webhook", endpointUrl: badUrl, syncScopes: ["contents"] }
      }, env)
    );
    assert.equal(saveBad.status, 400, `保存 ${badUrl} 必须被拒`);

    const testBad = await runWithDb(d1, () =>
      auth.authRoutes.__call("POST", "/external-targets/test", {
        url: "https://zhihu-backup.pages.dev/api/auth/external-targets/test",
        headers,
        body: { provider: "webhook", endpointUrl: badUrl }
      }, env)
    );
    assert.equal(testBad.status, 400, `探测 ${badUrl} 必须被拒`);
  }

  // 3) POST /external-targets/test 与 forwardToExternalTargets 必须传 redirect: "manual" 且 302 不跟随
  const recordedFetches = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    recordedFetches.push({ url: String(url), redirect: init.redirect });
    return {
      ok: false,
      status: 302,
      headers: new Headers({ location: "http://127.0.0.1:8080/internal" }),
      json: async () => ({}),
      text: async () => ""
    };
  };

  try {
    const testRedirect = await runWithDb(d1, () =>
      auth.authRoutes.__call("POST", "/external-targets/test", {
        url: "https://zhihu-backup.pages.dev/api/auth/external-targets/test",
        headers,
        body: { provider: "webhook", endpointUrl: "https://public.example.com/hook" }
      }, env)
    );
    assert.equal(testRedirect.status, 200);
    assert.equal(testRedirect.body.ok, false, "302 重定向不得被跟随判为连通成功");
    assert.ok(recordedFetches.length >= 1);
    assert.equal(recordedFetches.every(f => f.redirect === "manual"), true);

    recordedFetches.length = 0;
    auth.invalidateExternalTargetsCache();
    r2Store.set(auth.R2_EXTERNAL_TARGETS_KEY, JSON.stringify([{
      id: "ext-mirror-webhook",
      name: "Mirror Webhook",
      provider: "webhook",
      enabled: true,
      syncScopes: ["contents"],
      storageRole: "mirror",
      overflowThresholdRows: 1500000,
      endpointUrl: "https://public.example.com",
      authToken: "tok",
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO
    }]));

    await runWithDb(d1, () =>
      ingest.forwardToExternalTargets({ env: { BUCKET: bucket } }, "contents", "/ingest/content", { ok: true }, "answer:1")
    );
    assert.equal(recordedFetches.length, 1);
    assert.equal(recordedFetches[0].redirect, "manual", "forwardToExternalTargets 必须带 redirect: manual");
  } finally {
    globalThis.fetch = originalFetch;
    auth.invalidateExternalTargetsCache();
  }
});

test("[P2-5] 外部存储降级写 R2 按 updatedAt 择新不回滚；offload 单根清空不因无旧计数跳过", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  const auth = workerModules.auth;
  auth.invalidateExternalTargetsCache();
  auth.resetRemoteSchemaCache();

  // 1) D1 满额写失败降级只写入 R2 后，缓存失效再读取不得回滚到旧 D1 值
  sqlite.prepare(
    `INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)`
  ).run(
    auth.EXTERNAL_TARGETS_KEY,
    JSON.stringify([{
      id: "old-id",
      name: "Old Target",
      provider: "webhook",
      enabled: true,
      syncScopes: ["contents"],
      storageRole: "mirror",
      overflowThresholdRows: 1500000,
      endpointUrl: "https://old.example.com",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z"
    }]),
    "2024-01-01T00:00:00.000Z"
  );

  const r2Objects = new Map();
  const metaBucket = {
    async get(key) {
      const entry = r2Objects.get(key);
      if (!entry) return null;
      return {
        customMetadata: entry.customMetadata,
        async text() { return entry.body; }
      };
    },
    async put(key, val, opts = {}) {
      r2Objects.set(key, {
        body: String(val),
        customMetadata: opts.customMetadata || {}
      });
    }
  };

  const quotaFullD1 = {
    prepare(sql) {
      const bound = d1.prepare(sql);
      if (/INSERT INTO app_settings/i.test(sql)) {
        return {
          bind: () => ({
            run: async () => { throw new Error("D1 quota exceeded"); }
          })
        };
      }
      return bound;
    },
    batch: stmts => d1.batch(stmts)
  };

  await runWithDb(quotaFullD1, () =>
    auth.saveExternalTargetsRaw(metaBucket, [{
      id: "new-id",
      name: "New Target",
      provider: "turso",
      enabled: true,
      syncScopes: ["comments"],
      storageRole: "offload",
      overflowThresholdRows: 1500000,
      endpointUrl: "https://new.example.com",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }])
  );
  auth.invalidateExternalTargetsCache();
  const afterR2OnlySave = await runWithDb(quotaFullD1, () => auth.getExternalTargetsRaw(metaBucket));
  assert.equal(afterR2OnlySave.length, 1);
  assert.equal(afterR2OnlySave[0].id, "new-id", "缓存失效后必须择新返回 R2 里的 new-id，不能回滚到旧 D1");

  // 清空配置但 D1 仍写失败：依赖 R2 customMetadata.updatedAt 仍应赢过 2024 年的 D1 旧行
  await runWithDb(quotaFullD1, () => auth.saveExternalTargetsRaw(metaBucket, []));
  auth.invalidateExternalTargetsCache();
  const afterR2OnlyClear = await runWithDb(quotaFullD1, () => auth.getExternalTargetsRaw(metaBucket));
  assert.deepEqual(afterR2OnlyClear, [], "R2 清空时间更新时不得回滚复活 D1 旧配置");

  // 2) replaceCommentsByRootOffloaded：无既有外部线程与计数时提交完整空楼中楼也必须落空快照，且二次命中快路径
  sqlite.prepare(`DELETE FROM app_settings WHERE key = ?`).run(auth.EXTERNAL_TARGETS_KEY);
  auth.invalidateExternalTargetsCache();
  auth.resetRemoteSchemaCache();
  const remoteSqlite = new Database(":memory:");
  const offloadTarget = {
    id: "ext-p25",
    name: "Turso P25",
    provider: "turso",
    enabled: true,
    syncScopes: ["comments"],
    storageRole: "offload",
    overflowThresholdRows: 1500000,
    endpointUrl: "https://ext-p25.example.com",
    authToken: "tok",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO
  };
  const r2Store = new Map([
    [auth.R2_EXTERNAL_TARGETS_KEY, JSON.stringify([offloadTarget])],
    ["childcomments/r-p25.json", JSON.stringify({ children: [{ id: "stale_main_r2", content: "old" }], complete: true })]
  ]);
  const offloadBucket = {
    async get(key) {
      const val = r2Store.get(key);
      return val === undefined ? null : { async text() { return val; } };
    },
    async put(key, val) { r2Store.set(key, String(val)); },
    async delete(key) { r2Store.delete(key); }
  };

  let remoteBlobOrThreadWrites = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body));
    const results = [];
    for (const req of body.requests) {
      if (req.type === "close") {
        results.push({ type: "ok", response: { type: "close" } });
        continue;
      }
      const sql = req.stmt.sql;
      const args = (req.stmt.args || []).map(a => (!a || a.type === "null") ? null : (a.type === "integer" || a.type === "float") ? Number(a.value) : String(a.value));
      const st = remoteSqlite.prepare(sql);
      if (st.reader) {
        const cols = st.columns().map(c => ({ name: c.name }));
        const rows = st.all(...args).map(r => cols.map(c => tursoCell(r[c.name])));
        results.push({ type: "ok", response: { type: "execute", result: { cols, rows, affected_row_count: 0, last_insert_rowid: null } } });
      } else {
        if (/(child_comment_blobs|comment_threads)/i.test(sql) && !/^\s*CREATE\b/i.test(sql)) {
          remoteBlobOrThreadWrites++;
        }
        const info = st.run(...args);
        results.push({ type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: info.changes, last_insert_rowid: null } } });
      }
    }
    return { ok: true, status: 200, json: async () => ({ results }), text: async () => "" };
  };

  try {
    // 迁移前主 D1 / 主 R2 已有 r-p25 的旧线程索引，切 offload 后空快照必须落墓碑防止回退复活
    sqlite.prepare(`
      INSERT INTO comment_threads (root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at)
      VALUES ('r-p25', ?, 'childcomments/r-p25.json', 1, 1, 'old-h', 'old-in', '[]', ?)
    `).run(CONTENT_PK, NOW_ISO);

    const emptyRootPayload = {
      contentPk: CONTENT_PK,
      partial: false,
      allRootIds: ["r-p25"],
      roots: [{
        id: "r-p25",
        author: "Root",
        authorAvatar: "",
        content: "root",
        img: "",
        time: NOW_ISO,
        location: "",
        likes: 1,
        isAuthor: false,
        isTop: false,
        isFeatured: false,
        childCount: 0,
        isChildrenComplete: true,
        children: []
      }]
    };

    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot(emptyRootPayload, { DB: d1, BUCKET: offloadBucket })
    );
    const blob = remoteSqlite.prepare(`SELECT payload_json, complete FROM child_comment_blobs WHERE root_id = 'r-p25'`).get();
    assert.ok(blob, "迁移期存在主 R2 旧对象时，切 offload 后必须抢救归档到外部库并落 complete=1");
    assert.equal(blob.complete, 1);
    const parsedBlob = JSON.parse(blob.payload_json);
    assert.deepEqual(parsedBlob.children.map(c => c.id), ["stale_main_r2"]);
    assert.equal(parsedBlob.children[0].isDeleted, true);

    const children = await runWithDb(d1, () => commentsModule.getChildComments(offloadBucket, "r-p25", d1));
    assert.deepEqual(children.map(c => c.id), ["stale_main_r2"], "主 R2 旧子评论必须被抢救归档并标记已删除");
    assert.equal(children[0].isDeleted, true);

    // 第二次同输入必须命中快路径，0 次 blob/thread 写入
    remoteBlobOrThreadWrites = 0;
    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot(emptyRootPayload, { DB: d1, BUCKET: offloadBucket })
    );
    assert.equal(remoteBlobOrThreadWrites, 0, "外部库完整归档第二遍同输入应命中快路径");
  } finally {
    globalThis.fetch = originalFetch;
    auth.invalidateExternalTargetsCache();
    auth.resetRemoteSchemaCache();
  }
});

test("[P2-7] runAndRecord 写入 sync_runs 异常时必须立即释放 sync_lock", async () => {
  const { sqlite, d1 } = createMemoryDb();
  const sync = await loadTs(
    path.join(workerSrc, "routes", "sync.ts"),
    new Map([["hono", honoMockUrl]])
  );

  const throwingD1 = {
    prepare(sql) {
      if (/INSERT INTO sync_runs/i.test(sql)) {
        return {
          bind: () => ({
            run: async () => { throw new Error("D1 sync_runs write failed"); }
          })
        };
      }
      return d1.prepare(sql);
    },
    batch: stmts => d1.batch(stmts)
  };

  let apifyCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    apifyCalls++;
    return new Response("{}", { status: 200 });
  };

  try {
    const env = {
      DB: throwingD1,
      API_SECRET: "s",
      APIFY_TOKEN: "t",
      APIFY_ACTOR_ID: "a",
      WORKER_URL: "https://w.example.com",
      ZHIHU_USERNAME: "u",
      ZHIHU_COOKIE_STRING: "z_c0=abc"
    };
    const res = await runWithDb(throwingD1, () =>
      sync.runAndRecord(env, "manual", "all", false)
    );
    assert.equal(res.ok, false);
    assert.match(res.error || "", /sync_runs/);
    assert.equal(apifyCalls, 0, "sync_runs 写入失败不应继续触发 Apify");
    assert.equal(
      sqlite.prepare(`SELECT value FROM app_settings WHERE key = 'sync_lock'`).get(),
      undefined,
      "INSERT INTO sync_runs 抛错后必须释放云端锁，防止泄漏 15 分钟"
    );

    const nextLock = await runWithDb(d1, () => sync.acquireSyncLock("next-owner", "manual"));
    assert.equal(nextLock.ok, true);
    await runWithDb(d1, () => sync.releaseSyncLock("next-owner"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("[P1-5] D1 读取 write_token 异常时必须 fail-closed：recommend /ai-assess 返回 503（有 env 时 401）且绝不调 AI", async () => {
  const recommend = await loadTs(
    path.join(workerSrc, "routes", "recommend.ts"),
    new Map([["hono", honoMockUrl]])
  );
  const auth = workerModules.auth;
  const brokenD1 = {
    prepare() {
      return {
        bind: () => ({
          first: async () => { throw new Error("D1 unavailable"); },
          all: async () => { throw new Error("D1 unavailable"); },
          run: async () => { throw new Error("D1 unavailable"); }
        }),
        first: async () => { throw new Error("D1 unavailable"); },
        all: async () => { throw new Error("D1 unavailable"); },
        run: async () => { throw new Error("D1 unavailable"); }
      };
    },
    batch: async () => { throw new Error("D1 unavailable"); }
  };

  let aiCalls = 0;
  const envNoSecret = {
    ALLOWED_ORIGIN: "https://zhihu-backup.pages.dev",
    AI: { async run() { aiCalls++; return { response: "bad" }; } }
  };

  // 1) 无 env 密钥且 D1 抛错：即使携带白名单 Origin，也必须 503 拒绝（绝不退化为免密调用 AI）
  const res503 = await runWithDb(brokenD1, () =>
    recommend.recommendRoutes.__call("POST", "/ai-assess", {
      headers: { origin: "https://zhihu-backup.pages.dev" },
      body: { pk: "answer:1" }
    }, envNoSecret)
  );
  assert.equal(res503.status, 503);
  assert.equal(res503.body.error, "Auth storage unavailable");
  assert.equal(aiCalls, 0);

  // 2) 有 env 兜底密钥且 D1 抛错：必须返回 401，绝不放行
  const envWithToken = {
    ...envNoSecret,
    COOKIE_WRITE_TOKEN: "fallback-token"
  };
  const res401 = await runWithDb(brokenD1, () =>
    recommend.recommendRoutes.__call("POST", "/ai-assess", {
      headers: { origin: "https://zhihu-backup.pages.dev" },
      body: { pk: "answer:1" }
    }, envWithToken)
  );
  assert.equal(res401.status, 401);
  assert.equal(aiCalls, 0);

  // 3) auth.ts getActiveWriteTokenInfo 在 D1 抛错且无 env 密钥时显式抛错；POST /write-token 与 denyWrite 返回 503
  await assert.rejects(
    () => runWithDb(brokenD1, () => auth.getActiveWriteTokenInfo({ env: {} })),
    /Auth storage unavailable/
  );
  const resetToken503 = await runWithDb(brokenD1, () =>
    auth.authRoutes.__call("POST", "/write-token", {
      url: "https://zhihu-backup.pages.dev/api/auth/write-token",
      headers: { origin: "https://zhihu-backup.pages.dev" },
      body: { newToken: "hacked-pass" }
    }, { ALLOWED_ORIGIN: "https://zhihu-backup.pages.dev" })
  );
  assert.equal(resetToken503.status, 503);

  const denyWrite503 = await runWithDb(brokenD1, () =>
    auth.authRoutes.__call("POST", "/zhihu-cookie", {
      url: "https://zhihu-backup.pages.dev/api/auth/zhihu-cookie",
      headers: { origin: "https://zhihu-backup.pages.dev" },
      body: { cookieString: "z_c0=abc" }
    }, { ALLOWED_ORIGIN: "https://zhihu-backup.pages.dev" })
  );
  assert.equal(denyWrite503.status, 503);
});

test("[P2-7][P2-8] SSRF 尾点/IPv6/NAT64 与 3xx 重定向文案；非知乎头像保留 query", async () => {
  const auth = workerModules.auth;
  const { d1 } = createMemoryDb();

  // P2-7: 域名尾点、RFC4291 fe80::/10 (fe81~febf)、NAT64 64:ff9b::/96
  assert.equal(auth.isPrivateOrLoopbackHost("localhost."), true);
  assert.equal(auth.isPrivateOrLoopbackHost("sub.localhost."), true);
  assert.equal(auth.isPrivateOrLoopbackHost("169.254.169.254."), true);
  assert.equal(auth.isPrivateOrLoopbackHost("fe81::1"), true);
  assert.equal(auth.isPrivateOrLoopbackHost("[febf::1]"), true);
  assert.equal(auth.isPrivateOrLoopbackHost("64:ff9b::127.0.0.1"), true);
  assert.equal(auth.isPrivateOrLoopbackHost("[64:ff9b::7f00:1]"), true);
  assert.equal(auth.isPrivateOrLoopbackHost("db.example.com."), false);

  const env = { API_SECRET: "ssrf-2-secret" };
  const headers = { authorization: "Bearer ssrf-2-secret" };
  for (const badUrl of [
    "http://169.254.169.254./latest/meta-data/",
    "http://localhost./hook",
    "http://[fe81::1]/hook",
    "http://[64:ff9b::127.0.0.1]/hook"
  ]) {
    const res = await runWithDb(d1, () =>
      auth.authRoutes.__call("POST", "/external-targets/test", {
        url: "https://zhihu-backup.pages.dev/api/auth/external-targets/test",
        headers,
        body: { provider: "webhook", endpointUrl: badUrl }
      }, env)
    );
    assert.equal(res.status, 400, `必须拦截 ${badUrl}`);
  }

  // 3xx 明确重定向拒绝文案（不得误报客户端错误）
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 302,
    headers: new Headers({ location: "http://127.0.0.1/" }),
    json: async () => ({}),
    text: async () => ""
  });
  try {
    const testRes = await runWithDb(d1, () =>
      auth.authRoutes.__call("POST", "/external-targets/test", {
        url: "https://zhihu-backup.pages.dev/api/auth/external-targets/test",
        headers,
        body: { provider: "webhook", endpointUrl: "https://public.example.com/hook" }
      }, env)
    );
    assert.equal(testRes.status, 200);
    assert.equal(testRes.body.ok, false);
    assert.match(testRes.body.message, /重定向.*302/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // P2-8: 非知乎图床保留 query 参数，知乎图床仍剥离 query
  assert.equal(
    hashModule.normalizeAvatarUrlForCompare("https://cdn.example.com/avatar.png?v=1"),
    "https://cdn.example.com/avatar.png?v=1"
  );
  assert.equal(
    hashModule.isAvatarUrlChanged(
      "https://cdn.example.com/avatar.png?v=1",
      "https://cdn.example.com/avatar.png?v=2"
    ),
    true
  );
  assert.equal(
    hashModule.isAvatarUrlChanged(
      "https://pic1.zhimg.com/v2-abc.jpg?source=1",
      "https://picx.zhimg.com/v2-abc.jpg?source=2"
    ),
    false
  );
  // M14: 非知乎头像必须保留非默认端口并省略默认 80/443 端口
  assert.equal(
    hashModule.isAvatarUrlChanged(
      "https://avatars.example.com:8443/a.png",
      "https://avatars.example.com/a.png"
    ),
    true
  );
  assert.equal(
    hashModule.isAvatarUrlChanged(
      "https://avatars.example.com:443/a.png",
      "https://avatars.example.com/a.png"
    ),
    false
  );
  assert.equal(
    hashModule.isAvatarUrlChanged(
      "http://avatars.example.com:80/a.png",
      "http://avatars.example.com/a.png"
    ),
    false
  );
});

test("[P1-8][P2-3] image-tasks 落库失败清零并重抛、路由 limit 钳制 <= 12、waitUntil 记日志不外抛、以及租约 Fencing", async () => {
  const sharedIndexUrl = await moduleUrlFor(sharedIndexPath);
  const ingest = await loadTs(
    path.join(workerSrc, "routes", "ingest.ts"),
    new Map([["hono", honoMockUrl], ["shared", sharedIndexUrl]])
  );
  workerModules.auth.invalidateExternalTargetsCache();
  const originalFetch = globalThis.fetch;

  try {
    // 1) 末尾 db.batch 抛错时 processImageBatch 清零 summary 并重抛，POST /ingest/image-batch 透出异常
    const { sqlite: s1, d1: d1_1 } = createMemoryDb();
    seedContent(s1);
    seedImageTask(s1, {
      imageUrl: "https://picx.zhimg.com/p18-ok.jpg",
      objectKey: `images/${"a".repeat(64)}.jpg`,
      status: "pending",
      attempts: 0,
      updatedAt: NOW_ISO
    });
    const failStatusBatchD1 = {
      prepare: sql => d1_1.prepare(sql),
      batch: async stmts => {
        if (stmts.some(st => /UPDATE image_tasks SET status = 'done'/i.test(st.sql))) {
          throw new Error("simulated D1 write error");
        }
        return d1_1.batch(stmts);
      }
    };
    const okBucket = {
      async head() { return null; },
      async get() { return null; },
      async put() {},
      async delete() {}
    };
    globalThis.fetch = async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg", "content-length": "3" }
      });

    await assert.rejects(
      () => runWithDb(failStatusBatchD1, () => imageTasksModule.processImageBatch(okBucket, 5)),
      /simulated D1 write error/
    );

    // 路由 POST /ingest/image-batch 不吞异常（交由 app.onError 返回 500）
    s1.prepare(`UPDATE image_tasks SET status = 'pending', updated_at = ?`).run(NOW_ISO);
    await assert.rejects(
      () => runWithDb(failStatusBatchD1, () =>
        ingest.ingestRoutes.__call("POST", "/image-batch", {
          headers: { authorization: "Bearer img-secret" },
          body: { limit: 5 }
        }, { DB: failStatusBatchD1, BUCKET: okBucket, API_SECRET: "img-secret" })
      ),
      /simulated D1 write error/
    );

    // 2) waitUntil 后台 drain：db.batch 失败时被 try/catch 记日志，不产生未捕获拒绝
    const { d1: d1_2 } = createMemoryDb();
    let drainHitError = false;
    const failDrainD1 = {
      prepare: sql => d1_2.prepare(sql),
      batch: async stmts => {
        if (stmts.some(st => /UPDATE image_tasks SET status = 'done'/i.test(st.sql))) {
          drainHitError = true;
          throw new Error("drain batch failed");
        }
        return d1_2.batch(stmts);
      }
    };
    const waitUntilPromises = [];
    const contentRes = await runWithDb(failDrainD1, () =>
      ingest.ingestRoutes.__call("POST", "/content", {
        headers: { authorization: "Bearer img-secret" },
        executionCtx: { waitUntil: p => waitUntilPromises.push(p) },
        body: {
          sourceType: "answer",
          sourceId: "drain-1",
          title: "T",
          sourceUrl: "https://www.zhihu.com/question/1/answer/drain-1",
          contentHtml: `<p><img src="https://picx.zhimg.com/v2-drain1.jpg" /></p>`
        }
      }, { DB: failDrainD1, BUCKET: okBucket, API_SECRET: "img-secret" })
    );
    assert.equal(contentRes.status, 200);
    assert.ok(waitUntilPromises.length >= 1, "必须触发 waitUntil 图片 drain");
    await assert.doesNotReject(() => Promise.all(waitUntilPromises));
    assert.equal(drainHitError, true, "后台 drain 确实触发并捕获了 db.batch 失败");

    // 3) POST /ingest/image-batch 对超大 limit 使用 Math.min 钳制 <= 12，不返回 400
    const { sqlite: s3, d1: d1_3 } = createMemoryDb();
    seedContent(s3);
    for (let i = 0; i < 15; i++) {
      seedImageTask(s3, {
        imageUrl: `https://picx.zhimg.com/clamp-${i}.jpg`,
        objectKey: `images/${String(i).padStart(64, "b")}.jpg`,
        status: "pending",
        attempts: 0,
        updatedAt: NOW_ISO
      });
    }
    const clampRes = await runWithDb(d1_3, () =>
      ingest.ingestRoutes.__call("POST", "/image-batch", {
        headers: { authorization: "Bearer img-secret" },
        body: { limit: 100 }
      }, { DB: d1_3, BUCKET: okBucket, API_SECRET: "img-secret" })
    );
    assert.equal(clampRes.status, 200);
    assert.equal(clampRes.body.claimed, 12, "路由 limit=100 必须被钳制到 <= 12");
    assert.equal(clampRes.body.limit, 12, "路由必须暴露服务端有效上限 limit <= 12");

    // 4) [P2-3] 租约 Fencing：慢 Worker 回写时任务已被新 Worker 接管并置 done（updated_at 已变），
    //    慢 Worker 的 markTaskFailed 绝不可覆盖 done 状态，且统计不得计入该行
    const { sqlite: s4, d1: d1_4 } = createMemoryDb();
    seedContent(s4);
    const taskId = seedImageTask(s4, {
      imageUrl: "https://picx.zhimg.com/fence.jpg",
      objectKey: `images/${"c".repeat(64)}.jpg`,
      status: "pending",
      attempts: 2,
      updatedAt: "2025-01-01T00:00:00.000Z"
    });
    const slowBucket = {
      async head() { return null; },
      async get() { return null; },
      async put() {},
      async delete() {}
    };
    globalThis.fetch = async () => {
      // 模拟慢请求期间，新 Worker 已接管任务并标记为 done（刷新了 updated_at）
      s4.prepare(`UPDATE image_tasks SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?`).run(
        "2099-01-01T00:00:00.000Z",
        taskId
      );
      return new Response("fail", { status: 500 });
    };
    const fenceRes = await runWithDb(d1_4, () => imageTasksModule.processImageBatch(slowBucket, 1));
    assert.equal(fenceRes.done, 0);
    assert.equal(fenceRes.failed, 0, "被租约 Fence 拦截的行不得计入 failed");
    assert.equal(fenceRes.retry, 0, "被租约 Fence 拦截的行不得计入 retry");
    const fencedRow = s4.prepare(`SELECT status, updated_at FROM image_tasks WHERE id = ?`).get(taskId);
    assert.equal(fencedRow.status, "done", "旧 Worker 不得用 failed 覆盖新 Worker 已落库的 done");
    assert.equal(fencedRow.updated_at, "2099-01-01T00:00:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
    workerModules.auth.invalidateExternalTargetsCache();
  }
});

test("[P1-2][P2-2] cloudflare_d1 20 根批控制子请求 << 50 且单句绑定参数 <= 90；0 回复跳过墓碑；DDL 含 child_comment_blobs 索引", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  const auth = workerModules.auth;
  auth.invalidateExternalTargetsCache();
  auth.resetRemoteSchemaCache();

  const remoteSqlite = new Database(":memory:");
  const d1Target = {
    id: "ext-d1-batch",
    name: "Cloudflare D1 Ext",
    provider: "cloudflare_d1",
    enabled: true,
    syncScopes: ["comments"],
    storageRole: "offload",
    overflowThresholdRows: 1500000,
    endpointUrl: "https://api.cloudflare.com",
    databaseId: "acc1/db1",
    authToken: "tok",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO
  };
  const bucket = {
    async get(key) {
      if (key === auth.R2_EXTERNAL_TARGETS_KEY) {
        return { async text() { return JSON.stringify([d1Target]); } };
      }
      return null;
    },
    async put() {},
    async delete() {}
  };

  let fetchCount = 0;
  let maxParamsInSql = 0;
  const recordedSqls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    fetchCount++;
    const body = JSON.parse(String(init.body));
    const sql = body.sql;
    const params = Array.isArray(body.params) ? body.params : [];
    assert.ok(params.length <= 90, `单条远端 SQL 绑定参数 (${params.length}) 不得超过 90: ${sql.slice(0, 80)}`);
    if (params.length > maxParamsInSql) maxParamsInSql = params.length;
    recordedSqls.push({ sql, paramCount: params.length });

    const st = remoteSqlite.prepare(sql);
    if (st.reader) {
      const results = st.all(...params);
      return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results, meta: { changes: 0 } }] }), text: async () => "" };
    }
    const info = st.run(...params);
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: [], meta: { changes: info.changes } }] }), text: async () => "" };
  };

  try {
    // 预热远端建表 DDL（验证 P2-2 索引已创建）
    await auth.ensureRemoteCommentSchema(d1Target);
    const indexes = remoteSqlite.prepare(`PRAGMA index_list('child_comment_blobs')`).all().map(r => r.name);
    assert.ok(indexes.includes("idx_ext_child_comment_blobs_content"), "外部库必须建 idx_ext_child_comment_blobs_content 索引");

    // 1) 20 条全新 0 回复根：跳过墓碑 + 多行合并写入，fetch << 50，不降级写主库
    fetchCount = 0;
    d1.writes.length = 0;
    const zeroReplyRoots = Array.from({ length: 20 }, (_, i) => ({
      id: `rz-${i}`,
      author: `U${i}`,
      authorAvatar: "",
      content: `c${i}`,
      img: "",
      time: NOW_ISO,
      location: "",
      likes: i,
      isAuthor: false,
      isTop: false,
      isFeatured: false,
      childCount: 0,
      isChildrenComplete: true,
      children: []
    }));
    const resZero = await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        allRootIds: zeroReplyRoots.map(r => r.id),
        roots: zeroReplyRoots
      }, { DB: d1, BUCKET: bucket })
    );
    assert.equal(resZero.offloadedTo, "Cloudflare D1 Ext");
    assert.equal(resZero.offloadedCounts.added, 20);
    assert.ok(fetchCount < 15, `20 条全新 0 回复根 fetch 次数应远低于 50，实际=${fetchCount}`);
    assert.equal(d1.writes.length, 0, "不得降级回写主 D1");
    assert.equal(remoteSqlite.prepare(`SELECT COUNT(*) AS n FROM child_comment_blobs`).get().n, 0);
    assert.equal(remoteSqlite.prepare(`SELECT COUNT(*) AS n FROM comment_threads`).get().n, 0);

    // 2) 20 条带子评论根（合并写入 blobs 与 threads）：fetch << 50 且所有 SQL 参数 <= 90
    fetchCount = 0;
    const childRoots = Array.from({ length: 20 }, (_, i) => ({
      id: `rc-${i}`,
      author: `U${i}`,
      authorAvatar: "",
      content: `c${i}`,
      img: "",
      time: NOW_ISO,
      location: "",
      likes: i,
      isAuthor: false,
      isTop: false,
      isFeatured: false,
      childCount: 1,
      isChildrenComplete: true,
      children: [{ id: `ch-${i}`, parentId: `rc-${i}`, author: "A", content: `reply-${i}`, likes: 1 }]
    }));
    const resChild = await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        allRootIds: [...zeroReplyRoots, ...childRoots].map(r => r.id),
        roots: childRoots
      }, { DB: d1, BUCKET: bucket })
    );
    assert.equal(resChild.offloadedCounts.added, 20);
    assert.ok(fetchCount < 20, `20 条带子评论根 fetch 次数应远低于 50，实际=${fetchCount}`);
    assert.ok(maxParamsInSql <= 90);
    assert.equal(remoteSqlite.prepare(`SELECT COUNT(*) AS n FROM child_comment_blobs`).get().n, 20);
    assert.equal(remoteSqlite.prepare(`SELECT COUNT(*) AS n FROM comment_threads`).get().n, 20);

    // 3) 20 条不完整子评论根：mergeRootIds 使用 IN (...) 批量查询，fetch << 50
    fetchCount = 0;
    const incompleteRoots = Array.from({ length: 20 }, (_, i) => ({
      id: `rc-${i}`,
      author: `U${i}`,
      authorAvatar: "",
      content: `c${i}`,
      img: "",
      time: NOW_ISO,
      location: "",
      likes: i,
      isAuthor: false,
      isTop: false,
      isFeatured: false,
      childCount: 2,
      isChildrenComplete: false,
      children: [{ id: `ch2-${i}`, parentId: `rc-${i}`, author: "B", content: `reply2-${i}`, likes: 2 }]
    }));
    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: true,
        roots: incompleteRoots
      }, { DB: d1, BUCKET: bucket })
    );
    assert.ok(fetchCount < 35, `20 条含计数更新的不完整合并 fetch 次数应远低于 50，实际=${fetchCount}`);
    const sampleBlob = JSON.parse(
      remoteSqlite.prepare(`SELECT payload_json FROM child_comment_blobs WHERE root_id = 'rc-0'`).get().payload_json
    );
    assert.deepEqual(sampleBlob.children.map(c => c.id), ["ch-0", "ch2-0"]);
  } finally {
    globalThis.fetch = originalFetch;
    auth.invalidateExternalTargetsCache();
    auth.resetRemoteSchemaCache();
  }
});

test("[P1-6] offload 全量清零同步清理主 D1 残留评论/线程与主 R2 旧对象，杜绝回退复活", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  const auth = workerModules.auth;
  auth.invalidateExternalTargetsCache();
  auth.resetRemoteSchemaCache();

  // 1) 迁移前：主 D1 与主 R2 已有旧根评论、旧扁平子评论与 comment_threads/R2 对象
  const mainThreadKey = "childcomments/r-main-legacy.json";
  const r2Store = new Map([
    [mainThreadKey, JSON.stringify({ children: [{ id: "old_r2_child", content: "from main R2" }], complete: true })]
  ]);
  const bucket = {
    async get(key) {
      const val = r2Store.get(key);
      return val === undefined ? null : { async text() { return val; } };
    },
    async put(key, val) { r2Store.set(key, String(val)); },
    async delete(key) {
      if (Array.isArray(key)) {
        for (const k of key) r2Store.delete(k);
      } else {
        r2Store.delete(key);
      }
    }
  };
  sqlite.prepare(`
    INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, first_seen_at, last_seen_at, is_deleted)
    VALUES ('r-main-legacy', ?, NULL, 'OldRoot', 'root', 1, 'h1', ?, ?, 0),
           ('ch-main-legacy', ?, 'r-main-legacy', 'OldChild', 'child', 1, 'h2', ?, ?, 0)
  `).run(CONTENT_PK, NOW_ISO, NOW_ISO, CONTENT_PK, NOW_ISO, NOW_ISO);
  sqlite.prepare(`
    INSERT INTO comment_threads (root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at)
    VALUES ('r-main-legacy', ?, ?, 1, 1, 'th', 'ih', '[]', ?)
  `).run(CONTENT_PK, mainThreadKey, NOW_ISO);

  // 2) 启用 offload 后先写入远端一条新根，再提交全量清零
  const remoteSqlite = new Database(":memory:");
  const offloadTarget = {
    id: "ext-p16",
    name: "Turso P16",
    provider: "turso",
    enabled: true,
    syncScopes: ["comments"],
    storageRole: "offload",
    overflowThresholdRows: 1500000,
    endpointUrl: "https://ext-p16.example.com",
    authToken: "tok",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO
  };
  r2Store.set(auth.R2_EXTERNAL_TARGETS_KEY, JSON.stringify([offloadTarget]));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body));
    const results = [];
    for (const req of body.requests) {
      if (req.type === "close") {
        results.push({ type: "ok", response: { type: "close" } });
        continue;
      }
      const sql = req.stmt.sql;
      const args = (req.stmt.args || []).map(a => (!a || a.type === "null") ? null : (a.type === "integer" || a.type === "float") ? Number(a.value) : String(a.value));
      const st = remoteSqlite.prepare(sql);
      if (st.reader) {
        const cols = st.columns().map(c => ({ name: c.name }));
        const rows = st.all(...args).map(r => cols.map(c => tursoCell(r[c.name])));
        results.push({ type: "ok", response: { type: "execute", result: { cols, rows, affected_row_count: 0, last_insert_rowid: null } } });
      } else {
        const info = st.run(...args);
        results.push({ type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: info.changes, last_insert_rowid: null } } });
      }
    }
    return { ok: true, status: 200, json: async () => ({ results }), text: async () => "" };
  };

  try {
    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        allRootIds: ["r-ext"],
        roots: [{
          id: "r-ext",
          author: "Ext",
          authorAvatar: "",
          content: "ext",
          img: "",
          time: NOW_ISO,
          location: "",
          likes: 2,
          isAuthor: false,
          isTop: false,
          isFeatured: false,
          childCount: 1,
          isChildrenComplete: true,
          children: [{ id: "ch-ext", parentId: "r-ext", author: "C", content: "ext child", likes: 1 }]
        }]
      }, { DB: d1, BUCKET: bucket })
    );

    // 提交全量清零
    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        allRootIds: [],
        roots: []
      }, { DB: d1, BUCKET: bucket })
    );

    assert.equal(r2Store.has(mainThreadKey), true, "防删归档模式下主 R2 旧楼中楼对象必须保留");
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM comment_threads WHERE content_pk = ?`).get(CONTENT_PK).n, 1);
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM comments WHERE content_pk = ? AND is_deleted = 0`).get(CONTENT_PK).n, 0);
    assert.equal(sqlite.prepare(`SELECT comment_count FROM contents WHERE pk = ?`).get(CONTENT_PK).comment_count, 0);
    assert.ok(sqlite.prepare(`SELECT archived_comment_count FROM contents WHERE pk = ?`).get(CONTENT_PK).archived_comment_count >= 2);
    assert.equal(remoteSqlite.prepare(`SELECT COUNT(*) AS n FROM child_comment_blobs WHERE content_pk = ?`).get(CONTENT_PK).n, 1);
    assert.equal(remoteSqlite.prepare(`SELECT COUNT(*) AS n FROM comment_threads WHERE content_pk = ?`).get(CONTENT_PK).n, 1);
    assert.equal((await runWithDb(d1, () => commentsModule.getChildComments(bucket, "r-main-legacy", d1))).length, 1);
    const archivedRoots = await runWithDb(d1, () => commentsModule.listRootComments(d1, CONTENT_PK, {}, bucket));
    assert.ok(archivedRoots.length >= 2);
    assert.ok(archivedRoots.every(r => r.is_deleted === 1));
  } finally {
    globalThis.fetch = originalFetch;
    auth.invalidateExternalTargetsCache();
    auth.resetRemoteSchemaCache();
  }
});

test("[P1-3][P2-1] R2 批量删失败保留 comment_threads 行、部分成功按 <=90 参数分块删，以及 childcomments /v2/ 边缘缓存升版", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  workerModules.auth.invalidateExternalTargetsCache();

  // 1) 20 个线程清零时 bucket.delete(batch) 抛错 -> 必须保留全部 20 行 comment_threads 供重试
  const r2Store = new Map();
  for (let i = 0; i < 20; i++) {
    const rid = `r-fail-${i}`;
    r2Store.set(`childcomments/${rid}.json`, JSON.stringify({ children: [{ id: `c-${i}` }], complete: true }));
    sqlite.prepare(`
      INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, first_seen_at, last_seen_at, is_deleted)
      VALUES (?, ?, NULL, 'U', 'text', 1, 'h', ?, ?, 0)
    `).run(rid, CONTENT_PK, NOW_ISO, NOW_ISO);
    sqlite.prepare(`
      INSERT INTO comment_threads (root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at)
      VALUES (?, ?, ?, 1, 1, 'th', 'ih', '[]', ?)
    `).run(rid, CONTENT_PK, `childcomments/${rid}.json`, NOW_ISO);
  }
  const failingBucket = {
    async get(k) { const v = r2Store.get(k); return v === undefined ? null : { async text() { return v; } }; },
    async put(k, v) { r2Store.set(k, String(v)); },
    async delete() { throw new Error("R2 bulk delete error"); }
  };
  await runWithDb(d1, () =>
    commentsModule.replaceCommentsByRoot({ contentPk: CONTENT_PK, partial: false, allRootIds: [], roots: [] }, { DB: d1, BUCKET: failingBucket })
  );
  assert.equal(
    sqlite.prepare(`SELECT COUNT(*) AS n FROM comment_threads WHERE content_pk = ?`).get(CONTENT_PK).n,
    20,
    "防删归档全量清零不触发 bucket.delete 并保留全部 20 行 comment_threads"
  );

  // 2) 1015 个线程全量清零：防删归档模式下既不触发 R2 批量删除也不删 comment_threads（无子请求风险）
  const { sqlite: s2, d1: d1_2 } = createMemoryDb();
  seedContent(s2);
  const insertRootStmt = s2.prepare(`
    INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, first_seen_at, last_seen_at, is_deleted)
    VALUES (?, ?, NULL, 'U', 'text', 1, 'h', ?, ?, 0)
  `);
  const insertThreadStmt = s2.prepare(`
    INSERT INTO comment_threads (root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at)
    VALUES (?, ?, ?, 1, 1, 'th', 'ih', '[]', ?)
  `);
  s2.transaction(() => {
    for (let i = 0; i < 1015; i++) {
      const rid = `r-chunk-${i}`;
      insertRootStmt.run(rid, CONTENT_PK, NOW_ISO, NOW_ISO);
      insertThreadStmt.run(rid, CONTENT_PK, `childcomments/${rid}.json`, NOW_ISO);
    }
  })();

  let bucketDeleteCount = 0;
  const noDeleteBucket = {
    async get() { return null; },
    async put() {},
    async delete() {
      bucketDeleteCount++;
      throw new Error("should not call bucket.delete during archival full-clear");
    }
  };
  const threadDeleteParamCounts = [];
  const wrappedD1 = {
    prepare(sql) {
      const stmt = d1_2.prepare(sql);
      if (/DELETE FROM comment_threads/i.test(sql)) {
        return {
          bind(...params) {
            threadDeleteParamCounts.push(params.length);
            return stmt.bind(...params);
          }
        };
      }
      return stmt;
    },
    batch: stmts => d1_2.batch(stmts)
  };
  await runWithDb(wrappedD1, () =>
    commentsModule.replaceCommentsByRoot({ contentPk: CONTENT_PK, partial: false, allRootIds: [], roots: [] }, { DB: wrappedD1, BUCKET: noDeleteBucket })
  );
  assert.equal(bucketDeleteCount, 0);
  assert.equal(threadDeleteParamCounts.length, 0);
  assert.equal(
    s2.prepare(`SELECT COUNT(*) AS n FROM comment_threads WHERE content_pk = ?`).get(CONTENT_PK).n,
    1015,
    "1015 个线程索引在全量清零时均应保留"
  );

  // 3) P2-1: childcomments/* 边缘缓存 URL 必须带 /v2/ 前缀（自然淘汰旧 86400s 缓存）
  const edgeStore = new Map();
  const originalCaches = globalThis.caches;
  globalThis.caches = {
    default: {
      async match(url) { const hit = edgeStore.get(String(url)); return hit ? new Response(hit) : undefined; },
      async put(url, res) { edgeStore.set(String(url), await res.text()); },
      async delete(url) { edgeStore.delete(String(url)); }
    }
  };
  try {
    const v2Key = "childcomments/r-v2-check.json";
    const v2Bucket = {
      async get(k) {
        if (k === v2Key) return { async text() { return JSON.stringify({ children: [{ id: "cv2", content: "hi" }], complete: true }); } };
        return null;
      }
    };
    await runWithDb(d1, () => commentsModule.getChildComments(v2Bucket, "r-v2-check", d1));
    assert.equal(edgeStore.has(`https://r2-edge-cache.internal/v2/${encodeURIComponent(v2Key)}`), true);
    assert.equal(edgeStore.has(`https://r2-edge-cache.internal/${encodeURIComponent(v2Key)}`), false);
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("[P2-4] 闭评三态 is_complete=2：主库与外部库保留历史楼中楼、不被后续增量同步降级回 0、可正常恢复为 1", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  const auth = workerModules.auth;
  auth.invalidateExternalTargetsCache();
  auth.resetRemoteSchemaCache();

  // 1) 主 D1 + R2 路径：既有历史楼中楼 ch_old，随后遇闭评上报 ch_new + isChildrenClosed: true
  const r2Store = new Map([
    ["childcomments/r-closed.json", JSON.stringify({ children: [{ id: "ch_old", parentId: "r-closed", author: "Old", content: "old", likes: 1 }], complete: false })]
  ]);
  const mainBucket = {
    async get(k) { const v = r2Store.get(k); return v === undefined ? null : { async text() { return v; } }; },
    async put(k, v) { r2Store.set(k, String(v)); },
    async delete(k) { r2Store.delete(k); }
  };
  await runWithDb(d1, () =>
    commentsModule.replaceCommentsByRoot({
      contentPk: CONTENT_PK,
      partial: false,
      allRootIds: ["r-closed", "r-closed-noinline"],
      roots: [
        {
          id: "r-closed",
          author: "Root",
          authorAvatar: "",
          content: "root",
          img: "",
          time: NOW_ISO,
          location: "",
          likes: 5,
          isAuthor: false,
          isTop: false,
          isFeatured: false,
          childCount: 3,
          isChildrenComplete: false,
          isChildrenClosed: true,
          children: [{ id: "ch_new", parentId: "r-closed", author: "New", content: "new", likes: 2 }]
        },
        {
          id: "r-closed-noinline",
          author: "Root2",
          authorAvatar: "",
          content: "root2",
          img: "",
          time: NOW_ISO,
          location: "",
          likes: 3,
          isAuthor: false,
          isTop: false,
          isFeatured: false,
          childCount: 4,
          isChildrenComplete: false,
          isChildrenClosed: true,
          children: []
        }
      ]
    }, { DB: d1, BUCKET: mainBucket })
  );

  const mergedR2 = JSON.parse(r2Store.get("childcomments/r-closed.json"));
  assert.deepEqual(mergedR2.children.map(c => c.id), ["ch_old", "ch_new"], "闭评必须保留并合并历史楼中楼");
  assert.equal(sqlite.prepare(`SELECT is_complete FROM comment_threads WHERE root_id = 'r-closed'`).get().is_complete, 2);
  assert.equal(sqlite.prepare(`SELECT is_complete FROM comment_threads WHERE root_id = 'r-closed-noinline'`).get().is_complete, 2);

  // 后续 hot / 增量同步（跳过子评论：isChildrenComplete=false 且不带 isChildrenClosed）绝不可把 2 降级回 0
  await runWithDb(d1, () =>
    commentsModule.replaceCommentsByRoot({
      contentPk: CONTENT_PK,
      partial: true,
      roots: [
        {
          id: "r-closed",
          author: "Root",
          authorAvatar: "",
          content: "root",
          img: "",
          time: NOW_ISO,
          location: "",
          likes: 6,
          isAuthor: false,
          isTop: false,
          isFeatured: false,
          childCount: 3,
          isChildrenComplete: false,
          children: [{ id: "ch_new", parentId: "r-closed", author: "New", content: "new", likes: 2 }]
        },
        {
          id: "r-closed-noinline",
          author: "Root2",
          authorAvatar: "",
          content: "root2",
          img: "",
          time: NOW_ISO,
          location: "",
          likes: 3,
          isAuthor: false,
          isTop: false,
          isFeatured: false,
          childCount: 5,
          isChildrenComplete: false,
          children: []
        }
      ]
    }, { DB: d1, BUCKET: mainBucket })
  );
  assert.equal(sqlite.prepare(`SELECT is_complete FROM comment_threads WHERE root_id = 'r-closed'`).get().is_complete, 2, "有内联子评的后续增量同步不得降级 is_complete=2");
  assert.equal(sqlite.prepare(`SELECT is_complete FROM comment_threads WHERE root_id = 'r-closed-noinline'`).get().is_complete, 2, "无内联子评的后续增量同步不得降级 is_complete=2");

  // 后续评论区重开并抓全时，可正常升回 1
  await runWithDb(d1, () =>
    commentsModule.replaceCommentsByRoot({
      contentPk: CONTENT_PK,
      partial: false,
      allRootIds: ["r-closed", "r-closed-noinline"],
      roots: [{
        id: "r-closed",
        author: "Root",
        authorAvatar: "",
        content: "root",
        img: "",
        time: NOW_ISO,
        location: "",
        likes: 6,
        isAuthor: false,
        isTop: false,
        isFeatured: false,
        childCount: 2,
        isChildrenComplete: true,
        children: [
          { id: "ch_old", parentId: "r-closed", author: "Old", content: "old", likes: 1 },
          { id: "ch_new", parentId: "r-closed", author: "New", content: "new", likes: 2 }
        ]
      }]
    }, { DB: d1, BUCKET: mainBucket })
  );
  assert.equal(sqlite.prepare(`SELECT is_complete FROM comment_threads WHERE root_id = 'r-closed'`).get().is_complete, 1);

  // 2) 外部 offload 库对称支持 is_complete = 2 且不被后续增量同步降级回 0
  const remoteSqlite = new Database(":memory:");
  const offloadTarget = {
    id: "ext-p24",
    name: "Turso P24",
    provider: "turso",
    enabled: true,
    syncScopes: ["comments"],
    storageRole: "offload",
    overflowThresholdRows: 1500000,
    endpointUrl: "https://ext-p24.example.com",
    authToken: "tok",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO
  };
  r2Store.set(auth.R2_EXTERNAL_TARGETS_KEY, JSON.stringify([offloadTarget]));
  auth.invalidateExternalTargetsCache();
  auth.resetRemoteSchemaCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body));
    const results = [];
    for (const req of body.requests) {
      if (req.type === "close") { results.push({ type: "ok", response: { type: "close" } }); continue; }
      const sql = req.stmt.sql;
      const args = (req.stmt.args || []).map(a => (!a || a.type === "null") ? null : (a.type === "integer" || a.type === "float") ? Number(a.value) : String(a.value));
      const st = remoteSqlite.prepare(sql);
      if (st.reader) {
        const cols = st.columns().map(c => ({ name: c.name }));
        const rows = st.all(...args).map(r => cols.map(c => tursoCell(r[c.name])));
        results.push({ type: "ok", response: { type: "execute", result: { cols, rows, affected_row_count: 0, last_insert_rowid: null } } });
      } else {
        const info = st.run(...args);
        results.push({ type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: info.changes, last_insert_rowid: null } } });
      }
    }
    return { ok: true, status: 200, json: async () => ({ results }), text: async () => "" };
  };

  try {
    await auth.ensureRemoteCommentSchema(offloadTarget);
    remoteSqlite.prepare(`
      INSERT INTO child_comment_blobs (root_id, content_pk, payload_json, complete, updated_at)
      VALUES ('r-ext-closed', ?, ?, 0, ?)
    `).run(CONTENT_PK, JSON.stringify({ children: [{ id: "ch_ext_old", parentId: "r-ext-closed", author: "A", content: "old", likes: 1 }], complete: false }), NOW_ISO);

    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        allRootIds: ["r-ext-closed"],
        roots: [{
          id: "r-ext-closed",
          author: "ExtRoot",
          authorAvatar: "",
          content: "ext",
          img: "",
          time: NOW_ISO,
          location: "",
          likes: 1,
          isAuthor: false,
          isTop: false,
          isFeatured: false,
          childCount: 3,
          isChildrenComplete: false,
          isChildrenClosed: true,
          children: [{ id: "ch_ext_new", parentId: "r-ext-closed", author: "B", content: "new", likes: 1 }]
        }]
      }, { DB: d1, BUCKET: mainBucket })
    );
    const extBlob = JSON.parse(remoteSqlite.prepare(`SELECT payload_json FROM child_comment_blobs WHERE root_id = 'r-ext-closed'`).get().payload_json);
    assert.deepEqual(extBlob.children.map(c => c.id), ["ch_ext_old", "ch_ext_new"]);
    assert.equal(remoteSqlite.prepare(`SELECT is_complete FROM comment_threads WHERE root_id = 'r-ext-closed'`).get().is_complete, 2);

    // 外部库后续增量同步（无 isChildrenClosed）绝不降级回 0
    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: true,
        roots: [{
          id: "r-ext-closed",
          author: "ExtRoot",
          authorAvatar: "",
          content: "ext",
          img: "",
          time: NOW_ISO,
          location: "",
          likes: 2,
          isAuthor: false,
          isTop: false,
          isFeatured: false,
          childCount: 3,
          isChildrenComplete: false,
          children: [{ id: "ch_ext_new", parentId: "r-ext-closed", author: "B", content: "new", likes: 1 }]
        }]
      }, { DB: d1, BUCKET: mainBucket })
    );
    assert.equal(remoteSqlite.prepare(`SELECT is_complete FROM comment_threads WHERE root_id = 'r-ext-closed'`).get().is_complete, 2);
  } finally {
    globalThis.fetch = originalFetch;
    auth.invalidateExternalTargetsCache();
    auth.resetRemoteSchemaCache();
  }
});

// ---------- M5 / M6 / M7 / M11 回归测试 ----------

test("[M6] 闭评重开抓全（complete=true）且 R2 PUT 失败时 is_complete 必须置 0 可重试", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  workerModules.auth.invalidateExternalTargetsCache();

  sqlite.prepare(`
    INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, first_seen_at, last_seen_at, is_deleted)
    VALUES ('r-reopen', ?, NULL, 'U', 'root', 1, 'h-r', ?, ?, 0)
  `).run(CONTENT_PK, NOW_ISO, NOW_ISO);
  sqlite.prepare(`
    INSERT INTO comment_threads (root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at)
    VALUES ('r-reopen', ?, 'childcomments/r-reopen.json', 2, 2, 'old-th', 'old-in', '[]', ?)
  `).run(CONTENT_PK, NOW_ISO);

  const r2Store = new Map([
    ["childcomments/r-reopen.json", JSON.stringify({ children: [{ id: "ch_1", parentId: "r-reopen", author: "A", content: "old", likes: 1 }], complete: false })]
  ]);
  let failPut = true;
  const bucket = {
    async get(k) { const v = r2Store.get(k); return v === undefined ? null : { async text() { return v; } }; },
    async put(k, v) {
      if (failPut) throw new Error("R2 put failure");
      r2Store.set(k, String(v));
    },
    async delete(k) { r2Store.delete(k); }
  };

  const payload = {
    contentPk: CONTENT_PK,
    partial: false,
    allRootIds: ["r-reopen"],
    roots: [{
      id: "r-reopen",
      author: "U",
      authorAvatar: "",
      content: "root",
      img: "",
      time: NOW_ISO,
      location: "",
      likes: 1,
      isAuthor: false,
      isTop: false,
      isFeatured: false,
      childCount: 2,
      isChildrenComplete: true,
      children: [
        { id: "ch_1", parentId: "r-reopen", author: "A", content: "old", likes: 1 },
        { id: "ch_2", parentId: "r-reopen", author: "B", content: "new", likes: 2 }
      ]
    }]
  };

  await runWithDb(d1, () => commentsModule.replaceCommentsByRoot(payload, { DB: d1, BUCKET: bucket }));
  const rowFailed = sqlite.prepare(`SELECT is_complete, incoming_hash FROM comment_threads WHERE root_id = 'r-reopen'`).get();
  assert.equal(rowFailed.is_complete, 0, "重开抓全 R2 PUT 失败必须把 is_complete 置 0 以便下轮重试");
  assert.equal(rowFailed.incoming_hash, "");

  failPut = false;
  await runWithDb(d1, () => commentsModule.replaceCommentsByRoot(payload, { DB: d1, BUCKET: bucket }));
  const rowRecovered = sqlite.prepare(`SELECT is_complete FROM comment_threads WHERE root_id = 'r-reopen'`).get();
  assert.equal(rowRecovered.is_complete, 1, "下轮重试成功后应恢复为 is_complete=1");
});

test("[M5][M7][防删归档] 全量清零保留全部已归档楼中楼并将 comment_count 置 0 + offload 0回复历史探测抢救归档", async () => {
  const auth = workerModules.auth;
  auth.invalidateExternalTargetsCache();
  auth.resetRemoteSchemaCache();

  // 1) 主库路径：20 条根全量清零时即使 bucket.delete 会抛错也不调用它，保留全部 20 个 R2 对象与 19 行线程索引，comment_count=0 且 archived_comment_count>=20
  const { sqlite: s1, d1: d1_1 } = createMemoryDb();
  seedContent(s1);
  s1.prepare(`UPDATE contents SET comment_count = 0, archived_comment_count = 0 WHERE pk = ?`).run(CONTENT_PK);
  const mainR2 = new Map();
  for (let i = 0; i < 20; i++) {
    const rid = `r-m5-${i}`;
    mainR2.set(`childcomments/${rid}.json`, JSON.stringify({ children: [{ id: `c-${i}` }], complete: true }));
    s1.prepare(`
      INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, first_seen_at, last_seen_at, is_deleted)
      VALUES (?, ?, NULL, 'U', 'text', 1, 'h', ?, ?, 0)
    `).run(rid, CONTENT_PK, NOW_ISO, NOW_ISO);
    if (i > 0) {
      s1.prepare(`
        INSERT INTO comment_threads (root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at)
        VALUES (?, ?, ?, 1, 1, 'th', 'ih', '[]', ?)
      `).run(rid, CONTENT_PK, `childcomments/${rid}.json`, NOW_ISO);
    }
  }

  let deleteCalls = 0;
  const mainBucket = {
    async get(k) { const v = mainR2.get(k); return v === undefined ? null : { async text() { return v; } }; },
    async put(k, v) { mainR2.set(k, String(v)); },
    async delete() {
      deleteCalls++;
      throw new Error("R2 delete outage");
    }
  };

  await runWithDb(d1_1, () =>
    commentsModule.replaceCommentsByRoot({ contentPk: CONTENT_PK, partial: false, allRootIds: [], roots: [] }, { DB: d1_1, BUCKET: mainBucket })
  );
  assert.equal(deleteCalls, 0);
  assert.equal(s1.prepare(`SELECT COUNT(*) AS n FROM comment_threads WHERE content_pk = ?`).get(CONTENT_PK).n, 19);
  assert.equal(s1.prepare(`SELECT comment_count FROM contents WHERE pk = ?`).get(CONTENT_PK).comment_count, 0);
  assert.ok(s1.prepare(`SELECT archived_comment_count FROM contents WHERE pk = ?`).get(CONTENT_PK).archived_comment_count >= 20);
  assert.equal(mainR2.size, 20, "包括无索引旧根在内的全部 R2 楼中楼对象必须保留");
  const listAfterMainClear = await runWithDb(d1_1, () => commentsModule.listRootComments(d1_1, CONTENT_PK, {}, mainBucket));
  assert.equal(listAfterMainClear.length, 20);
  assert.ok(listAfterMainClear.every(r => r.is_deleted === 1));

  // 2) offload 路径：探测远端旧 blobs / 未删扁平子评论并将缺失子评论标记 isDeleted 归档；全量清零保留全部对象
  auth.invalidateExternalTargetsCache();
  auth.resetRemoteSchemaCache();
  const { sqlite: s2, d1: d1_2 } = createMemoryDb();
  seedContent(s2);
  s2.prepare(`UPDATE contents SET comment_count = 0, archived_comment_count = 0 WHERE pk = ?`).run(CONTENT_PK);
  s2.prepare(`
    INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, first_seen_at, last_seen_at, is_deleted)
    VALUES ('r-legacy-main', ?, NULL, 'U', 'legacy', 1, 'h', ?, ?, 0)
  `).run(CONTENT_PK, NOW_ISO, NOW_ISO);

  const remoteSqlite = new Database(":memory:");
  const offloadTarget = {
    id: "ext-m5-m7",
    name: "Turso M5M7",
    provider: "turso",
    enabled: true,
    syncScopes: ["comments"],
    storageRole: "offload",
    overflowThresholdRows: 1500000,
    endpointUrl: "https://ext-m5m7.example.com",
    authToken: "tok",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO
  };
  const offloadR2 = new Map([
    [auth.R2_EXTERNAL_TARGETS_KEY, JSON.stringify([offloadTarget])],
    ["childcomments/r-legacy-main.json", JSON.stringify({ children: [{ id: "old-c" }], complete: true })]
  ]);
  const offloadBucket = {
    async get(k) { const v = offloadR2.get(k); return v === undefined ? null : { async text() { return v; } }; },
    async put(k, v) { offloadR2.set(k, String(v)); },
    async delete() { throw new Error("offload full-clear must not delete R2"); }
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body));
    const results = [];
    for (const req of body.requests) {
      if (req.type === "close") { results.push({ type: "ok", response: { type: "close" } }); continue; }
      const sql = req.stmt.sql;
      const args = (req.stmt.args || []).map(a => (!a || a.type === "null") ? null : (a.type === "integer" || a.type === "float") ? Number(a.value) : String(a.value));
      const st = remoteSqlite.prepare(sql);
      if (st.reader) {
        const cols = st.columns().map(c => ({ name: c.name }));
        const rows = st.all(...args).map(r => cols.map(c => tursoCell(r[c.name])));
        results.push({ type: "ok", response: { type: "execute", result: { cols, rows, affected_row_count: 0, last_insert_rowid: null } } });
      } else {
        const info = st.run(...args);
        results.push({ type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: info.changes, last_insert_rowid: null } } });
      }
    }
    return { ok: true, status: 200, json: async () => ({ results }), text: async () => "" };
  };

  try {
    await auth.ensureRemoteCommentSchema(offloadTarget);

    // 2a) offload 0 回复根：外部库仅有旧 child_comment_blobs（r-blob-only）或未删扁平子评论行（r-flat-only）→ 保留历史子评论并标记 isDeleted: true
    remoteSqlite.prepare(`
      INSERT INTO child_comment_blobs (root_id, content_pk, payload_json, complete, updated_at)
      VALUES ('r-blob-only', ?, '{"children":[{"id":"old-b","author":"B","content":"old reply","likes":2}],"complete":true}', 1, ?)
    `).run(CONTENT_PK, NOW_ISO);
    remoteSqlite.prepare(`
      INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, first_seen_at, last_seen_at, is_deleted)
      VALUES ('c-flat-legacy', ?, 'r-flat-only', 'U', 'flat child', 1, 'hf', ?, ?, 0)
    `).run(CONTENT_PK, NOW_ISO, NOW_ISO);

    const makeZeroRoot = id => ({
      id,
      author: "Root",
      authorAvatar: "",
      content: "root",
      img: "",
      time: NOW_ISO,
      location: "",
      likes: 1,
      isAuthor: false,
      isTop: false,
      isFeatured: false,
      childCount: 0,
      isChildrenComplete: true,
      children: []
    });
    await runWithDb(d1_2, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        allRootIds: ["r-blob-only", "r-flat-only", "r-brand-new"],
        roots: [makeZeroRoot("r-blob-only"), makeZeroRoot("r-flat-only"), makeZeroRoot("r-brand-new")]
      }, { DB: d1_2, BUCKET: offloadBucket })
    );
    const blobLegacy1 = remoteSqlite.prepare(`SELECT payload_json, complete FROM child_comment_blobs WHERE root_id = 'r-blob-only'`).get();
    const blobLegacy2 = remoteSqlite.prepare(`SELECT payload_json, complete FROM child_comment_blobs WHERE root_id = 'r-flat-only'`).get();
    const blobBrandNew = remoteSqlite.prepare(`SELECT payload_json, complete FROM child_comment_blobs WHERE root_id = 'r-brand-new'`).get();
    const parsed1 = JSON.parse(blobLegacy1.payload_json);
    assert.deepEqual(parsed1.children.map(c => c.id), ["old-b"]);
    assert.equal(parsed1.children[0].isDeleted, true, "外部库旧 blob 子评论被删后必须标为已删除归档");
    assert.equal(blobLegacy1.complete, 1);
    const parsed2 = JSON.parse(blobLegacy2.payload_json);
    assert.deepEqual(parsed2.children.map(c => c.id), ["c-flat-legacy"]);
    assert.equal(parsed2.children[0].isDeleted, true, "外部库扁平子评论行必须迁移归档并标为已删除");
    assert.equal(blobLegacy2.complete, 1);
    assert.equal(blobBrandNew, undefined, "全新 0 回复根仍应跳过写入");

    // 2b) offload 全量清零：保留主 R2 无索引旧根与远端 blob，comment_count 归 0 且 archived_comment_count 保留
    await runWithDb(d1_2, () =>
      commentsModule.replaceCommentsByRoot({ contentPk: CONTENT_PK, partial: false, allRootIds: [], roots: [] }, { DB: d1_2, BUCKET: offloadBucket })
    );
    assert.equal(offloadR2.has("childcomments/r-legacy-main.json"), true);
    assert.equal(s2.prepare(`SELECT comment_count FROM contents WHERE pk = ?`).get(CONTENT_PK).comment_count, 0);
    assert.ok(s2.prepare(`SELECT archived_comment_count FROM contents WHERE pk = ?`).get(CONTENT_PK).archived_comment_count >= 1);
  } finally {
    globalThis.fetch = originalFetch;
    auth.invalidateExternalTargetsCache();
    auth.resetRemoteSchemaCache();
  }
});

test("[防删归档] 楼中楼部分删除标记/恢复复活/快路径，以及列表详情与统计接口返回已归档计数", async () => {
  workerModules.auth.invalidateExternalTargetsCache();
  const { sqlite, d1 } = createMemoryDb();
  const { bucket, store } = makeTrackedBucket();

  // 1) 创建内容并写入 1 条根评论 + 2 条子评论
  await runWithDb(d1, () =>
    contentsModule.upsertContent({
      sourceType: "answer",
      sourceId: "1",
      title: "T",
      sourceUrl: "https://www.zhihu.com/question/1/answer/1",
      authorName: "A",
      contentHtml: "<p>hello</p>",
      contentMd: "hello",
      excerpt: "hello",
      voteupCount: 1,
      commentCount: 3,
      favoriteCount: 0,
      visitCount: 0
    }, bucket)
  );

  const rootWith = children => ({
    contentPk: CONTENT_PK,
    partial: false,
    allRootIds: ["r1"],
    roots: [{
      id: "r1",
      author: "Root",
      authorAvatar: "",
      content: "root body",
      img: "",
      time: NOW_ISO,
      location: "",
      likes: 10,
      isAuthor: false,
      isTop: false,
      isFeatured: false,
      childCount: children.length,
      isChildrenComplete: true,
      children
    }]
  });

  await runWithDb(d1, () =>
    commentsModule.replaceCommentsByRoot(
      rootWith([childComment("ch1", "first"), childComment("ch2", "second")]),
      { DB: d1, BUCKET: bucket }
    )
  );

  // 2) 原站删除 ch1，仅剩 ch2（complete=true）-> ch1 标记 isDeleted=true，preview 优先存活评论，二次同步命中快路径
  await runWithDb(d1, () =>
    commentsModule.replaceCommentsByRoot(
      rootWith([childComment("ch2", "second")]),
      { DB: d1, BUCKET: bucket }
    )
  );
  const afterPartialDel = JSON.parse(store.get("childcomments/r1.json"));
  const ch1Del = afterPartialDel.children.find(c => c.id === "ch1");
  const ch2Live = afterPartialDel.children.find(c => c.id === "ch2");
  assert.equal(ch1Del?.isDeleted, true);
  assert.ok(!ch2Live?.isDeleted);

  const secondSame = await quietly(() => runWithDb(d1, () =>
    commentsModule.replaceCommentsByRoot(
      rootWith([childComment("ch2", "second")]),
      { DB: d1, BUCKET: bucket }
    )
  ));
  assert.equal(secondSame.r2Puts, 0, "带 isDeleted 归档集合重复同输入必须命中快路径");
  assert.equal(secondSame.threadUpserts, 0);

  // 3) 若 ch1 后续恢复可见 -> 清除 isDeleted 标记
  await runWithDb(d1, () =>
    commentsModule.replaceCommentsByRoot(
      rootWith([childComment("ch1", "first"), childComment("ch2", "second")]),
      { DB: d1, BUCKET: bucket }
    )
  );
  const afterRevive = JSON.parse(store.get("childcomments/r1.json"));
  assert.ok(!afterRevive.children.find(c => c.id === "ch1")?.isDeleted);

  // 4) 原站全量清空 -> upsertContent(commentCount: 0) 保留 archived_comment_count，爬虫读回 prevCommentCount=0，列表/详情/统计接口仍返回已归档总数
  const upAfterZero = await runWithDb(d1, () =>
    contentsModule.upsertContent({
      sourceType: "answer",
      sourceId: "1",
      title: "T",
      sourceUrl: "https://www.zhihu.com/question/1/answer/1",
      authorName: "A",
      contentHtml: "<p>hello</p>",
      contentMd: "hello",
      excerpt: "hello",
      voteupCount: 1,
      commentCount: 0,
      favoriteCount: 0,
      visitCount: 0
    }, bucket)
  );
  assert.equal(upAfterZero.prevCommentCount, 3);
  await runWithDb(d1, () =>
    commentsModule.replaceCommentsByRoot(
      { contentPk: CONTENT_PK, partial: false, allRootIds: [], roots: [] },
      { DB: d1, BUCKET: bucket }
    )
  );

  const dbRow = sqlite.prepare(`SELECT comment_count, archived_comment_count FROM contents WHERE pk = ?`).get(CONTENT_PK);
  assert.equal(dbRow.comment_count, 0);
  assert.equal(dbRow.archived_comment_count, 3);

  const listRes = await runWithDb(d1, () => contentsModule.listContents({ page: 1 }));
  assert.equal(listRes.rows[0].comment_count, 3);
  assert.equal(listRes.rows[0].archived_comment_count, 3);

  const detailRes = await runWithDb(d1, () => contentsModule.getContentDetail(CONTENT_PK));
  assert.equal(detailRes.content.live_comment_count, 0);
  assert.equal(detailRes.content.archived_comment_count, 3);
  assert.equal(detailRes.content.comment_count, 3);

  const statsRes = await runWithDb(d1, () =>
    statsRouteModule.statsRoutes.__call("GET", "/", { url: "http://127.0.0.1/api/stats?fresh=1" })
  );
  assert.equal(statsRes.body.total_comments, 1, "total_comments 应计入已软删归档的根评论");

  const nextSync = await runWithDb(d1, () =>
    contentsModule.upsertContent({
      sourceType: "answer",
      sourceId: "1",
      title: "T",
      sourceUrl: "https://www.zhihu.com/question/1/answer/1",
      authorName: "A",
      contentHtml: "<p>hello</p>",
      contentMd: "hello",
      excerpt: "hello",
      voteupCount: 1,
      commentCount: 0,
      favoriteCount: 0,
      visitCount: 0
    }, bucket)
  );
  assert.equal(nextSync.prevCommentCount, 0, "live comment_count 保持 0，下轮增量同步才不会误以为站内仍有 3 条");
});

test("[M11] GET /zhihu-status 在 D1 故障且无 env 写口令兜底时返回 503", async () => {
  const { d1 } = createMemoryDb();
  const brokenD1 = {
    prepare(sql) {
      if (/app_settings/i.test(sql)) {
        return {
          bind: () => ({
            first: async () => { throw new Error("D1 unavailable"); },
            get: async () => { throw new Error("D1 unavailable"); },
            all: async () => { throw new Error("D1 unavailable"); },
            run: async () => { throw new Error("D1 unavailable"); }
          }),
          first: async () => { throw new Error("D1 unavailable"); },
          get: async () => { throw new Error("D1 unavailable"); },
          all: async () => { throw new Error("D1 unavailable"); },
          run: async () => { throw new Error("D1 unavailable"); }
        };
      }
      return d1.prepare(sql);
    },
    batch: stmts => d1.batch(stmts)
  };
  const emptyBucket = { async get() { return null; }, async put() {}, async delete() {} };
  const res = await runWithDb(brokenD1, () =>
    workerModules.auth.authRoutes.__call("GET", "/zhihu-status", {
      url: "https://zhihu-backup.pages.dev/api/auth/zhihu-status"
    }, { DB: brokenD1, BUCKET: emptyBucket })
  );
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { error: "Auth storage unavailable" });
});

test("[PR2-1][PR2-7] offload 0 回复归档：主 R2 报错保留可重试、主 D1 独有旧子评论迁移归档、查询失败不写死空快照，且保留旧 child_count", async () => {
  const auth = workerModules.auth;
  auth.invalidateExternalTargetsCache();
  auth.resetRemoteSchemaCache();

  const remoteSqlite = new Database(":memory:");
  const offloadTarget = {
    id: "ext-pr2-p0",
    name: "Turso PR2 P0",
    provider: "turso",
    enabled: true,
    syncScopes: ["comments"],
    storageRole: "offload",
    overflowThresholdRows: 1500000,
    endpointUrl: "https://ext-pr2-p0.example.com",
    authToken: "tok",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO
  };

  const originalFetch = globalThis.fetch;
  let failRemoteLegacyQuery = false;
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body));
    const results = [];
    for (const req of body.requests) {
      if (req.type === "close") { results.push({ type: "ok", response: { type: "close" } }); continue; }
      const sql = req.stmt.sql;
      if (failRemoteLegacyQuery && /SELECT root_id FROM child_comment_blobs WHERE content_pk = \?/i.test(sql)) {
        throw new Error("remote legacy query failed");
      }
      const args = (req.stmt.args || []).map(a => (!a || a.type === "null") ? null : (a.type === "integer" || a.type === "float") ? Number(a.value) : String(a.value));
      const st = remoteSqlite.prepare(sql);
      if (st.reader) {
        const cols = st.columns().map(c => ({ name: c.name }));
        const rows = st.all(...args).map(r => cols.map(c => tursoCell(r[c.name])));
        results.push({ type: "ok", response: { type: "execute", result: { cols, rows, affected_row_count: 0, last_insert_rowid: null } } });
      } else {
        const info = st.run(...args);
        results.push({ type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: info.changes, last_insert_rowid: null } } });
      }
    }
    return { ok: true, status: 200, json: async () => ({ results }), text: async () => "" };
  };

  const makeZeroRoot = id => ({
    id,
    author: "Root",
    authorAvatar: "",
    content: "root",
    img: "",
    time: NOW_ISO,
    location: "",
    likes: 1,
    isAuthor: false,
    isTop: false,
    isFeatured: false,
    childCount: 0,
    isChildrenComplete: true,
    children: []
  });

  try {
    await auth.ensureRemoteCommentSchema(offloadTarget);

    // 1) 主库路径 [PR2-7]：0 回复根无 comment_threads 但 comments.child_count = 4 → archivedCount 必须保留 4
    {
      const { sqlite: sMain, d1: d1Main } = createMemoryDb();
      seedContent(sMain);
      sMain.prepare(`
        INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, child_count, first_seen_at, last_seen_at, is_deleted)
        VALUES ('r-main-cnt', ?, NULL, 'U', 'root', 1, 'h', 4, ?, ?, 0)
      `).run(CONTENT_PK, NOW_ISO, NOW_ISO);
      const mainR2 = new Map();
      const mainBucket = {
        async get(k) { const v = mainR2.get(k); return v === undefined ? null : { async text() { return v; } }; },
        async put(k, v) { mainR2.set(k, String(v)); },
        async delete() {}
      };
      await runWithDb(d1Main, () =>
        commentsModule.replaceCommentsByRoot({
          contentPk: CONTENT_PK,
          partial: false,
          allRootIds: ["r-main-cnt"],
          roots: [makeZeroRoot("r-main-cnt")]
        }, { DB: d1Main, BUCKET: mainBucket })
      );
      const th = sMain.prepare(`SELECT child_count, is_complete FROM comment_threads WHERE root_id = 'r-main-cnt'`).get();
      assert.equal(th.child_count, 4, "主路径 0 回复归档必须保留根表旧 child_count");
      assert.equal(th.is_complete, 1);
    }

    // 2) offload 场景：准备主 D1 与主 R2 各类迁移前状态（清除前面主库用例留下的空目标缓存）
    auth.invalidateExternalTargetsCache();
    const { sqlite, d1 } = createMemoryDb();
    seedContent(sqlite);
    // 2a) 主 R2 存在旧回复，但首轮主 R2 读取抛错（r-r2-err）
    sqlite.prepare(`
      INSERT INTO comment_threads (root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at)
      VALUES ('r-r2-err', ?, 'childcomments/r-r2-err.json', 3, 0, 'th-old', 'in-old', '[]', ?)
    `).run(CONTENT_PK, NOW_ISO);
    // 2b) 主 D1 独有旧扁平子评论（主 R2 missing），且主根有历史 child_count = 5（r-d1-only）
    sqlite.prepare(`
      INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, child_count, first_seen_at, last_seen_at, is_deleted)
      VALUES ('r-d1-only', ?, NULL, 'U', 'root d1', 1, 'h1', 5, ?, ?, 0)
    `).run(CONTENT_PK, NOW_ISO, NOW_ISO);
    sqlite.prepare(`
      INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, first_seen_at, last_seen_at, is_deleted)
      VALUES ('c-main-flat-1', ?, 'r-d1-only', 'Child', 'from main d1 only', 2, 'hc1', ?, ?, 0)
    `).run(CONTENT_PK, NOW_ISO, NOW_ISO);
    // 2c) 主 comment_threads 有 child_count = 6 但 R2/D1 无子行（r-main-th-cnt）
    sqlite.prepare(`
      INSERT INTO comment_threads (root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at)
      VALUES ('r-main-th-cnt', ?, 'childcomments/r-main-th-cnt.json', 6, 0, 'th6', 'in6', '[]', ?)
    `).run(CONTENT_PK, NOW_ISO);

    const r2Store = new Map([
      [auth.R2_EXTERNAL_TARGETS_KEY, JSON.stringify([offloadTarget])],
      ["childcomments/r-r2-err.json", JSON.stringify({ children: [{ id: "rescued-r2-1", author: "A", content: "old r2 reply", likes: 9 }], complete: true })]
    ]);
    let failR2Key = "childcomments/r-r2-err.json";
    const bucket = {
      async get(k) {
        if (failR2Key && k === failR2Key) throw new Error("R2 transient read error");
        const v = r2Store.get(k);
        return v === undefined ? null : { async text() { return v; } };
      },
      async put(k, v) { r2Store.set(k, String(v)); },
      async delete() {}
    };

    // 预置远端 existingThread（使 r-r2-err 在报错时可观测到被置为可重试 is_complete=0, incoming_hash=""）
    remoteSqlite.prepare(`
      INSERT INTO comment_threads (root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at)
      VALUES ('r-r2-err', ?, 'childcomments/r-r2-err.json', 3, 0, 'th-rem', 'stale-in', '[]', ?)
    `).run(CONTENT_PK, NOW_ISO);
    // 2c-bis) 外部库根表已有 child_count=7，但尚无 comment_threads 行且无主库历史（r-remote-cnt）
    remoteSqlite.prepare(`
      INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, child_count, first_seen_at, last_seen_at, is_deleted)
      VALUES ('r-remote-cnt', ?, NULL, 'U', 'remote root', 1, 'h-rc', 7, ?, ?, 0)
    `).run(CONTENT_PK, NOW_ISO, NOW_ISO);

    // 2d) 先模拟远端 legacy 查询失败：不得写死 complete=1 空快照
    failRemoteLegacyQuery = true;
    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        allRootIds: ["r-r2-err", "r-d1-only", "r-main-th-cnt"],
        roots: [makeZeroRoot("r-r2-err"), makeZeroRoot("r-d1-only"), makeZeroRoot("r-main-th-cnt")]
      }, { DB: d1, BUCKET: bucket })
    );
    assert.equal(
      remoteSqlite.prepare(`SELECT payload_json FROM child_comment_blobs WHERE root_id = 'r-d1-only'`).get(),
      undefined,
      "远端 legacy 查询失败时绝不能写死 complete=1 空快照"
    );
    const r2ErrThAfterQueryFail = remoteSqlite.prepare(`SELECT is_complete, incoming_hash FROM comment_threads WHERE root_id = 'r-r2-err'`).get();
    assert.equal(r2ErrThAfterQueryFail.is_complete, 0);
    assert.equal(r2ErrThAfterQueryFail.incoming_hash, "");
    failRemoteLegacyQuery = false;

    // 2e) 模拟主 D1 legacy 查询失败：同样不得写死 complete=1 空快照
    const failMainLegacyD1 = {
      prepare(sql) {
        if (/SELECT root_id, child_count FROM comment_threads/i.test(sql)) {
          return {
            bind: () => ({ all: async () => { throw new Error("main D1 read outage"); } }),
            all: async () => { throw new Error("main D1 read outage"); }
          };
        }
        return d1.prepare(sql);
      },
      batch: stmts => d1.batch(stmts)
    };
    await runWithDb(failMainLegacyD1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        allRootIds: ["r-d1-only"],
        roots: [makeZeroRoot("r-d1-only")]
      }, { DB: failMainLegacyD1, BUCKET: bucket })
    );
    assert.equal(
      remoteSqlite.prepare(`SELECT payload_json FROM child_comment_blobs WHERE root_id = 'r-d1-only'`).get(),
      undefined,
      "主 D1 legacy 查询失败时绝不能写死 complete=1 空快照"
    );
    // 但必须留下待重试索引行（is_complete=0, thread_hash="", incoming_hash=""），否则爬虫不会再补抓
    const d1OnlyRetryAfterMainQueryFail = remoteSqlite.prepare(
      `SELECT child_count, is_complete, thread_hash, incoming_hash FROM comment_threads WHERE root_id = 'r-d1-only'`
    ).get();
    assert.equal(d1OnlyRetryAfterMainQueryFail?.is_complete, 0);
    assert.equal(d1OnlyRetryAfterMainQueryFail?.thread_hash, "");
    assert.equal(d1OnlyRetryAfterMainQueryFail?.incoming_hash, "");
    assert.equal(d1OnlyRetryAfterMainQueryFail?.child_count, 5, "待重试行必须保留主 D1 根表历史 child_count");

    // 2f) 正常 D1 + 主 R2 r-r2-err 仍报错：r-r2-err 保持可重试、r-d1-only 捞出主 D1 独有扁平子评论、r-main-th-cnt 保留 child_count=6、r-remote-cnt 保留 child_count=7
    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        allRootIds: ["r-r2-err", "r-d1-only", "r-main-th-cnt", "r-remote-cnt"],
        roots: [makeZeroRoot("r-r2-err"), makeZeroRoot("r-d1-only"), makeZeroRoot("r-main-th-cnt"), makeZeroRoot("r-remote-cnt")]
      }, { DB: d1, BUCKET: bucket })
    );
    assert.equal(
      remoteSqlite.prepare(`SELECT payload_json FROM child_comment_blobs WHERE root_id = 'r-r2-err'`).get(),
      undefined,
      "主 R2 读取报错时绝不能往外部库落 complete=1 空快照"
    );
    const thErr = remoteSqlite.prepare(`SELECT is_complete, incoming_hash FROM comment_threads WHERE root_id = 'r-r2-err'`).get();
    assert.equal(thErr.is_complete, 0);
    assert.equal(thErr.incoming_hash, "");

    const blobD1Only = remoteSqlite.prepare(`SELECT payload_json, complete FROM child_comment_blobs WHERE root_id = 'r-d1-only'`).get();
    const parsedD1Only = JSON.parse(blobD1Only.payload_json);
    assert.deepEqual(parsedD1Only.children.map(c => c.id), ["c-main-flat-1"]);
    assert.equal(parsedD1Only.children[0].isDeleted, true);
    assert.equal(blobD1Only.complete, 1);
    const thD1Only = remoteSqlite.prepare(`SELECT child_count FROM comment_threads WHERE root_id = 'r-d1-only'`).get();
    assert.equal(thD1Only.child_count, 5, "offload 0 回复归档必须保留主 D1 根表旧 child_count");

    const thMainCnt = remoteSqlite.prepare(`SELECT child_count FROM comment_threads WHERE root_id = 'r-main-th-cnt'`).get();
    assert.equal(thMainCnt.child_count, 6, "offload 0 回复归档必须保留 mainLegacyThreadChildCountByRoot");

    const thRemoteCnt = remoteSqlite.prepare(`SELECT child_count, is_complete FROM comment_threads WHERE root_id = 'r-remote-cnt'`).get();
    assert.equal(thRemoteCnt?.child_count, 7, "外部库无 comment_threads 且无主库历史时仍必须保留 existingRootChildCount");
    assert.equal(thRemoteCnt?.is_complete, 1);

    // 2g) 主 R2 恢复后重跑同步：r-r2-err 成功抢救出旧 R2 回复并标 isDeleted=true 落盘外部库
    failR2Key = null;
    await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot({
        contentPk: CONTENT_PK,
        partial: false,
        allRootIds: ["r-r2-err", "r-d1-only", "r-main-th-cnt"],
        roots: [makeZeroRoot("r-r2-err"), makeZeroRoot("r-d1-only"), makeZeroRoot("r-main-th-cnt")]
      }, { DB: d1, BUCKET: bucket })
    );
    const blobRecovered = remoteSqlite.prepare(`SELECT payload_json, complete FROM child_comment_blobs WHERE root_id = 'r-r2-err'`).get();
    const parsedRecovered = JSON.parse(blobRecovered.payload_json);
    assert.deepEqual(parsedRecovered.children.map(c => c.id), ["rescued-r2-1"]);
    assert.equal(parsedRecovered.children[0].isDeleted, true);
    assert.equal(blobRecovered.complete, 1);
    const childrenAfterRecover = await runWithDb(d1, () =>
      commentsModule.getChildComments(bucket, "r-r2-err", d1)
    );
    assert.deepEqual(childrenAfterRecover.map(c => c.id), ["rescued-r2-1"]);
    assert.equal(childrenAfterRecover[0].isDeleted, true);
  } finally {
    globalThis.fetch = originalFetch;
    auth.invalidateExternalTargetsCache();
    auth.resetRemoteSchemaCache();
  }
});

test("[PR2-2][PR2-8] listRootComments 与 /root-comments 的 live_only=1 过滤（含 offload），且 D1 预览优先展示存活回复", async () => {
  const auth = workerModules.auth;
  auth.invalidateExternalTargetsCache();
  auth.resetRemoteSchemaCache();

  const sharedIndexUrl = await moduleUrlFor(sharedIndexPath);
  const contentsRoute = await loadTs(
    path.join(workerSrc, "routes", "contents.ts"),
    new Map([["hono", honoMockUrl], ["shared", sharedIndexUrl]])
  );

  // 1) 主 D1：50 条高赞已删归档根 + 3 条低赞存活根，外加 D1 扁平子评论（前 2 条已删、第 3 条存活）
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  for (let i = 0; i < 50; i++) {
    sqlite.prepare(`
      INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, first_seen_at, last_seen_at, is_deleted)
      VALUES (?, ?, NULL, 'Del', 'deleted root', ?, ?, ?, ?, 1)
    `).run(`del-${i}`, CONTENT_PK, 1000 + i, `hd-${i}`, NOW_ISO, NOW_ISO);
  }
  for (let i = 0; i < 3; i++) {
    sqlite.prepare(`
      INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, child_count, first_seen_at, last_seen_at, is_deleted)
      VALUES (?, ?, NULL, 'Live', 'live root', ?, ?, ?, ?, ?, 0)
    `).run(`live-${i}`, CONTENT_PK, 10 + i, `hl-${i}`, i === 0 ? 3 : 0, NOW_ISO, NOW_ISO);
  }
  // live-0 下无 comment_threads：最早 2 条子评论已删，第 3 条存活 → 预览必须优先展示存活回复
  sqlite.prepare(`
    INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, first_seen_at, last_seen_at, is_deleted)
    VALUES
      ('ch-del-1', ?, 'live-0', 'C1', 'deleted reply 1', 1, 'hc1', '2024-01-01T00:00:01.000Z', ?, 1),
      ('ch-del-2', ?, 'live-0', 'C2', 'deleted reply 2', 1, 'hc2', '2024-01-01T00:00:02.000Z', ?, 1),
      ('ch-live-3', ?, 'live-0', 'C3', 'surviving reply 3', 1, 'hc3', '2024-01-01T00:00:03.000Z', ?, 0)
  `).run(CONTENT_PK, NOW_ISO, CONTENT_PK, NOW_ISO, CONTENT_PK, NOW_ISO);

  // 前端不传 live_only：仍看到高赞已删归档根
  const frontendRes = await runWithDb(d1, () =>
    contentsRoute.contentRoutes.__call("GET", "/:pk/root-comments", {
      params: { pk: CONTENT_PK },
      url: `http://127.0.0.1/api/contents/${encodeURIComponent(CONTENT_PK)}/root-comments?limit=50`
    }, { DB: d1 })
  );
  assert.equal(frontendRes.status, 200);
  assert.equal(frontendRes.body.data.length, 50);
  assert.ok(frontendRes.body.data.every(r => r.is_deleted === 1));

  // 爬虫传 live_only=1：直接跳过 50 条已删归档，返回全部 3 条存活根
  const crawlerRes = await runWithDb(d1, () =>
    contentsRoute.contentRoutes.__call("GET", "/:pk/root-comments", {
      params: { pk: CONTENT_PK },
      url: `http://127.0.0.1/api/contents/${encodeURIComponent(CONTENT_PK)}/root-comments?limit=50&live_only=1`
    }, { DB: d1 })
  );
  assert.equal(crawlerRes.status, 200);
  assert.deepEqual(crawlerRes.body.data.map(r => r.id), ["live-2", "live-1", "live-0"]);
  const live0 = crawlerRes.body.data.find(r => r.id === "live-0");
  assert.equal(live0.preview_replies[0].id, "ch-live-3", "D1 兜底预览必须优先展示存活回复");

  // 1b) 主库 live_only=1 返回现网 child_count，而前端不传 live_only 仍保留已删归档水位
  {
    const { sqlite: sMainCnt, d1: d1MainCnt } = createMemoryDb();
    seedContent(sMainCnt);
    const mainR2 = new Map();
    const mainBucket = {
      async get(k) { const v = mainR2.get(k); return v === undefined ? null : { async text() { return v; } }; },
      async put(k, v) { mainR2.set(k, String(v)); },
      async delete() {}
    };
    const archived100 = Array.from({ length: 100 }, (_, i) => childComment(`arch-${i}`, `archived ${i}`));
    const liveOne = childComment("live-only-1", "live reply");
    const buildPayload = (children, childCount = children.length) => ({
      contentPk: CONTENT_PK,
      partial: false,
      allRootIds: ["r-arch-cnt"],
      roots: [{
        id: "r-arch-cnt",
        author: "Root",
        authorAvatar: "",
        content: "root",
        img: "",
        time: NOW_ISO,
        location: "",
        likes: 10,
        isAuthor: false,
        isTop: false,
        isFeatured: false,
        childCount,
        isChildrenComplete: true,
        children
      }]
    });
    await runWithDb(d1MainCnt, () =>
      commentsModule.replaceCommentsByRoot(buildPayload([...archived100, liveOne]), { DB: d1MainCnt, BUCKET: mainBucket })
    );
    await runWithDb(d1MainCnt, () =>
      commentsModule.replaceCommentsByRoot(buildPayload([liveOne]), { DB: d1MainCnt, BUCKET: mainBucket })
    );
    const mainFrontend = await runWithDb(d1MainCnt, () =>
      commentsModule.listRootComments(d1MainCnt, CONTENT_PK, { limit: 10, offset: 0 }, mainBucket)
    );
    const mainCrawler = await runWithDb(d1MainCnt, () =>
      commentsModule.listRootComments(d1MainCnt, CONTENT_PK, { limit: 10, offset: 0, liveOnly: true }, mainBucket)
    );
    assert.equal(mainFrontend[0].child_count, 101, "主库前端展示 child_count 必须保持 101");
    assert.equal(mainCrawler[0].child_count, 1, "主库爬虫 live_only=1 必须返回现网 child_count=1");

    // 现网最后 1 条回复也被删光 → comments.child_count 如实归 0，comment_threads 保留 101
    await runWithDb(d1MainCnt, () =>
      commentsModule.replaceCommentsByRoot(buildPayload([], 0), { DB: d1MainCnt, BUCKET: mainBucket })
    );
    const mainFrontendZero = await runWithDb(d1MainCnt, () =>
      commentsModule.listRootComments(d1MainCnt, CONTENT_PK, { limit: 10, offset: 0 }, mainBucket)
    );
    const mainCrawlerZero = await runWithDb(d1MainCnt, () =>
      commentsModule.listRootComments(d1MainCnt, CONTENT_PK, { limit: 10, offset: 0, liveOnly: true }, mainBucket)
    );
    assert.equal(mainFrontendZero[0].child_count, 101);
    assert.equal(mainCrawlerZero[0].child_count, 0);
  }

  // 2) offload 混合/远端路径：live_only=1 同样过滤已删根评论
  auth.invalidateExternalTargetsCache();
  const remoteSqlite = new Database(":memory:");
  const offloadTarget = {
    id: "ext-live-only",
    name: "Turso LiveOnly",
    provider: "turso",
    enabled: true,
    syncScopes: ["comments"],
    storageRole: "offload",
    overflowThresholdRows: 1500000,
    endpointUrl: "https://ext-live-only.example.com",
    authToken: "tok",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO
  };
  const offloadBucket = {
    async get(k) {
      if (k === auth.R2_EXTERNAL_TARGETS_KEY) {
        return { async text() { return JSON.stringify([offloadTarget]); } };
      }
      return null;
    },
    async put() {},
    async delete() {}
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body));
    const results = [];
    for (const req of body.requests) {
      if (req.type === "close") { results.push({ type: "ok", response: { type: "close" } }); continue; }
      const args = (req.stmt.args || []).map(a => (!a || a.type === "null") ? null : (a.type === "integer" || a.type === "float") ? Number(a.value) : String(a.value));
      const st = remoteSqlite.prepare(req.stmt.sql);
      if (st.reader) {
        const cols = st.columns().map(c => ({ name: c.name }));
        const rows = st.all(...args).map(r => cols.map(c => tursoCell(r[c.name])));
        results.push({ type: "ok", response: { type: "execute", result: { cols, rows, affected_row_count: 0, last_insert_rowid: null } } });
      } else {
        const info = st.run(...args);
        results.push({ type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: info.changes, last_insert_rowid: null } } });
      }
    }
    return { ok: true, status: 200, json: async () => ({ results }), text: async () => "" };
  };
  try {
    await auth.ensureRemoteCommentSchema(offloadTarget);
    const { sqlite: sOff, d1: d1Off } = createMemoryDb();
    seedContent(sOff);
    // 主 D1 放 1 条已删 + 1 条存活（验证 offset=1 混合过渡态 mainIds 也只计存活根）
    sOff.prepare(`
      INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, first_seen_at, last_seen_at, is_deleted)
      VALUES
        ('m-del', ?, NULL, 'U', 'md', 999, 'hmd', ?, ?, 1),
        ('m-live', ?, NULL, 'U', 'ml', 50, 'hml', ?, ?, 0)
    `).run(CONTENT_PK, NOW_ISO, NOW_ISO, CONTENT_PK, NOW_ISO, NOW_ISO);
    remoteSqlite.prepare(`
      INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, first_seen_at, last_seen_at, is_deleted)
      VALUES
        ('r-del', ?, NULL, 'U', 'rd', 888, 'hrd', ?, ?, 1),
        ('r-live', ?, NULL, 'U', 'rl', 20, 'hrl', ?, ?, 0)
    `).run(CONTENT_PK, NOW_ISO, NOW_ISO, CONTENT_PK, NOW_ISO, NOW_ISO);

    const offLive = await runWithDb(d1Off, () =>
      commentsModule.listRootComments(d1Off, CONTENT_PK, { limit: 10, offset: 0, liveOnly: true }, offloadBucket)
    );
    assert.deepEqual(offLive.map(r => r.id), ["m-live", "r-live"]);

    const offPage2 = await runWithDb(d1Off, () =>
      commentsModule.listRootComments(d1Off, CONTENT_PK, { limit: 10, offset: 1, liveOnly: true }, offloadBucket)
    );
    assert.deepEqual(offPage2.map(r => r.id), ["r-live"], "offset=1 混合过渡态按 live_only=1 精准切到 r-live");

    // 2b) offload 路径 live_only=1 返回现网 child_count（t.child_count=101, c.child_count=1）
    const remoteRootSql = `
      INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, child_count, first_seen_at, last_seen_at, is_deleted)
      VALUES ('r-off-arch', ?, NULL, 'U', 'off root', 9999, 'h-oa', 1, ?, ?, 0)
    `;
    remoteSqlite.prepare(remoteRootSql).run(CONTENT_PK, NOW_ISO, NOW_ISO);
    remoteSqlite.prepare(`
      INSERT INTO comment_threads (root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at)
      VALUES ('r-off-arch', ?, 'childcomments/r-off-arch.json', 101, 1, 'th-oa', 'in-oa', '[]', ?)
    `).run(CONTENT_PK, NOW_ISO);
    const { d1: d1OffOnly } = createMemoryDb();
    const offFrontend = await runWithDb(d1OffOnly, () =>
      commentsModule.listRootComments(d1OffOnly, CONTENT_PK, { limit: 10, offset: 0 }, offloadBucket)
    );
    const offCrawler = await runWithDb(d1OffOnly, () =>
      commentsModule.listRootComments(d1OffOnly, CONTENT_PK, { limit: 10, offset: 0, liveOnly: true }, offloadBucket)
    );
    const frontRow = offFrontend.find(r => r.id === "r-off-arch");
    const crawlRow = offCrawler.find(r => r.id === "r-off-arch");
    assert.equal(frontRow?.child_count, 101, "offload 前端不传 live_only 必须展示 101");
    assert.equal(crawlRow?.child_count, 1, "offload 爬虫 live_only=1 必须返回现网 child_count=1");
  } finally {
    globalThis.fetch = originalFetch;
    auth.invalidateExternalTargetsCache();
    auth.resetRemoteSchemaCache();
  }
});

test("[PR2-3] recommend 与 following 使用 live_comment_count 触发零评风控预警，同时保留归档展示计数", async () => {
  const auth = workerModules.auth;
  auth.invalidateExternalTargetsCache();
  const { sqlite, d1 } = createMemoryDb();

  const recommendModule = await loadTs(path.join(workerSrc, "services", "recommend.ts"));
  const followingModule = await loadTs(path.join(workerSrc, "services", "following.ts"));

  // 种子：高赞 (1500)、现网 comment_count = 0、归档 archived_comment_count = 200 的答主内容
  sqlite.prepare(`
    INSERT INTO contents (
      pk, source_type, source_id, title, question_id, question_title, source_url,
      author_name, author_url_token, excerpt, content_hash,
      voteup_count, comment_count, archived_comment_count, favorite_count, visit_count,
      is_deleted, is_collapsed, is_labeled, first_seen_at, last_seen_at
    ) VALUES (
      'answer:risk-zero', 'answer', 'risk-zero', '高赞被清评回答', 'q1', '高赞被清评问题', 'https://www.zhihu.com/question/q1/answer/risk-zero',
      '答主A', 'author-a', '普通文本不含敏感词', 'hash-rz',
      1500, 0, 200, 10, 1000,
      0, 0, 0, ?, ?
    ), (
      'answer:sim-peer', 'answer', 'sim-peer', '同答主另一篇', 'q1', '高赞被清评问题', 'https://www.zhihu.com/question/q1/answer/sim-peer',
      '答主A', 'author-a', '相似内容', 'hash-sp',
      2000, 0, 80, 10, 1000,
      0, 0, 0, ?, ?
    )
  `).run(NOW_ISO, NOW_ISO, NOW_ISO, NOW_ISO);

  const r2Map = new Map([
    ["meta/followed_users.json", JSON.stringify({
      "author-a": {
        url_token: "author-a",
        name: "答主A",
        answer_count: 10,
        articles_count: 0,
        sync_mode: "default"
      }
    })]
  ]);
  const bucket = {
    async get(k) { const v = r2Map.get(k); return v === undefined ? null : { async text() { return v; } }; },
    async put(k, v) { r2Map.set(k, String(v)); },
    async delete() {}
  };

  // 1) recommend.getRecommendFeed（内部调 buildScoredPool）
  const recFeed = await runWithDb(d1, () =>
    recommendModule.getRecommendFeed({ DB: d1, BUCKET: bucket, ZHIHU_USERNAME: "me" }, { channel: "risk", limit: 20, seed: 1 })
  );
  const recItem = recFeed.data.find(x => x.pk === "answer:risk-zero");
  assert.ok(recItem);
  assert.equal(recItem.comment_count, 200, "前端展示 comment_count 必须保留归档水位 200");
  assert.equal(recItem.live_comment_count, 0);
  assert.ok(recItem.risk_tags.some(t => t.includes("千赞零评")), `recommend 必须命中千赞零评预警，实际=${JSON.stringify(recItem.risk_tags)}`);

  // 2) recommend.getSimilarContents
  const simRes = await runWithDb(d1, () => recommendModule.getSimilarContents("answer:sim-peer"));
  const simItem = simRes.data.find(x => x.pk === "answer:risk-zero");
  assert.ok(simItem);
  assert.equal(simItem.comment_count, 200);
  assert.ok(simItem.risk_tags.some(t => t.includes("千赞零评")));

  // 3) recommend.assessContentWithWorkersAI prompt 体现现网 0 评论 / 归档 200 评论，且缓存键按 v2 + wiped 区分
  let aiCallCount = 0;
  let capturedPrompt = "";
  r2Map.set(
    "meta/ai-risk/answer_risk-zero.hash-rz.json",
    JSON.stringify({ model: "old", analysis: "stale pre-v2 cache" })
  );
  const mockAiEnv = {
    DB: d1,
    BUCKET: bucket,
    AI: {
      run: async (_model, opts) => {
        aiCallCount++;
        capturedPrompt = String(opts?.messages?.[1]?.content || "");
        return { response: `run-${aiCallCount}: ${capturedPrompt.slice(0, 20)}` };
      }
    }
  };
  const aiRes = await runWithDb(d1, () => recommendModule.assessContentWithWorkersAI(mockAiEnv, "answer:risk-zero"));
  assert.equal(aiRes.ok, true);
  assert.equal(aiCallCount, 1, "旧版无 .v2 缓存不得命中，必须重新鉴定");
  assert.ok(aiRes.risk_tags.some(t => t.includes("千赞零评")));
  assert.match(capturedPrompt, /现网 0 评论 \/ 归档 200 评论/);
  assert.equal(
    r2Map.has("meta/ai-risk/answer_risk-zero.hash-rz.v2.wiped.json"),
    true,
    "清评态必须写入带 .v2.wiped.json 后缀的缓存键"
  );

  // 未清评（live=200, archived=200）时使用 .v2.json，不与清评态共用缓存
  sqlite.prepare(`UPDATE contents SET comment_count = 200 WHERE pk = 'answer:risk-zero'`).run();
  const aiResLive = await runWithDb(d1, () => recommendModule.assessContentWithWorkersAI(mockAiEnv, "answer:risk-zero"));
  assert.equal(aiResLive.ok, true);
  assert.equal(aiCallCount, 2, "清评状态变化后即使 content_hash 不变也必须重新鉴定");
  assert.equal(r2Map.has("meta/ai-risk/answer_risk-zero.hash-rz.v2.json"), true);

  // 切回清评态命中之前的 .v2.wiped.json 缓存（不再消耗 AI 调用）
  sqlite.prepare(`UPDATE contents SET comment_count = 0 WHERE pk = 'answer:risk-zero'`).run();
  const aiResCachedWiped = await runWithDb(d1, () => recommendModule.assessContentWithWorkersAI(mockAiEnv, "answer:risk-zero"));
  assert.equal(aiResCachedWiped.cached, true);
  assert.equal(aiCallCount, 2);

  // 4) following.getFollowedUserContents & listFollowingFeed
  const userContents = await runWithDb(d1, () =>
    followingModule.getFollowedUserContents(bucket, "author-a", { onlyRisk: true })
  );
  const userItem = userContents.data.find(x => x.pk === "answer:risk-zero");
  assert.ok(userItem);
  assert.equal(userItem.comment_count, 200);
  assert.ok(userItem.risk_tags.some(t => t.includes("千赞零评")));

  const followFeed = await runWithDb(d1, () =>
    followingModule.listFollowingFeed(bucket, { onlyRisk: true })
  );
  const feedItem = followFeed.data.find(x => x.pk === "answer:risk-zero");
  assert.ok(feedItem);
  assert.equal(feedItem.comment_count, 200);
  assert.ok(feedItem.risk_tags.some(t => t.includes("千赞零评")));
});

test("[PR2-4] contents.ts upsertContent 更新 archived_comment_count 并发交错写入不回滚", async () => {
  const { sqlite, d1 } = createMemoryDb();
  const bucket = { async get() { return null; }, async put() {}, async delete() {} };

  const baseInput = {
    sourceType: "answer",
    sourceId: "race-1",
    title: "T",
    sourceUrl: "https://www.zhihu.com/question/1/answer/race-1",
    authorName: "A",
    contentHtml: "<p>v1</p>",
    contentMd: "v1",
    excerpt: "v1",
    voteupCount: 10,
    commentCount: 5,
    favoriteCount: 1,
    visitCount: 20
  };
  await runWithDb(d1, () => contentsModule.upsertContent(baseInput, bucket));

  // 模拟在 upsertContent SELECT 读到 archived_comment_count=5 之后、UPDATE 执行之前，
  // 并发的 replaceCommentsByRoot 把库里 archived_comment_count 抬高到了 88
  let bumpedDuringRace = false;
  const raceD1 = {
    prepare(sql) {
      if (!bumpedDuringRace && /^\s*UPDATE contents\b/i.test(sql)) {
        bumpedDuringRace = true;
        sqlite.prepare(`UPDATE contents SET archived_comment_count = 88 WHERE pk = 'answer:race-1'`).run();
      }
      return d1.prepare(sql);
    },
    batch(stmts) {
      if (!bumpedDuringRace && stmts.some(s => /^\s*UPDATE contents\b/i.test(s.sql))) {
        bumpedDuringRace = true;
        sqlite.prepare(`UPDATE contents SET archived_comment_count = 88 WHERE pk = 'answer:race-1'`).run();
      }
      return d1.batch(stmts);
    }
  };

  // 1) counterChanges 分支并发交错：archived_comment_count 必须保持 88 不回滚
  await runWithDb(raceD1, () =>
    contentsModule.upsertContent({ ...baseInput, voteupCount: 11, commentCount: 0 }, bucket)
  );
  assert.equal(bumpedDuringRace, true);
  assert.equal(
    sqlite.prepare(`SELECT archived_comment_count FROM contents WHERE pk = 'answer:race-1'`).get().archived_comment_count,
    88,
    "counterChanges 分支不得把并发抬高的 archived_comment_count 回滚成 5"
  );

  // 2) bodyChanges 分支并发交错：同样抬高到 120 后，archived_comment_count 必须保持 120
  bumpedDuringRace = false;
  sqlite.prepare(`UPDATE contents SET archived_comment_count = 88 WHERE pk = 'answer:race-1'`).run();
  const raceBodyD1 = {
    prepare(sql) {
      return d1.prepare(sql);
    },
    batch(stmts) {
      if (!bumpedDuringRace && stmts.some(s => /^\s*UPDATE contents\b/i.test(s.sql))) {
        bumpedDuringRace = true;
        sqlite.prepare(`UPDATE contents SET archived_comment_count = 120 WHERE pk = 'answer:race-1'`).run();
      }
      return d1.batch(stmts);
    }
  };
  await runWithDb(raceBodyD1, () =>
    contentsModule.upsertContent({ ...baseInput, contentHtml: "<p>v2</p>", contentMd: "v2", commentCount: 0 }, bucket)
  );
  assert.equal(bumpedDuringRace, true);
  assert.equal(
    sqlite.prepare(`SELECT archived_comment_count FROM contents WHERE pk = 'answer:race-1'`).get().archived_comment_count,
    120,
    "bodyChanges 分支不得把并发抬高的 archived_comment_count 回滚成 88"
  );
});

test("[PR2-10] auth.ts 外部存储 /test 慢探测期间并发编辑/新增/删除不会覆盖或复活，且拒绝旧时间戳覆盖", async () => {
  const auth = workerModules.auth;
  auth.invalidateExternalTargetsCache();
  const { sqlite, d1 } = createMemoryDb();
  const r2Store = new Map();
  const bucket = {
    async get(k) { const v = r2Store.get(k); return v === undefined ? null : { async text() { return v; } }; },
    async put(k, v) { r2Store.set(k, String(v)); }
  };
  const env = { API_SECRET: "unit-secret", BUCKET: bucket };
  const authHeaders = { authorization: "Bearer unit-secret" };
  const call = (method, p, init) => runWithDb(d1, () => auth.authRoutes.__call(method, p, init, env));

  // 创建目标 A
  const createA = await call("POST", "/external-targets", {
    headers: authHeaders,
    body: { name: "Target A", provider: "turso", endpointUrl: "https://a.turso.io", authToken: "tokA", syncScopes: ["comments"] }
  });
  const idA = createA.body.target.id;

  const originalFetch = globalThis.fetch;
  let releaseProbe;
  let probeStartedResolve;
  const probeStarted = new Promise(r => { probeStartedResolve = r; });

  try {
    globalThis.fetch = async () => {
      probeStartedResolve();
      await new Promise(r => { releaseProbe = r; });
      return { ok: true, status: 200, json: async () => ({ results: [{ type: "ok" }] }), text: async () => "" };
    };

    // 1) 发起针对 A 的慢探测，在探测等待期间并发重命名 A 并新增 B
    const testPromise = call("POST", "/external-targets/test", {
      headers: authHeaders,
      body: { id: idA }
    });
    await probeStarted;

    await call("POST", "/external-targets", {
      headers: authHeaders,
      body: { id: idA, name: "Target A Renamed", provider: "turso", endpointUrl: "https://a.turso.io", syncScopes: ["comments"] }
    });
    await call("POST", "/external-targets", {
      headers: authHeaders,
      body: { name: "Target B", provider: "turso", endpointUrl: "https://b.turso.io", authToken: "tokB", syncScopes: ["contents"] }
    });

    releaseProbe();
    const testRes = await testPromise;
    assert.equal(testRes.status, 200);
    assert.equal(testRes.body.ok, true);

    auth.invalidateExternalTargetsCache();
    const afterConcurrentEdit = await runWithDb(d1, () => auth.getExternalTargetsRaw(bucket));
    assert.equal(afterConcurrentEdit.length, 2, "新增的目标 B 不得被探测写回覆盖丢失");
    const targetA = afterConcurrentEdit.find(t => t.id === idA);
    assert.equal(targetA.name, "Target A Renamed", "并发重命名不得被探测前的旧快照覆盖");
    assert.equal(targetA.endpointUrl, "https://a.turso.io");
    assert.equal(targetA.lastTestOk, true, "并发只改非连接字段时必须正常写回本次探测结果");

    // 1b) 探测期间并发修改该目标的 endpointUrl / authToken：探测结果不得贴到新连接配置上
    const createE = await call("POST", "/external-targets", {
      headers: authHeaders,
      body: { name: "Target E", provider: "turso", endpointUrl: "https://e.turso.io", authToken: "tokE", syncScopes: ["comments"] }
    });
    const idE = createE.body.target.id;
    let probeStartedEResolve;
    const probeStartedE = new Promise(r => { probeStartedEResolve = r; });
    globalThis.fetch = async () => {
      probeStartedEResolve();
      await new Promise(r => { releaseProbe = r; });
      return { ok: true, status: 200, json: async () => ({ results: [{ type: "ok" }] }), text: async () => "" };
    };
    const testChangedPromise = call("POST", "/external-targets/test", {
      headers: authHeaders,
      body: { id: idE }
    });
    await probeStartedE;
    const editE = await call("POST", "/external-targets", {
      headers: authHeaders,
      body: { id: idE, name: "Target E Renamed", provider: "turso", endpointUrl: "https://e-changed.turso.io", authToken: "tokE2", syncScopes: ["comments"] }
    });
    assert.equal(editE.status, 200);
    releaseProbe();
    const testChangedRes = await testChangedPromise;
    assert.equal(testChangedRes.status, 200);
    assert.equal(testChangedRes.body.ok, true, "探测本身仍要正常返回结果");
    assert.equal(testChangedRes.body.target, undefined, "连接配置已被并发修改时必须跳过写回");

    auth.invalidateExternalTargetsCache();
    const afterConnEdit = await runWithDb(d1, () => auth.getExternalTargetsRaw(bucket));
    const targetE = afterConnEdit.find(t => t.id === idE);
    assert.equal(targetE.endpointUrl, "https://e-changed.turso.io", "并发编辑后的新连接配置必须保留");
    assert.equal(targetE.authToken, "tokE2");
    assert.equal(targetE.lastTestAt, null, "旧配置的探测结果不得污染新配置 lastTestAt");
    assert.equal(targetE.lastTestOk, null, "旧配置的探测结果不得污染新配置 lastTestOk");
    assert.equal(targetE.lastTestMsg, null, "旧配置的探测结果不得污染新配置 lastTestMsg");

    // 1c) 前端编辑表单携带未保存的草稿配置点「先测试连接」：返回草稿探测结果，但不覆写已保存目标的 lastTest*
    auth.invalidateExternalTargetsCache();
    const beforeDraftTest = (await runWithDb(d1, () => auth.getExternalTargetsRaw(bucket))).find(t => t.id === idA);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ results: [{ type: "ok" }] }), text: async () => "" });
    const draftTestRes = await call("POST", "/external-targets/test", {
      headers: authHeaders,
      body: { id: idA, endpointUrl: "https://a-draft.turso.io", authToken: "tokDraft" }
    });
    assert.equal(draftTestRes.status, 200);
    assert.equal(draftTestRes.body.ok, true);
    assert.equal(draftTestRes.body.target, undefined, "草稿配置的探测结果不得写回已保存目标");
    auth.invalidateExternalTargetsCache();
    const afterDraftTest = (await runWithDb(d1, () => auth.getExternalTargetsRaw(bucket))).find(t => t.id === idA);
    assert.equal(afterDraftTest.endpointUrl, "https://a.turso.io", "草稿配置不得被 /test 落库");
    assert.equal(afterDraftTest.authToken, "tokA", "草稿 token 不得被 /test 落库");
    assert.equal(afterDraftTest.lastTestAt, beforeDraftTest.lastTestAt, "草稿探测不得覆写已保存目标的 lastTestAt");
    assert.equal(afterDraftTest.lastTestOk, beforeDraftTest.lastTestOk, "草稿探测不得覆写已保存目标的 lastTestOk");
    assert.equal(afterDraftTest.lastTestMsg, beforeDraftTest.lastTestMsg, "草稿探测不得覆写已保存目标的 lastTestMsg");

    // 清理临时目标 E，保持后续并发删除/新增用例的原始目标数量假设
    const deleteE = await call("POST", "/external-targets/delete", {
      headers: authHeaders,
      body: { id: idE }
    });
    assert.equal(deleteE.status, 200);

    // 2) 探测期间并发删除目标 A：探测结束后跳过写回，绝不复活 A
    let probeStarted2Resolve;
    const probeStarted2 = new Promise(r => { probeStarted2Resolve = r; });
    globalThis.fetch = async () => {
      probeStarted2Resolve();
      await new Promise(r => { releaseProbe = r; });
      return { ok: true, status: 200, json: async () => ({ results: [{ type: "ok" }] }), text: async () => "" };
    };
    const testDeletePromise = call("POST", "/external-targets/test", {
      headers: authHeaders,
      body: { id: idA }
    });
    await probeStarted2;
    await call("POST", "/external-targets/delete", {
      headers: authHeaders,
      body: { id: idA }
    });
    releaseProbe();
    const testAfterDelRes = await testDeletePromise;
    assert.equal(testAfterDelRes.status, 200);
    assert.equal(testAfterDelRes.body.target, undefined);

    auth.invalidateExternalTargetsCache();
    const afterConcurrentDelete = await runWithDb(d1, () => auth.getExternalTargetsRaw(bucket));
    assert.equal(afterConcurrentDelete.some(t => t.id === idA), false, "探测期间已删除的目标 A 绝不可复活");
    assert.equal(afterConcurrentDelete.length, 1);

    // 3) saveExternalTargetsRaw 显式 CAS：过期 expectedUpdatedAt 与较旧时间戳必抛 ExternalTargetsConflictError，不覆盖 R2 且失效缓存
    await assert.rejects(
      () => runWithDb(d1, () => auth.saveExternalTargetsRaw(bucket, [], { expectedUpdatedAt: "2020-01-01T00:00:00.000Z" })),
      err => err instanceof auth.ExternalTargetsConflictError && err.code === "CONFLICT"
    );
    await assert.rejects(
      () => runWithDb(d1, () => auth.saveExternalTargetsRaw(bucket, [], { expectedUpdatedAt: null })),
      err => err instanceof auth.ExternalTargetsConflictError && err.code === "CONFLICT"
    );

    const beforeConflictR2 = r2Store.get(auth.R2_EXTERNAL_TARGETS_KEY);
    sqlite.prepare(`UPDATE app_settings SET updated_at = '2099-01-01T00:00:00.000Z' WHERE key = ?`).run(auth.EXTERNAL_TARGETS_KEY);
    await assert.rejects(
      () => runWithDb(d1, () => auth.saveExternalTargetsRaw(bucket, [])),
      err => err instanceof auth.ExternalTargetsConflictError
    );
    assert.equal(r2Store.get(auth.R2_EXTERNAL_TARGETS_KEY), beforeConflictR2, "CAS 冲突时绝不可覆盖 R2");
    const stillKept = await runWithDb(d1, () => auth.getExternalTargetsRaw(bucket));
    assert.equal(stillKept.length, 1, "CAS 冲突失效缓存后仍应读出原有目标");

    // 4) 跨 isolate 并发 CAS：单次瞬时冲突自动重试成功；持续冲突耗尽重试返回 HTTP 409（绝不假报 ok:true）
    let injectConflicts = 1;
    const casRaceD1 = {
      prepare(sql) {
        const stmt = d1.prepare(sql);
        if (/UPDATE app_settings\s+SET value = \?, updated_at = \?\s+WHERE key = \? AND updated_at = \?/i.test(sql)) {
          return {
            bind(...params) {
              const bound = stmt.bind(...params);
              return {
                first: () => bound.first(),
                all: () => bound.all(),
                execute: () => bound.execute(),
                run: async () => {
                  if (injectConflicts > 0) {
                    injectConflicts--;
                    // 模拟另一 isolate 抢先更新了 updated_at，导致本次 CAS changes=0
                    sqlite.prepare(`UPDATE app_settings SET updated_at = '2099-02-01T00:00:00.000Z' WHERE key = ?`).run(auth.EXTERNAL_TARGETS_KEY);
                    return { success: true, meta: { changes: 0 } };
                  }
                  return bound.run();
                }
              };
            }
          };
        }
        return stmt;
      },
      batch: stmts => d1.batch(stmts)
    };
    const retryOkRes = await runWithDb(casRaceD1, () =>
      auth.authRoutes.__call("POST", "/external-targets", {
        headers: authHeaders,
        body: { name: "Target C", provider: "turso", endpointUrl: "https://c.turso.io", authToken: "tokC", syncScopes: ["contents"] }
      }, env)
    );
    assert.equal(retryOkRes.status, 200, "单次跨 isolate CAS 冲突必须自动重读重试并成功");
    assert.equal(retryOkRes.body.targets.length, 2);
    const idC = retryOkRes.body.target.id;

    // 持续冲突（超过 2 次重试）必须返回 409
    injectConflicts = 10;
    const conflict409Save = await runWithDb(casRaceD1, () =>
      auth.authRoutes.__call("POST", "/external-targets", {
        headers: authHeaders,
        body: { name: "Target D", provider: "turso", endpointUrl: "https://d.turso.io", syncScopes: ["contents"] }
      }, env)
    );
    assert.equal(conflict409Save.status, 409);
    assert.equal(conflict409Save.body.conflict, true);

    injectConflicts = 10;
    const conflict409Del = await runWithDb(casRaceD1, () =>
      auth.authRoutes.__call("POST", "/external-targets/delete", {
        headers: authHeaders,
        body: { id: idC }
      }, env)
    );
    assert.equal(conflict409Del.status, 409);
    assert.equal(conflict409Del.body.conflict, true);

    injectConflicts = 10;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ results: [{ type: "ok" }] }), text: async () => "" });
    const conflict409Test = await runWithDb(casRaceD1, () =>
      auth.authRoutes.__call("POST", "/external-targets/test", {
        headers: authHeaders,
        body: { id: idC }
      }, env)
    );
    assert.equal(conflict409Test.status, 409);
    assert.equal(conflict409Test.body.conflict, true);
  } finally {
    globalThis.fetch = originalFetch;
    auth.invalidateExternalTargetsCache();
  }
});

test("[PR2-P2-1] /external-targets 编辑已并发删除的目标返回 409，不误新建也不触发无意义 CAS 重试", async () => {
  const auth = workerModules.auth;
  auth.invalidateExternalTargetsCache();
  const { d1 } = createMemoryDb();
  const store = new Map();
  let metaGets = 0;
  const bucket = {
    async get(k) {
      if (k === auth.R2_EXTERNAL_TARGETS_KEY) metaGets++;
      const v = store.get(k);
      return v === undefined ? null : { async text() { return v; } };
    },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); }
  };
  const env = { API_SECRET: "unit-secret", BUCKET: bucket };
  const authHeaders = { authorization: "Bearer unit-secret" };
  const call = (method, p, init) => runWithDb(d1, () => auth.authRoutes.__call(method, p, init, env));

  const created = await call("POST", "/external-targets", {
    headers: authHeaders,
    body: { name: "并发删除目标", provider: "turso", endpointUrl: "https://deleted.turso.io", syncScopes: ["comments"] }
  });
  assert.equal(created.status, 200);
  const id = created.body.target.id;

  const deleted = await call("POST", "/external-targets/delete", {
    headers: authHeaders,
    body: { id }
  });
  assert.equal(deleted.status, 200);

  auth.invalidateExternalTargetsCache();
  metaGets = 0;
  // 模拟并发删除后前端仍拿旧 id 提交未保存的编辑：必须 409，绝不能静默新建一条复活配置
  const staleEdit = await call("POST", "/external-targets", {
    headers: authHeaders,
    body: {
      id,
      name: "复活尝试",
      provider: "turso",
      endpointUrl: "https://resurrect.turso.io",
      syncScopes: ["comments"]
    }
  });
  assert.equal(staleEdit.status, 409);
  assert.equal(staleEdit.body.conflict, true);
  assert.match(staleEdit.body.error, /不存在|已被删除/);
  assert.equal(metaGets, 1, "直接 return 409 不得 throw 冲突并空跑 2 次 CAS 重试");

  auth.invalidateExternalTargetsCache();
  const after = await runWithDb(d1, () => auth.getExternalTargetsRaw(bucket));
  assert.deepEqual(after, [], "并发删除后旧 id 编辑绝不可新建/复活目标");
  assert.equal(store.get(auth.R2_EXTERNAL_TARGETS_KEY), "[]", "R2 镜像必须保持已删除状态");

  // 正常新建（不带 id）仍然可用，且不会误判为过期编辑
  const fresh = await call("POST", "/external-targets", {
    headers: authHeaders,
    body: { name: "正常新建", provider: "turso", endpointUrl: "https://fresh.turso.io", syncScopes: ["comments"] }
  });
  assert.equal(fresh.status, 200);
  auth.invalidateExternalTargetsCache();
});

test("[PR2-P2-2] D1 故障降级写 R2 使用原生 onlyIf CAS，读不到 R2 版本时拒绝盲写", async () => {
  const auth = workerModules.auth;
  auth.invalidateExternalTargetsCache();
  const { d1 } = createMemoryDb();
  const env = { API_SECRET: "unit-secret" };
  const authHeaders = { authorization: "Bearer unit-secret" };
  const concurrentTarget = {
    id: "ext-concurrent",
    name: "Concurrent Writer",
    provider: "turso",
    enabled: true,
    syncScopes: ["comments"],
    storageRole: "offload",
    overflowThresholdRows: 1500000,
    endpointUrl: "https://concurrent.turso.io",
    authToken: "tokC",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO
  };
  const makeTargetBody = name => ({
    name,
    provider: "turso",
    endpointUrl: `https://${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.turso.io`,
    authToken: "tok",
    syncScopes: ["comments"]
  });

  const failingD1 = {
    prepare() {
      const fail = async () => { throw new Error("D1 outage"); };
      return {
        bind() { return { first: fail, all: fail, run: fail }; },
        first: fail,
        all: fail,
        run: fail
      };
    },
    batch: async () => { throw new Error("D1 outage"); }
  };

  const createEtagBucket = () => {
    const objects = new Map();
    const puts = [];
    let seq = 0;
    let beforePut = null;
    const seed = (key, body) => {
      const etag = `etag-${++seq}`;
      objects.set(key, { body: String(body), etag, customMetadata: {} });
      return etag;
    };
    const bucket = {
      objects,
      puts,
      seed,
      setBeforePut(fn) { beforePut = fn; },
      async get(key) {
        const entry = objects.get(key);
        if (!entry) return null;
        return {
          etag: entry.etag,
          httpEtag: `"${entry.etag}"`,
          customMetadata: entry.customMetadata,
          async text() { return entry.body; }
        };
      },
      async put(key, body, opts = {}) {
        puts.push({ key, opts, body: String(body) });
        if (beforePut) await beforePut({ bucket, key, body, opts, count: puts.length });
        const current = objects.get(key) ?? null;
        const onlyIf = opts.onlyIf;
        if (onlyIf) {
          if ("etagMatches" in onlyIf && (!current || current.etag !== onlyIf.etagMatches)) return null;
          if ("etagDoesNotMatch" in onlyIf && current) return null;
        }
        const etag = `etag-${++seq}`;
        objects.set(key, { body: String(body), etag, customMetadata: opts.customMetadata || {} });
        return { etag, httpEtag: `"${etag}"` };
      },
      async delete(key) { objects.delete(key); }
    };
    return bucket;
  };

  // 1) R2 对象尚不存在（expectedR2Etag=null）：onlyIf etagDoesNotMatch "*" 允许首次创建
  {
    auth.invalidateExternalTargetsCache();
    const bucket = createEtagBucket();
    const res = await runWithDb(failingD1, () =>
      auth.authRoutes.__call("POST", "/external-targets", {
        headers: authHeaders,
        body: makeTargetBody("Null Etag")
      }, { ...env, BUCKET: bucket })
    );
    assert.equal(res.status, 200);
    assert.deepEqual(bucket.puts[0]?.opts?.onlyIf, { etagDoesNotMatch: "*" });
    assert.equal(JSON.parse(bucket.objects.get(auth.R2_EXTERNAL_TARGETS_KEY).body).length, 1);
  }

  // 2) D1 失败 + R2 onlyIf 匹配（expectedR2Etag=当前 etag）：降级写成功
  {
    auth.invalidateExternalTargetsCache();
    const bucket = createEtagBucket();
    const seededEtag = bucket.seed(auth.R2_EXTERNAL_TARGETS_KEY, "[]");
    const res = await runWithDb(failingD1, () =>
      auth.authRoutes.__call("POST", "/external-targets", {
        headers: authHeaders,
        body: makeTargetBody("Cas Match")
      }, { ...env, BUCKET: bucket })
    );
    assert.equal(res.status, 200, "D1 故障时 R2 版本校验通过必须降级写成功");
    assert.deepEqual(bucket.puts[0]?.opts?.onlyIf, { etagMatches: seededEtag });
    const stored = JSON.parse(bucket.objects.get(auth.R2_EXTERNAL_TARGETS_KEY).body);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].name, "Cas Match");
  }

  // 3) 首轮 onlyIf 返回 null（并发 R2 写入）→ 自动重读重试成功，且不覆盖并发写入
  {
    auth.invalidateExternalTargetsCache();
    const bucket = createEtagBucket();
    bucket.seed(auth.R2_EXTERNAL_TARGETS_KEY, "[]");
    let injected = 0;
    bucket.setBeforePut(({ bucket, key, count }) => {
      if (count === 1) {
        injected++;
        bucket.seed(key, JSON.stringify([concurrentTarget]));
      }
    });
    const res = await runWithDb(failingD1, () =>
      auth.authRoutes.__call("POST", "/external-targets", {
        headers: authHeaders,
        body: makeTargetBody("Retry After Conflict")
      }, { ...env, BUCKET: bucket })
    );
    assert.equal(res.status, 200, "单次 R2 并发冲突必须自动重读重试并成功");
    assert.equal(injected, 1);
    assert.equal(bucket.puts.length, 2);
    assert.equal(typeof bucket.puts[1].opts.onlyIf.etagMatches, "string");
    assert.notEqual(bucket.puts[0].opts.onlyIf.etagMatches, bucket.puts[1].opts.onlyIf.etagMatches);
    const stored = JSON.parse(bucket.objects.get(auth.R2_EXTERNAL_TARGETS_KEY).body);
    assert.equal(stored.length, 2, "重试必须基于并发写入后的最新配置合并");
    assert.ok(stored.some(t => t.id === "ext-concurrent"), "并发写入的目标不得被覆盖丢失");
    assert.ok(stored.some(t => t.name === "Retry After Conflict"));
  }

  // 4) 持续冲突耗尽重试：HTTP 409，绝不覆盖并发写入
  {
    auth.invalidateExternalTargetsCache();
    const bucket = createEtagBucket();
    bucket.seed(auth.R2_EXTERNAL_TARGETS_KEY, JSON.stringify([concurrentTarget]));
    bucket.setBeforePut(({ bucket, key }) => {
      // 每次 put 前都模拟另一个 isolate 抢先写入，版本始终变化
      bucket.seed(key, JSON.stringify([concurrentTarget]));
    });
    const res = await runWithDb(failingD1, () =>
      auth.authRoutes.__call("POST", "/external-targets", {
        headers: authHeaders,
        body: makeTargetBody("Never Wins")
      }, { ...env, BUCKET: bucket })
    );
    assert.equal(res.status, 409);
    assert.equal(res.body.conflict, true);
    assert.equal(bucket.puts.length, 3, "首轮 + 最多 2 次重试");
    const stored = JSON.parse(bucket.objects.get(auth.R2_EXTERNAL_TARGETS_KEY).body);
    assert.deepEqual(stored.map(t => t.id), ["ext-concurrent"], "持续冲突时绝不可覆盖并发写入");
  }

  // 5) R2 读取失败拿不到版本（expectedR2Etag=undefined）：拒绝盲写并抛错，绝不返回 ok:true
  {
    auth.invalidateExternalTargetsCache();
    const bucket = createEtagBucket();
    bucket.get = async key => {
      if (key === auth.R2_EXTERNAL_TARGETS_KEY) throw new Error("R2 read outage");
      return null;
    };
    await assert.rejects(
      () => runWithDb(failingD1, () =>
        auth.authRoutes.__call("POST", "/external-targets", {
          headers: authHeaders,
          body: makeTargetBody("Blind Write")
        }, { ...env, BUCKET: bucket })
      ),
      /D1 outage/
    );
    assert.equal(bucket.puts.length, 0, "无法校验 R2 版本时拒绝盲写，不得覆盖对象");
  }
});

test("[PR2-P2-4] 0 活回复归档失败留下 needs_thread_retry=1 待重试索引行（主 D1 / offload 双路径），爬虫据此重抓", async () => {
  const auth = workerModules.auth;
  auth.invalidateExternalTargetsCache();
  auth.resetRemoteSchemaCache();
  const makeZeroRoot = id => ({
    id,
    author: "Root",
    authorAvatar: "",
    content: "root",
    img: "",
    time: NOW_ISO,
    location: "",
    likes: 1,
    isAuthor: false,
    isTop: false,
    isFeatured: false,
    childCount: 0,
    isChildrenComplete: true,
    children: []
  });

  // 1) 主 D1：活根原有回复在原站删光，本轮 R2 读取失败 → 不写空快照，但留下待重试索引行
  {
    const { sqlite, d1 } = createMemoryDb();
    seedContent(sqlite);
    sqlite.prepare(`
      INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, child_count, first_seen_at, last_seen_at, is_deleted)
      VALUES ('r-main-live-empty', ?, NULL, 'Root', 'root', 1, 'h-main', 2, ?, ?, 0)
    `).run(CONTENT_PK, NOW_ISO, NOW_ISO);
    sqlite.prepare(`
      INSERT INTO comment_threads (root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at)
      VALUES ('r-main-live-empty', ?, 'childcomments/r-main-live-empty.json', 2, 1, 'th-main', 'in-main', '[]', ?)
    `).run(CONTENT_PK, NOW_ISO);
    const r2Store = new Map([
      ["childcomments/r-main-live-empty.json", JSON.stringify({
        children: [
          { id: "main-old-1", author: "A", content: "old 1", likes: 1 },
          { id: "main-old-2", author: "B", content: "old 2", likes: 2 }
        ],
        complete: true
      })]
    ]);
    let failKey = "childcomments/r-main-live-empty.json";
    const bucket = {
      async get(k) {
        if (failKey && k === failKey) throw new Error("R2 read outage");
        const v = r2Store.get(k);
        return v === undefined ? null : { async text() { return v; } };
      },
      async put(k, v) { r2Store.set(k, String(v)); },
      async delete() {}
    };

    const payload = {
      contentPk: CONTENT_PK,
      partial: false,
      allRootIds: ["r-main-live-empty", "r-main-brand-new"],
      roots: [makeZeroRoot("r-main-live-empty"), makeZeroRoot("r-main-brand-new")]
    };
    await runWithDb(d1, () => commentsModule.replaceCommentsByRoot(payload, { DB: d1, BUCKET: bucket }));

    const thread = sqlite.prepare(
      `SELECT child_count, is_complete, thread_hash, incoming_hash FROM comment_threads WHERE root_id = 'r-main-live-empty'`
    ).get();
    assert.equal(thread.is_complete, 0, "归档失败必须保持可重试 is_complete=0");
    assert.equal(thread.incoming_hash, "");
    assert.equal(thread.thread_hash, "th-main");
    assert.equal(thread.child_count, 2, "失败时 child_count 必须保留既有历史水位");
    const brandNewThread = sqlite.prepare(
      `SELECT root_id FROM comment_threads WHERE root_id = 'r-main-brand-new'`
    ).get();
    assert.equal(brandNewThread, undefined, "全新 0 回复根不得凭空写线程索引行");

    const rows = await runWithDb(d1, () =>
      commentsModule.listRootComments(d1, CONTENT_PK, { limit: 10, offset: 0, liveOnly: true }, bucket)
    );
    const retryRow = rows.find(r => r.id === "r-main-live-empty");
    assert.equal(retryRow.child_count, 0, "live_only=1 必须返回现网 child_count=0");
    assert.equal(retryRow.is_complete, 0);
    assert.equal(retryRow.needs_thread_retry, 1, "归档失败必须暴露 needs_thread_retry=1");
    const brandNewRow = rows.find(r => r.id === "r-main-brand-new");
    assert.equal(brandNewRow.child_count, 0);
    assert.equal(brandNewRow.is_complete, 0);
    assert.equal(brandNewRow.needs_thread_retry, 0, "全新 0 回复根不得误触发重试");

    // 归档恢复成功后：旧回复标 isDeleted 归档，needs_thread_retry 归 0
    failKey = null;
    await runWithDb(d1, () => commentsModule.replaceCommentsByRoot(payload, { DB: d1, BUCKET: bucket }));
    const threadAfter = sqlite.prepare(
      `SELECT child_count, is_complete FROM comment_threads WHERE root_id = 'r-main-live-empty'`
    ).get();
    assert.equal(threadAfter.is_complete, 1);
    assert.equal(threadAfter.child_count, 2);
    const archived = JSON.parse(r2Store.get("childcomments/r-main-live-empty.json"));
    assert.deepEqual(archived.children.map(c => c.id).sort(), ["main-old-1", "main-old-2"]);
    assert.ok(archived.children.every(c => c.isDeleted === true));
    const rowsAfter = await runWithDb(d1, () =>
      commentsModule.listRootComments(d1, CONTENT_PK, { limit: 10, offset: 0, liveOnly: true }, bucket)
    );
    assert.equal(rowsAfter.find(r => r.id === "r-main-live-empty").needs_thread_retry, 0);
  }

  // 2) offload：活根原有回复在原站删光，本轮外部库 blob 读取失败 → 不用空快照覆盖，留下待重试行
  {
    auth.invalidateExternalTargetsCache();
    auth.resetRemoteSchemaCache();
    const remoteSqlite = new Database(":memory:");
    const offloadTarget = {
      id: "ext-pr2-needs-retry",
      name: "Turso Needs Retry",
      provider: "turso",
      enabled: true,
      syncScopes: ["comments"],
      storageRole: "offload",
      overflowThresholdRows: 1500000,
      endpointUrl: "https://ext-pr2-needs-retry.example.com",
      authToken: "tok",
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO
    };
    const originalFetch = globalThis.fetch;
    let failBlobRead = false;
    globalThis.fetch = async (_url, init = {}) => {
      const body = JSON.parse(String(init.body));
      const results = [];
      for (const req of body.requests) {
        if (req.type === "close") { results.push({ type: "ok", response: { type: "close" } }); continue; }
        const sql = req.stmt.sql;
        if (failBlobRead && /SELECT root_id, payload_json FROM child_comment_blobs WHERE root_id IN/i.test(sql)) {
          throw new Error("remote blob read failed");
        }
        const args = (req.stmt.args || []).map(a => (!a || a.type === "null") ? null : (a.type === "integer" || a.type === "float") ? Number(a.value) : String(a.value));
        const st = remoteSqlite.prepare(sql);
        if (st.reader) {
          const cols = st.columns().map(c => ({ name: c.name }));
          const rows = st.all(...args).map(r => cols.map(c => tursoCell(r[c.name])));
          results.push({ type: "ok", response: { type: "execute", result: { cols, rows, affected_row_count: 0, last_insert_rowid: null } } });
        } else {
          const info = st.run(...args);
          results.push({ type: "ok", response: { type: "execute", result: { cols: [], rows: [], affected_row_count: info.changes, last_insert_rowid: null } } });
        }
      }
      return { ok: true, status: 200, json: async () => ({ results }), text: async () => "" };
    };
    const offloadBucket = {
      async get(k) {
        if (k === auth.R2_EXTERNAL_TARGETS_KEY) {
          return { async text() { return JSON.stringify([offloadTarget]); } };
        }
        return null;
      },
      async put() {},
      async delete() {}
    };
    const { sqlite: mainSqlite, d1: mainD1 } = createMemoryDb();
    seedContent(mainSqlite);

    try {
      await auth.ensureRemoteCommentSchema(offloadTarget);
      remoteSqlite.prepare(`
        INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, child_count, first_seen_at, last_seen_at, is_deleted)
        VALUES ('r-off-live-empty', ?, NULL, 'Root', 'off root', 1, 'h-off', 2, ?, ?, 0)
      `).run(CONTENT_PK, NOW_ISO, NOW_ISO);
      remoteSqlite.prepare(`
        INSERT INTO comment_threads (root_id, content_pk, r2_key, child_count, is_complete, thread_hash, incoming_hash, preview_json, synced_at)
        VALUES ('r-off-live-empty', ?, 'childcomments/r-off-live-empty.json', 2, 1, 'th-off', 'in-off', '[]', ?)
      `).run(CONTENT_PK, NOW_ISO);
      remoteSqlite.prepare(`
        INSERT INTO child_comment_blobs (root_id, content_pk, payload_json, complete, updated_at)
        VALUES ('r-off-live-empty', ?, ?, 1, ?)
      `).run(CONTENT_PK, JSON.stringify({
        children: [
          { id: "off-old-1", author: "A", content: "old off 1", likes: 1 },
          { id: "off-old-2", author: "B", content: "old off 2", likes: 2 }
        ],
        complete: true
      }), NOW_ISO);
      remoteSqlite.prepare(`
        INSERT INTO comments (id, content_pk, parent_comment_id, author_name, content_md, likes, comment_hash, child_count, first_seen_at, last_seen_at, is_deleted)
        VALUES ('r-off-brand-new', ?, NULL, 'Root', 'brand new', 1, 'h-new', 0, ?, ?, 0)
      `).run(CONTENT_PK, NOW_ISO, NOW_ISO);

      const payload = {
        contentPk: CONTENT_PK,
        partial: false,
        allRootIds: ["r-off-live-empty", "r-off-brand-new"],
        roots: [makeZeroRoot("r-off-live-empty"), makeZeroRoot("r-off-brand-new")]
      };

      failBlobRead = true;
      await runWithDb(mainD1, () => commentsModule.replaceCommentsByRoot(payload, { DB: mainD1, BUCKET: offloadBucket }));

      const blobBefore = remoteSqlite.prepare(
        `SELECT payload_json FROM child_comment_blobs WHERE root_id = 'r-off-live-empty'`
      ).get();
      const parsedBefore = JSON.parse(blobBefore.payload_json);
      assert.deepEqual(parsedBefore.children.map(c => c.id).sort(), ["off-old-1", "off-old-2"], "失败时绝不能用空快照覆盖既有楼中楼");
      assert.ok(parsedBefore.children.every(c => c.isDeleted !== true));
      const thread = remoteSqlite.prepare(
        `SELECT child_count, is_complete, thread_hash, incoming_hash FROM comment_threads WHERE root_id = 'r-off-live-empty'`
      ).get();
      assert.equal(thread.is_complete, 0);
      assert.equal(thread.incoming_hash, "");
      assert.equal(thread.thread_hash, "th-off");
      assert.equal(thread.child_count, 2, "失败时 child_count 必须保留既有历史水位");
      assert.equal(
        remoteSqlite.prepare(`SELECT root_id FROM comment_threads WHERE root_id = 'r-off-brand-new'`).get(),
        undefined,
        "全新 0 回复根不得凭空写线程索引行"
      );

      const rows = await runWithDb(mainD1, () =>
        commentsModule.listRootComments(mainD1, CONTENT_PK, { limit: 10, offset: 0, liveOnly: true }, offloadBucket)
      );
      const retryRow = rows.find(r => r.id === "r-off-live-empty");
      assert.equal(retryRow.child_count, 0);
      assert.equal(retryRow.is_complete, 0);
      assert.equal(retryRow.needs_thread_retry, 1, "offload 归档失败必须暴露 needs_thread_retry=1");
      const brandNewRow = rows.find(r => r.id === "r-off-brand-new");
      assert.equal(brandNewRow.needs_thread_retry, 0, "offload 全新 0 回复根不得误触发重试");

      failBlobRead = false;
      await runWithDb(mainD1, () => commentsModule.replaceCommentsByRoot(payload, { DB: mainD1, BUCKET: offloadBucket }));
      const blobAfter = remoteSqlite.prepare(
        `SELECT payload_json, complete FROM child_comment_blobs WHERE root_id = 'r-off-live-empty'`
      ).get();
      const parsedAfter = JSON.parse(blobAfter.payload_json);
      assert.deepEqual(parsedAfter.children.map(c => c.id).sort(), ["off-old-1", "off-old-2"]);
      assert.ok(parsedAfter.children.every(c => c.isDeleted === true));
      assert.equal(blobAfter.complete, 1);
      const threadAfter = remoteSqlite.prepare(
        `SELECT child_count, is_complete FROM comment_threads WHERE root_id = 'r-off-live-empty'`
      ).get();
      assert.equal(threadAfter.is_complete, 1);
      assert.equal(threadAfter.child_count, 2);
      const rowsAfter = await runWithDb(mainD1, () =>
        commentsModule.listRootComments(mainD1, CONTENT_PK, { limit: 10, offset: 0, liveOnly: true }, offloadBucket)
      );
      assert.equal(rowsAfter.find(r => r.id === "r-off-live-empty").needs_thread_retry, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // 3) 爬虫消费 needs_thread_retry：即使 comment_count 未变化且 child_count=0 也要重抓；归档成功后不再重复
  {
    const crawlerSrc = readFileSync(crawlerMainPath, "utf8").replace(/\r\n/g, "\n");
    const crawlerJs = ts.transpileModule(crawlerSrc, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
    }).outputText;
    const extractTopLevelFunction = (src, name) => {
      const start = src.indexOf(`function ${name}(`);
      assert.ok(start >= 0, `源码中缺少函数 ${name}`);
      const end = src.indexOf("\n}\n", start);
      assert.ok(end >= 0, `函数 ${name} 缺少顶层结束括号`);
      return src.slice(start, end + 3);
    };
    const fnBlock = [
      extractTopLevelFunction(crawlerJs, "shouldSyncComments"),
      extractTopLevelFunction(crawlerJs, "isStoredRootCommentRow"),
      "async " + extractTopLevelFunction(crawlerJs, "fetchStoredCommentState"),
      "async " + extractTopLevelFunction(crawlerJs, "shouldSyncCommentsDeep")
    ].join("\n");
    let returnedRows = [];
    const ctx = vm.createContext({
      apiUrl: "https://worker.example",
      apiSecret: "sec",
      commentSyncIncomplete: new Set(),
      fetch: async () => ({ ok: true, json: async () => ({ data: returnedRows }) })
    });
    vm.runInContext(
      `${fnBlock}\nglobalThis.__state = fetchStoredCommentState;\nglobalThis.__deep = shouldSyncCommentsDeep;`,
      ctx
    );

    // 归档失败：needs_thread_retry=1，child_count=0 且 comment_count 未变化也必须重抓
    returnedRows = [{ child_count: 0, is_complete: 0, needs_thread_retry: 1, thread_synced_at: NOW_ISO }];
    const retryState = await ctx.__state("answer:needs-retry");
    assert.equal(retryState.incompleteRoots, 1);
    assert.equal(await ctx.__deep("answer:needs-retry", 1, 1, "full"), true);

    // 归档成功：needs_thread_retry=0，不再重复抓取
    returnedRows = [{ child_count: 0, is_complete: 1, needs_thread_retry: 0, thread_synced_at: NOW_ISO }];
    const doneState = await ctx.__state("answer:needs-retry-done");
    assert.equal(doneState.incompleteRoots, 0);
    assert.equal(await ctx.__deep("answer:needs-retry-done", 1, 1, "full"), false);

    // 全新 0 回复根（无 comment_threads 行）与闭评冻结 is_complete=2 均不误触发
    returnedRows = [{ child_count: 0, is_complete: 0, needs_thread_retry: 0, thread_synced_at: null }];
    assert.equal((await ctx.__state("answer:brand-new-zero")).incompleteRoots, 0);
    returnedRows = [{ child_count: 0, is_complete: 2, needs_thread_retry: 0, thread_synced_at: NOW_ISO }];
    assert.equal((await ctx.__state("answer:closed-zero")).incompleteRoots, 0);

    // 兼容旧接口：无 needs_thread_retry 字段但已有线程同步时间且 is_complete=0 时仍触发重抓
    returnedRows = [{ child_count: 0, is_complete: 0, thread_synced_at: NOW_ISO }];
    assert.equal((await ctx.__state("answer:legacy-retry")).incompleteRoots, 1);
  }
});

test("[PR2-11][PR2-12.1] image-tasks 按并发分组及时落库；/ingest/image-batch 小数 limit=0.5 归一为 1", async () => {
  const ingest = await loadTs(
    path.join(workerSrc, "routes", "ingest.ts"),
    new Map([["hono", honoMockUrl]])
  );
  const originalFetch = globalThis.fetch;

  try {
    // 1) 8 条任务分 2 组（每组 4 条）：第 1 组 db.batch 立刻落库为 done，第 2 组 db.batch 抛错时第 1 组不受回滚影响
    const { sqlite: s1, d1: d1_1 } = createMemoryDb();
    seedContent(s1);
    for (let i = 0; i < 8; i++) {
      seedImageTask(s1, {
        imageUrl: `https://picx.zhimg.com/chunk-${i}.jpg`,
        objectKey: `images/${String(i).padStart(64, "d")}.jpg`,
        status: "pending",
        attempts: 0,
        updatedAt: NOW_ISO
      });
    }
    let doneBatchCalls = 0;
    const chunkFailD1 = {
      prepare: sql => d1_1.prepare(sql),
      batch: async stmts => {
        if (stmts.some(st => /UPDATE image_tasks SET status = 'done'/i.test(st.sql))) {
          doneBatchCalls++;
          if (doneBatchCalls === 2) {
            throw new Error("chunk 2 batch write failed");
          }
        }
        return d1_1.batch(stmts);
      }
    };
    const okBucket = { async head() { return null; }, async get() { return null; }, async put() {}, async delete() {} };
    globalThis.fetch = async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg", "content-length": "3" }
      });

    await assert.rejects(
      () => runWithDb(chunkFailD1, () => imageTasksModule.processImageBatch(okBucket, 8)),
      /chunk 2 batch write failed/
    );
    assert.equal(doneBatchCalls, 2);
    assert.equal(
      s1.prepare(`SELECT COUNT(*) AS n FROM image_tasks WHERE status = 'done'`).get().n,
      4,
      "第 1 并发分组的 4 条任务必须在第 2 组失败前已及时持久化为 done"
    );

    // 2) POST /ingest/image-batch 传入小数 limit: 0.5 → 实际执行 1 条且返回 limit: 1
    const { sqlite: s2, d1: d1_2 } = createMemoryDb();
    seedContent(s2);
    for (let i = 0; i < 3; i++) {
      seedImageTask(s2, {
        imageUrl: `https://picx.zhimg.com/frac-${i}.jpg`,
        objectKey: `images/${String(i).padStart(64, "e")}.jpg`,
        status: "pending",
        attempts: 0,
        updatedAt: NOW_ISO
      });
    }
    const fracRes = await runWithDb(d1_2, () =>
      ingest.ingestRoutes.__call("POST", "/image-batch", {
        headers: { authorization: "Bearer img-secret" },
        body: { limit: 0.5 }
      }, { DB: d1_2, BUCKET: okBucket, API_SECRET: "img-secret" })
    );
    assert.equal(fracRes.status, 200);
    assert.equal(fracRes.body.limit, 1, "limit: 0.5 必须统一钳制返回 limit: 1");
    assert.equal(fracRes.body.claimed, 1, "limit: 0.5 必须实际领取并处理 1 条");
    assert.equal(fracRes.body.done, 1);
  } finally {
    globalThis.fetch = originalFetch;
    workerModules.auth.invalidateExternalTargetsCache();
  }
});
