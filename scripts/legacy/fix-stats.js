import { execSync } from "child_process";
import fs from "fs";

async function main() {
  // Get all contents with 0 voteup_count
  const res = execSync(`npx wrangler d1 execute zhihu-backup --local --command="SELECT pk, source_type, source_id FROM contents WHERE voteup_count = 0 AND source_type = 'answer';" --json`, { encoding: "utf-8" });
  
  const parsed = JSON.parse(res);
  const rows = parsed[0]?.results || [];
  
  console.log(`Found ${rows.length} answers with 0 voteups.`);
  
  // Read cookie from apify input if needed
  let cookie = "";
  try {
     const inputStr = fs.readFileSync("apps/apify-crawler/apify_storage/key_value_stores/default/INPUT.json", "utf-8");
     cookie = JSON.parse(inputStr).cookieString || "";
  } catch(e) {}
  
  for (const row of rows) {
    console.log(`Fetching stats for ${row.pk}...`);
    try {
       const fetchRes = await fetch(`https://www.zhihu.com/api/v4/answers/${row.source_id}?include=voteup_count,comment_count,visit_count,favorite_count`, {
           headers: { 
             cookie,
             "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
           }
       });
       if (fetchRes.ok) {
           const data = await fetchRes.json();
           const voteup = data.voteup_count || 0;
           const comment = data.comment_count || 0;
           const visit = data.visit_count || 0;
           let fav = data.favorite_count || data.thanks_count || 0;
           
           if (fav === 0) {
              const favlistsRes = await fetch(`https://www.zhihu.com/api/v4/answers/${row.source_id}/favlists?limit=1&offset=0`, { 
                headers: { 
                  cookie,
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                } 
              });
              if (favlistsRes.ok) {
                 const favlistsData = await favlistsRes.json();
                 if (favlistsData.paging && typeof favlistsData.paging.totals === "number") {
                    fav = favlistsData.paging.totals;
                 }
              }
           }
           
           if (voteup > 0 || comment > 0 || visit > 0 || fav > 0) {
              console.log(`Updating ${row.pk}: 👍 ${voteup} 💬 ${comment} ⭐ ${fav} 👁️ ${visit}`);
              execSync(`npx wrangler d1 execute zhihu-backup --local --command="UPDATE contents SET voteup_count = ${voteup}, comment_count = ${comment}, favorite_count = ${fav}, visit_count = ${visit} WHERE pk = '${row.pk}';"`, { encoding: "utf-8", stdio: "ignore" });
           } else {
              console.log(`Still 0 for ${row.pk}. Data: ${JSON.stringify(data)}`);
           }
       } else {
           console.log(`Fetch failed for ${row.pk}: ${fetchRes.status}`);
       }
    } catch(e) {
       console.log(`Error on ${row.pk}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

main();
