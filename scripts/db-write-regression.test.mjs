import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
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

// 按顺序加载 migrations 目录全部 0000~0005（node:fs 同步只读，绝不访问 .wrangler）
const migrationsDir = path.join(repoRoot, "apps", "worker", "migrations");
const migrationSql = readdirSync(migrationsDir)
  .filter(name => /^000[0-5]_.*\.sql$/.test(name))
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
const handlers = new Map();
class Hono {
  use() { return this }
  get(path, handler) { handlers.set("GET " + path, handler); return this }
  post(path, handler) { handlers.set("POST " + path, handler); return this }
  route() { return this }
  async __call(method, path, { body, headers } = {}, env = {}) {
    const handler = handlers.get(method + " " + path);
    if (!handler) throw new Error("no handler for " + method + " " + path);
    let status = 200;
    let payload;
    const lower = {};
    for (const [k, v] of Object.entries(headers || {})) lower[String(k).toLowerCase()] = v;
    const c = {
      env,
      req: {
        url: "http://127.0.0.1/api/auth" + path,
        header: name => lower[String(name).toLowerCase()],
        json: async () => body
      },
      json: (obj, code = 200) => { status = code; payload = obj; return { status, body: obj }; }
    };
    await handler(c);
    return { status, body: payload };
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
  const collections = await loadTs(path.join(workerSrc, "services", "collections.ts"));
  const sharedIndexUrl = await moduleUrlFor(sharedIndexPath);
  const contents = await loadTs(
    path.join(workerSrc, "services", "contents.ts"),
    new Map([["shared", sharedIndexUrl]])
  );
  const schemas = await loadTs(sharedSchemasPath);
  return { db, hash, changes, comments, imageTasks, auth, collections, contents, schemas };
})();

const { db: dbModule, hash: hashModule, changes: changesModule, comments: commentsModule, imageTasks: imageTasksModule, collections: collectionsModule, contents: contentsModule } = workerModules;

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
    "全量对账后 contents.comment_count 必须归零"
  );
  // 全量清零必须连残余线程索引行一起删掉（thread_hash / incoming_hash 随行消失），
  // 否则原站清空后又新增子评论时，旧 R2 子评论会在下次 partial 同步里被「复活合并」。
  assert.equal(
    sqlite.prepare(`SELECT * FROM comment_threads WHERE root_id = 'r1'`).get(),
    undefined,
    "全量清零后 comment_threads 残余线程行必须删除"
  );
  assert.equal(r2Deletes, 1, "全量清零必须删除旧 R2 子评论对象");
  assert.equal(r2Store.has("childcomments/r1.json"), false, "旧 R2 子评论对象必须已不存在");
  assert.equal(sqlite.prepare(`SELECT is_deleted FROM comments WHERE id = 'r1'`).get().is_deleted, 1);
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

  // 原站楼中楼被删光：抓全 + childCount = 0
  await runWithDb(d1, () => commentsModule.replaceCommentsByRoot(
    rootPayload([], 0, true),
    { DB: d1, BUCKET: bucket }
  ));

  const stored = JSON.parse(r2Store.get(key));
  assert.deepEqual(stored.children, []);
  assert.equal(stored.complete, true);
  const thread = sqlite.prepare(`SELECT child_count, is_complete, preview_json FROM comment_threads WHERE root_id = 'r1'`).get();
  assert.equal(thread.child_count, 0);
  assert.equal(thread.is_complete, 1);
  assert.equal(thread.preview_json, "[]");
});

test("complete-empty：旧扁平 D1 子评论 + 无线程索引时建立 R2 空快照与计数 0，读取 API 不回退旧行", async () => {
  const { sqlite, d1 } = createMemoryDb();
  seedContent(sqlite);
  insertLegacyChild(sqlite, { id: "legacy-child", content: "legacy reply" });
  const { bucket, store, stats } = makeTrackedBucket();

  const result = await runWithDb(d1, () => commentsModule.replaceCommentsByRoot(
    rootPayload({ children: [], childCount: 0, isChildrenComplete: true }),
    { DB: d1, BUCKET: bucket }
  ));

  assert.equal(result.r2Puts, 1, "权威空快照必须写入 complete-empty R2 对象");
  assert.equal(stats.puts, 1);
  const stored = JSON.parse(store.get("childcomments/r1.json"));
  assert.deepEqual(stored.children, []);
  assert.equal(stored.complete, true);

  const thread = sqlite.prepare(`SELECT child_count, is_complete, preview_json FROM comment_threads WHERE root_id = 'r1'`).get();
  assert.equal(thread.child_count, 0, "即使原先没有线程索引也必须建立 child_count=0 的索引");
  assert.equal(thread.is_complete, 1);
  assert.equal(thread.preview_json, "[]");

  const children = await runWithDb(d1, () => commentsModule.getChildComments(bucket, "r1", d1));
  assert.deepEqual(children, [], "complete-empty 快照必须阻止读取 API 回退旧 D1 子评论");
  assert.equal(
    sqlite.prepare(`SELECT COUNT(*) AS n FROM comments WHERE id = 'legacy-child'`).get().n,
    1,
    "清空 R2/索引时不得删除 D1 旧子评论行"
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

  assert.equal(result.r2Puts, 1, "不能因为 child_count 已经是 0 就跳过 R2 清空");
  assert.equal(stats.puts, putsBefore + 1);
  const stored = JSON.parse(store.get("childcomments/r1.json"));
  assert.deepEqual(stored.children, []);
  assert.equal(stored.complete, true);
  const thread = sqlite.prepare(`SELECT child_count, is_complete FROM comment_threads WHERE root_id = 'r1'`).get();
  assert.equal(thread.child_count, 0);
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

  assert.equal(batchCalls, 1, "领取阶段必须只发 1 个 D1 batch");
  assert.equal(batchSizes[0], 3, "候选只能包含 2 条 pending + 1 条超时 processing");
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
  fail: async message => { throw new Error(String(message)); }
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
  assert.equal(d1Selects, 1, "保存后应命中内存缓存，不再查 D1");

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

  // 8) 删除：缓存立即刷新，D1 与 R2 都清空
  // 上面的 401 分支会查一次写口令（app_settings SELECT），从这里重新计数
  d1Selects = 0;
  const delRes = await call("POST", "/external-targets/delete", {
    headers: authHeaders,
    body: { id: savedId }
  });
  assert.equal(delRes.status, 200);
  assert.deepEqual(delRes.body.targets, []);
  assert.deepEqual(await runWithDb(countingD1, () => auth.getExternalTargetsRaw(bucket)), []);
  assert.equal(d1Selects, 0, "删除与读取全部命中缓存/early-return，不应产生 D1 SELECT");
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
    const threadUrl = `https://r2-edge-cache.internal/${encodeURIComponent(threadKey)}`;
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

    // 7) 清空楼中楼同样 purge：R2 写入空对象后，读路径不再看到旧回复
    const emptyWrite = await runWithDb(d1, () =>
      commentsModule.replaceCommentsByRoot(
        { contentPk: CONTENT_PK, partial: false, roots: [], allRootIds: [] },
        { DB: d1, BUCKET: commentBucket.bucket }
      )
    );
    assert.equal(emptyWrite.r2Puts, 0);
    assert.equal(edgeStore.has(threadUrl), false, "清零后边缘缓存必须被 purge");
    const readAfterClear = await runWithDb(d1, () =>
      commentsModule.getChildComments(commentBucket.bucket, "r1", d1)
    );
    assert.deepEqual(readAfterClear, [], "已清零的楼中楼不得从旧缓存里复活");

    // 8) GET /api/contents/:pk 正文走边缘缓存；children 路由带短时 CDN 缓存头
    const contentsRoutePath = path.join(workerSrc, "routes", "contents.ts");
    const routeMockUrl = toDataUrl(`
const handlers = new Map();
const headerStore = new Map();
class Hono {
  use() { return this }
  get(path, handler) { handlers.set("GET " + path, handler); return this }
  post() { return this }
  route() { return this }
  async __call(pattern, params = {}, env = {}) {
    const handler = handlers.get("GET " + pattern);
    if (!handler) throw new Error("no handler for GET " + pattern);
    let status = 200;
    let payload;
    headerStore.clear();
    const c = {
      env,
      req: {
        param: name => params[name],
        query: name => params[name],
        url: "http://127.0.0.1/api/contents/" + (params.pk || ""),
        header: () => undefined
      },
      header: (name, value) => { headerStore.set(String(name).toLowerCase(), value); },
      json: (obj, code = 200) => { status = code; payload = obj; return { status, body: obj }; }
    };
    await handler(c);
    return { status, body: payload, headers: Object.fromEntries(headerStore) };
  }
}
export { Hono };
export default Hono;
`);
    const sharedIndexUrl = await moduleUrlFor(sharedIndexPath);
    const contentsRoutes = await loadTs(
      contentsRoutePath,
      new Map([["hono", routeMockUrl], ["shared", sharedIndexUrl]])
    );

    const htmlStore = makeBucket();
    const hash = "h";
    r2Store.set(`html/${CONTENT_PK}/${hash}`, "<p>full body</p>");
    const env = { BUCKET: htmlStore.bucket, DB: d1 };

    const res1 = await runWithDb(d1, () => contentsRoutes.contentRoutes.__call("/:pk", { pk: CONTENT_PK }, env));
    assert.equal(res1.body.content.content_html, "<p>full body</p>");
    assert.equal(htmlStore.stats.gets, 1);

    const res2 = await runWithDb(d1, () => contentsRoutes.contentRoutes.__call("/:pk", { pk: CONTENT_PK }, env));
    assert.equal(res2.body.content.content_html, "<p>full body</p>");
    assert.equal(htmlStore.stats.gets, 1, "详情页二次打开必须命中边缘缓存，0 次 R2 读取");

    const childrenRes = await runWithDb(d1, () =>
      contentsRoutes.contentRoutes.__call(
        "/:pk/comments/:rootId/children",
        { pk: CONTENT_PK, rootId: "r1" },
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
    assert.deepEqual(children, [], "外部库 complete=true 空楼中楼必须返回 []，不得被主 R2 旧快照遮蔽或复活旧扁平行");

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
