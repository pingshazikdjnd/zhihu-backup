# 知乎字段审计（2026-11-01）

真机实测：登录态请求 22 个端点（含 include 三组对照）+ 3 个免登录端点。
产出 **805 行明细 / 563 个去重字段 / 13 个实体**。

## 先看这几个

| 文件 | 内容 |
|---|---|
| `知乎字段总表.xlsx` | **主表**，7 个 sheet：字段总表 / 按实体统计 / 明细-按接口 / 疑似遗漏 / 代码要但接口不给 / 抽样复测 / 新旧对账 |
| `字段总表.md` | 同内容 Markdown 版 |
| `字段总表.csv` | 805 行明细，便于导入其它工具 |
| `22-conflicts.md` | 与旧 `FIELD_AUDIT.md` 的逐条对账（旧文档 10 条仍成立、8 条已过时） |

## 分轮证据

| 文件 | 轮次 | 内容 |
|---|---|---|
| `01-endpoints-include.*` | 第一轮 | 13 个接口 + include 原文 + 代码读取字段（file:line） |
| `02-observed-keys.*` | 第一轮 | 历史探测产物里的真实字段（articles 两次探测等） |
| `03-open-endpoints.*` | 第一轮 | 免登录接口实测（hot-list / recommend 字段树） |
| `10-live-answers.*` | 真机 | 回答列表 × 详情，224 条字段判定 |
| `11-live-comments.*` | 真机 | 根评论 / 子评论，81 条路径 |
| `12-live-articles.*` | 真机 | 文章列表 × 专栏详情 |
| `13-live-collections.*` | 真机 | 收藏夹列表 / 条目 / 详情 |
| `14-live-members.*` | 真机 | 用户资料 / 关注 / 粉丝 / me |
| `15-live-pins-questions.*` | 真机 | 动态流 / 问题 / 点赞（部分 403 未测） |
| `20-missing-audit.*` | 验证 | 遗漏审计 + 57 条外部候选（未实测） |
| `21-verification.*` | 验证 | 独立抽样复测：6 PASS / 0 FAIL / 1 UNVERIFIED |
| `22-conflicts.*` | 验证 | 新旧审计对账（7 条冲突） |
| `30-merged-fields.json` | 汇总 | 合并后原始数据 |

## 最重要的四条

1. **include 语法陷阱**：必须「首项带 `data[*].` + 逗号编码 `%2C`」。写成「原始逗号 + 每项都带前缀」会被服务端整串静默忽略，不报错。
2. **include 也拿不到**：回答列表的 `voteup_count/favorite_count/visit_count/thanks_count`；文章的 `favorite_count/visit_count/thanks_count`；收藏夹条目的 `favorite_count/visit_count`。
3. **评论真实字段名**：`vote_count`（非 likes）、`top/featured`（非 is_top/is_featured）、`author{role,member}` 两层、**没有 img_url/image_url**（图片在 `attached_info`）。
4. **`/api/v4/questions/{id}` 直连 403/10003**（缺 x-zse-96 签名）；`collections/{id}/items` 用 `limit=50` 会静默空页，`limit=20` 正常。

## 复现

```bash
node merge.mjs        # 合并 10~15/03 号产物 → 30-merged-fields.json + 字段总表.csv
python gen_xlsx.py    # 生成 知乎字段总表.xlsx
python gen_md.py      # 生成 字段总表.md
```

注：`merge.mjs` 里的固定路径指向本次的会话工作区；挪到别处跑时改 `DIR` 即可。
