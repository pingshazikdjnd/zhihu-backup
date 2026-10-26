# 知乎备份系统 · 项目报告

**版本**：v0.1.1（main @ 908d4a5）　**日期**：2026-10-26
**仓库**：pingshazikdjnd/zhihu-backup（private）　**状态**：已部署生产运行

---

## 1. 项目概述

把个人在知乎的公开活动（回答、文章、想法、评论、收藏夹、赞同记录）持续备份到自有基础设施，随时可查、可搜、可看变更历史。

| 服务 | 地址 | 状态 |
|---|---|---|
| 前端 | https://zhihu-backup.pages.dev | ✅ 运行中 |
| API | https://gemini-zhihu-api.1490262644.workers.dev | ✅ 运行中 |
| 定时抓取 | Cron 每天 10:00 / 22:00（北京时间）快速增量 | ✅ 已验证自动触发 |
| 数据 | Cloudflare D1（11 表）+ R2（正文仓） | ✅ 2668+ 条内容入库 |

## 2. 架构与技术选型

```
┌────────────────┐  触发(Cron/手动/API)  ┌─────────────────┐
│ Cloudflare     │ ────────────────────► │ Apify Actor      │
│ Worker (Hono)  │      转发 cookie       │ (Playwright      │
│                │ ◄──────────────────── │  chromium 无页面) │
│  D1 索引层     │   POST /ingest/*      │                  │
│  R2 正文仓     │   Bearer 鉴权回传      │ 抓知乎 v4/v3 API │
└───────┬────────┘                       └─────────────────┘
        │ 只读 API (CORS 白名单)
        ▼
┌────────────────┐
│ React 19 前端   │ Cloudflare Pages 纯静态
│ /auth 维护cookie│ SPA + DOMPurify 白名单
└────────────────┘
```

**分工与理由**：

| 组件 | 职责 | 选型理由 |
|---|---|---|
| Apify Actor | 唯一抓取实现（Node 24 + Playwright） | CF 出口 IP 抓知乎必被风控；Apify 的 IP 池+无服务器容器是唯一稳妥出口 |
| Worker (Hono) | API 网关 + D1/R2 编排 + Cron | 免费版够用；Hono 轻量原生 Workers |
| D1 (SQLite) | 索引层：元数据、4000 字检索摘要、事件 | SQL 搜索/排序需要；正文不进 D1 |
| R2 | 正文唯一真源（HTML/MD/版本快照） | 出口流量免费、10GB 免费额度用 3% |
| React SPA | 展示 + `/auth` cookie 维护 | 静态托管零成本；cookie 粘贴免重部署 |

**关键数据流**：一条回答 = D1 3 行（contents + content_versions + change_events）+ R2 2 对象（html/{pk}/{hash} + versions/…）。正文按内容 SHA-256 寻址，多版本永不覆盖。

## 3. 实现方法

### 3.1 数据完整性核心机制

- **幂等 upsert**：所有写入按业务主键（`answer:123` 形 pk）幂等，重放零副作用（实测同 payload 5 次重放零事件增长）
- **partial 防误删**：抓取中断（风控/网络）时评论/收藏提交带 `partial`/`incremental` 标记，服务端跳过删除对账——宁可漏抓不可误删
- **分批对账协议**：评论 500 条/批（中间批 partial、末批带全量 allIds）+ 批次失败重试 + 重复 id 双侧去重（知乎点赞排序漂移会让同条评论出现在两页）
- **并发安全**：按 key 的进程内串行化锁（三个写服务）+ `/api/sync` 10 分钟防重入锁（防 cron 与手动重叠的双爬虫竞态——曾实测 60 并发静默丢失 48 条更新）
- **弱数据源兜底**：赞同动态（缺正文/问题/时间戳）不覆盖已入库的真实数据——空值、1970 哨兵、占位串（“未知问题”/`/question/undefined/`）三重拦截
- **断点续传**（v0.1.1 新增）：赞同段每页上报游标到 Worker，下次 run 先扫新增段（一页全已存在即跳）再从断点续翻历史；翻到底自动清游标、断点失效自愈重翻

### 3.2 可靠性机制（对抗静默失败）

- **失败可见**：爬虫全局 stats 统计，cookie 失效（401/403）/风控空页（200+空数组）/回传全失败/异常 → `Actor.fail()` 显性 FAILED + 可读 statusMessage（此前任何失败都显示成功，零数据入库无感知）
- **同步健康可查**：`/api/auth/zhihu-status` 返回 cookie 状态 + 上次 Apify run 结果（60s D1 缓存）

### 3.3 安全设计

- 写接口 Bearer 鉴权 fail-closed（缺 secret 直接 503）
- CORS 白名单精确匹配 + cookie 写入端点 CSRF 防线（跨站表单 Origin 校验）
- sourceUrl 限定 http(s)（堵 `javascript:` 存储型 XSS）、DOMPurify 白名单 + 双向控制符剥离（RTLO 欺骗）
- 公开端点全量钳制（limit 1-500、page 1-100000、payload 剥离）
- cookie 只存 D1，读接口仅返回元数据不回明文

## 4. 质量工程（本项目的方法论核心）

**14 轮审查/测试，发现即修复，修复即回归**：

| 轮次 | 方向 | 代表性发现 |
|---|---|---|
| 1-3 | 模型代码审查（后端/爬虫/前端） | 静默失败 P0：Actor 永远显示成功 |
| 4 | Playwright UI + D1 EXPLAIN + 回归审计 | type 过滤深分页 3.57s（索引与排序列不符） |
| 5 | 爬虫全链路模拟 + 渗透 + 压力 | 60 并发丢失更新 6/6 复现；CSRF、`javascript:` URL |
| 6 | CI 实查 + 依赖审计 + Docker 链 + Unicode | **Docker 构建必败 ×2**（WORKDIR root 属主 + 锁文件被 ignore）|
| 7 | 真实部署测试 | 超时强杀、D1 日限、cron 重复抓取 |
| 8 | 断点续传状态机 | 重复翻页成本卡死进度 |

**测试台账**：冒烟 28 项、场景 38 项、纯逻辑单测 73 项、UI 交互 19 项、爬虫 mock 全链路 130+ 断言、渗透矩阵 8 组、压力 1573 请求 0 5xx、EXPLAIN 21 条查询、回归审计 23 项、干净 clone 验收 8 步。

**CI**（GitHub Actions，实测 7 连绿）：typecheck×3 + build + 本地 D1 冒烟。

## 5. 生产运行现状

| 指标 | 数值 |
|---|---|
| 已备份内容 | 3494（+赞同补全进行中，目标 ~26000） |
| 评论 / 收藏条目 / 赞同 | 2106 / 1099 / 1981（补全中，目标 ~18114） |
| D1 用量 | 23.8 MB / 5GB；日写入峰值 12 万行撞过免费限额一次 |
| R2 用量 | 24.5 MB / 10GB（7196 对象）|
| 单次增量耗时 | 预计 <10 分钟（快速模式早停） |
| 首次全量耗时 | ~8-10 小时（断点续传已消除重复成本） |

**运维要点**：cookie 失效去 `/auth` 重贴；每天 cron 自动增量；全量补历史用 `POST /api/sync/full?target=upvotes`；D1 免费版日写入 10 万行（增量模式日常 <1%）。

## 6. 遗留与展望

- **已知限制**：前端 store 会话内不自动刷新；R2 `versions/` 有待版本对比 UI；`apps/api`/`apps/collector` 为废弃参考实现
- **可选升级**：FTS5 全文搜索（十万级数据后）、keyset 游标分页、Workers Paid（$5/月彻底解除 D1 日限）
- **恢复能力**：D1 `export` + rclone R2 全量导出，命令级 runbook 见 README「数据备份与恢复」

---

*19 个提交，从「审查一个 AI 生成的工具」到「生产运行的个人数据基础设施」。*
