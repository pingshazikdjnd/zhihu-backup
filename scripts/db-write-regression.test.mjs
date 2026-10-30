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

function createMemoryDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(schemaSql);
  return { sqlite, d1: new MemoryD1(sqlite) };
}

const workerModules = await (async () => {
  const db = await loadTs(path.join(workerSrc, "db.ts"));
  const hash = await loadTs(path.join(workerSrc, "utils", "hash.ts"));
  const changes = await loadTs(path.join(workerSrc, "services", "changes.ts"));
  const comments = await loadTs(path.join(workerSrc, "services", "comments.ts"));
  const collections = await loadTs(path.join(workerSrc, "services", "collections.ts"));
  const schemas = await loadTs(sharedSchemasPath);
  return { db, hash, changes, comments, collections, schemas };
})();

const { db: dbModule, hash: hashModule, changes: changesModule, comments: commentsModule, collections: collectionsModule } = workerModules;

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

test("点赞显式变化只写 3 条语句（主评论+版本+事件），事件不含正文", async () => {
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
  assert.equal(d1.writes.length, 3, `期望 3 条语句，实际 ${d1.writes.map(w => w.sql).join(" | ")}`);
  assert.equal(d1.writes.filter(write => /^UPDATE comments/i.test(write.sql)).length, 1);
  assert.equal(d1.writes.filter(write => /^INSERT INTO comment_versions/i.test(write.sql)).length, 1);
  assert.equal(d1.writes.filter(write => /^INSERT INTO change_events/i.test(write.sql)).length, 1);

  const row = sqlite.prepare(`SELECT payload_json FROM change_events ORDER BY id DESC LIMIT 1`).get();
  assert.deepEqual(JSON.parse(row.payload_json), { commentId: "c1", contentPk: CONTENT_PK });
  assert.equal(row.payload_json.includes("hello"), false, "事件 payload 不应复制评论正文");
  assert.equal(sqlite.prepare(`SELECT likes FROM comments WHERE id = 'c1'`).get().likes, 2);
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
    .filter(request => request.path === "/ingest/comments");
  assert.equal(payloads.length, 2, "两条链路各应提交一次评论 payload");

  const [mainPayload, hotPayload] = payloads;
  assert.deepEqual(mainPayload.body.comments, hotPayload.body.comments, "两条链路必须产出相同评论对象");

  const imageComment = mainPayload.body.comments.find(comment => comment.id === "9001");
  assert.equal(imageComment.img, standardImage);
  assert.equal(imageComment.imageUrl, standardImage);
  assert.equal(imageComment.content, "<p>hi</p>");
  assert.equal(imageComment.content.includes(standardImage), false, "图片 URL 不得写进正文");

  const fallbackComment = mainPayload.body.comments.find(comment => comment.id === "9002");
  assert.equal(fallbackComment.img, fallbackImage);
  assert.equal(fallbackComment.imageUrl, fallbackImage);
  assert.equal(fallbackComment.content, "<p>text only</p>");

  const parsed = workerModules.schemas.IngestCommentsSchema.parse(mainPayload.body);
  assert.equal(parsed.comments[0].imageUrl, standardImage);
  assert.equal(parsed.comments[1].imageUrl, fallbackImage);
});