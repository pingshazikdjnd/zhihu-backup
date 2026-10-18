import cron from "node-cron";
import { runScraper, runCollectionScraper } from "./jobs/sync.js";

async function main() {
  console.log("🕒 混合模式：定时轮询任务已启动！");
  console.log("   - 每天凌晨 02:00 和 14:00 自动抓取 回答与评论");
  console.log("   - 每天凌晨 03:00 和 15:00 自动抓取 收藏夹");
  console.log("   (当然，你也可以随时在前端页面点击同步按钮手动触发)");

  // 每天 02:00 和 14:00 执行回答/评论同步
  cron.schedule("0 2,14 * * *", async () => {
    console.log("⏰ 触发定时任务：同步回答和评论...");
    try {
      await runScraper();
    } catch (e) {
      console.error("同步失败:", e);
    }
  });

  // 每天 03:00 和 15:00 执行收藏夹同步
  cron.schedule("0 3,15 * * *", async () => {
    console.log("⏰ 触发定时任务：同步收藏夹...");
    try {
      await runCollectionScraper();
    } catch (e) {
      console.error("同步失败:", e);
    }
  });
}

main().catch(err => {
  console.error("定时任务启动失败:", err);
  process.exit(1);
});
