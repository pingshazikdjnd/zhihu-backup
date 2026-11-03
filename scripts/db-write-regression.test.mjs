import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
  }

  prepare(sql) {
    return new MemoryD1Statement(this, sql);
  }

  record(sql, params) {
    this.writes.push({ sql: sql.replace(/\s+/g, " ").trim(), params: [...params] });
  }

  batch(statements) {
    const runAll = this.sqlite.transaction(() => statements.map(statement => {
      this.record(statement.sql, statement.params);
      const info = statement.execute();
      return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
    }));
    return Promise.resolve(runAll());
  }
}

const schemaSql = readFileSync(
  path.join(repoRoot, "apps", "worker", "migrations", "0000_schema.sql"),
  "utf8"
);
const commentThreadsMigrationSql = readFileSync(
  path.join(repoRoot, "apps", "worker", "migrations", "0004_comment_threads.sql"),
  "utf8"
);
const appSettingsMigrationSql = readFileSync(
  path.join(repoRoot, "apps", "worker", "migrations", "0001_app_settings.sql"),
  "utf8"
);

function createMemoryDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(schemaSql);
  sqlite.exec(appSettingsMigrationSql);
  sqlite.exec(commentThreadsMigrationSql);
  return { sqlite, d1: new MemoryD1(sqlite) };
}

const workerModules = await (async () => {
  const db = await loadTs(path.join(workerSrc, "db.ts"));
  const hash = await loadTs(path.join(workerSrc, "utils", "hash.ts"));
  const changes = await loadTs(path.join(workerSrc, "services", "changes.ts"));
  const comments = await loadTs(path.join(workerSrc, "services", "comments.ts"));
  const collections = await loadTs(path.join(workerSrc, "services", "collections.ts"));
  const sharedIndexUrl = await moduleUrlFor(sharedIndexPath);
  const contents = await loadTs(
    path.join(workerSrc, "services", "contents.ts"),
    new Map([["shared", sharedIndexUrl]])
  );
  const schemas = await loadTs(sharedSchemasPath);
  return { db, hash, changes, comments, collections, contents, schemas };
})();

const { db: dbModule, hash: hashModule, changes: changesModule, comments: commentsModule, collections: collectionsModule, contents: contentsModule } = workerModules;

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
      if (target.includes("/answers?")) return okJson({ data: [answerFixture], paging: { is_end: true } });
      if (target.includes("/root_comments")) return okJson({ data: commentFixtures, paging: { is_end: true } });
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

// sync.ts 在模块加载时只注册路由（不发起请求），用最小 Hono mock 阻断真实框架依赖
const honoMockUrl = toDataUrl(`
class Hono {
  use() { return this }
  get() { return this }
  post() { return this }
  route() { return this }
}
export { Hono };
export default Hono;
`);

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