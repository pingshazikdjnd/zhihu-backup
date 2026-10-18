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

PASS=0
FAIL=0

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
CM5=$(python3 - "$STAMP" <<'PY'
import json, sys
s = sys.argv[1]
cs = [{"id": f"smoke-{s}-c{i}", "parentId": None, "author": f"u{i}", "authorAvatar": "",
       "beReplied": None, "content": f"comment-{i}", "img": "",
       "time": "2026-10-18T00:00:00.000Z", "location": "", "likes": i,
       "isAuthor": False, "isTop": False, "isFeatured": False} for i in range(1, 6)]
print(json.dumps({"contentPk": f"answer:smoke-{s}", "comments": cs, "partial": False}))
PY
)
R=$(curl -s -X POST "$BASE_URL/ingest/comments" "${json[@]}" "${auth[@]}" -d "$CM5")
expect_contains "首次写入 added:5" "$R" '"added":5'

CM2_PARTIAL=$(python3 - "$STAMP" <<'PY'
import json, sys
s = sys.argv[1]
cs = [{"id": f"smoke-{s}-c{i}", "parentId": None, "author": f"u{i}", "authorAvatar": "",
       "beReplied": None, "content": f"comment-{i}", "img": "",
       "time": "2026-10-18T00:00:00.000Z", "location": "", "likes": i,
       "isAuthor": False, "isTop": False, "isFeatured": False} for i in range(1, 3)]
print(json.dumps({"contentPk": f"answer:smoke-{s}", "comments": cs, "partial": True}))
PY
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
R=$(curl -s -X POST "$BASE_URL/api/auth/zhihu-cookie" "${json[@]}" \
  -d '{"cookieString":"z_c0=smoke-token; _xsrf=smoke"}')
expect_contains "保存 cookie 成功" "$R" '"ok":true'
R=$(curl -s "$BASE_URL/api/auth/zhihu-status")
expect_contains "状态 hasCookie:true" "$R" '"hasCookie":true'
expect_contains "来源为 db" "$R" '"source":"db"'
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/auth/zhihu-cookie" "${json[@]}" \
  -d '{"cookieString":"no-zc0=1"}')
expect_eq "缺 z_c0 被拒 400" "$C" "400"

echo "== 10. 已删除的路由 =="
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/api/contents/$PK/sync-live" "${auth[@]}")
expect_eq "sync-live 已移除 → 404" "$C" "404"

echo ""
echo "==== PASS=$PASS  FAIL=$FAIL ===="

# 清理测试数据（失败不影响结果）
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if command -v pnpm >/dev/null 2>&1 && [ -f "$REPO_ROOT/apps/worker/wrangler.toml" ]; then
  (
    cd "$REPO_ROOT/apps/worker" || exit 0
    pnpm exec wrangler d1 execute zhihu-backup --local --command \
      "DELETE FROM comments WHERE content_pk='$PK'; \
       DELETE FROM content_versions WHERE content_pk='$PK'; \
       DELETE FROM upvotes WHERE content_pk='$PK'; \
       DELETE FROM contents WHERE pk='$PK'; \
       DELETE FROM collection_items WHERE collection_id='$COLL_ID'; \
       DELETE FROM collections WHERE id='$COLL_ID'; \
       DELETE FROM change_events WHERE content_pk='$PK' OR entity_pk='$COLL_ID'; \
       DELETE FROM app_settings WHERE key='zhihu_cookie';" >/dev/null 2>&1 \
      && echo "（测试数据已清理）" \
      || echo "（清理失败：如果这是你的本地开发库，请手动删除 $PK 相关数据）"
  )
fi

[ "$FAIL" -eq 0 ] || exit 1
