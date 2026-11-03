#!/usr/bin/env bash
# 接口冒烟测试：对已经跑起来的 Worker 打一圈真实请求。
#
# 用法：
#   bash scripts/smoke-test.sh                      # 默认打 127.0.0.1:8788，密钥 test-secret
#   BASE_URL=http://127.0.0.1:8787 bash scripts/smoke-test.sh
#
# 前置：Worker 已启动，且 API_SECRET 与 $API_SECRET 一致。
# 注意：脚本会写入测试数据（用带时间戳的唯一 pk），结束时自动清理。
#       如果你在本地开发库上跑，清理依赖 wrangler；清理失败会打印提示。

set -o pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8788}"
API_SECRET="${API_SECRET:-test-secret}"

STAMP="$(date +%s)"
PK="answer:smoke-$STAMP"
COLL_ID="smoke-$STAMP"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0
FAIL=0

# 本地 D1 操作统一走 wrangler：清理测试数据、备份/恢复真实 cookie 都依赖它
has_wrangler() {
  command -v pnpm >/dev/null 2>&1 && [ -f "$REPO_ROOT/apps/worker/wrangler.toml" ]
}

d1_exec() {
  (
    cd "$REPO_ROOT/apps/worker" || exit 1
    pnpm exec wrangler d1 execute zhihu-backup --local --command "$1" >/dev/null 2>&1
  )
}

ok()   { echo "  PASS  $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL  $1"; [ -n "$2" ] && echo "        $2"; FAIL=$((FAIL + 1)); }

expect_eq() {
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "got=[$2] want=[$3]"; fi
}

expect_contains() {
  case "$2" in
    *"$3"*) ok "$1" ;;
    *) bad "$1" "missing [$3] in: $(echo "$2" | head -c 220)" ;;
  esac
}

auth=(-H "authorization: Bearer $API_SECRET")
json=(-H "content-type: application/json")

echo "== 1. 健康检查 =="
expect_eq "GET /api/health" "$(curl -s "$BASE_URL/api/health")" '{"ok":true}'

echo "== 2. 写接口鉴权 fail-closed =="
BODY='{"sourceType":"answer","sourceId":"x","sourceUrl":"https://www.zhihu.com/question/1/answer/1","contentHtml":"<p>x</p>"}'
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/ingest/content" "${json[@]}" -d "$BODY")
expect_eq "无 token → 401" "$C" "401"
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/ingest/content" "${json[@]}" "${auth[@]}" -H "authorization: Bearer wrong" -d "$BODY")
expect_eq "错 token → 401" "$C" "401"

echo "== 3. 内容写入 =="
CONTENT=$(cat <<JSON
{"sourceType":"answer","sourceId":"smoke-$STAMP","sourceUrl":"https://www.zhihu.com/question/1/answer/smoke-$STAMP",
 "title":"smoke-title-v1","author":{"name":"smoke","urlToken":"smoke"},
 "contentHtml":"<p>smoke-body-v1</p>","contentMd":"","excerpt":"",
 "voteupCount":1,"commentCount":0,
 "createdTime":"2026-10-18T00:00:00.000Z","updatedTime":"2026-10-18T00:00:00.000Z"}
JSON
)
R=$(curl -s -X POST "$BASE_URL/ingest/content" "${json[@]}" "${auth[@]}" -d "$CONTENT")
expect_contains "created:true" "$R" '"created":true'
expect_contains "返回 hash" "$R" '"hash"'

echo "== 4. 列表与详情 =="
R=$(curl -s "$BASE_URL/api/contents?page=1")
expect_contains "列表含该条目" "$R" "smoke-title-v1"
expect_contains "列表带 author_avatar 字段" "$R" 'author_avatar'
R=$(curl -s "$BASE_URL/api/contents/$PK")
expect_contains "详情正文从 R2 注入" "$R" 'smoke-body-v1'
expect_contains "详情带 content_hash" "$R" 'content_hash'

echo "== 5. 内容更新（batch 原子路径）=="
UPD=$(cat <<JSON
{"sourceType":"answer","sourceId":"smoke-$STAMP","sourceUrl":"https://www.zhihu.com/question/1/answer/smoke-$STAMP",
 "title":"smoke-title-v2","author":{"name":"smoke","urlToken":"smoke"},
 "contentHtml":"<p>smoke-body-v2</p>","contentMd":"","excerpt":"",
 "voteupCount":42,"commentCount":5,
 "createdTime":"2026-10-18T00:00:00.000Z","updatedTime":"2026-10-18T01:00:00.000Z"}
JSON
)
R=$(curl -s -X POST "$BASE_URL/ingest/content" "${json[@]}" "${auth[@]}" -d "$UPD")
expect_contains "changed:true" "$R" '"changed":true'
expect_contains "created:false" "$R" '"created":false'
R=$(curl -s "$BASE_URL/api/contents/$PK")
expect_contains "标题已更新" "$R" 'smoke-title-v2'
expect_contains "正文已更新" "$R" 'smoke-body-v2'
expect_contains "计数已更新" "$R" '"voteup_count":42'
expect_contains "产生版本快照" "$R" 'snapshot_at'

echo "== 6. 评论批量与 partial 防误删 =="
CM5=$(node - "$STAMP" <<'JS'
// 不用 python3：Windows 上它常是 Store 假 stub，跑起来无输出导致 curl 发空请求。
// 注意：这里刻意复刻 python json.dumps 的默认分隔符（", " / ": "），
// 输出须与旧版逐字节一致——下方 sed 按 '"partial": true'（带空格）精确匹配。
const dumps = (v) => {
  if (Array.isArray(v)) return `[${v.map(dumps).join(", ")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${dumps(x)}`).join(", ")}}`;
  }
  return JSON.stringify(v);
};

const s = process.argv[2];
const cs = [];
for (let i = 1; i <= 5; i++) {
  cs.push({
    id: `smoke-${s}-c${i}`, parentId: null, author: `u${i}`, authorAvatar: "",
    beReplied: null, content: `comment-${i}`, img: "",
    time: "2026-10-18T00:00:00.000Z", location: "", likes: i,
    isAuthor: false, isTop: false, isFeatured: false
  });
}
console.log(dumps({ contentPk: `answer:smoke-${s}`, comments: cs, partial: false }));
JS
)
R=$(curl -s -X POST "$BASE_URL/ingest/comments" "${json[@]}" "${auth[@]}" -d "$CM5")
expect_contains "首次写入 added:5" "$R" '"added":5'

CM2_PARTIAL=$(node - "$STAMP" <<'JS'
// 同上：node 替代 python3，分隔符保持与 json.dumps 一致，sed 才能命中
const dumps = (v) => {
  if (Array.isArray(v)) return `[${v.map(dumps).join(", ")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${dumps(x)}`).join(", ")}}`;
  }
  return JSON.stringify(v);
};

const s = process.argv[2];
const cs = [];
for (let i = 1; i <= 2; i++) {
  cs.push({
    id: `smoke-${s}-c${i}`, parentId: null, author: `u${i}`, authorAvatar: "",
    beReplied: null, content: `comment-${i}`, img: "",
    time: "2026-10-18T00:00:00.000Z", location: "", likes: i,
    isAuthor: false, isTop: false, isFeatured: false
  });
}
console.log(dumps({ contentPk: `answer:smoke-${s}`, comments: cs, partial: true }));
JS
)
R=$(curl -s -X POST "$BASE_URL/ingest/comments" "${json[@]}" "${auth[@]}" -d "$CM2_PARTIAL")
expect_contains "partial=true 不删任何评论" "$R" '"deleted":0'

CM2_FULL=$(echo "$CM2_PARTIAL" | sed 's/"partial": true/"partial": false/')
R=$(curl -s -X POST "$BASE_URL/ingest/comments" "${json[@]}" "${auth[@]}" -d "$CM2_FULL")
expect_contains "partial=false 对账删除 3 条" "$R" '"deleted":3'

echo "== 7. 收藏夹快照 =="
COLL=$(cat <<JSON
{"collection":{"id":"$COLL_ID","title":"smoke-collection","ownerToken":"smoke","updatedTime":""},
 "incremental":false,
 "items":[{"sourceType":"answer","sourceId":"smoke-$STAMP","title":"smoke-title-v2",
           "authorName":"smoke","sourceUrl":"https://www.zhihu.com/question/1/answer/smoke-$STAMP"}]}
JSON
)
R=$(curl -s -X POST "$BASE_URL/ingest/collection-snapshot" "${json[@]}" "${auth[@]}" -d "$COLL")
expect_contains "快照写入 added:1" "$R" '"added":1'
R=$(curl -s "$BASE_URL/api/collections")
expect_contains "收藏夹可读" "$R" 'smoke-collection'

echo "== 8. 赞同与统计 =="
R=$(curl -s -X POST "$BASE_URL/ingest/upvote" "${json[@]}" "${auth[@]}" \
  -d "{\"contentPk\":\"$PK\",\"upvoteTime\":\"2026-10-18T00:00:00.000Z\"}")
expect_contains "首次赞同 created:true" "$R" '"created":true'
R=$(curl -s "$BASE_URL/api/upvotes?page=1")
expect_contains "赞同列表可读" "$R" 'smoke-title'
R=$(curl -s "$BASE_URL/api/stats")
expect_contains "统计接口可用" "$R" '"total_contents"'

echo "== 9. cookie 表单 =="
# 本地开发库可能已经登录了真实知乎账号：先备份 app_settings 里的真实 cookie，
# 结束时只删除本次写入的 smoke 假值并恢复备份，绝不误删真实登录态。
COOKIE_BACKED_UP=0
STATUS_BEFORE=$(curl -s "$BASE_URL/api/auth/zhihu-status" 2>/dev/null || echo "")
HAS_DB_COOKIE=0
case "$STATUS_BEFORE" in
  *'"source":"db"'*) HAS_DB_COOKIE=1 ;;
esac
if has_wrangler; then
  if d1_exec "
    CREATE TABLE IF NOT EXISTS _smoke_app_settings_backup (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    DELETE FROM _smoke_app_settings_backup;
    INSERT INTO _smoke_app_settings_backup (key, value, updated_at)
      SELECT key, value, updated_at FROM app_settings
      WHERE key = 'zhihu_cookie' AND value NOT LIKE '%smoke-token%';
  "; then
    COOKIE_BACKED_UP=1
  fi
fi

# 已有真实 DB cookie 又备份不了时，跳过会覆盖它的成功写入用例（拒绝类用例仍照跑）
ALLOW_COOKIE_WRITE=1
if [ "$HAS_DB_COOKIE" = "1" ] && [ "$COOKIE_BACKED_UP" != "1" ]; then
  ALLOW_COOKIE_WRITE=0
  echo "  SKIP  本地库已有真实知乎 cookie 且无法用 wrangler 备份，跳过覆盖式 cookie 写入测试"
fi

# 写接口严格 fail-closed：无 Bearer 时哪怕带合法 Origin 也必须被拒绝（Origin-only 绕过已封堵）
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/auth/zhihu-cookie" "${json[@]}" \
  -H "origin: http://127.0.0.1:5173" -d '{"cookieString":"z_c0=smoke-token; _xsrf=smoke"}')
expect_eq "无 Bearer 仅 Origin 被拒 401" "$C" "401"
if [ "$ALLOW_COOKIE_WRITE" = "1" ]; then
  R=$(curl -s -X POST "$BASE_URL/api/auth/zhihu-cookie" "${json[@]}" "${auth[@]}" \
    -d '{"cookieString":"z_c0=smoke-token; _xsrf=smoke"}')
  expect_contains "带 Bearer 保存 cookie 成功" "$R" '"ok":true'
  R=$(curl -s "$BASE_URL/api/auth/zhihu-status")
  expect_contains "状态 hasCookie:true" "$R" '"hasCookie":true'
  expect_contains "来源为 db" "$R" '"source":"db"'
else
  # 真实 cookie 未被覆盖：hasCookie / source=db 仍然应成立
  expect_contains "状态 hasCookie:true" "$STATUS_BEFORE" '"hasCookie":true'
  expect_contains "来源为 db" "$STATUS_BEFORE" '"source":"db"'
fi
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/auth/zhihu-cookie" "${json[@]}" "${auth[@]}" \
  -d '{"cookieString":"no-zc0=1"}')
expect_eq "带 Bearer 但缺 z_c0 被拒 400" "$C" "400"

echo "== 10. 两层评论（按根提交）=="
ROOT_ID="smoke-$STAMP-root1"
ROOTS=$(cat <<JSON
{"contentPk":"$PK",
 "roots":[{"id":"$ROOT_ID","author":"root-author","authorAvatar":"","content":"root-body",
           "img":"","time":"2026-10-18T00:00:00.000Z","location":"","likes":1,
           "isAuthor":false,"isTop":false,"isFeatured":false,"childCount":2,
           "children":[{"id":"smoke-$STAMP-r1c1","parentId":"$ROOT_ID","author":"c1","beReplied":null,
                        "content":"child-one","likes":0},
                       {"id":"smoke-$STAMP-r1c2","parentId":"$ROOT_ID","author":"c2","beReplied":null,
                        "content":"child-two","likes":0}],
           "isChildrenComplete":true}],
 "allRootIds":["$ROOT_ID"],"partial":false}
JSON
)
R=$(curl -s -X POST "$BASE_URL/ingest/comments-by-root" "${json[@]}" "${auth[@]}" -d "$ROOTS")
expect_contains "首次写入 1 根" "$R" '"added":1'
expect_contains "子评论落 R2 一次" "$R" '"r2Puts":1'
R=$(curl -s -X POST "$BASE_URL/ingest/comments-by-root" "${json[@]}" "${auth[@]}" -d "$ROOTS")
expect_contains "重复提交不重写 R2" "$R" '"r2Puts":0'
R=$(curl -s "$BASE_URL/api/contents/$PK/root-comments")
expect_contains "根列表带 preview_replies" "$R" 'preview_replies'
expect_contains "预览含首条子评论" "$R" 'child-one'
R=$(curl -s "$BASE_URL/api/contents/$PK/comments/$ROOT_ID/children")
expect_contains "子评论接口返回第 1 条" "$R" 'child-one'
expect_contains "子评论接口返回第 2 条" "$R" 'child-two'

echo "== 11. 已删除的路由 =="
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/contents/$PK/sync-live" "${auth[@]}")
expect_eq "sync-live 已移除 → 404" "$C" "404"

echo "== 12. 分布式同步锁 =="
# 与云端 cron / 本地脚本共用同一把租约锁：只有相同 ownerId 才能续租与释放
R=$(curl -s -X POST "$BASE_URL/ingest/sync-lock/acquire" "${json[@]}" "${auth[@]}" \
  -d '{"ownerId":"smoke-owner-1","source":"smoke-test"}')
expect_contains "owner-1 首次 acquire 成功" "$R" '"ok":true'
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/ingest/sync-lock/acquire" "${json[@]}" "${auth[@]}" \
  -d '{"ownerId":"smoke-owner-2","source":"smoke-test"}')
expect_eq "owner-2 抢锁被互斥 409" "$C" "409"
R=$(curl -s -X POST "$BASE_URL/ingest/sync-lock/release" "${json[@]}" "${auth[@]}" \
  -d '{"ownerId":"smoke-owner-2"}')
expect_contains "错误 ownerId 不释放" "$R" '"released":false'
R=$(curl -s -X POST "$BASE_URL/ingest/sync-lock/release" "${json[@]}" "${auth[@]}" \
  -d '{"ownerId":"smoke-owner-1"}')
expect_contains "正确 ownerId 释放成功" "$R" '"released":true'
R=$(curl -s -X POST "$BASE_URL/ingest/sync-lock/acquire" "${json[@]}" "${auth[@]}" \
  -d '{"ownerId":"smoke-owner-1","source":"smoke-test"}')
expect_contains "释放后可再次 acquire" "$R" '"ok":true'
R=$(curl -s -X POST "$BASE_URL/ingest/sync-lock/release" "${json[@]}" "${auth[@]}" \
  -d '{"ownerId":"smoke-owner-1"}')
expect_contains "清理测试锁" "$R" '"released":true'

echo ""
echo "==== PASS=$PASS  FAIL=$FAIL ===="

# 清理测试数据（失败不影响结果）
if has_wrangler; then
  if d1_exec "
       DELETE FROM comments WHERE content_pk='$PK';
       DELETE FROM content_versions WHERE content_pk='$PK';
       DELETE FROM upvotes WHERE content_pk='$PK';
       DELETE FROM comment_threads WHERE content_pk='$PK';
       DELETE FROM contents WHERE pk='$PK';
       DELETE FROM collection_items WHERE collection_id='$COLL_ID';
       DELETE FROM collections WHERE id='$COLL_ID';
       DELETE FROM change_events WHERE content_pk='$PK' OR entity_pk='$COLL_ID';
       -- 只删本次冒烟写入的假值：绝不误删真实知乎 cookie 或他人持有的同步锁
       DELETE FROM app_settings WHERE key = 'zhihu_cookie' AND value LIKE '%smoke-token%';
       DELETE FROM app_settings WHERE key = 'sync_lock' AND value LIKE '%smoke-owner-%';
  "; then
    echo "（测试数据已清理）"
  else
    echo "（清理失败：如果这是你的本地开发库，请手动删除 $PK 相关数据）"
  fi

  # 第 9 节若覆盖过真实 cookie，用测试前备份恢复原行
  if [ "$COOKIE_BACKED_UP" = "1" ]; then
    if d1_exec "
         INSERT OR REPLACE INTO app_settings (key, value, updated_at)
           SELECT key, value, updated_at FROM _smoke_app_settings_backup WHERE key = 'zhihu_cookie';
         DROP TABLE IF EXISTS _smoke_app_settings_backup;
    "; then
      echo "（已恢复测试前的真实知乎 cookie 备份）"
    else
      echo "（恢复真实知乎 cookie 备份失败：请手动检查 app_settings 的 zhihu_cookie）"
    fi
  fi
fi

[ "$FAIL" -eq 0 ] || exit 1
