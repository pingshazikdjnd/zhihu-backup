import { db } from "../db.js";
import {
  IMAGE_FETCH_CONCURRENCY,
  getImageQualitySetting,
  localizeImage,
  type PreparedImageTask
} from "./images.js";

/**
 * 正文图片下载任务队列（P1：图片处理从 ingest 请求剥离）。
 *
 * ingest 只做纯 CPU 的确定性改写：按图片身份算出 R2 对象名、立刻把 <img src>
 * 改成站内路径，并把「下载这张图」写入 image_tasks；真正的网络下载由
 * /ingest/image-batch 批量消费（ingest 响应后的 waitUntil 与 cron 兜底触发）。
 * 这样 /ingest/content 不会被最多 50 张图的下载/重试拖成长请求。
 *
 * 状态机：pending → processing → done / failed
 * - 下载失败先回到 pending（下一批重试），累计 MAX_IMAGE_TASK_ATTEMPTS 次才置 failed；
 * - failed 行不会自动复活：后续 ingest 重新入队时，仅当 updated_at 早于 6 小时冷却阈值，
 *   才按数据库当前 status='failed' 做 CAS 并重置 attempts / 刷新签名 URL；
 * - processing 超过 10 分钟视为执行者已死（Worker 超时/重载），下一批可以重新领取；
 * - done 行保留：既是「重同步不再入队」的去重依据，也为 /api/images/* 缺失时
 *   回退到原始外链提供查询线索。
 */

/** 单次批量默认/最多领取多少条任务 */
export const IMAGE_TASK_BATCH_DEFAULT_LIMIT = 20;
export const IMAGE_TASK_BATCH_MAX_LIMIT = 100;
/** ingest 响应后 waitUntil 顺手消化的任务数：小批量，控制在后台生命周期内 */
export const IMAGE_TASK_INGEST_KICK_LIMIT = 4;
/** 一次后台 drain 最多消化多少条（含重试），避免单个 isolate 被历史积压拖住 */
const IMAGE_TASK_KICK_TOTAL_LIMIT = 16;

const MAX_IMAGE_TASK_ATTEMPTS = 3;
const PROCESSING_STALE_MS = 10 * 60 * 1000;
// failed 任务的重试冷却：下载失败往往是图床临时故障，重同步同一篇正文时
// 立刻重排队会在几分钟内把 attempts 再次打满。冷却期过后才允许重新入队。
const FAILED_RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export type ImageTaskStatus = "pending" | "processing" | "done" | "failed";

interface ImageTaskRow {
  id: number;
  content_pk: string;
  image_url: string;
  object_key: string;
  status: string;
  attempts: number;
  updated_at: string;
}

export interface ImageBatchResult {
  /** 本次领取的任务数 */
  claimed: number;
  /** 下载成功、对象已落 R2 */
  done: number;
  /** 重试次数耗尽，已置 failed */
  failed: number;
  /** 下载失败但还会重试，已置回 pending */
  retry: number;
}

function warnTasks(message: string, err?: unknown): void {
  if (err === undefined) {
    console.warn(`[image-tasks] ${message}`);
    return;
  }
  console.warn(`[image-tasks] ${message}`, err instanceof Error ? err.message : err);
}

/**
 * 把一篇正文的图片任务写进队列。
 *
 * 重同步同一篇正文时只补插新对象名：已 done 的不再下载；failed 且已过冷却期
 * （updated_at 早于 6 小时前）的重新排队，attempts 归零并刷新为本次的新签名 URL。
 * 重排队用条件 UPDATE 按数据库当前 status='failed' 做 CAS，防止读取后状态被
 * 其他消费者改掉时误复活；done/pending/processing 行完全不动。
 */
export async function enqueueImageTasks(
  contentPk: string,
  tasks: PreparedImageTask[]
): Promise<number> {
  if (!tasks.length) return 0;

  const now = new Date().toISOString();
  const retryBefore = new Date(Date.now() - FAILED_RETRY_COOLDOWN_MS).toISOString();
  const existing = await db.prepare(
    `SELECT object_key, status, attempts FROM image_tasks WHERE content_pk = ?`
  ).all<{ object_key: string; status: string; attempts: number }>(contentPk);
  const known = new Map(existing.map(row => [row.object_key, row]));

  const stmts: unknown[] = [];
  let inserted = 0;
  for (const task of tasks) {
    const row = known.get(task.objectKey);
    if (!row) {
      stmts.push(db.prepare(`
        INSERT OR IGNORE INTO image_tasks
          (content_pk, image_url, object_key, status, attempts, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', 0, ?, ?)
      `).raw(contentPk, task.imageUrl, task.objectKey, now, now));
      inserted += 1;
      continue;
    }
    // 冷却期已过的 failed 行：重置 attempts、换成本轮新签名 URL 后重新排队。
    // WHERE 里的 status 条件是 CAS：预读之后该行被并发改成 done/processing 时不会误改。
    if (row.status === "failed") {
      stmts.push(db.prepare(`
        UPDATE image_tasks
        SET status = 'pending', attempts = 0, image_url = ?, updated_at = ?
        WHERE content_pk = ? AND object_key = ?
          AND status = 'failed' AND updated_at < ?
      `).raw(task.imageUrl, now, contentPk, task.objectKey, retryBefore));
    }
  }

  if (stmts.length) await db.batch(stmts);
  return inserted;
}

/**
 * 领取一批任务：pending 或「processing 超时未更新」的都算可领。
 * 所有候选的条件 UPDATE 放进同一个 db.batch 提交（不再逐条 await）：
 * 100 条候选只产生 1 次 D1 往返，避免撞 Workers 子请求上限。
 * 条件 UPDATE 仍是乐观锁：并发两个消费者抢同一条时只有一个 changes=1，
 * 这里按 batch 返回数组里各自的 meta.changes 只取真正抢到的行。
 */
async function claimImageTasks(limit: number): Promise<ImageTaskRow[]> {
  const staleBefore = new Date(Date.now() - PROCESSING_STALE_MS).toISOString();
  const candidates = await db.prepare(`
    SELECT id, content_pk, image_url, object_key, status, attempts, updated_at
    FROM image_tasks
    WHERE status = 'pending' OR (status = 'processing' AND updated_at < ?)
    ORDER BY id
    LIMIT ?
  `).all<ImageTaskRow>(staleBefore, limit);
  if (!candidates.length) return [];

  const now = new Date().toISOString();
  const results = await db.batch(candidates.map(row => db.prepare(`
    UPDATE image_tasks
    SET status = 'processing', attempts = attempts + 1, updated_at = ?
    WHERE id = ? AND status = ? AND updated_at = ?
  `).raw(now, row.id, row.status, row.updated_at)));

  const claimed: ImageTaskRow[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (Number(results?.[i]?.meta?.changes ?? 0) > 0) claimed.push(candidates[i]);
  }
  return claimed;
}

async function markTaskDone(id: number): Promise<void> {
  await db.prepare(
    `UPDATE image_tasks SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?`
  ).run(new Date().toISOString(), id);
}

async function markTaskRetry(id: number): Promise<void> {
  await db.prepare(
    `UPDATE image_tasks SET status = 'pending', updated_at = ? WHERE id = ?`
  ).run(new Date().toISOString(), id);
}

async function markTaskFailed(id: number, message: string): Promise<void> {
  await db.prepare(
    `UPDATE image_tasks SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`
  ).run(message.slice(0, 500), new Date().toISOString(), id);
}

/**
 * 消费一批图片任务：下载并写 R2，逐条更新任务状态。
 * 单条失败只影响自己；批量层任何异常都不会外抛给调用方。
 */
export async function processImageBatch(
  bucket: R2Bucket,
  limit: number = IMAGE_TASK_BATCH_DEFAULT_LIMIT
): Promise<ImageBatchResult> {
  const parsedLimit = Number.isFinite(limit) ? Math.trunc(limit) : IMAGE_TASK_BATCH_DEFAULT_LIMIT;
  const take = Math.min(Math.max(parsedLimit, 1), IMAGE_TASK_BATCH_MAX_LIMIT);

  const rows = await claimImageTasks(take);
  const summary: ImageBatchResult = { claimed: rows.length, done: 0, failed: 0, retry: 0 };
  if (!rows.length) return summary;

  // 质量设置在每个 isolate 内缓存 60 秒，整批只读一次
  const quality = await getImageQualitySetting(bucket);

  // 与下载并发保持一致地分批：槽位闸门本身也会限流，这里分批是为了把
  // HEAD/失败写库的节奏摊平，避免一次拉起几十个并行请求
  for (let i = 0; i < rows.length; i += IMAGE_FETCH_CONCURRENCY) {
    const chunk = rows.slice(i, i + IMAGE_FETCH_CONCURRENCY);
    await Promise.all(chunk.map(async row => {
      try {
        const localPath = await localizeImage(row.image_url, bucket, quality);
        if (localPath) {
          await markTaskDone(row.id);
          summary.done += 1;
          return;
        }
        // 领取时 attempts 已 +1，这里用 +1 后的值判断是否耗尽重试
        if (row.attempts + 1 >= MAX_IMAGE_TASK_ATTEMPTS) {
          await markTaskFailed(row.id, "download failed");
          summary.failed += 1;
        } else {
          await markTaskRetry(row.id);
          summary.retry += 1;
        }
      } catch (err) {
        // 任务层任何异常都不能让整批失败：单条置回 pending，等下一轮
        warnTasks(`task ${row.id} failed`, err);
        await markTaskRetry(row.id).catch(() => {});
        summary.retry += 1;
      }
    }));
  }

  return summary;
}

/**
 * 后台 drain：在单飞的 promise 里连跑若干小批，直到队列清空、达到上限，
 * 或整批都在失败重试（避免在同一个 drain 里把 attempts 刷爆）。
 * ingest 只调用它并 waitUntil，不等待结果。
 */
export async function drainImageTasks(
  bucket: R2Bucket,
  limitPerBatch: number,
  maxTotal: number = IMAGE_TASK_KICK_TOTAL_LIMIT
): Promise<ImageBatchResult> {
  const total: ImageBatchResult = { claimed: 0, done: 0, failed: 0, retry: 0 };
  while (total.claimed < maxTotal) {
    const remaining = maxTotal - total.claimed;
    const one = await processImageBatch(bucket, Math.min(limitPerBatch, remaining));
    total.claimed += one.claimed;
    total.done += one.done;
    total.failed += one.failed;
    total.retry += one.retry;
    // 队列已空（不足一批），本轮 drain 结束
    if (one.claimed < Math.min(limitPerBatch, remaining)) break;
    // 整批失败回队：先退出，等下一次 ingest/手动批量再重试
    if (one.retry === one.claimed) break;
  }
  return total;
}

// isolate 内单飞：爬虫连续 POST 多篇正文时只跑一个后台 drain，
// 避免每个响应都拉起一批任务、把槽位等待队列堆满。
let activeDrain: Promise<ImageBatchResult> | null = null;

/** 单飞版 drain：已有 drain 在跑时直接复用它的 promise */
export function kickImageDrain(bucket: R2Bucket, limitPerBatch: number): Promise<ImageBatchResult> {
  if (activeDrain) return activeDrain;
  const run = drainImageTasks(bucket, limitPerBatch).finally(() => {
    if (activeDrain === run) activeDrain = null;
  });
  activeDrain = run;
  return run;
}

/**
 * /api/images/* 未命中时的回退查询：在未完成/已失败的任务里找原始外链。
 * 只查非 done 行——done 但对象缺失属于数据被删，重定向到外链会掩盖问题。
 */
export async function findImageFallbackUrl(objectKey: string): Promise<string | null> {
  const row = await db.prepare(`
    SELECT image_url FROM image_tasks
    WHERE object_key = ? AND status <> 'done'
    ORDER BY updated_at DESC
    LIMIT 1
  `).get<{ image_url: string }>(objectKey);
  return row?.image_url ?? null;
}
