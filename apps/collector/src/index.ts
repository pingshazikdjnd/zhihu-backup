import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
import { runScraper, runCollectionScraper, runUpvotesScraper } from "./jobs/sync.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "sync";

  if (command === "sync") {
    await runScraper();
  } else if (command === "sync:collections") {
    await runCollectionScraper();
  } else if (command === "sync:upvotes") {
    await runUpvotesScraper();
  } else {
    console.error(`❌ 未知命令: ${command || "(空)"}`);
  }

  console.log(`
支持命令:
  sync             (默认) 同步我的回答与评论
  sync:collections 同步收藏夹
  sync:upvotes     同步赞同记录
`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
